use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use url::Url;

use crate::config::CoreConfig;

/// The client realm. `/ws/nodes` is a different realm with a different
/// credential, and this shell has no business on it.
pub const CLIENT_SOCKET_PATH: &str = "/ws/clients";
/// Must match the core's `ENVELOPE_VERSION`; an unknown version fails closed there.
pub const ENVELOPE_VERSION: u32 = 1;
const MAX_BACKOFF: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEvent {
    Connected,
    /// A server frame, verbatim. This process forwards, it does not interpret.
    Frame(String),
    Disconnected(String),
}

pub fn socket_url(base: &Url) -> Result<Url, String> {
    let scheme = match base.scheme() {
        "http" => "ws",
        "https" => "wss",
        other => return Err(format!("The core scheme {other} has no socket equivalent")),
    };

    let mut url = base.clone();

    url.set_scheme(scheme)
        .map_err(|()| "The core URL cannot carry a socket scheme".to_owned())?;
    url.set_path(CLIENT_SOCKET_PATH);

    Ok(url)
}

pub fn subscribe_frame(after_sequence: u64) -> String {
    serde_json::json!({
        "kind": "subscribe",
        "envelopeVersion": ENVELOPE_VERSION,
        "afterSequence": after_sequence,
    })
    .to_string()
}

/// Where the resume point comes from. A delivered event moves it forward; a gap
/// frame moves it *back* to what the core actually holds, because a cursor ahead
/// of the ledger asks for events that will never arrive.
pub fn advance_cursor(frame: &str, current: u64) -> u64 {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(frame) else {
        return current;
    };

    match parsed.get("kind").and_then(serde_json::Value::as_str) {
        Some("event") => parsed
            .get("event")
            .and_then(|event| event.get("sequence"))
            .and_then(serde_json::Value::as_u64)
            .filter(|sequence| *sequence > current)
            .unwrap_or(current),
        Some("gap") => parsed
            .get("fromSequence")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(current),
        _ => current,
    }
}

/// One connection: dial, subscribe from the cursor, forward frames until the
/// socket ends. The cursor moves as frames are handed over, which is what makes
/// the next attempt a resume rather than a replay from zero.
async fn connect_once<E>(config: &CoreConfig, cursor: &AtomicU64, emit: &E) -> Result<(), String>
where
    E: Fn(StreamEvent),
{
    let url = socket_url(&config.base)?;
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|error| error.to_string())?;

    // The client realm authenticates with the same bearer the REST proxy uses.
    // A browser could not send this header, which is exactly why the packaged
    // shell holds the socket and the browser transport polls instead.
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&config.bearer())
            .map_err(|_| "The core token cannot be sent as a header".to_owned())?,
    );

    let (mut socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|error| error.to_string())?;

    emit(StreamEvent::Connected);

    socket
        .send(Message::Text(
            subscribe_frame(cursor.load(Ordering::SeqCst)).into(),
        ))
        .await
        .map_err(|error| error.to_string())?;

    while let Some(message) = socket.next().await {
        match message.map_err(|error| error.to_string())? {
            Message::Text(text) => {
                let text = text.to_string();

                emit(StreamEvent::Frame(text.clone()));
                cursor.store(
                    advance_cursor(&text, cursor.load(Ordering::SeqCst)),
                    Ordering::SeqCst,
                );
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    Ok(())
}

/// Reconnects for as long as the task lives. Cancellation is the task being
/// aborted: there is no half-finished state to unwind, because the cursor is the
/// only thing carried between attempts.
pub async fn run_stream<E>(config: CoreConfig, cursor: Arc<AtomicU64>, emit: E, backoff: Duration)
where
    E: Fn(StreamEvent) + Send + Sync,
{
    let mut delay = backoff;

    loop {
        match connect_once(&config, &cursor, &emit).await {
            Ok(()) => {
                emit(StreamEvent::Disconnected(
                    "the core closed the socket".to_owned(),
                ));
                // A connection that worked earns a fresh budget; otherwise one
                // long-lived session followed by a drop starts at the cap.
                delay = backoff;
            }
            Err(reason) => emit(StreamEvent::Disconnected(reason)),
        }

        tokio::time::sleep(delay).await;
        delay = (delay * 2).min(MAX_BACKOFF);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    fn event_frame(sequence: u64) -> String {
        serde_json::json!({
            "kind": "event",
            "envelopeVersion": ENVELOPE_VERSION,
            "event": { "sequence": sequence },
        })
        .to_string()
    }

    #[test]
    fn derives_the_client_socket_url() {
        let base = CoreConfig::new(None, Some(TOKEN))
            .expect("configuration")
            .base;

        assert_eq!(
            socket_url(&base).expect("url").as_str(),
            "ws://127.0.0.1:7717/ws/clients"
        );
    }

    #[test]
    fn upgrades_a_secure_core_to_a_secure_socket() {
        let base = CoreConfig::new(Some("https://core.example"), Some(TOKEN))
            .expect("configuration")
            .base;

        assert_eq!(
            socket_url(&base).expect("url").as_str(),
            "wss://core.example/ws/clients"
        );
    }

    #[test]
    fn subscribes_at_the_resume_point() {
        let frame: serde_json::Value =
            serde_json::from_str(&subscribe_frame(12)).expect("valid json");

        assert_eq!(
            frame,
            serde_json::json!({
                "kind": "subscribe",
                "envelopeVersion": ENVELOPE_VERSION,
                "afterSequence": 12,
            })
        );
    }

    #[test]
    fn advances_the_cursor_over_delivered_events() {
        assert_eq!(advance_cursor(&event_frame(5), 4), 5);
    }

    #[test]
    fn never_moves_the_cursor_backwards_on_a_replayed_event() {
        assert_eq!(advance_cursor(&event_frame(2), 7), 7);
    }

    #[test]
    fn winds_the_cursor_back_to_the_ledger_on_a_gap() {
        let gap = serde_json::json!({
            "kind": "gap",
            "envelopeVersion": ENVELOPE_VERSION,
            "fromSequence": 3,
            "toSequence": 9,
        })
        .to_string();

        assert_eq!(advance_cursor(&gap, 9), 3);
    }

    #[test]
    fn leaves_the_cursor_alone_for_a_frame_it_cannot_read() {
        assert_eq!(advance_cursor("not json", 7), 7);
        assert_eq!(advance_cursor("{}", 7), 7);
    }
    /// The whole reason the shell owns this socket: a drop must resume, not
    /// restart. Round one delivers sequence 5 and hangs up; round two must ask
    /// for what comes after 5.
    // The handshake callback returns tungstenite's own error response type,
    // which is large by its own design and not something this test chooses.
    #[allow(clippy::result_large_err)]
    #[tokio::test]
    async fn resumes_from_the_cursor_after_the_socket_drops() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let port = listener.local_addr().expect("address").port();

        let server = tokio::spawn(async move {
            let mut rounds: Vec<(String, String)> = Vec::new();

            for round in 0..2u8 {
                let (stream, _) = listener.accept().await.expect("connection");
                let authorization = Arc::new(std::sync::Mutex::new(String::new()));
                let captured = Arc::clone(&authorization);

                let mut socket = tokio_tungstenite::accept_hdr_async(
                    stream,
                    move |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                          response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                        *captured.lock().expect("lock") = request
                            .headers()
                            .get("authorization")
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or_default()
                            .to_owned();

                        Ok(response)
                    },
                )
                .await
                .expect("handshake");

                let subscribe = socket.next().await.expect("frame").expect("message");

                rounds.push((
                    subscribe.to_text().expect("text").to_owned(),
                    authorization.lock().expect("lock").clone(),
                ));

                if round == 0 {
                    socket
                        .send(Message::Text(event_frame(5).into()))
                        .await
                        .expect("send");
                    socket.close(None).await.expect("close");
                }
            }

            rounds
        });

        let config = CoreConfig::new(Some(&format!("http://127.0.0.1:{port}")), Some(TOKEN))
            .expect("configuration");
        let cursor = Arc::new(AtomicU64::new(0));
        let seen: Arc<std::sync::Mutex<Vec<StreamEvent>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorder = Arc::clone(&seen);

        let client = tokio::spawn(run_stream(
            config,
            Arc::clone(&cursor),
            move |event| recorder.lock().expect("lock").push(event),
            Duration::from_millis(1),
        ));

        let rounds = server.await.expect("server");

        client.abort();

        let first: serde_json::Value = serde_json::from_str(&rounds[0].0).expect("json");
        let second: serde_json::Value = serde_json::from_str(&rounds[1].0).expect("json");

        assert_eq!(rounds[0].1, format!("Bearer {TOKEN}"));
        assert_eq!(first["afterSequence"], 0);
        assert_eq!(second["afterSequence"], 5);
        assert_eq!(cursor.load(Ordering::SeqCst), 5);
        assert!(seen
            .lock()
            .expect("lock")
            .iter()
            .any(|event| matches!(event, StreamEvent::Frame(_))));
    }

    /// A refused handshake is a condition the user has to see. Retrying in
    /// silence is how a shell sits there looking connected while it is not.
    // The handshake callback returns tungstenite's own error response type,
    // which is large by its own design and not something this test chooses.
    #[allow(clippy::result_large_err)]
    #[tokio::test]
    async fn reports_a_refused_handshake() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let port = listener.local_addr().expect("address").port();

        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("connection");

            let _ = tokio_tungstenite::accept_hdr_async(
                stream,
                |_request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                 _response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                    Err(tokio_tungstenite::tungstenite::http::Response::builder()
                        .status(401)
                        .body(None)
                        .expect("response"))
                },
            )
            .await;
        });

        let config = CoreConfig::new(Some(&format!("http://127.0.0.1:{port}")), Some(TOKEN))
            .expect("configuration");
        let seen: Arc<std::sync::Mutex<Vec<StreamEvent>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorder = Arc::clone(&seen);

        let client = tokio::spawn(run_stream(
            config,
            Arc::new(AtomicU64::new(0)),
            move |event| recorder.lock().expect("lock").push(event),
            Duration::from_millis(1),
        ));

        let refusal = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let found = seen
                    .lock()
                    .expect("lock")
                    .iter()
                    .find_map(|event| match event {
                        StreamEvent::Disconnected(reason) if reason.contains("401") => {
                            Some(reason.clone())
                        }
                        _ => None,
                    });

                if let Some(reason) = found {
                    return reason;
                }

                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await;

        client.abort();

        assert!(refusal.is_ok(), "the refused handshake was never reported");
    }
}

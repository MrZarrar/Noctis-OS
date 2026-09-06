use reqwest::{Client, Method, Request};
use serde::Serialize;
use serde_json::Value;
use url::Url;

use crate::config::CoreConfig;

#[derive(Debug, PartialEq, Eq)]
pub enum ProxyError {
    /// The path could name a host, so signing it could hand the token away.
    PathRefused,
    MethodRefused,
    Unreachable(String),
}

impl std::fmt::Display for ProxyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PathRefused => write!(f, "A core path must be rooted and may not name a host"),
            Self::MethodRefused => write!(f, "The core accepts GET and POST"),
            Self::Unreachable(reason) => write!(f, "The core could not be reached: {reason}"),
        }
    }
}

/// What the WebView gets back. The core's body is passed through verbatim: this
/// process signs requests, it does not interpret answers.
#[derive(Debug, Serialize)]
pub struct ProxyResponse {
    pub status: u16,
    pub body: String,
}

/// The token is attached to whatever this returns, so a path that can name a
/// host is a path that can hand the token to that host.
pub fn core_url(base: &Url, path: &str) -> Result<Url, ProxyError> {
    if !path.starts_with(char::from(47)) {
        return Err(ProxyError::PathRefused);
    }

    // Both shapes are read as authority-relative by URL parsers, so a leading
    // slash alone does not prove a path stays on this origin.
    //
    // This and the origin comparison below are mutually redundant: sabotage
    // showed that removing either one alone fails no test, because whichever
    // remains catches every input. Removing both does fail
    // `refuses_a_path_that_names_another_host`. Both stay — the comparison is
    // the general truth, this is the one that reads as the rule — but neither
    // is claimed to be independently tested.
    if path.starts_with("//") || path.starts_with(&format!("/{}", char::from(92))) {
        return Err(ProxyError::PathRefused);
    }

    let resolved = base.join(path).map_err(|_| ProxyError::PathRefused)?;

    if resolved.origin() != base.origin() {
        return Err(ProxyError::PathRefused);
    }

    Ok(resolved)
}

pub fn build_request(
    client: &Client,
    config: &CoreConfig,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Request, ProxyError> {
    let method = match method {
        "GET" => Method::GET,
        "POST" => Method::POST,
        _ => return Err(ProxyError::MethodRefused),
    };

    let mut request = client
        .request(method, core_url(&config.base, path)?)
        .header("authorization", config.bearer());

    if let Some(body) = body {
        request = request.json(body);
    }

    request
        .build()
        .map_err(|error| ProxyError::Unreachable(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";

    fn config() -> CoreConfig {
        CoreConfig::new(None, Some(TOKEN)).expect("configuration")
    }

    #[test]
    fn resolves_a_rooted_path_against_the_core() {
        let base = config().base;

        assert_eq!(
            core_url(&base, "/events?after=3").expect("url").as_str(),
            "http://127.0.0.1:7717/events?after=3"
        );
    }

    #[test]
    fn refuses_a_path_that_names_another_host() {
        let base = config().base;
        let backslash_host = format!("/{}evil.example/steal", char::from(92));

        for path in [
            "//evil.example/steal",
            &backslash_host,
            "http://evil.example/steal",
        ] {
            assert_eq!(
                core_url(&base, path),
                Err(ProxyError::PathRefused),
                "{path}"
            );
        }
    }

    #[test]
    fn refuses_a_path_that_is_not_rooted() {
        let base = config().base;

        assert_eq!(core_url(&base, "events"), Err(ProxyError::PathRefused));
        assert_eq!(core_url(&base, ""), Err(ProxyError::PathRefused));
    }

    #[test]
    fn signs_a_read_with_the_bearer_token() {
        let request =
            build_request(&Client::new(), &config(), "GET", "/objectives", None).expect("request");

        assert_eq!(request.method(), "GET");
        assert_eq!(request.url().as_str(), "http://127.0.0.1:7717/objectives");
        assert_eq!(
            request
                .headers()
                .get("authorization")
                .expect("authorization"),
            &format!("Bearer {TOKEN}")
        );
        assert!(request.body().is_none());
    }

    #[test]
    fn sends_a_command_as_json() {
        let body = serde_json::json!({ "title": "T" });
        let request = build_request(
            &Client::new(),
            &config(),
            "POST",
            "/commands/x",
            Some(&body),
        )
        .expect("request");

        assert_eq!(request.method(), "POST");
        assert_eq!(
            request.headers().get("content-type").expect("content-type"),
            "application/json"
        );
        assert_eq!(
            request
                .body()
                .and_then(|body| body.as_bytes())
                .expect("body"),
            serde_json::to_vec(&body).expect("json").as_slice()
        );
    }

    #[test]
    fn refuses_a_method_the_core_does_not_serve() {
        assert_eq!(
            build_request(&Client::new(), &config(), "DELETE", "/objectives", None).unwrap_err(),
            ProxyError::MethodRefused
        );
    }

    #[test]
    fn a_refusal_never_carries_the_token() {
        let refusal = build_request(&Client::new(), &config(), "GET", "//evil.example", None)
            .expect_err("refusal");

        assert!(!refusal.to_string().contains(TOKEN));
    }
}

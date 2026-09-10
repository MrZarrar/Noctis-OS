pub mod config;
pub mod deeplink;
pub mod placement;
pub mod proxy;
pub mod stream;
pub mod tool_authority;
pub mod tool_registry;
/// The Tauri commands that reach specialist tools. Empty off Windows, by an
/// inner `cfg`, for the same reason `windows_commands` is.
pub mod tools_commands;
pub mod window_authority;
/// The Tauri commands that place native windows. Empty off Windows, by an inner
/// `cfg` in the module itself rather than a `cfg` here, so the file states its
/// own platform.
pub mod windows_commands;
pub mod windows_state;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, Window, WindowEvent,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use config::CoreConfig;
use placement::{Placement, WorkArea};
use proxy::ProxyResponse;
use stream::StreamEvent;

/// Events the shell emits to the WebView. Named, and few: everything else the
/// page wants, it has to ask for.
pub const FRAME_EVENT: &str = "core:frame";
pub const STATUS_EVENT: &str = "core:status";
pub const DEEP_LINK_EVENT: &str = "core:deep-link";

const MAIN_WINDOW: &str = "main";
/// Registering a URL scheme writes to the user's registry. That is a
/// production activation, so it happens only when it is asked for by name.
pub const REGISTER_SCHEME_VAR: &str = "NOCTIS_REGISTER_SCHEME";
const PLACEMENT_FILE: &str = "window.json";
const RECONNECT_BACKOFF: Duration = Duration::from_millis(500);
/// A drag emits a move event per frame. Saving every one of them writes the file
/// hundreds of times a second for no gain; a close always saves exactly, so the
/// most a crash can lose is the last moment of a drag.
const SAVE_THROTTLE: Duration = Duration::from_millis(250);

/// The configuration, or the reason there isn't one.
///
/// A shell that cannot reach the core still opens its window and says so.
/// Exiting on a missing environment variable would leave a double-clicked
/// application with nowhere to print the reason.
pub struct CoreState(pub Result<CoreConfig, String>);

impl CoreState {
    pub fn get(&self) -> Result<&CoreConfig, String> {
        self.0.as_ref().map_err(Clone::clone)
    }
}

#[derive(Default)]
pub struct StreamState {
    cursor: Arc<AtomicU64>,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

#[derive(Default)]
struct LastSave(Mutex<Option<Instant>>);

/// The WebView's only route to the core.
///
/// It names a method and a rooted path; the token, the origin, and the decision
/// to sign the request all stay here (Section 9.2).
#[tauri::command]
async fn core_request(
    core: State<'_, CoreState>,
    client: State<'_, reqwest::Client>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<ProxyResponse, String> {
    let config = core.get()?;
    let request = proxy::build_request(&client, config, &method, &path, body.as_ref())
        .map_err(|error| error.to_string())?;

    let response = client
        .execute(request)
        .await
        .map_err(|error| proxy::ProxyError::Unreachable(error.to_string()).to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|error| error.to_string())?;

    // Method, path, status. Never the token, never the body: every consequential
    // request is auditable, and none of that audit is a secret (Section 9.2).
    eprintln!("noctis: proxied {method} {path} -> {status}");

    Ok(ProxyResponse { status, body })
}

#[tauri::command]
fn core_subscribe(
    app: AppHandle,
    core: State<'_, CoreState>,
    state: State<'_, StreamState>,
    after_sequence: u64,
) -> Result<(), String> {
    let config = core.get()?.clone();
    let mut task = state
        .task
        .lock()
        .map_err(|_| "stream state is poisoned".to_owned())?;

    if task.is_some() {
        // Already streaming. A second subscribe would open a second socket and
        // deliver every event twice.
        return Ok(());
    }

    state.cursor.store(after_sequence, Ordering::SeqCst);

    let cursor = Arc::clone(&state.cursor);
    let handle = tauri::async_runtime::spawn(async move {
        stream::run_stream(
            config,
            cursor,
            move |event| {
                let sent = match event {
                    StreamEvent::Frame(text) => app.emit(FRAME_EVENT, text),
                    StreamEvent::Connected => app.emit(STATUS_EVENT, "connected".to_owned()),
                    StreamEvent::Disconnected(reason) => {
                        app.emit(STATUS_EVENT, format!("disconnected: {reason}"))
                    }
                };

                if let Err(error) = sent {
                    eprintln!("noctis: could not reach the WebView: {error}");
                }
            },
            RECONNECT_BACKOFF,
        )
        .await;
    });

    *task = Some(handle);

    Ok(())
}

#[tauri::command]
fn core_unsubscribe(state: State<'_, StreamState>) -> Result<(), String> {
    let mut task = state
        .task
        .lock()
        .map_err(|_| "stream state is poisoned".to_owned())?;

    if let Some(handle) = task.take() {
        handle.abort();
    }

    Ok(())
}

fn placement_path(app: &AppHandle) -> PathBuf {
    // Derived from the Noctis application identifier, so this shell shares no
    // directory with the donor or with anything else.
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(PLACEMENT_FILE)
}

fn current_placement(window: &Window) -> Option<Placement> {
    let position = window.outer_position().ok()?;
    // The inner size, because `set_size` sets the inner size. Saving the outer
    // size and restoring it as the inner one grows the window by the width of
    // its own frame on every restart.
    let size = window.inner_size().ok()?;

    Some(Placement {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: window.is_maximized().ok()?,
    })
}

fn save_placement(window: &Window, force: bool) {
    let app = window.app_handle();

    if !force {
        let Some(last) = app.try_state::<LastSave>() else {
            return;
        };
        let Ok(mut last) = last.0.lock() else {
            return;
        };

        if last.is_some_and(|at| at.elapsed() < SAVE_THROTTLE) {
            return;
        }

        *last = Some(Instant::now());
    }

    let Some(placement) = current_placement(window) else {
        return;
    };

    if let Err(error) = placement::save(&placement_path(app), &placement) {
        eprintln!("noctis: could not save the window placement: {error}");
    }
}

fn restore_placement(window: &Window) {
    let Some(saved) = placement::load(&placement_path(window.app_handle())) else {
        return;
    };

    let monitors: Vec<WorkArea> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| WorkArea {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        })
        .collect();

    // ponytail: monitor bounds, not work area — Tauri 2 does not expose the work
    // area, so a restored window can sit under the taskbar by its height. Swap
    // the source here if that ever shows.
    let restored = placement::restore(saved, &monitors);

    let _ = window.set_size(PhysicalSize::new(restored.width, restored.height));
    let _ = window.set_position(PhysicalPosition::new(restored.x, restored.y));

    if restored.maximized {
        let _ = window.maximize();
    }
}

fn focus_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };

    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn toggle_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };

    if window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false) {
        let _ = window.hide();
    } else {
        focus_main(app);
    }
}

fn emit_deep_link(app: &AppHandle, link: &deeplink::DeepLink) {
    focus_main(app);

    // The route, not the target: a link is a navigation, and its identifier is
    // the page's business rather than the log's.
    eprintln!("noctis: forwarded a deep link to {}", link.route);

    if let Err(error) = app.emit(DEEP_LINK_EVENT, link) {
        eprintln!("noctis: could not deliver a deep link: {error}");
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show Noctis", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Noctis", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::with_id("noctis")
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            tauri::Error::AssetNotFound("the window icon the tray reuses".to_owned())
        })?)
        .tooltip("Noctis OS")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => focus_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        // First, and deliberately: a second launch must be answered before it
        // gets as far as building a window of its own.
        // Focus, and nothing else. This plugin's `deep-link` feature already
        // hands a second launch's URL to the deep-link plugin, so parsing argv
        // here as well delivered every link to the page twice.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(CoreState(
            CoreConfig::from_env().map_err(|error| error.to_string()),
        ))
        .manage(reqwest::Client::new())
        .manage(StreamState::default())
        .manage(LastSave::default());

    // The window commands exist only where there are Win32 windows to place.
    // Registered in a `cfg` branch rather than behind a runtime check, so a
    // build for another platform simply does not offer them — a command that
    // exists and always refuses is a capability the page has to learn is a lie.
    #[cfg(windows)]
    let builder = builder
        .manage(windows_state::NativeWindows::default())
        .invoke_handler(tauri::generate_handler![
            core_request,
            core_subscribe,
            core_unsubscribe,
            windows_commands::window_survey,
            windows_commands::window_place,
            windows_commands::window_restore,
            windows_commands::window_clear_override,
            tools_commands::tool_survey,
            tools_commands::tool_execute
        ]);

    #[cfg(not(windows))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        core_request,
        core_subscribe,
        core_unsubscribe
    ]);

    builder
        .setup(|app| {
            let handle = app.handle().clone();

            // Filled here rather than where the state is managed, because the
            // config directory needs an `AppHandle` and the builder has none
            // yet. A position somebody dragged a window to has to survive a
            // restart, or "the user always wins" means "until Noctis restarts".
            #[cfg(windows)]
            windows_commands::restore_overrides(&handle);

            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                let window = window.as_ref().window();

                restore_placement(&window);
                // Write the first run's placement immediately rather than
                // waiting for a move: a window nobody has dragged yet still has
                // a position worth keeping across a crash.
                save_placement(&window, true);
            }

            build_tray(&handle)?;

            // Off by default. A canary run has no installer, and a development
            // build claiming the scheme system-wide is a side effect nobody
            // asked for; the ops guide says how to turn it on and off.
            if std::env::var(REGISTER_SCHEME_VAR).is_ok_and(|value| value == "true") {
                if let Err(error) = app.deep_link().register_all() {
                    eprintln!("noctis: could not register the noctis:// scheme: {error}");
                }
            }

            // `on_open_url` covers links that arrive while the shell is already
            // running. A cold start carrying one is not an event at all — it is
            // a command line, and only this asks for it.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    if let Some(link) = deeplink::parse(url.as_str()) {
                        emit_deep_link(&handle, &link);
                    }
                }
            }

            let deep_link_handle = handle.clone();

            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    match deeplink::parse(url.as_str()) {
                        Some(link) => emit_deep_link(&deep_link_handle, &link),
                        None => eprintln!("noctis: refused a deep link this build does not serve"),
                    }
                }
            });

            // A shortcut another application already owns is not a reason to
            // refuse to start.
            let toggle = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyN);

            if let Err(error) =
                app.global_shortcut()
                    .on_shortcut(toggle, |app, _shortcut, event| {
                        if event.state == ShortcutState::Pressed {
                            toggle_main(app);
                        }
                    })
            {
                eprintln!("noctis: could not register the global shortcut: {error}");
            }

            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => save_placement(window, false),
            WindowEvent::CloseRequested { api, .. } => {
                save_placement(window, true);
                // The tray is the way back, and the way out.
                api.prevent_close();
                let _ = window.hide();
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("Noctis desktop shell failed to start");
}

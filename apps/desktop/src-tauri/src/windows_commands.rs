//! The Tauri commands that place native windows.
//!
//! Thin on purpose. Every rule about whether a window may be moved is in
//! `noctis-windows`, every rule about whether the core said so is in
//! `window_authority`, and what is left here is the order the two are asked in.
//!
//! That order is the design. Section 11.2's rules are all satisfied *before* the
//! core is asked anything: a window that is protected, ungranted, or ambiguous
//! never becomes an authority request, so the Approval Surface is never shown a
//! consequence Noctis could not have carried out anyway.

#![cfg(windows)]

use noctis_windows::win32;
use noctis_windows::{
    make_room, moved_by_hand, resolve, select_window, Placement, PlacementRequest, Selection,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};

use crate::placement;
use crate::proxy;
use crate::proxy::ProxyResponse;
use crate::window_authority::{authorises, execute_body, request_body, PLACE_CAPABILITY};
use crate::windows_state::{
    display_name, granted_targets, minimum_dip, stamp_launches, Moved, NativeWindows, PlaceIntent,
    MOVED_FILE, OVERRIDES_FILE,
};
use crate::{CoreState, MAIN_WINDOW};

/// One of several windows a target matched, as much of it as a person choosing
/// between them needs.
///
/// Not the whole `WindowIdentity`: this ends up in a Surface payload, and a
/// Surface payload is persisted. Storing every candidate's executable path in
/// the database to render a list of two titles is data kept for no reader.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub handle: u64,
    pub title: String,
}

/// What a placement attempt produced.
///
/// A single tagged type rather than `Result<Placement, String>`, because several
/// of these are ordinary answers rather than errors. "Two editors are open,
/// which did you mean" is a question, and a UI that received it as an error
/// string would have to parse prose to know it could ask.
///
/// Tagged `kind`, not `outcome`: `NeedsApproval` carries the *authority's*
/// outcome, and one field cannot honestly be both which answer this is and what
/// the core decided.
///
/// `rename_all_fields` as well as `rename_all`, because they do different jobs
/// and only having the first is a bug that hides: `rename_all` renames the
/// *variants*, so without the second the fields go out as `monitor_id` while
/// `NativeApplicationStateSchema` expects `monitorId`, the payload fails its
/// schema, and the Surface silently renders a fallback.
#[derive(Debug, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum PlaceOutcome {
    /// Moved, and here is what it cost and what it looked like before.
    Placed {
        placement: noctis_windows::Placement,
        previous: noctis_windows::Placement,
        monitor_id: String,
        notes: Vec<noctis_windows::ResolutionNote>,
        elapsed_ms: u64,
        request_id: String,
    },
    /// The core wants a person to decide. The Approval Surface renders this and
    /// calls back with the same `requestId` once it is confirmed.
    NeedsApproval {
        request_id: String,
        outcome: String,
        consequence_summary: String,
        confirmation_phrase: Option<String>,
    },
    /// Put back where it was before Noctis moved it.
    Restored {
        placement: noctis_windows::Placement,
        application_id: String,
    },
    /// Found, and not arranged. The state a Place action is offered from.
    Discovered { window_title: String, handle: u64 },
    /// More than one window matched. Carries the candidates so the caller can ask.
    Ambiguous { candidates: Vec<Candidate> },
    /// The application is not running, or has no placeable window.
    NotRunning,
    /// Section 11.2's "degrade to an instruction/open-only handoff when control
    /// is unsupported". A reason, never a silent no-op.
    Refused { reason: String },
}

async fn post(
    core: &CoreState,
    client: &reqwest::Client,
    path: &str,
    body: Option<&Value>,
) -> Result<ProxyResponse, String> {
    let config = core.get()?;
    let request = proxy::build_request(client, config, "POST", path, body)
        .map_err(|error| error.to_string())?;
    let response = client
        .execute(request)
        .await
        .map_err(|error| proxy::ProxyError::Unreachable(error.to_string()).to_string())?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|error| error.to_string())?;

    eprintln!("noctis: proxied POST {path} -> {status}");

    Ok(ProxyResponse { status, body })
}

async fn get_json(core: &CoreState, client: &reqwest::Client, path: &str) -> Result<Value, String> {
    let config = core.get()?;
    let request =
        proxy::build_request(client, config, "GET", path, None).map_err(|e| e.to_string())?;
    let response = client
        .execute(request)
        .await
        .map_err(|error| proxy::ProxyError::Unreachable(error.to_string()).to_string())?;
    let body = response.text().await.map_err(|error| error.to_string())?;

    serde_json::from_str(&body).map_err(|error| error.to_string())
}

/// How far a window may drift from where Noctis put it before that counts as
/// somebody having moved it.
///
/// Wider than the placement tolerance on purpose. An application that adjusts
/// its own size a moment after being placed has not expressed a preference, and
/// mistaking that for one would hand every window an override nobody asked for —
/// which is the failure mode that makes "the user always wins" unusable rather
/// than respectful.
const HAND_TOLERANCE: i32 = 4;

/// Moves Noctis's own window out from in front of what was just arranged.
///
/// Section 11.2's "compose Noctis with native windows without covering critical
/// controls". Focus mode's layout has always put the tools on one display and
/// Noctis on another; this is Noctis actually going there.
///
/// No authority is asked for, and that is not an oversight. Moving another
/// application's window is a consequence somebody has to agree to; moving
/// Noctis's own window is Noctis rearranging its own interface, which is what
/// the crash-safe placement restore has always done without asking.
///
/// Only when it would otherwise be covering: a person who has put Noctis where
/// they want it should not have it relocated by a placement it was never in the
/// way of.
fn compose_around(app: &AppHandle, placed: Placement, displays: &[noctis_windows::Monitor]) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };

    let Some(current) = current_own_placement(&window) else {
        return;
    };

    let Some(destination) = make_room(&current, &placed, displays) else {
        return;
    };

    // Before the move, not after. A maximized window ignores a position, so
    // setting one first would silently do nothing and leave Noctis on top.
    if current.maximized {
        let _ = window.unmaximize();
    }

    let _ = window.set_position(tauri::PhysicalPosition {
        x: destination.x,
        y: destination.y,
    });
    let _ = window.set_size(tauri::PhysicalSize {
        width: destination.width,
        height: destination.height,
    });
}

/// Noctis's own window as a `Placement`.
///
/// The *outer* size here, unlike the saved placement, which stores the inner
/// one: this is compared against another window's outer rectangle to decide
/// whether they overlap, and comparing an inner size to an outer one would miss
/// the frame.
fn current_own_placement(window: &tauri::WebviewWindow) -> Option<Placement> {
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;

    Some(Placement {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: window.is_maximized().ok()?,
    })
}

/// Where the overrides file lives, beside the shell's own window placement.
fn overrides_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(OVERRIDES_FILE)
}

/// Loads the overrides a previous run wrote into the managed state.
///
/// Called once from `setup`, which is the first point an `AppHandle` exists. A
/// file that cannot be read is treated as no overrides: a corrupt preferences
/// file should cost somebody their preferences, not their editor.
pub fn restore_overrides(app: &AppHandle) {
    // `state` borrows from `app`, so it is used within this statement rather
    // than bound first — the `let Some(..) else` form would drop the guard while
    // the lock still borrowed it.
    let Some(state) = app.try_state::<NativeWindows>() else {
        return;
    };

    if let Some(saved) = placement::load::<HashMap<String, Placement>>(&overrides_path(app)) {
        if let Ok(mut held) = state.overrides.lock() {
            *held = saved;
        }
    }

    // Keyed by window handle, which JSON can only spell as a string. Anything
    // that does not parse back to a handle is dropped rather than guessed at.
    if let Some(saved) = placement::load::<HashMap<String, Moved>>(&moved_path(app)) {
        if let Ok(mut held) = state.moved.lock() {
            *held = saved
                .into_iter()
                .filter_map(|(handle, entry)| handle.parse::<u64>().ok().map(|key| (key, entry)))
                .collect();
        }
    }
}

fn moved_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(MOVED_FILE)
}

/// Writes the moved-window records out.
///
/// Without this, "put it back" worked until the shell was restarted and then
/// reported the window as not running — a window Noctis moved and can no longer
/// return is worse than one it never moved.
fn remember_moved(app: &AppHandle, native: &NativeWindows) {
    let snapshot: HashMap<String, Moved> = match native.moved.lock() {
        Ok(held) => held
            .iter()
            .map(|(handle, entry)| (handle.to_string(), entry.clone()))
            .collect(),
        Err(_) => return,
    };

    if let Err(error) = placement::save(&moved_path(app), &snapshot) {
        eprintln!("noctis: could not save the moved-window records: {error}");
    }
}

fn remember_override(
    app: AppHandle,
    native: &NativeWindows,
    application_id: &str,
    position: Placement,
) -> Result<(), String> {
    let snapshot = {
        let mut held = native
            .overrides
            .lock()
            .map_err(|_| "user overrides are poisoned".to_owned())?;

        held.insert(application_id.to_owned(), position);
        held.clone()
    };

    if let Err(error) = placement::save(&overrides_path(&app), &snapshot) {
        // The override still applies for this session. Saying nothing would be
        // worse than a line in the log: the preference silently not surviving a
        // restart is exactly the failure this file exists to prevent.
        eprintln!("noctis: could not save the window overrides: {error}");
    }

    Ok(())
}

/// Forgets a person's position for one application, so the named region applies
/// again.
///
/// The way out. Without it, one drag would mean Noctis could never arrange that
/// window again — a preference with no undo is a trap rather than a preference.
/// No authority is asked for: this discards a preference and moves nothing.
#[tauri::command]
pub fn window_clear_override(
    app: AppHandle,
    native: State<'_, NativeWindows>,
    application_id: String,
) -> Result<(), String> {
    let snapshot = {
        let mut held = native
            .overrides
            .lock()
            .map_err(|_| "user overrides are poisoned".to_owned())?;

        held.remove(&application_id);
        held.clone()
    };

    if let Err(error) = placement::save(&overrides_path(&app), &snapshot) {
        eprintln!("noctis: could not save the window overrides: {error}");
    }

    Ok(())
}

/// One granted application and what Noctis can currently see of it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Surveyed {
    pub application_id: String,
    pub display_name: String,
    pub state: PlaceOutcome,
}

/// What is on screen, per application Noctis is allowed to arrange.
///
/// This is `window.discover`, and it reports per *target* rather than returning
/// a raw window list, because the grant list lives here. A page handed every
/// window on the machine would have to know which executables count as the
/// editor in order to say anything about it, and a grant list the page knows is
/// a grant list the page can disagree with.
///
/// `read_inspect`, which the baseline policy allows, so no approval is asked
/// for. It stays a named capability rather than an unnamed convenience so that
/// it can be refused later without inventing a concept.
#[tauri::command]
pub fn window_survey(native: State<'_, NativeWindows>) -> Result<Vec<Surveyed>, String> {
    let held = native
        .correlations
        .lock()
        .map_err(|_| "launch correlations are poisoned".to_owned())?
        .clone();

    let mut windows = win32::top_level_windows();
    // Discovery cannot prove what launched a process, so it reports none. This
    // is the caller filling that in for the processes Noctis started itself.
    stamp_launches(&mut windows, &held);

    Ok(granted_targets()
        .iter()
        .map(|target| Surveyed {
            application_id: target.id.clone(),
            display_name: display_name(&target.id).to_owned(),
            state: match select_window(
                &windows,
                target,
                held.get(&target.id)
                    .map(|launch| launch.correlation_id.as_str()),
            ) {
                Selection::One(window, _) => PlaceOutcome::Discovered {
                    window_title: window.title.clone(),
                    handle: window.handle,
                },
                Selection::Ambiguous(candidates) => PlaceOutcome::Ambiguous {
                    candidates: candidates
                        .into_iter()
                        .map(|window| Candidate {
                            handle: window.handle,
                            title: window.title.clone(),
                        })
                        .collect(),
                },
                Selection::Absent => PlaceOutcome::NotRunning,
            },
        })
        .collect())
}

/// Places one application's window in a named region.
///
/// Called twice in the confirmation case: once without an `approval_id` to get
/// the decision, and once with it after the Approval Surface has been confirmed
/// through the ordinary core route.
#[tauri::command]
pub async fn window_place(
    app: AppHandle,
    core: State<'_, CoreState>,
    client: State<'_, reqwest::Client>,
    native: State<'_, NativeWindows>,
    intent: PlaceIntent,
    approval_id: Option<String>,
    title_hint: Option<String>,
) -> Result<PlaceOutcome, String> {
    // Before Win32 and before the core: a machine whose coordinates are
    // virtualized cannot be placed on, and finding that out after moving a
    // window is finding out too late.
    if !win32::is_per_monitor_dpi_aware() {
        return Ok(PlaceOutcome::Refused {
            reason: "This process is not per-monitor DPI aware, so window coordinates \
                     cannot be trusted. Placement is disabled rather than approximate."
                .to_owned(),
        });
    }

    let targets = granted_targets();
    let Some(target) = targets.iter().find(|t| t.id == intent.application_id) else {
        return Ok(PlaceOutcome::Refused {
            reason: format!(
                "{} is not an application Noctis may arrange",
                intent.application_id
            ),
        });
    };

    let launches = native
        .correlations
        .lock()
        .map_err(|_| "launch correlations are poisoned".to_owned())?
        .clone();
    let correlation = launches
        .get(&intent.application_id)
        .map(|launch| launch.correlation_id.clone());

    let mut windows = win32::top_level_windows();
    stamp_launches(&mut windows, &launches);

    let selection = select_window(&windows, target, correlation.as_deref())
        .narrow_by_title(title_hint.as_deref().unwrap_or_default());

    let (window, match_evidence) = match selection {
        Selection::One(window, evidence) => (window, evidence),
        Selection::Ambiguous(candidates) => {
            return Ok(PlaceOutcome::Ambiguous {
                candidates: candidates
                    .into_iter()
                    .map(|window| Candidate {
                        handle: window.handle,
                        title: window.title.clone(),
                    })
                    .collect(),
            })
        }
        Selection::Absent => return Ok(PlaceOutcome::NotRunning),
    };

    // The core is asked only now, when there is a real window and Noctis could
    // actually carry the consequence out.
    let request_id = match approval_id {
        Some(id) => {
            let approval = get_json(&core, &client, &format!("/approvals/{id}")).await?;

            if let Err(denied) = authorises(&approval, PLACE_CAPABILITY, &intent.application_id) {
                return Ok(PlaceOutcome::Refused {
                    reason: denied.to_string(),
                });
            }

            id
        }
        None => {
            let body = request_body(&intent, &new_key(), &window.title);
            let response = post(&core, &client, "/commands/authority.request", Some(&body)).await?;
            let decision: Value =
                serde_json::from_str(&response.body).map_err(|e| e.to_string())?;

            let outcome = decision
                .get("outcome")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("The core did not decide: {}", response.body))?;
            let request_id = decision
                .get("requestId")
                .and_then(Value::as_str)
                .ok_or("The core's decision named no request")?
                .to_owned();

            if outcome != "allow" {
                return Ok(PlaceOutcome::NeedsApproval {
                    request_id,
                    outcome: outcome.to_owned(),
                    consequence_summary: body["consequenceSummary"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned(),
                    confirmation_phrase: decision
                        .get("confirmationPhrase")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                });
            }

            request_id
        }
    };

    let Some(saved) = win32::capture(window.handle) else {
        return Ok(PlaceOutcome::Refused {
            reason: "The window's placement could not be read, so it cannot be put back".to_owned(),
        });
    };
    let previous = saved.placement();

    // The user always wins.
    //
    // If Noctis placed this window before and it is no longer where Noctis left
    // it, somebody moved it, and that position becomes their standing preference
    // for this application — now and after a restart. Noticed here rather than
    // by a hook because this is the only moment the answer changes anything, and
    // a global window hook to learn it would be a permanent cost for one
    // question asked occasionally.
    let dragged = native
        .moved
        .lock()
        .map_err(|_| "moved windows are poisoned".to_owned())?
        .get(&window.handle)
        .filter(|entry| entry.application_id == intent.application_id)
        .filter(|entry| moved_by_hand(&entry.applied, &previous, HAND_TOLERANCE))
        .map(|_| previous);

    if let Some(position) = dragged {
        remember_override(app.clone(), &native, &intent.application_id, position)?;
    }

    let user_override = native
        .overrides
        .lock()
        .map_err(|_| "user overrides are poisoned".to_owned())?
        .get(&intent.application_id)
        .copied();

    let displays = win32::monitors();
    let Some(resolution) = resolve(
        PlacementRequest {
            monitor: intent.monitor,
            region: intent.region,
            minimum_dip: minimum_dip(&intent.application_id),
        },
        &displays,
        user_override,
    ) else {
        return Ok(PlaceOutcome::Refused {
            reason: "No display to place on".to_owned(),
        });
    };

    // The move happens before the execution is recorded, deliberately. Phase 8's
    // gate says a status may not claim completion until evidence verifies it, and
    // the only evidence that a window moved is the window having moved. The race
    // this leaves — two callers both authorised, both moving — is harmless for
    // exactly this operation class: the second move writes the same rectangle.
    // It would be the wrong order for a spend.
    let applied = match win32::apply(window.handle, resolution.placement) {
        Ok(applied) => applied,
        Err(error) => {
            return Ok(PlaceOutcome::Refused {
                reason: describe(&error),
            })
        }
    };

    // After the move, so the decision is made against where the window really
    // ended up rather than where it was asked to go.
    compose_around(&app, applied.placement, &displays);

    let evidence = json!({
        "applicationId": intent.application_id,
        "handle": window.handle,
        "identity": window,
        "match": match_evidence,
        "previous": previous,
        "applied": applied.placement,
        "monitorId": resolution.monitor_id,
        "notes": resolution.notes,
        "elapsedMs": applied.elapsed_ms,
    });

    let execute = execute_body(&request_id, &new_key(), evidence);
    let response = post(
        &core,
        &client,
        "/commands/authority.execute",
        Some(&execute),
    )
    .await?;

    if response.status != 200 {
        // The window did move. Saying otherwise would be the dishonesty this
        // whole boundary exists to prevent, so the move is reported and the
        // recording failure is reported with it.
        eprintln!(
            "noctis: window moved but the execution could not be recorded: {}",
            response.body
        );
    }

    native
        .moved
        .lock()
        .map_err(|_| "moved windows are poisoned".to_owned())?
        .insert(
            window.handle,
            Moved {
                application_id: intent.application_id.clone(),
                applied: applied.placement,
                saved,
                identity: window.clone(),
            },
        );

    remember_moved(&app, &native);

    Ok(PlaceOutcome::Placed {
        placement: applied.placement,
        previous,
        monitor_id: resolution.monitor_id,
        notes: resolution.notes,
        elapsed_ms: applied.elapsed_ms,
        request_id,
    })
}

/// Puts back a window Noctis moved.
///
/// Section 11.2: "restore only windows Noctis moved and only when their identity
/// still matches". The first half is the map; the second is the comparison
/// below, which exists because Windows reuses a handle once its window is gone.
///
/// No approval, deliberately, and this is the one place that deserves arguing
/// rather than asserting. Restore can only reach a window already in the map,
/// which means a placement the core approved put it there, and it can only put
/// that window back where it was. The approval that authorised the move declared
/// `reversibility: "reversible"`, and reversing is what that word promised — so a
/// second consent for the undo would be consent theatre, and worse, it would
/// make the undo the step most likely to be refused or forgotten. The map
/// membership is the authorisation, which is a stronger guarantee than an
/// optional check a caller can decline to pass.
#[tauri::command]
pub fn window_restore(
    app: AppHandle,
    native: State<'_, NativeWindows>,
    application_id: String,
) -> Result<PlaceOutcome, String> {
    let live = win32::top_level_windows();
    let outcome = restore_locked(&native, &live, application_id)?;

    // Outside the lock `restore_locked` holds, because writing the file takes
    // it again to snapshot the map.
    remember_moved(&app, &native);

    Ok(outcome)
}

fn restore_locked(
    native: &NativeWindows,
    live: &[noctis_windows::WindowIdentity],
    application_id: String,
) -> Result<PlaceOutcome, String> {
    let mut held = native
        .moved
        .lock()
        .map_err(|_| "moved windows are poisoned".to_owned())?;

    let Some(handle) = held
        .iter()
        .find(|(handle, entry)| {
            entry.application_id == application_id
                && live.iter().any(|window| {
                    window.handle == **handle
                    // Identity, not just the handle. A recycled handle belonging
                    // to a different process is a different window wearing the
                    // same number.
                    && window.process_id == entry.identity.process_id
                    && window.class_name == entry.identity.class_name
                })
        })
        .map(|(handle, _)| *handle)
    else {
        return Ok(PlaceOutcome::NotRunning);
    };

    let entry = held.remove(&handle).expect("just found");

    match win32::restore(handle, &entry.saved) {
        Ok(()) => Ok(PlaceOutcome::Restored {
            placement: entry.saved.placement(),
            application_id,
        }),
        Err(error) => {
            // Put it back in the map. A restore that failed is still a window
            // Noctis moved, and dropping the record would strand it.
            held.insert(handle, entry);

            Ok(PlaceOutcome::Refused {
                reason: describe(&error),
            })
        }
    }
}

fn describe(error: &win32::PlacementError) -> String {
    match error {
        win32::PlacementError::Gone => "The window closed before it could be moved".to_owned(),
        win32::PlacementError::NotResponding => {
            "The application is not responding, so Noctis left it alone".to_owned()
        }
        win32::PlacementError::Refused { code } => format!(
            "Windows refused the move (error {code}). This is usually a window \
             owned by a process running with higher privileges than Noctis."
        ),
        win32::PlacementError::NotHonoured { asked, got } => format!(
            "The application kept its own position: asked for {},{} and it stayed at {},{}",
            asked.x, asked.y, got.x, got.y
        ),
    }
}

/// An idempotency key for one command.
///
/// The core requires one per command, and these are single-shot: the retry story
/// for a placement is to ask again and get a new decision, not to replay an old
/// one against a window that has since moved.
fn new_key() -> String {
    format!(
        "window-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn describes_every_placement_failure_in_words_rather_than_a_code() {
        let failures = [
            win32::PlacementError::Gone,
            win32::PlacementError::NotResponding,
            win32::PlacementError::Refused { code: 5 },
            win32::PlacementError::NotHonoured {
                asked: noctis_windows::Placement {
                    x: 0,
                    y: 0,
                    width: 100,
                    height: 100,
                    maximized: false,
                },
                got: noctis_windows::Placement {
                    x: 50,
                    y: 50,
                    width: 100,
                    height: 100,
                    maximized: false,
                },
            },
        ];

        for failure in &failures {
            let described = describe(failure);

            assert!(described.len() > 20, "{described} is not an explanation");
            assert!(described.chars().next().is_some_and(char::is_uppercase));
        }
    }

    /// Two placements in the same process must not collide, or the core's
    /// idempotency guard turns the second one into a replay of the first.
    #[test]
    fn issues_a_different_idempotency_key_each_time() {
        let keys: std::collections::HashSet<String> = (0..50).map(|_| new_key()).collect();

        assert_eq!(keys.len(), 50);
    }

    /// THE GATE: these field names are the wire contract with
    /// `NativeApplicationStateSchema`, which is `.strict()`. A snake_case field
    /// here is not a compile error and not a runtime error — it is a Surface
    /// that quietly renders a fallback, which is the worst of the three.
    #[test]
    fn spells_every_field_the_way_the_surface_schema_reads_it() {
        let placed = serde_json::to_value(PlaceOutcome::Placed {
            placement: noctis_windows::Placement {
                x: 0,
                y: 0,
                width: 100,
                height: 100,
                maximized: false,
            },
            previous: noctis_windows::Placement {
                x: 1,
                y: 1,
                width: 100,
                height: 100,
                maximized: false,
            },
            monitor_id: r"\\.\DISPLAY1".to_owned(),
            notes: vec![noctis_windows::ResolutionNote::DegradedToPrimary],
            elapsed_ms: 29,
            request_id: "req-1".to_owned(),
        })
        .expect("json");

        assert_eq!(placed["kind"], "placed");
        assert_eq!(placed["monitorId"], r"\\.\DISPLAY1");
        assert_eq!(placed["elapsedMs"], 29);
        assert_eq!(placed["requestId"], "req-1");
        assert!(placed.get("monitor_id").is_none(), "snake_case leaked");
        assert!(placed.get("elapsed_ms").is_none(), "snake_case leaked");
        // The note spelling is the crate's serde, and it must stay snake_case
        // because `ResolutionNoteSchema` is an enum of snake_case strings.
        assert_eq!(placed["notes"][0], "degraded_to_primary");

        let approval = serde_json::to_value(PlaceOutcome::NeedsApproval {
            request_id: "req-2".to_owned(),
            outcome: "require_confirmation".to_owned(),
            consequence_summary: "Move vscode".to_owned(),
            confirmation_phrase: None,
        })
        .expect("json");

        assert_eq!(approval["kind"], "needsApproval");
        assert_eq!(approval["requestId"], "req-2");
        assert_eq!(approval["consequenceSummary"], "Move vscode");

        let restored = serde_json::to_value(PlaceOutcome::Restored {
            placement: noctis_windows::Placement {
                x: 15,
                y: 65,
                width: 491,
                height: 437,
                maximized: false,
            },
            application_id: "vscode".to_owned(),
        })
        .expect("json");

        assert_eq!(restored["kind"], "restored");
        assert_eq!(restored["applicationId"], "vscode");
    }

    /// The outcome is a tagged union on the wire, because a caller has to tell
    /// "ask the user" apart from "it moved" without reading prose.
    #[test]
    fn tags_every_outcome_for_the_caller() {
        let ambiguous =
            serde_json::to_value(PlaceOutcome::Ambiguous { candidates: vec![] }).expect("json");
        let refused = serde_json::to_value(PlaceOutcome::Refused {
            reason: "no".to_owned(),
        })
        .expect("json");

        assert_eq!(ambiguous["kind"], "ambiguous");
        assert_eq!(refused["kind"], "refused");
        assert_eq!(
            serde_json::to_value(PlaceOutcome::NotRunning).expect("json")["kind"],
            "notRunning"
        );
    }
}

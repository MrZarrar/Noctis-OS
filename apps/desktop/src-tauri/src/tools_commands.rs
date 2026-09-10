//! The Tauri commands that reach specialist tools.
//!
//! Thin, in the order `windows_commands` is thin: every rule about what a tool
//! offers is in `tool_registry`, every rule about whether the core said so is in
//! `tool_authority`, and what is left here is the order the two are asked in.
//!
//! The order is the design, and it is the same one Phase 9 settled on. A route
//! the tool does not declare, a verb it does not have, and a route this machine
//! cannot reach are all refused *before* the core is asked anything — so the
//! Approval Surface is never shown a consequence Noctis could not carry out.

#![cfg(windows)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::proxy;
use crate::proxy::ProxyResponse;
use crate::tool_authority::{admits, authorises, execute_body, request_body};
use crate::tool_registry::{
    load, origin_allows, resolve_executable, tools_path, ToolDescriptor, ToolRoute,
};
use crate::windows_state::{Launch, NativeWindows};
use crate::CoreState;

/// What the page asks for.
///
/// Note what it cannot carry: no URL, no executable, no arguments. A caller
/// names a tool and a verb, and the descriptor supplies everything else — which
/// is what makes the descriptor an allowlist rather than advice, and is the same
/// rule `PlaceIntent` enforces by having nowhere to put a coordinate.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolIntent {
    pub tool_id: String,
    #[serde(default)]
    pub verb_id: String,
    /// The Objective this is part of, when there is one. Section 9.1 lets a
    /// reversible local edit proceed without asking while an Objective is
    /// active, and the core decides that by looking the Objective up.
    #[serde(default)]
    pub objective_id: Option<String>,
}

/// Whether a route can be taken on this machine right now.
///
/// A reason rather than a bare `false`: "not installed" and "not built yet" send
/// a person to different places.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteAvailability {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl RouteAvailability {
    fn yes() -> Self {
        Self {
            available: true,
            reason: None,
        }
    }

    fn no(reason: impl Into<String>) -> Self {
        Self {
            available: false,
            reason: Some(reason.into()),
        }
    }
}

/// A verb as the page is allowed to see it.
///
/// The arguments are absent, deliberately. A page that knew a verb's argument
/// list would be a page that could propose a different one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurveyedVerb {
    pub id: String,
    pub label: String,
    pub operation_class: String,
}

/// One tool, as much of it as the router needs and no more.
///
/// No executable path, no URL, no origin allowlist. This is Phase 9's
/// `window_survey` lesson a layer up: report per target, never hand the page the
/// grant list, because a grant list the page holds is one it can disagree with.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurveyedTool {
    pub tool_id: String,
    pub display_name: String,
    pub declared_routes: Vec<String>,
    pub verbs: Vec<SurveyedVerb>,
    pub availability: HashMap<String, RouteAvailability>,
    /// The terminal fallback's content, so a degraded Surface has something to
    /// say without a second round trip.
    pub manual_steps: Vec<String>,
}

/// What reaching a tool produced.
///
/// The variant names match `ExternalToolStateSchema`, so the bridge passes an
/// outcome through rather than translating it — a translation layer between two
/// enums is where the two drift apart.
///
/// `rename_all_fields` as well as `rename_all`: the first renames the variants
/// and the second the struct-variant fields. Missing the second sends
/// `launch_correlation_id` where the contract expects `launchCorrelationId`,
/// which fails no Rust test and renders a fallback in the page.
#[derive(Debug, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum ToolOutcome {
    Launched {
        process_id: u32,
        launch_correlation_id: String,
    },
    Ran {
        exit_code: i32,
        output: String,
    },
    /// Opened in the person's own browser. Section 9.1's preparation boundary:
    /// the page is on screen and Noctis stopped there.
    HandedOff {
        url: String,
    },
    /// The terminal fallback. Always reachable, which is what makes degradation
    /// safe rather than a branch somebody remembered.
    Instructions {
        steps: Vec<String>,
    },
    NeedsApproval {
        request_id: String,
        outcome: String,
        consequence_summary: String,
        confirmation_phrase: Option<String>,
    },
    /// The route is legitimate and cannot run here. Distinct from `Refused`,
    /// because this is about the machine rather than about permission.
    RouteUnavailable {
        route: String,
        reason: String,
    },
    Refused {
        reason: String,
    },
}

fn config_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// The descriptors, read from disk on every call.
///
/// Deliberately not cached in managed state. The file is small, these commands
/// are user-initiated, and reading it each time means editing `tools.json` takes
/// effect without restarting Noctis — which is most of what makes a tool a row
/// rather than a code change.
fn descriptors(app: &AppHandle) -> Vec<ToolDescriptor> {
    load(&tools_path(&config_dir(app)))
}

/// Whether each route a tool declares can actually be taken here.
///
/// Answered by the shell because the shell is the only thing that knows: whether
/// a program is installed is not something a page can be told and then trusted
/// about.
fn availability(descriptor: &ToolDescriptor) -> HashMap<String, RouteAvailability> {
    let path_var = std::env::var("PATH").ok();
    let pathext = std::env::var("PATHEXT").ok();

    descriptor
        .routes
        .iter()
        .map(|route| {
            let answer = match route {
                ToolRoute::OfficialCli { executable, .. } => {
                    match resolve_executable(executable, path_var.as_deref(), pathext.as_deref()) {
                        Some(_) => RouteAvailability::yes(),
                        // Named by the tool rather than by its executable. This
                        // string reaches a persisted Surface payload, and a
                        // reason that named the binary would put a fact about
                        // the grant list somewhere the page can read it back —
                        // besides which "Visual Studio Code is not installed" is
                        // what a person reading it actually wants to know.
                        None => RouteAvailability::no(format!(
                            "{} is not installed here",
                            descriptor.display_name
                        )),
                    }
                }
                // Not built this phase, and said so rather than reported as a
                // failure at execution time. The router skips it, so no grant is
                // ever spent on a route that cannot run.
                ToolRoute::IsolatedBrowser { .. } => RouteAvailability::no(
                    "Noctis has no isolated browser executor yet, so it was passed over.",
                ),
                ToolRoute::VisibleHandoff { .. } => RouteAvailability::yes(),
                ToolRoute::Manual { .. } => RouteAvailability::yes(),
            };

            (route.name().to_owned(), answer)
        })
        .collect()
}

/// What tools Noctis can reach, and how.
///
/// `read_inspect`, which the baseline policy allows, so no approval is asked
/// for. It stays a named capability rather than an unnamed convenience so that
/// it can be refused later without inventing a concept.
#[tauri::command]
pub fn tool_survey(app: AppHandle) -> Result<Vec<SurveyedTool>, String> {
    Ok(descriptors(&app)
        .into_iter()
        .map(|descriptor| SurveyedTool {
            tool_id: descriptor.id.clone(),
            display_name: descriptor.display_name.clone(),
            declared_routes: descriptor
                .routes
                .iter()
                .map(|r| r.name().to_owned())
                .collect(),
            verbs: descriptor
                .verbs()
                .iter()
                .map(|verb| SurveyedVerb {
                    id: verb.id.clone(),
                    label: verb.label.clone(),
                    operation_class: verb.operation_class.clone(),
                })
                .collect(),
            availability: availability(&descriptor),
            manual_steps: descriptor.manual_steps(),
        })
        .collect())
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

/// How much of a command's output is kept.
///
/// Section 9.2 forbids unbounded bodies in logs and evidence, and a build log is
/// exactly the thing that would otherwise arrive in megabytes.
const OUTPUT_LIMIT: usize = 4000;

fn trim_output(raw: &str) -> String {
    if raw.len() <= OUTPUT_LIMIT {
        return raw.to_owned();
    }

    // The tail, not the head: a command that failed says why at the end.
    let start = raw.len().saturating_sub(OUTPUT_LIMIT);
    let boundary = (start..raw.len())
        .find(|index| raw.is_char_boundary(*index))
        .unwrap_or(raw.len());

    format!("…{}", &raw[boundary..])
}

/// Reaches one tool by one route.
///
/// Called twice in the confirmation case: once without an `approval_id` to get
/// the decision, and once with it after the Approval Surface has been confirmed
/// through the ordinary core route — the same two-step `window_place` uses.
#[tauri::command]
pub async fn tool_execute(
    app: AppHandle,
    core: State<'_, CoreState>,
    client: State<'_, reqwest::Client>,
    native: State<'_, NativeWindows>,
    intent: ToolIntent,
    route: String,
    approval_id: Option<String>,
) -> Result<ToolOutcome, String> {
    let tools = descriptors(&app);
    let Some(descriptor) = tools.iter().find(|tool| tool.id == intent.tool_id) else {
        return Ok(ToolOutcome::Refused {
            reason: format!("{} is not a tool Noctis knows", intent.tool_id),
        });
    };

    // The descriptor is the allowlist, and this is where the page's word is
    // checked against it. Before the core is asked anything.
    let (capability, verb) = match admits(descriptor, &route, &intent.verb_id) {
        Ok(admitted) => admitted,
        Err(denied) => {
            return Ok(ToolOutcome::Refused {
                reason: denied.to_string(),
            })
        }
    };

    // Availability before authority, so a grant is never spent on a route that
    // cannot run. `manual` is absent from the map and is always available, which
    // is what makes the fallback total.
    if route != "manual" {
        if let Some(unavailable) = availability(descriptor)
            .get(&route)
            .filter(|answer| !answer.available)
        {
            return Ok(ToolOutcome::RouteUnavailable {
                route,
                reason: unavailable
                    .reason
                    .clone()
                    .unwrap_or_else(|| "unavailable".to_owned()),
            });
        }
    }

    let request_id = match approval_id {
        Some(id) => {
            let approval = get_json(&core, &client, &format!("/approvals/{id}")).await?;

            if let Err(denied) = authorises(&approval, capability, &descriptor.id) {
                return Ok(ToolOutcome::Refused {
                    reason: denied.to_string(),
                });
            }

            id
        }
        None => {
            let body = request_body(
                descriptor,
                &route,
                capability,
                verb,
                intent.objective_id.as_deref(),
                &new_key(),
            );
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
                return Ok(ToolOutcome::NeedsApproval {
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

    let started_at = now_iso();
    let clock = Instant::now();

    let (outcome, detail, session_kind) = match perform(descriptor, &route, &intent, &native) {
        Ok(performed) => performed,
        Err(reason) => return Ok(ToolOutcome::Refused { reason }),
    };

    let evidence = json!({
        "toolId": descriptor.id,
        "route": route,
        "capability": capability,
        // The host this actually happened on. Section 12.2 wants a reference to
        // name where it lives, and "the machine Noctis is running on" is not a
        // name somebody can check later.
        "hostId": host_id(),
        "sessionKind": session_kind,
        "startedAt": started_at,
        "elapsedMs": u64::try_from(clock.elapsed().as_millis()).unwrap_or(u64::MAX),
        "detail": detail,
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
        // It already happened. Saying otherwise would be the dishonesty this
        // whole boundary exists to prevent, so the act is reported and the
        // recording failure is reported with it.
        eprintln!(
            "noctis: tool route taken but the execution could not be recorded: {}",
            response.body
        );
    }

    Ok(outcome)
}

/// Actually take the route. Everything above this decided whether to.
///
/// Returns the outcome, the evidence detail, and which session it acted in —
/// the third being the field the separation between isolated automation and
/// existing-profile control exists to record.
fn perform(
    descriptor: &ToolDescriptor,
    route: &str,
    intent: &ToolIntent,
    native: &NativeWindows,
) -> Result<(ToolOutcome, Value, &'static str), String> {
    match descriptor.route(route) {
        Some(ToolRoute::OfficialCli {
            executable,
            detached,
            ..
        }) => {
            let verb = descriptor.verb(&intent.verb_id);
            let args: Vec<String> = verb.map(|verb| verb.args.clone()).unwrap_or_default();

            let Some(resolved) = resolve_executable(
                executable,
                std::env::var("PATH").ok().as_deref(),
                std::env::var("PATHEXT").ok().as_deref(),
            ) else {
                return Err(format!("{} is not installed here", descriptor.display_name));
            };

            // The resolved path, never the name. What gets started is what was
            // found a moment ago, rather than whatever `PATH` resolves to next.
            let mut command = std::process::Command::new(&resolved);
            command.args(&args);

            if *detached {
                let child = command
                    .spawn()
                    .map_err(|error| format!("{executable} would not start: {error}"))?;
                let process_id = child.id();
                let correlation_id = format!("launch-{}-{}", std::process::id(), process_id);

                // The map Phase 9 plumbed and never wrote to. This is the only
                // thing that ever writes it, which is why launching belongs with
                // tool routing rather than with window placement.
                native
                    .correlations
                    .lock()
                    .map_err(|_| "launch correlations are poisoned".to_owned())?
                    .insert(
                        descriptor.id.clone(),
                        Launch {
                            correlation_id: correlation_id.clone(),
                            process_id,
                        },
                    );

                Ok((
                    ToolOutcome::Launched {
                        process_id,
                        launch_correlation_id: correlation_id.clone(),
                    },
                    json!({
                        "kind": "launched",
                        "processId": process_id,
                        "launchCorrelationId": correlation_id,
                    }),
                    "none",
                ))
            } else {
                let finished = command
                    .output()
                    .map_err(|error| format!("{executable} would not run: {error}"))?;
                // `-1` for a process a signal ended rather than a status: the
                // evidence records that it did not exit normally rather than
                // claiming a code it never returned.
                let exit_code = finished.status.code().unwrap_or(-1);
                let mut output = String::from_utf8_lossy(&finished.stdout).into_owned();
                output.push_str(&String::from_utf8_lossy(&finished.stderr));
                let output = trim_output(&output);

                Ok((
                    ToolOutcome::Ran {
                        exit_code,
                        output: output.clone(),
                    },
                    json!({ "kind": "ran", "exitCode": exit_code, "output": output }),
                    "none",
                ))
            }
        }
        Some(ToolRoute::VisibleHandoff { url, origins }) => {
            // THE check that makes a per-tool grant narrow in fact rather than
            // in name. The descriptor was validated when it was loaded; this is
            // the executor refusing to be the one place that trusted it anyway.
            if !origin_allows(origins, url) {
                return Err(format!("{url} is outside what {} may open", descriptor.id));
            }

            open_in_default_browser(url)?;

            Ok((
                ToolOutcome::HandedOff {
                    url: url.to_owned(),
                },
                json!({ "kind": "opened", "url": url }),
                // The person's own browser, carrying their own sign-ins. Named
                // honestly, because this is the field the isolation grant exists
                // to ask about.
                "existing_profile",
            ))
        }
        Some(ToolRoute::IsolatedBrowser { .. }) => Err(
            "Noctis has no isolated browser executor yet, so this route cannot be taken."
                .to_owned(),
        ),
        // Either a declared manual route or no route at all. `manual_steps`
        // falls back to the tool's instructions, so this is never empty.
        _ => Ok((
            ToolOutcome::Instructions {
                steps: descriptor.manual_steps(),
            },
            json!({ "kind": "instructed" }),
            "none",
        )),
    }
}

/// Hands a URL to whatever the person has set as their browser.
///
/// `explorer.exe` rather than `cmd /c start`, because `start` goes through the
/// command interpreter and a URL containing `&` would be parsed rather than
/// opened. The argument is passed as a single argv entry, so there is no command
/// line for a URL to escape from — and the URL has already been checked against
/// the descriptor's origin allowlist before it gets here.
///
/// ponytail: `explorer.exe` rather than `ShellExecuteW`, so the shell crate does
/// not gain a `windows` dependency for one call. The upgrade is worth it if the
/// exit status ever has to mean something — explorer's does not.
fn open_in_default_browser(url: &str) -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("The browser would not open: {error}"))
}

/// Which machine this happened on.
fn host_id() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "desktop".to_owned())
}

fn now_iso() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = now.as_secs();
    let millis = now.subsec_millis();

    // Days since the epoch, converted with the civil-from-days algorithm rather
    // than by pulling in a date crate for one timestamp.
    let days = i64::try_from(seconds / 86_400).unwrap_or(0);
    let time = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);

    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        time / 3600,
        (time % 3600) / 60,
        time % 60
    )
}

/// Howard Hinnant's `civil_from_days`, which is the shortest correct way to turn
/// a day count into a date without a dependency.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };

    (
        if m <= 2 { y + 1 } else { y },
        u32::try_from(m).unwrap_or(1),
        u32::try_from(d).unwrap_or(1),
    )
}

/// An idempotency key for one command. Single-shot: the retry story for reaching
/// a tool is to ask again and get a new decision, not to replay an old one.
fn new_key() -> String {
    format!(
        "tool-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool_registry::{built_in, ToolVerb};

    fn cli(executable: &str, detached: bool) -> ToolDescriptor {
        ToolDescriptor {
            id: "editor".to_owned(),
            display_name: "Editor".to_owned(),
            instructions: "Open it yourself.".to_owned(),
            routes: vec![ToolRoute::OfficialCli {
                executable: executable.to_owned(),
                detached,
                verbs: vec![ToolVerb {
                    id: "open".to_owned(),
                    label: "Open".to_owned(),
                    args: Vec::new(),
                    operation_class: "local_reversible_edit".to_owned(),
                }],
            }],
        }
    }

    /// THE GATE: the isolated route is routed to and cannot be taken, and the
    /// router must learn that from availability rather than from a failure after
    /// a grant has been spent.
    #[test]
    fn reports_the_isolated_browser_route_as_unavailable_rather_than_absent() {
        let descriptor = ToolDescriptor {
            id: "suno".to_owned(),
            display_name: "Suno".to_owned(),
            instructions: "Open Suno.".to_owned(),
            routes: vec![ToolRoute::IsolatedBrowser {
                url: "https://suno.com/create".to_owned(),
                origins: vec!["https://suno.com".to_owned()],
            }],
        };

        let answers = availability(&descriptor);
        let isolated = answers.get("isolated_browser").expect("reported");

        assert!(!isolated.available);
        assert!(isolated
            .reason
            .as_deref()
            .expect("a reason")
            .contains("isolated browser"));
    }

    #[test]
    fn reports_a_command_route_as_unavailable_when_nothing_is_installed() {
        let answers = availability(&cli("noctis-definitely-not-installed", true));
        let command = answers.get("official_cli").expect("reported");

        assert!(!command.available);
        assert!(command
            .reason
            .as_deref()
            .expect("a reason")
            .contains("not installed"));
    }

    /// A handoff needs nothing installed: every Windows machine can open a URL.
    #[test]
    fn reports_a_handoff_as_available() {
        let descriptor = built_in()
            .into_iter()
            .find(|tool| tool.id == "vinted")
            .expect("a built-in handoff tool");

        assert!(availability(&descriptor)["visible_handoff"].available);
    }

    /// THE GATE: the survey is what the page sees, and it must not contain an
    /// executable path, a URL, or an origin. A page holding those could disagree
    /// with the allowlist rather than merely name a tool in it.
    #[test]
    fn tells_the_page_nothing_it_could_disagree_with() {
        for descriptor in built_in() {
            let surveyed = SurveyedTool {
                tool_id: descriptor.id.clone(),
                display_name: descriptor.display_name.clone(),
                declared_routes: descriptor
                    .routes
                    .iter()
                    .map(|r| r.name().to_owned())
                    .collect(),
                verbs: descriptor
                    .verbs()
                    .iter()
                    .map(|verb| SurveyedVerb {
                        id: verb.id.clone(),
                        label: verb.label.clone(),
                        operation_class: verb.operation_class.clone(),
                    })
                    .collect(),
                availability: availability(&descriptor),
                manual_steps: descriptor.manual_steps(),
            };

            let json = serde_json::to_string(&surveyed).expect("serialisable");

            assert!(
                !json.contains("https://"),
                "{} leaked a url: {json}",
                descriptor.id
            );
            assert!(
                !json.contains(".exe"),
                "{} leaked an executable: {json}",
                descriptor.id
            );
            assert!(
                !json.contains("origins"),
                "{} leaked origins: {json}",
                descriptor.id
            );
        }
    }

    /// THE GATE: `rename_all` renames variants, `rename_all_fields` renames
    /// struct-variant fields. Without the second the page receives
    /// `launch_correlation_id`, the payload fails its schema, and the Surface
    /// silently renders a fallback.
    #[test]
    fn spells_every_outcome_field_the_way_the_surface_schema_reads_it() {
        let launched = serde_json::to_string(&ToolOutcome::Launched {
            process_id: 4242,
            launch_correlation_id: "launch-7".to_owned(),
        })
        .expect("serialisable");

        assert!(launched.contains("\"kind\":\"launched\""), "{launched}");
        assert!(launched.contains("\"launchCorrelationId\""), "{launched}");
        assert!(!launched.contains("launch_correlation_id"), "{launched}");

        let unavailable = serde_json::to_string(&ToolOutcome::RouteUnavailable {
            route: "isolated_browser".to_owned(),
            reason: "not built".to_owned(),
        })
        .expect("serialisable");

        assert!(
            unavailable.contains("\"kind\":\"routeUnavailable\""),
            "{unavailable}"
        );
    }

    /// An availability answer must serialise the way the contract's
    /// discriminated union reads it: no `reason` key at all when available,
    /// rather than a `null` one that `.strict()` would refuse.
    #[test]
    fn omits_the_reason_entirely_when_a_route_is_available() {
        let yes = serde_json::to_string(&RouteAvailability::yes()).expect("serialisable");

        assert_eq!(yes, "{\"available\":true}");
    }

    /// An intent has nowhere to put a URL, an executable, or an argument, so a
    /// caller that sends one has it dropped rather than honoured.
    #[test]
    fn refuses_an_intent_that_tries_to_carry_a_url_or_a_command() {
        let smuggled = r#"{
            "toolId": "vinted",
            "verbId": "open",
            "url": "https://evil.example/",
            "executable": "cmd.exe",
            "args": ["/c", "calc"]
        }"#;

        let parsed: ToolIntent = serde_json::from_str(smuggled).expect("an intent");

        assert_eq!(parsed.tool_id, "vinted");
        assert_eq!(parsed.verb_id, "open");
    }

    /// Evidence and logs are bounded. A build log arriving in megabytes is
    /// exactly what Section 9.2 forbids, and the tail is the half that says why
    /// a command failed.
    #[test]
    fn keeps_the_end_of_an_output_too_long_to_record() {
        let long = "a".repeat(OUTPUT_LIMIT * 2) + "the actual error";
        let kept = trim_output(&long);

        assert!(kept.len() <= OUTPUT_LIMIT + 4);
        assert!(kept.ends_with("the actual error"));
        assert!(kept.starts_with('…'));
    }

    #[test]
    fn leaves_a_short_output_alone() {
        assert_eq!(trim_output("done"), "done");
    }

    /// A multi-byte character straddling the cut must not panic or produce
    /// invalid UTF-8.
    #[test]
    fn cuts_a_long_output_on_a_character_boundary() {
        let long = "é".repeat(OUTPUT_LIMIT);

        assert!(trim_output(&long).len() <= OUTPUT_LIMIT + 4);
    }

    #[test]
    fn writes_a_timestamp_the_core_will_accept() {
        let stamp = now_iso();

        assert_eq!(stamp.len(), 24, "{stamp}");
        assert!(stamp.ends_with('Z'), "{stamp}");
        assert_eq!(&stamp[4..5], "-");
        assert_eq!(&stamp[10..11], "T");
    }

    #[test]
    fn converts_days_to_dates_the_way_a_calendar_does() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // A leap day, which is where an off-by-one in the algorithm would show.
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
    }

    #[test]
    fn names_a_host_even_when_the_environment_does_not() {
        assert!(!host_id().is_empty());
    }
}

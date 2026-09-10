//! The boundary between "the WebView asked to reach a tool" and "the core said
//! it may".
//!
//! The same shape as `window_authority`, and for the same reason: the shell is
//! the only process that can start something, so it is the process that has to
//! satisfy itself the act was authorised. Asking the core is not enough on its
//! own, because the *answer* has to be checked against the tool actually about
//! to be reached.
//!
//! One thing here that `window_authority` does not need: the page also names a
//! **route**, and a route is a capability. So the route is re-derived from the
//! same table the router used and checked against the descriptor, rather than
//! being taken on the page's word.

use serde_json::{json, Value};

use crate::tool_registry::{ToolDescriptor, ToolVerb};

/// The `AuthorityTarget.type` every tool request carries, matching
/// `TOOL_TARGET_TYPE` in `@noctis/contracts`.
pub const TOOL_TARGET_TYPE: &str = "tool";

/// Which capability each route spends, matching `ROUTE_CAPABILITY`.
///
/// A total match over the four route names rather than a lookup that can miss:
/// an unknown route name returns `None` and is refused, so a page inventing one
/// gets a refusal instead of a default.
pub fn route_capability(route: &str) -> Option<&'static str> {
    match route {
        "official_cli" => Some("tool.run_command"),
        "isolated_browser" => Some("browser.automate_isolated"),
        "visible_handoff" => Some("browser.open_visible"),
        "manual" => Some("tool.inspect"),
        _ => None,
    }
}

/// The operation class of each capability, matching
/// `TOOL_CAPABILITY_OPERATION_CLASS`.
pub fn capability_operation_class(capability: &str) -> Option<&'static str> {
    match capability {
        "tool.inspect" => Some("read_inspect"),
        "tool.launch" => Some("local_reversible_edit"),
        "tool.run_command" => Some("external_write"),
        "browser.open_visible" => Some("local_reversible_edit"),
        "browser.automate_isolated" => Some("local_reversible_edit"),
        "browser.control_profile" => Some("external_write"),
        "tool.register_descriptor" => Some("credential_security"),
        _ => None,
    }
}

/// Severity, strictest last, matching `SEVERITY` in `packages/domain`.
fn severity(operation_class: &str) -> Option<u8> {
    match operation_class {
        "read_inspect" => Some(0),
        "local_reversible_edit" => Some(1),
        "external_write" => Some(2),
        "message_send" => Some(3),
        "publish" => Some(4),
        "spend" => Some(5),
        "destructive" => Some(6),
        "production_deploy" => Some(7),
        "credential_security" => Some(8),
        _ => None,
    }
}

/// The class of one act: the capability's floor, raised by the verb, never
/// lowered by it.
///
/// Derived here rather than taken from the request, which is the whole point. A
/// page that could name its own operation class could understate a publish as a
/// read, and the Approval Surface would faithfully render the understatement.
///
/// An unrecognised class from either side falls back to the floor rather than
/// being trusted: fail closed.
pub fn raised_operation_class(capability: &str, verb: Option<&ToolVerb>) -> Option<&'static str> {
    let floor = capability_operation_class(capability)?;
    let Some(verb) = verb else {
        return Some(floor);
    };

    let (Some(verb_rank), Some(floor_rank)) = (severity(&verb.operation_class), severity(floor))
    else {
        return Some(floor);
    };

    if verb_rank > floor_rank {
        // Returned as a `'static` string from the table rather than the verb's
        // own `String`, so the value that reaches the core is one of the nine
        // the enum names and never whatever a file happened to contain.
        severity_name(verb_rank)
    } else {
        Some(floor)
    }
}

fn severity_name(rank: u8) -> Option<&'static str> {
    match rank {
        0 => Some("read_inspect"),
        1 => Some("local_reversible_edit"),
        2 => Some("external_write"),
        3 => Some("message_send"),
        4 => Some("publish"),
        5 => Some("spend"),
        6 => Some("destructive"),
        7 => Some("production_deploy"),
        8 => Some("credential_security"),
        _ => None,
    }
}

/// Why an approval, or a request, does not authorise the act in hand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Denied {
    Unreadable,
    /// The page named a route this tool does not declare.
    RouteNotDeclared {
        route: String,
    },
    /// The page named a route that is not one of the four.
    UnknownRoute {
        route: String,
    },
    /// The page named a verb this tool does not declare.
    UnknownVerb {
        verb: String,
    },
    WrongCapability {
        found: String,
    },
    WrongTargetType {
        found: String,
    },
    /// THE interesting one: an approval for another tool.
    WrongTarget {
        approved: String,
        asked: String,
    },
    Denied,
    NotConfirmed,
    AlreadyExecuted,
}

impl std::fmt::Display for Denied {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreadable => write!(f, "The core's answer was not an approval"),
            Self::RouteNotDeclared { route } => {
                write!(f, "This tool does not offer the {route} route")
            }
            Self::UnknownRoute { route } => write!(f, "{route} is not a route Noctis knows"),
            Self::UnknownVerb { verb } => write!(f, "This tool has nothing called {verb}"),
            Self::WrongCapability { found } => {
                write!(f, "That approval is for {found}, not this route")
            }
            Self::WrongTargetType { found } => {
                write!(f, "That approval is for a {found}, not a tool")
            }
            Self::WrongTarget { approved, asked } => {
                write!(f, "That approval covers {approved}, not {asked}")
            }
            Self::Denied => write!(f, "Authority denied it"),
            Self::NotConfirmed => write!(f, "It has not been confirmed"),
            Self::AlreadyExecuted => write!(f, "That approval has already been used"),
        }
    }
}

/// Whether the tool actually offers the route and verb the page named.
///
/// Run before the core is asked anything, so a route a tool does not declare
/// never becomes an authority request — the same ordering that keeps a
/// protected window from ever reaching the Approval Surface. The descriptor is
/// the allowlist, and this is where the page's word is checked against it.
pub fn admits<'a>(
    descriptor: &'a ToolDescriptor,
    route: &str,
    verb_id: &str,
) -> Result<(&'static str, Option<&'a ToolVerb>), Denied> {
    let capability = route_capability(route).ok_or_else(|| Denied::UnknownRoute {
        route: route.to_owned(),
    })?;

    // `manual` needs no declaration: it is the terminal fallback, and a tool's
    // instructions are always present. Every other route must be declared.
    if route != "manual" && descriptor.route(route).is_none() {
        return Err(Denied::RouteNotDeclared {
            route: route.to_owned(),
        });
    }

    // A verb is only meaningful where the tool has verbs at all. Naming one that
    // does not exist is refused rather than ignored: silently running "the
    // default" is how a caller ends up publishing when it meant to draft.
    let verb = if descriptor.verbs().is_empty() {
        None
    } else {
        Some(
            descriptor
                .verb(verb_id)
                .ok_or_else(|| Denied::UnknownVerb {
                    verb: verb_id.to_owned(),
                })?,
        )
    };

    Ok((capability, verb))
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str()
}

/// Whether one approval record authorises one act against one tool.
///
/// The target check is the reason this function exists: a WebView holding any
/// approval id at all could otherwise present the one it was given for opening a
/// listing form and have the shell start a process instead. The core would say
/// "that approval is valid" and be telling the truth about a different question.
pub fn authorises(approval: &Value, capability: &str, tool_id: &str) -> Result<(), Denied> {
    let found_capability = text(approval, "capability").ok_or(Denied::Unreadable)?;

    if found_capability != capability {
        return Err(Denied::WrongCapability {
            found: found_capability.to_owned(),
        });
    }

    let target = approval.get("target").ok_or(Denied::Unreadable)?;
    let target_type = text(target, "type").ok_or(Denied::Unreadable)?;

    if target_type != TOOL_TARGET_TYPE {
        return Err(Denied::WrongTargetType {
            found: target_type.to_owned(),
        });
    }

    let target_id = text(target, "id").ok_or(Denied::Unreadable)?;

    if target_id != tool_id {
        return Err(Denied::WrongTarget {
            approved: target_id.to_owned(),
            asked: tool_id.to_owned(),
        });
    }

    let outcome = text(approval, "outcome").ok_or(Denied::Unreadable)?;

    if outcome == "deny" {
        return Err(Denied::Denied);
    }

    if outcome != "allow"
        && approval
            .get("confirmedAt")
            .and_then(Value::as_str)
            .is_none()
    {
        return Err(Denied::NotConfirmed);
    }

    if approval.get("executedAt").and_then(Value::as_str).is_some() {
        return Err(Denied::AlreadyExecuted);
    }

    Ok(())
}

/// What a person reads on the Approval Surface before agreeing to this.
///
/// Says what will visibly happen, naming the tool and the route in ordinary
/// words. A summary reading "run a tool route" would be a boundary nobody could
/// make a decision at.
pub fn consequence_summary(
    descriptor: &ToolDescriptor,
    route: &str,
    verb: Option<&ToolVerb>,
) -> String {
    let name = &descriptor.display_name;

    match route {
        "official_cli" => match verb {
            Some(verb) => format!("{} in {name}, using its own command line", verb.label),
            None => format!("Run a {name} command"),
        },
        "isolated_browser" => {
            format!("Drive {name} in an isolated browser that holds none of your sign-ins")
        }
        "visible_handoff" => format!("Open {name} in your own signed-in browser"),
        "manual" => format!("Show you how to do this in {name} yourself"),
        other => format!("Reach {name} by {other}"),
    }
}

/// The body of the `authority.request` command for reaching a tool.
pub fn request_body(
    descriptor: &ToolDescriptor,
    route: &str,
    capability: &str,
    verb: Option<&ToolVerb>,
    objective_id: Option<&str>,
    idempotency_key: &str,
) -> Value {
    let operation_class = raised_operation_class(capability, verb).unwrap_or("credential_security");

    let mut body = json!({
        "idempotencyKey": idempotency_key,
        "actorId": "local",
        "operationClass": operation_class,
        "capability": capability,
        "target": { "type": TOOL_TARGET_TYPE, "id": descriptor.id },
        "consequenceSummary": consequence_summary(descriptor, route, verb),
        // Nothing this phase executes is irreversible: a launched process can be
        // closed and an opened tab can be shut. The commit boundary — a publish,
        // a send, a spend — is a *separate* request whose verb raises the class,
        // and that one states its own reversibility.
        "reversibility": if operation_class == "publish"
            || operation_class == "spend"
            || operation_class == "destructive"
        {
            "irreversible"
        } else {
            "reversible"
        },
    });

    // An absent key, never a `null`: the core's schema takes an optional
    // `objectiveId` and `null` fails it. Omitting it made the whole
    // active-Objective allow path unreachable in Phase 9.
    if let Some(objective_id) = objective_id {
        body["objectiveId"] = json!(objective_id);
    }

    body
}

/// The body of the `authority.execute` command, carrying the evidence.
pub fn execute_body(request_id: &str, idempotency_key: &str, evidence: Value) -> Value {
    json!({
        "idempotencyKey": idempotency_key,
        "requestId": request_id,
        "evidenceVersion": 1,
        "evidence": evidence,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tool_registry::{ToolRoute, ToolVerb};

    fn verb(id: &str, class: &str) -> ToolVerb {
        ToolVerb {
            id: id.to_owned(),
            label: format!("Do {id}"),
            args: Vec::new(),
            operation_class: class.to_owned(),
        }
    }

    fn vinted() -> ToolDescriptor {
        ToolDescriptor {
            id: "vinted".to_owned(),
            display_name: "Vinted".to_owned(),
            instructions: "Open Vinted by hand.".to_owned(),
            routes: vec![ToolRoute::VisibleHandoff {
                url: "https://www.vinted.co.uk/items/new".to_owned(),
                origins: vec!["https://www.vinted.co.uk".to_owned()],
            }],
        }
    }

    fn cli() -> ToolDescriptor {
        ToolDescriptor {
            id: "gh".to_owned(),
            display_name: "GitHub".to_owned(),
            instructions: "Use the website.".to_owned(),
            routes: vec![ToolRoute::OfficialCli {
                executable: "gh".to_owned(),
                detached: false,
                verbs: vec![verb("pr_list", "read_inspect"), verb("release", "publish")],
            }],
        }
    }

    fn approval(overrides: Value) -> Value {
        let mut record = json!({
            "id": "0199a000-0000-7000-8000-000000000001",
            "capability": "browser.open_visible",
            "target": { "type": "tool", "id": "vinted" },
            "outcome": "allow",
        });

        for (key, value) in overrides.as_object().expect("an object") {
            record[key] = value.clone();
        }

        record
    }

    /// THE GATE, and the Phase 9 lesson: a table cannot hide a missing entry.
    #[test]
    fn names_a_capability_for_every_route_and_refuses_anything_else() {
        for route in [
            "official_cli",
            "isolated_browser",
            "visible_handoff",
            "manual",
        ] {
            assert!(
                route_capability(route).is_some(),
                "{route} has no capability"
            );
        }

        assert_eq!(route_capability("screen_share"), None);
        assert_eq!(route_capability(""), None);
    }

    #[test]
    fn classifies_every_capability_and_refuses_anything_else() {
        for capability in [
            "tool.inspect",
            "tool.launch",
            "tool.run_command",
            "browser.open_visible",
            "browser.automate_isolated",
            "browser.control_profile",
            "tool.register_descriptor",
        ] {
            assert!(
                capability_operation_class(capability).is_some(),
                "{capability} has no class"
            );
        }

        assert_eq!(capability_operation_class("tool.anything"), None);
    }

    /// THE GATE: the page names a route, and a route it was never offered must
    /// not become an authority request. Checked before the core is asked, so the
    /// Approval Surface is never shown a consequence Noctis could not carry out.
    #[test]
    fn refuses_a_route_the_tool_does_not_declare() {
        assert_eq!(
            admits(&vinted(), "official_cli", ""),
            Err(Denied::RouteNotDeclared {
                route: "official_cli".to_owned()
            })
        );
    }

    #[test]
    fn refuses_a_route_that_is_not_one_of_the_four() {
        assert_eq!(
            admits(&vinted(), "remote_desktop", ""),
            Err(Denied::UnknownRoute {
                route: "remote_desktop".to_owned()
            })
        );
    }

    /// The terminal fallback needs no declaration, which is what makes
    /// degradation total: every tool can always be explained.
    #[test]
    fn always_admits_the_manual_route() {
        let (capability, _) = admits(&vinted(), "manual", "").expect("admitted");

        assert_eq!(capability, "tool.inspect");
    }

    #[test]
    fn refuses_a_verb_the_tool_does_not_declare() {
        assert_eq!(
            admits(&cli(), "official_cli", "rm_rf"),
            Err(Denied::UnknownVerb {
                verb: "rm_rf".to_owned()
            })
        );
    }

    /// THE GATE: the class the core is asked about is derived from the shell's
    /// own descriptor, never sent by the page. A verb that publishes raises the
    /// request above the capability's floor.
    #[test]
    fn raises_the_class_to_the_verb_and_never_below_the_floor() {
        assert_eq!(
            raised_operation_class("tool.run_command", Some(&verb("release", "publish"))),
            Some("publish")
        );
        // The floor wins: reaching an external tool with a command is an
        // external act even when the command only reads.
        assert_eq!(
            raised_operation_class("tool.run_command", Some(&verb("pr_list", "read_inspect"))),
            Some("external_write")
        );
        assert_eq!(
            raised_operation_class("browser.open_visible", None),
            Some("local_reversible_edit")
        );
    }

    /// A descriptor naming a class Noctis does not know must not smuggle it
    /// through to the core. The floor is used instead.
    #[test]
    fn falls_back_to_the_floor_for_a_class_it_does_not_recognise() {
        assert_eq!(
            raised_operation_class("tool.run_command", Some(&verb("x", "harmless"))),
            Some("external_write")
        );
    }

    #[test]
    fn accepts_an_allowed_approval_for_the_tool_being_reached() {
        assert_eq!(
            authorises(&approval(json!({})), "browser.open_visible", "vinted"),
            Ok(())
        );
    }

    /// THE GATE: the WebView chooses both which approval id to present and which
    /// tool to name. Without comparing them, an approval to open Vinted opens
    /// anything at all.
    #[test]
    fn refuses_an_approval_granted_for_a_different_tool() {
        assert_eq!(
            authorises(&approval(json!({})), "browser.open_visible", "suno"),
            Err(Denied::WrongTarget {
                approved: "vinted".to_owned(),
                asked: "suno".to_owned(),
            })
        );
    }

    /// THE GATE for Section 12.3's separation, at the shell. An approval to open
    /// a tab must never authorise driving the signed-in profile, and the two
    /// differ by capability name as well as class.
    #[test]
    fn refuses_an_approval_for_a_different_capability_on_the_same_tool() {
        assert!(matches!(
            authorises(&approval(json!({})), "browser.control_profile", "vinted"),
            Err(Denied::WrongCapability { .. })
        ));
    }

    /// Ids are only unique within a target type, so a window whose id happens to
    /// be `vinted` must not satisfy a tool request.
    #[test]
    fn refuses_an_approval_whose_target_is_not_a_tool() {
        let for_a_window = approval(json!({ "target": { "type": "window", "id": "vinted" } }));

        assert!(matches!(
            authorises(&for_a_window, "browser.open_visible", "vinted"),
            Err(Denied::WrongTargetType { .. })
        ));
    }

    #[test]
    fn refuses_a_denied_an_unconfirmed_and_a_spent_approval() {
        assert_eq!(
            authorises(
                &approval(json!({ "outcome": "deny" })),
                "browser.open_visible",
                "vinted"
            ),
            Err(Denied::Denied)
        );
        assert_eq!(
            authorises(
                &approval(json!({ "outcome": "require_confirmation" })),
                "browser.open_visible",
                "vinted"
            ),
            Err(Denied::NotConfirmed)
        );
        assert_eq!(
            authorises(
                &approval(json!({ "executedAt": "2026-09-10T12:00:00.000Z" })),
                "browser.open_visible",
                "vinted"
            ),
            Err(Denied::AlreadyExecuted)
        );
    }

    #[test]
    fn accepts_a_confirmed_approval_that_required_confirmation() {
        let confirmed = approval(json!({
            "outcome": "require_confirmation",
            "confirmedAt": "2026-09-10T12:00:00.000Z",
        }));

        assert_eq!(
            authorises(&confirmed, "browser.open_visible", "vinted"),
            Ok(())
        );
    }

    #[test]
    fn refuses_anything_that_is_not_an_approval() {
        for not_an_approval in [
            json!({}),
            json!({ "capability": "browser.open_visible" }),
            json!({ "capability": "browser.open_visible", "target": {} }),
            json!(null),
            json!("approved"),
            json!({ "error": { "code": "not_found" } }),
        ] {
            assert!(
                authorises(&not_an_approval, "browser.open_visible", "vinted").is_err(),
                "accepted {not_an_approval}"
            );
        }
    }

    /// The class is the shell's, not the caller's, and the target is spelled the
    /// way the contract reads it.
    #[test]
    fn always_states_the_operation_class_and_target_itself() {
        let body = request_body(
            &vinted(),
            "visible_handoff",
            "browser.open_visible",
            None,
            None,
            "idem-1",
        );

        assert_eq!(body["operationClass"], "local_reversible_edit");
        assert_eq!(body["capability"], "browser.open_visible");
        assert_eq!(body["target"]["type"], "tool");
        assert_eq!(body["target"]["id"], "vinted");
        assert_eq!(body["reversibility"], "reversible");
    }

    /// THE GATE, and Phase 9's sharpest lesson: Section 9.1 lets a
    /// `local_reversible_edit` proceed without asking while an Objective is
    /// active, and the core decides that by looking the Objective up. A request
    /// that does not name one makes that whole path unreachable while every test
    /// of the evaluator implementing it still passes.
    #[test]
    fn names_the_objective_so_the_core_can_see_it_is_active() {
        let body = request_body(
            &vinted(),
            "visible_handoff",
            "browser.open_visible",
            None,
            Some("0199a000-0000-7000-8000-0000000000ff"),
            "idem-2",
        );

        assert_eq!(body["objectiveId"], "0199a000-0000-7000-8000-0000000000ff");
    }

    #[test]
    fn leaves_the_objective_out_entirely_when_there_is_none() {
        let body = request_body(
            &vinted(),
            "visible_handoff",
            "browser.open_visible",
            None,
            None,
            "idem-3",
        );

        assert!(body.get("objectiveId").is_none());
    }

    /// A publish is not reversible, and a request that claimed otherwise would
    /// be asking a person to agree to the wrong thing.
    #[test]
    fn does_not_call_a_publish_reversible() {
        let publishing = verb("release", "publish");
        let body = request_body(
            &cli(),
            "official_cli",
            "tool.run_command",
            Some(&publishing),
            Some("0199a000-0000-7000-8000-0000000000ff"),
            "idem-4",
        );

        assert_eq!(body["operationClass"], "publish");
        assert_eq!(body["reversibility"], "irreversible");
    }

    /// The summary is a sentence somebody decides on, and the two browser routes
    /// must not read alike — agreeing to an isolated session is not agreeing to
    /// one carrying your sign-ins.
    #[test]
    fn describes_each_route_in_words_a_person_can_decide_on() {
        let isolated = consequence_summary(&vinted(), "isolated_browser", None);
        let visible = consequence_summary(&vinted(), "visible_handoff", None);

        assert!(isolated.contains("Vinted"));
        assert!(visible.contains("Vinted"));
        assert_ne!(isolated, visible);
        assert!(
            visible.contains("signed-in"),
            "the visible route must say whose browser it is: {visible}"
        );
        assert!(
            isolated.contains("none of your sign-ins"),
            "the isolated route must say what it does not carry: {isolated}"
        );
    }

    #[test]
    fn carries_the_evidence_into_the_execute_command() {
        let body = execute_body("req-1", "idem-5", json!({ "toolId": "vinted" }));

        assert_eq!(body["requestId"], "req-1");
        assert_eq!(body["evidenceVersion"], 1);
        assert_eq!(body["evidence"]["toolId"], "vinted");
    }
}

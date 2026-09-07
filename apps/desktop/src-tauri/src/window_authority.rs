//! The boundary between "the WebView asked for a window to move" and "the core
//! said it may".
//!
//! Everything here is pure and takes the core's JSON as it arrived. The shell is
//! the only process that can move a window, so it is the process that has to
//! satisfy itself the move was authorised — asking the core is not enough on its
//! own, because the *answer* has to be checked against the window actually about
//! to be moved.

use serde_json::{json, Value};

use crate::windows_state::PlaceIntent;

/// The `AuthorityTarget.type` every window request carries, matching
/// `WINDOW_TARGET_TYPE` in `@noctis/contracts`.
pub const WINDOW_TARGET_TYPE: &str = "window";

/// The operation class of a placement, matching
/// `WINDOW_CAPABILITY_OPERATION_CLASS` in `@noctis/contracts`.
///
/// Written here rather than sent by the caller for the same reason the
/// TypeScript table exists: the capability is the thing with consequences, so a
/// caller that named its own class could understate one.
pub const PLACE_OPERATION_CLASS: &str = "local_reversible_edit";
pub const PLACE_CAPABILITY: &str = "window.place";

/// Why an approval does not authorise the move in hand.
///
/// Each variant is a different lie a caller could tell, and they are separate so
/// the refusal says which one rather than "denied".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Denied {
    /// The core's answer was not an approval record at all.
    Unreadable,
    /// The approval is for a different capability — a file write, say.
    WrongCapability {
        found: String,
    },
    /// The approval is for a different kind of thing entirely.
    WrongTargetType {
        found: String,
    },
    /// THE interesting one: an approval for another application's window.
    WrongTarget {
        approved: String,
        asked: String,
    },
    Denied,
    /// Confirmation was required and nobody gave it.
    NotConfirmed,
    /// The one execution this approval allowed has already happened.
    AlreadyExecuted,
}

impl std::fmt::Display for Denied {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreadable => write!(f, "The core's answer was not an approval"),
            Self::WrongCapability { found } => {
                write!(f, "That approval is for {found}, not placing a window")
            }
            Self::WrongTargetType { found } => {
                write!(f, "That approval is for a {found}, not a window")
            }
            Self::WrongTarget { approved, asked } => {
                write!(f, "That approval covers {approved}, not {asked}")
            }
            Self::Denied => write!(f, "Authority denied the placement"),
            Self::NotConfirmed => write!(f, "The placement has not been confirmed"),
            Self::AlreadyExecuted => write!(f, "That approval has already been used"),
        }
    }
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key)?.as_str()
}

/// Whether one approval record authorises placing one application's window.
///
/// The target check is the reason this function exists. A WebView that has been
/// handed any approval id at all could otherwise present the one it was given
/// for the editor and have the shell move something else — the core would say
/// "that approval is valid" and be telling the truth about a different question.
pub fn authorises(approval: &Value, capability: &str, application_id: &str) -> Result<(), Denied> {
    let found_capability = text(approval, "capability").ok_or(Denied::Unreadable)?;

    if found_capability != capability {
        return Err(Denied::WrongCapability {
            found: found_capability.to_owned(),
        });
    }

    let target = approval.get("target").ok_or(Denied::Unreadable)?;
    let target_type = text(target, "type").ok_or(Denied::Unreadable)?;

    if target_type != WINDOW_TARGET_TYPE {
        return Err(Denied::WrongTargetType {
            found: target_type.to_owned(),
        });
    }

    let target_id = text(target, "id").ok_or(Denied::Unreadable)?;

    if target_id != application_id {
        return Err(Denied::WrongTarget {
            approved: target_id.to_owned(),
            asked: application_id.to_owned(),
        });
    }

    let outcome = text(approval, "outcome").ok_or(Denied::Unreadable)?;

    if outcome == "deny" {
        return Err(Denied::Denied);
    }

    // `allow` needs no confirmation by definition; every other outcome does, and
    // an unconfirmed one is a request that tried to answer itself. This mirrors
    // `executeAuthority` in the core deliberately: the core would refuse too, and
    // the shell refusing first means it never moves a window it then cannot
    // record having moved.
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

/// The body of the `authority.request` command for a placement.
///
/// The consequence summary says what will visibly happen, in the words a person
/// reading an Approval Surface needs — which application, which display, which
/// region. A summary that said "place a window" would be a boundary nobody could
/// make a decision at.
pub fn request_body(intent: &PlaceIntent, idempotency_key: &str, window_title: &str) -> Value {
    json!({
        "idempotencyKey": idempotency_key,
        "actorId": "local",
        "operationClass": PLACE_OPERATION_CLASS,
        "capability": PLACE_CAPABILITY,
        "target": { "type": WINDOW_TARGET_TYPE, "id": intent.application_id },
        "consequenceSummary": format!(
            "Move {} ({}) to the {} of the {} display",
            intent.application_id,
            window_title,
            intent.region_label(),
            intent.monitor_label(),
        ),
        "reversibility": "reversible",
    })
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

    fn approval(overrides: Value) -> Value {
        let mut record = json!({
            "id": "0199a000-0000-7000-8000-000000000001",
            "capability": PLACE_CAPABILITY,
            "target": { "type": "window", "id": "vscode" },
            "outcome": "allow",
        });

        for (key, value) in overrides.as_object().expect("an object") {
            record[key] = value.clone();
        }

        record
    }

    #[test]
    fn accepts_an_allowed_approval_for_the_window_being_moved() {
        assert_eq!(
            authorises(&approval(json!({})), PLACE_CAPABILITY, "vscode"),
            Ok(())
        );
    }

    /// THE GATE: the WebView chooses which approval id to present and which
    /// application to name. If those two are never compared, an approval granted
    /// for the editor moves anything at all.
    #[test]
    fn refuses_an_approval_granted_for_a_different_application() {
        let for_the_editor = approval(json!({}));

        assert_eq!(
            authorises(&for_the_editor, PLACE_CAPABILITY, "emulator"),
            Err(Denied::WrongTarget {
                approved: "vscode".to_owned(),
                asked: "emulator".to_owned(),
            })
        );
    }

    /// An approval to write a file is not an approval to move a window, however
    /// valid it is.
    #[test]
    fn refuses_an_approval_for_a_different_capability() {
        let for_a_file = approval(json!({ "capability": "fs.write" }));

        assert!(matches!(
            authorises(&for_a_file, PLACE_CAPABILITY, "vscode"),
            Err(Denied::WrongCapability { .. })
        ));
    }

    /// Ids are only unique within a target type, so a file whose id happens to be
    /// `vscode` must not satisfy a window request.
    #[test]
    fn refuses_an_approval_whose_target_is_not_a_window() {
        let for_a_repository = approval(json!({
            "target": { "type": "repository", "id": "vscode" }
        }));

        assert!(matches!(
            authorises(&for_a_repository, PLACE_CAPABILITY, "vscode"),
            Err(Denied::WrongTargetType { .. })
        ));
    }

    #[test]
    fn refuses_a_denied_approval() {
        let denied = approval(json!({ "outcome": "deny" }));

        assert_eq!(
            authorises(&denied, PLACE_CAPABILITY, "vscode"),
            Err(Denied::Denied)
        );
    }

    /// THE GATE: an approval that asked for confirmation and did not get one is a
    /// preparation, and moving on it would be the bypass Phase 8 exists to stop.
    #[test]
    fn refuses_an_unconfirmed_approval_that_required_confirmation() {
        let waiting = approval(json!({ "outcome": "require_confirmation" }));

        assert_eq!(
            authorises(&waiting, PLACE_CAPABILITY, "vscode"),
            Err(Denied::NotConfirmed)
        );
    }

    #[test]
    fn accepts_a_confirmed_approval_that_required_confirmation() {
        let confirmed = approval(json!({
            "outcome": "require_confirmation",
            "confirmedAt": "2026-09-07T12:00:00.000Z",
        }));

        assert_eq!(authorises(&confirmed, PLACE_CAPABILITY, "vscode"), Ok(()));
    }

    #[test]
    fn refuses_a_typed_confirmation_nobody_typed() {
        let waiting = approval(json!({ "outcome": "require_typed_confirmation" }));

        assert_eq!(
            authorises(&waiting, PLACE_CAPABILITY, "vscode"),
            Err(Denied::NotConfirmed)
        );
    }

    /// The core refuses a second execution too. The shell refusing first is not
    /// redundancy for its own sake: it is what stops the window being moved and
    /// only then discovering the move could not be recorded.
    #[test]
    fn refuses_an_approval_that_has_already_been_used() {
        let spent = approval(json!({ "executedAt": "2026-09-07T12:00:00.000Z" }));

        assert_eq!(
            authorises(&spent, PLACE_CAPABILITY, "vscode"),
            Err(Denied::AlreadyExecuted)
        );
    }

    #[test]
    fn refuses_anything_that_is_not_an_approval() {
        for not_an_approval in [
            json!({}),
            json!({ "capability": PLACE_CAPABILITY }),
            json!({ "capability": PLACE_CAPABILITY, "target": {} }),
            json!({ "capability": PLACE_CAPABILITY, "target": { "type": "window" } }),
            json!(null),
            json!("approved"),
        ] {
            assert!(
                authorises(&not_an_approval, PLACE_CAPABILITY, "vscode").is_err(),
                "accepted {not_an_approval}"
            );
        }
    }

    /// An error body from the core is JSON too, and it must not read as consent.
    #[test]
    fn refuses_an_error_body_from_the_core() {
        let error = json!({ "error": { "code": "not_found", "message": "approval not found" } });

        assert_eq!(
            authorises(&error, PLACE_CAPABILITY, "vscode"),
            Err(Denied::Unreadable)
        );
    }

    #[test]
    fn distinguishes_placing_from_restoring() {
        let for_placing = approval(json!({}));

        assert!(matches!(
            authorises(&for_placing, "window.restore", "vscode"),
            Err(Denied::WrongCapability { .. })
        ));
    }

    #[test]
    fn describes_the_consequence_in_words_a_person_can_decide_on() {
        let intent = PlaceIntent {
            application_id: "vscode".to_owned(),
            monitor: noctis_windows::MonitorRole::Primary,
            region: noctis_windows::RegionName::LeftTwoThirds,
        };

        let body = request_body(&intent, "idem-1", "Noctis-OS - Visual Studio Code");
        let summary = body["consequenceSummary"].as_str().expect("a summary");

        assert!(summary.contains("vscode"));
        assert!(summary.contains("Noctis-OS"));
        assert!(summary.contains("left two thirds"));
        assert!(summary.contains("primary"));
    }

    /// The class is the shell's, not the caller's. A request body that carried a
    /// caller-supplied class would let a caller understate the consequence.
    #[test]
    fn always_states_the_operation_class_itself() {
        let intent = PlaceIntent {
            application_id: "emulator".to_owned(),
            monitor: noctis_windows::MonitorRole::Secondary,
            region: noctis_windows::RegionName::Full,
        };

        let body = request_body(&intent, "idem-2", "Android Emulator");

        assert_eq!(body["operationClass"], PLACE_OPERATION_CLASS);
        assert_eq!(body["capability"], PLACE_CAPABILITY);
        assert_eq!(body["target"]["type"], WINDOW_TARGET_TYPE);
        assert_eq!(body["target"]["id"], "emulator");
        assert_eq!(body["reversibility"], "reversible");
    }

    #[test]
    fn carries_the_evidence_into_the_execute_command() {
        let body = execute_body("req-1", "idem-3", json!({ "applicationId": "vscode" }));

        assert_eq!(body["requestId"], "req-1");
        assert_eq!(body["evidenceVersion"], 1);
        assert_eq!(body["evidence"]["applicationId"], "vscode");
    }
}

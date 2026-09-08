//! What the shell knows about native windows between one request and the next.
//!
//! Two things live here: the curated list of applications Noctis is allowed to
//! arrange, and the placements it preserved before moving them. Both are
//! deliberately in the shell rather than the core — the core is the authority on
//! *whether*, and this process is the only one that can act, so it is the only
//! one that can honestly say what it did.

use std::collections::HashMap;
use std::sync::Mutex;

use noctis_windows::{ApplicationTarget, MonitorRole, Placement, RegionName};
use serde::{Deserialize, Serialize};

/// A placement request as it arrives from the WebView.
///
/// Note what it cannot carry: no coordinates, no monitor index, no window
/// handle. A caller names an application and a named region, and the shell
/// resolves both. Section 11.2 — "semantic placement requests, not
/// model-provided coordinates" — is enforced by this type having nowhere to put
/// a pixel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceIntent {
    pub application_id: String,
    pub monitor: MonitorRole,
    pub region: RegionName,
    /// The Objective this placement is part of, when there is one.
    ///
    /// Not decoration. Section 9.1 lets a `local_reversible_edit` proceed
    /// without asking while an Objective is active, and the core decides that by
    /// looking the Objective up — so a request that names none is a request the
    /// core must treat as unscoped, and it will ask. Omitting this made the
    /// active-Objective path unreachable from the product while passing every
    /// test of the evaluator that implements it.
    #[serde(default)]
    pub objective_id: Option<String>,
}

impl PlaceIntent {
    /// The region in the words a person reads on an Approval Surface.
    ///
    /// Not `Debug`, and not the serde spelling: `LeftTwoThirds` and
    /// `left_two_thirds` are both names for programs. Somebody deciding whether
    /// to let Noctis move their editor is reading a sentence.
    pub fn region_label(&self) -> &'static str {
        match self.region {
            RegionName::Full => "whole",
            RegionName::LeftHalf => "left half",
            RegionName::RightHalf => "right half",
            RegionName::LeftTwoThirds => "left two thirds",
            RegionName::RightThird => "right third",
        }
    }

    pub fn monitor_label(&self) -> &'static str {
        match self.monitor {
            MonitorRole::Primary => "primary",
            MonitorRole::Secondary => "secondary",
        }
    }
}

/// The applications Noctis may arrange.
///
/// Configuration rather than model output, and compiled in for now rather than
/// read from a file: a grant list a model could append to is not a grant list.
/// It moves to user-editable configuration when there is a settings surface to
/// edit it from, and that surface is the thing that needs designing, not this
/// list.
pub fn granted_targets() -> Vec<ApplicationTarget> {
    vec![
        ApplicationTarget {
            id: "vscode".to_owned(),
            executable_names: vec!["code.exe".to_owned()],
            executable_paths: Vec::new(),
            // Electron's frame class, shared with every other Electron
            // application — which is why it corroborates the executable rather
            // than standing in for it.
            class_names: vec!["Chrome_WidgetWin_1".to_owned()],
            title_contains: Some("Visual Studio Code".to_owned()),
        },
        ApplicationTarget {
            id: "emulator".to_owned(),
            executable_names: vec![
                "qemu-system-x86_64.exe".to_owned(),
                "emulator.exe".to_owned(),
            ],
            executable_paths: Vec::new(),
            class_names: vec![
                "Qt5152QWindowIcon".to_owned(),
                "Qt672QWindowIcon".to_owned(),
            ],
            title_contains: Some("Android Emulator".to_owned()),
        },
    ]
}

/// The minimum size each application's window is never placed below, in
/// device-independent pixels, scaled to the monitor before it is applied.
///
/// A per-application number because it is a property of the application: an
/// editor that cannot show a file tree and a document in 400 points is not going
/// to be improved by Noctis insisting.
pub fn minimum_dip(application_id: &str) -> (u32, u32) {
    match application_id {
        "vscode" => (800, 600),
        _ => (400, 300),
    }
}

/// The application's name as a person would say it.
///
/// Beside the grant list rather than in `ApplicationTarget`, because how an
/// application is identified and how it is described are different concerns and
/// only one of them belongs in a crate that decides whether to move windows.
pub fn display_name(application_id: &str) -> &str {
    match application_id {
        "vscode" => "Visual Studio Code",
        "emulator" => "Android Emulator",
        other => other,
    }
}

/// Everything the shell remembers about native windows.
///
/// One managed state rather than three, because all three answer the same
/// question — what has Noctis done to which window — and a command that needed
/// all of them took nine arguments, which clippy was right to object to.
#[cfg(windows)]
#[derive(Default)]
pub struct NativeWindows {
    /// What Noctis moved, keyed by window handle. Section 11.2: "restore only
    /// windows Noctis moved and only when their identity still matches" — this
    /// map is the first half, and the stored identity answers the second.
    pub moved: Mutex<HashMap<u64, Moved>>,
    /// Where a person moved a window after Noctis placed it, by application id.
    ///
    /// Written to disk, because "the user always wins" that lasted only until
    /// the next restart would not be the user winning. Not keyed by display
    /// arrangement: a stale override is fitted onto a display that currently
    /// exists by `region::resolve`, so unplugging a monitor degrades rather than
    /// resurrects a rectangle nobody can see.
    pub overrides: Mutex<HashMap<String, Placement>>,
    /// Correlations for processes Noctis started itself, by application id.
    pub correlations: Mutex<HashMap<String, String>>,
}

#[cfg(windows)]
pub struct Moved {
    /// Which granted target this window belonged to. Without it, restoring "the
    /// editor" would put back whichever moved window happened to still be alive.
    pub application_id: String,
    /// The exact placement to restore to.
    pub saved: noctis_windows::win32::Saved,
    /// Where the window actually ended up, as read back after the move.
    ///
    /// Read back rather than what was asked for, because an application is
    /// entitled to adjust its own size and the difference between "the app did
    /// that" and "a person did that" is the whole question this field answers.
    pub applied: Placement,
    /// The identity at the moment of the move. A handle is reused by Windows
    /// once its window is destroyed, so restoring on the handle alone would
    /// eventually move whatever inherited it.
    pub identity: noctis_windows::WindowIdentity,
}

/// The file the overrides live in, beside the shell's own window placement.
pub const OVERRIDES_FILE: &str = "window-overrides.json";

#[cfg(test)]
mod tests {
    use super::*;

    fn intent(monitor: MonitorRole, region: RegionName) -> PlaceIntent {
        PlaceIntent {
            application_id: "vscode".to_owned(),
            monitor,
            region,
            objective_id: None,
        }
    }

    #[test]
    fn labels_every_region_in_readable_words() {
        for region in [
            RegionName::Full,
            RegionName::LeftHalf,
            RegionName::RightHalf,
            RegionName::LeftTwoThirds,
            RegionName::RightThird,
        ] {
            let label = intent(MonitorRole::Primary, region).region_label();

            assert!(!label.is_empty());
            assert!(
                !label.contains('_') && label.chars().all(|c| c.is_lowercase() || c == ' '),
                "{label} reads like an identifier rather than a phrase"
            );
        }
    }

    #[test]
    fn labels_both_display_roles() {
        assert_eq!(
            intent(MonitorRole::Primary, RegionName::Full).monitor_label(),
            "primary"
        );
        assert_eq!(
            intent(MonitorRole::Secondary, RegionName::Full).monitor_label(),
            "secondary"
        );
    }

    /// A placement intent arrives as JSON from the WebView. If it could carry a
    /// rectangle, the semantic-request rule would be a comment rather than a
    /// constraint.
    #[test]
    fn refuses_an_intent_that_tries_to_carry_coordinates() {
        let with_pixels = r#"{
            "applicationId": "vscode",
            "monitor": "primary",
            "region": "left_two_thirds",
            "x": 0, "y": 0, "width": 100, "height": 100
        }"#;

        // `serde` ignores unknown fields by default, so this asserts the fields
        // that survive rather than that parsing fails — the point being that no
        // coordinate reaches the placement layer whatever the caller sends.
        let parsed: PlaceIntent = serde_json::from_str(with_pixels).expect("an intent");

        assert_eq!(parsed.application_id, "vscode");
        assert_eq!(parsed.region, RegionName::LeftTwoThirds);
    }

    #[test]
    fn reads_the_region_names_the_contract_sends() {
        let intent: PlaceIntent = serde_json::from_str(
            r#"{"applicationId":"emulator","monitor":"secondary","region":"right_third"}"#,
        )
        .expect("an intent");

        assert_eq!(intent.monitor, MonitorRole::Secondary);
        assert_eq!(intent.region, RegionName::RightThird);
    }

    #[test]
    fn grants_only_the_applications_phase_nine_names() {
        let ids: Vec<String> = granted_targets().into_iter().map(|t| t.id).collect();

        assert_eq!(ids, vec!["vscode", "emulator"]);
    }

    /// THE GATE: a target with no class names matches every window its process
    /// owns, including tooltips. Both shipped targets must discriminate.
    #[test]
    fn gives_every_granted_target_a_window_class_to_discriminate_by() {
        for target in granted_targets() {
            assert!(
                !target.class_names.is_empty(),
                "{} would match every window its process owns",
                target.id
            );
            assert!(!target.executable_names.is_empty());
        }
    }

    #[test]
    fn gives_the_editor_a_larger_minimum_than_the_default() {
        assert_eq!(minimum_dip("vscode"), (800, 600));
        assert_eq!(minimum_dip("emulator"), (400, 300));
        assert_eq!(minimum_dip("anything else"), (400, 300));
    }
}

//! Deciding whether a window on screen is the window a request meant.
//!
//! Section 11.2's first rule: "identify windows by process identity, executable
//! signature/path, class, title pattern, and launch correlation; never act on a
//! title match alone." Everything here is pure, because the interesting failure
//! is not reading a title from Win32 — it is deciding that reading one was
//! enough.

use serde::{Deserialize, Serialize};

/// What Win32 could be persuaded to say about one top-level window.
///
/// `executable_path` is optional because reading it needs a handle to the owning
/// process, and a process running at a higher integrity level will refuse. An
/// absent path is a weaker identity, never a wildcard.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowIdentity {
    /// The `HWND` as an opaque integer. Never parsed, only carried and compared.
    pub handle: u64,
    pub process_id: u32,
    pub executable_path: Option<String>,
    pub class_name: String,
    pub title: String,
    /// Set when Noctis started this process itself and can prove it.
    pub launch_correlation_id: Option<String>,
}

/// A curated description of an application Noctis is allowed to place.
///
/// This list is configuration, not model output. A model may ask for "the
/// editor"; it may not describe what an editor's executable is called.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationTarget {
    /// Stable id used as the authority target: `window:vscode`.
    pub id: String,
    /// Executable file names, lowercase, without a directory.
    pub executable_names: Vec<String>,
    /// Full executable paths. When this list is non-empty the window's path must
    /// be one of them, so a `code.exe` dropped somewhere else does not inherit
    /// the grant made to the installed one.
    ///
    /// ponytail: path pinning, not signature verification. Authenticode checking
    /// is the upgrade if a target ever justifies it; for moving a window it
    /// would be ceremony.
    #[serde(default)]
    pub executable_paths: Vec<String>,
    /// Window classes that count as this application's real window. Empty means
    /// the target declines to discriminate, which is a decision its author makes
    /// knowingly — every tooltip and drop-shadow helper the process owns then
    /// matches too.
    pub class_names: Vec<String>,
    /// Corroborating only. Present in the evidence, absent from the decision.
    pub title_contains: Option<String>,
}

/// Which of the signals actually lined up.
///
/// Kept as four independent booleans rather than a score, so that the rule
/// forbidding a title-only match is a readable expression instead of a threshold
/// somebody later tunes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchEvidence {
    pub launch_correlated: bool,
    pub executable_matched: bool,
    pub class_matched: bool,
    pub title_matched: bool,
}

impl MatchEvidence {
    /// Whether this window may be acted on.
    ///
    /// A strong signal says *which application* this is: either Noctis launched
    /// the process, or the executable on disk is one the target names. The class
    /// then says *which of that application's windows* this is. Title is
    /// deliberately absent from the expression — it is the one signal any other
    /// program can set to whatever it likes.
    pub fn is_actionable(&self) -> bool {
        (self.launch_correlated || self.executable_matched) && self.class_matched
    }
}

fn file_name(path: &str) -> Option<&str> {
    path.rsplit(['\\', '/']).next()
}

fn equal_ignoring_case(left: &str, right: &str) -> bool {
    left.len() == right.len() && left.eq_ignore_ascii_case(right)
}

/// Compares one window against one target.
///
/// `correlation` is the id Noctis recorded when it launched the process, if it
/// launched one at all for this target during this session.
pub fn evaluate(
    window: &WindowIdentity,
    target: &ApplicationTarget,
    correlation: Option<&str>,
) -> MatchEvidence {
    let launch_correlated = match (&window.launch_correlation_id, correlation) {
        (Some(theirs), Some(ours)) => theirs == ours,
        _ => false,
    };

    let executable_matched = window.executable_path.as_deref().is_some_and(|path| {
        let named = file_name(path).is_some_and(|name| {
            target
                .executable_names
                .iter()
                .any(|candidate| equal_ignoring_case(candidate, name))
        });

        let pinned = target.executable_paths.is_empty()
            || target
                .executable_paths
                .iter()
                .any(|candidate| equal_ignoring_case(candidate, path));

        named && pinned
    });

    MatchEvidence {
        launch_correlated,
        executable_matched,
        class_matched: target.class_names.is_empty()
            || target
                .class_names
                .iter()
                .any(|candidate| candidate == &window.class_name),
        title_matched: target
            .title_contains
            .as_deref()
            .is_some_and(|needle| window.title.to_lowercase().contains(&needle.to_lowercase())),
    }
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    /// VS Code as actually installed on the qualification machine.
    pub const VSCODE_PATH: &str =
        "C:\\Users\\mmush\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe";

    pub fn vscode_target() -> ApplicationTarget {
        ApplicationTarget {
            id: "vscode".to_owned(),
            executable_names: vec!["code.exe".to_owned()],
            executable_paths: Vec::new(),
            // Electron's frame class. Shared with every other Electron app,
            // which is exactly why it corroborates the executable rather than
            // standing in for it.
            class_names: vec!["Chrome_WidgetWin_1".to_owned()],
            title_contains: Some("Visual Studio Code".to_owned()),
        }
    }

    pub fn window(class_name: &str, title: &str, path: Option<&str>) -> WindowIdentity {
        WindowIdentity {
            handle: 0x1234,
            process_id: 4242,
            executable_path: path.map(str::to_owned),
            class_name: class_name.to_owned(),
            title: title.to_owned(),
            launch_correlation_id: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    #[test]
    fn matches_the_installed_editor_by_executable_and_class() {
        let evidence = evaluate(
            &window(
                "Chrome_WidgetWin_1",
                "AGENTS.md - Noctis-OS - Visual Studio Code",
                Some(VSCODE_PATH),
            ),
            &vscode_target(),
            None,
        );

        assert!(evidence.executable_matched);
        assert!(evidence.class_matched);
        assert!(evidence.title_matched);
        assert!(evidence.is_actionable());
    }

    /// THE GATE: Section 11.2's "never act on a title match alone". A window that
    /// merely calls itself Visual Studio Code is not Visual Studio Code.
    #[test]
    fn refuses_a_window_that_only_has_the_right_title() {
        let impostor = window(
            "Notepad",
            "Visual Studio Code",
            Some("C:\\Windows\\System32\\notepad.exe"),
        );

        let evidence = evaluate(&impostor, &vscode_target(), None);

        assert!(evidence.title_matched);
        assert!(!evidence.executable_matched);
        assert!(!evidence.class_matched);
        assert!(
            !evidence.is_actionable(),
            "a title any program can set was enough to move a window"
        );
    }

    /// The Electron class alone matches Slack, Discord, and every other Electron
    /// application on the machine.
    #[test]
    fn refuses_another_electron_application_with_the_same_window_class() {
        let evidence = evaluate(
            &window(
                "Chrome_WidgetWin_1",
                "Slack | general",
                Some("C:\\Users\\mmush\\AppData\\Local\\slack\\slack.exe"),
            ),
            &vscode_target(),
            None,
        );

        assert!(evidence.class_matched);
        assert!(!evidence.executable_matched);
        assert!(!evidence.is_actionable());
    }

    /// One process owns many windows. The executable says which application;
    /// only the class says which of its windows is the one worth moving.
    #[test]
    fn refuses_a_helper_window_owned_by_the_right_process() {
        let evidence = evaluate(
            &window("Chrome_WidgetWin_0", "", Some(VSCODE_PATH)),
            &vscode_target(),
            None,
        );

        assert!(evidence.executable_matched);
        assert!(!evidence.class_matched);
        assert!(!evidence.is_actionable());
    }

    #[test]
    fn accepts_a_window_noctis_launched_even_without_a_readable_path() {
        let mut launched = window("Chrome_WidgetWin_1", "Untitled", None);
        launched.launch_correlation_id = Some("run-7".to_owned());

        let evidence = evaluate(&launched, &vscode_target(), Some("run-7"));

        assert!(evidence.launch_correlated);
        assert!(!evidence.executable_matched);
        assert!(evidence.is_actionable());
    }

    #[test]
    fn does_not_correlate_a_launch_from_a_different_run() {
        let mut launched = window("Chrome_WidgetWin_1", "Untitled", None);
        launched.launch_correlation_id = Some("run-6".to_owned());

        assert!(!evaluate(&launched, &vscode_target(), Some("run-7")).launch_correlated);
    }

    /// A window with no readable executable path and no launch correlation is
    /// something running at a higher integrity level than Noctis. Unknown is not
    /// permission.
    #[test]
    fn treats_an_unreadable_executable_path_as_no_match_rather_than_any_match() {
        let evidence = evaluate(
            &window("Chrome_WidgetWin_1", "Visual Studio Code", None),
            &vscode_target(),
            None,
        );

        assert!(!evidence.executable_matched);
        assert!(!evidence.is_actionable());
    }

    #[test]
    fn matches_an_executable_name_case_insensitively() {
        let evidence = evaluate(
            &window(
                "Chrome_WidgetWin_1",
                "Visual Studio Code",
                Some("C:\\Program Files\\Microsoft VS Code\\CODE.EXE"),
            ),
            &vscode_target(),
            None,
        );

        assert!(evidence.executable_matched);
    }

    /// THE GATE: a pinned path narrows the grant to the installed copy. A
    /// `code.exe` somewhere else does not inherit it.
    #[test]
    fn refuses_a_copy_of_the_executable_outside_the_pinned_path() {
        let pinned = ApplicationTarget {
            executable_paths: vec![VSCODE_PATH.to_owned()],
            ..vscode_target()
        };

        let elsewhere = window(
            "Chrome_WidgetWin_1",
            "Visual Studio Code",
            Some("C:\\Users\\mmush\\Downloads\\code.exe"),
        );

        assert!(!evaluate(&elsewhere, &pinned, None).executable_matched);
        assert!(
            evaluate(
                &window(
                    "Chrome_WidgetWin_1",
                    "Visual Studio Code",
                    Some(VSCODE_PATH)
                ),
                &pinned,
                None
            )
            .executable_matched
        );
    }

    /// `eq_ignore_ascii_case` on differently sized strings is a cheap way to get
    /// this wrong; the length guard is what makes the comparison total.
    #[test]
    fn does_not_match_an_executable_whose_name_merely_starts_the_same() {
        let evidence = evaluate(
            &window(
                "Chrome_WidgetWin_1",
                "Visual Studio Code",
                Some("C:\\tools\\code.exe.bak"),
            ),
            &vscode_target(),
            None,
        );

        assert!(!evidence.executable_matched);
    }
}

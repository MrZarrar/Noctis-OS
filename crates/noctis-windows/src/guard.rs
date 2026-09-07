//! The refusals that come before any placement.
//!
//! Section 11.2: "exclude system/security windows and ungranted processes." The
//! order matters. A protected window is refused before the grant list is even
//! consulted, so that a grant broad enough to cover the UAC prompt still cannot
//! move it.

use serde::{Deserialize, Serialize};

use crate::identity::{evaluate, ApplicationTarget, MatchEvidence, WindowIdentity};

/// Window classes owned by the shell and by the secure desktop.
///
/// Matched on class rather than executable because most of these belong to
/// `explorer.exe`, which also owns windows that are perfectly ordinary.
const PROTECTED_CLASSES: &[&str] = &[
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "Progman",
    "WorkerW",
    "NotifyIconOverflowWindow",
    "TaskListThumbnailWnd",
    "MultitaskingViewFrame",
    "ForegroundStaging",
    "XamlExplorerHostIslandWindow",
    "TaskSwitcherWnd",
    "DV2ControlHost",
    "Windows.UI.Core.CoreWindow",
    "Credential Dialog Xaml Host",
];

/// Executables whose windows are never moved, whatever else is true.
///
/// Consent and credential UI runs on the secure desktop and a `SetWindowPos`
/// against it fails anyway; refusing here means Noctis never even asks, and
/// never has to explain an error it should not have provoked.
const PROTECTED_EXECUTABLES: &[&str] = &[
    "consent.exe",
    "logonui.exe",
    "winlogon.exe",
    "lsass.exe",
    "credentialuibroker.exe",
    "securityhealthhost.exe",
    "securityhealthsystray.exe",
    "lockapp.exe",
];

/// Why a window will not be touched.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "reason")]
pub enum Refusal {
    /// The shell or the secure desktop owns it.
    Protected { detail: String },
    /// Nothing in the grant list identifies this window strongly enough.
    NotGranted,
}

fn file_name(path: &str) -> Option<&str> {
    path.rsplit(['\\', '/']).next()
}

/// Whether a window belongs to the shell or to the security surface.
///
/// Public because a caller listing candidate windows should be able to say
/// "excluded: system window" rather than silently dropping rows.
pub fn is_protected(window: &WindowIdentity) -> Option<String> {
    if let Some(class) = PROTECTED_CLASSES
        .iter()
        .find(|class| class.eq_ignore_ascii_case(&window.class_name))
    {
        return Some(format!("system window class {class}"));
    }

    let name = window.executable_path.as_deref().and_then(file_name)?;

    PROTECTED_EXECUTABLES
        .iter()
        .find(|executable| executable.eq_ignore_ascii_case(name))
        .map(|executable| format!("security process {executable}"))
}

/// The granted target this window belongs to, or the reason it has none.
pub fn admit<'a>(
    window: &WindowIdentity,
    granted: &'a [ApplicationTarget],
    correlation: Option<&str>,
) -> Result<(&'a ApplicationTarget, MatchEvidence), Refusal> {
    // Before the grant list, deliberately. A grant is a statement about an
    // application Noctis may arrange; it is never a statement about the taskbar.
    if let Some(detail) = is_protected(window) {
        return Err(Refusal::Protected { detail });
    }

    granted
        .iter()
        .map(|target| (target, evaluate(window, target, correlation)))
        .find(|(_, evidence)| evidence.is_actionable())
        .ok_or(Refusal::NotGranted)
}

/// Which window a target names, when a target can name more than one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Selection<'a> {
    /// Exactly one window, and the evidence that identified it.
    One(&'a WindowIdentity, MatchEvidence),
    /// Several, and no way to tell which was meant. Carried rather than reduced,
    /// so the caller can show them and ask.
    Ambiguous(Vec<&'a WindowIdentity>),
    /// The application is not running, or none of its windows are placeable.
    Absent,
}

impl<'a> Selection<'a> {
    /// Narrows an ambiguous selection using a hint from the work in hand — an
    /// Objective's workspace name, typically.
    ///
    /// This is not the title rule Section 11.2 forbids, and the difference is
    /// the order. Authorization has already happened: every candidate here is a
    /// window the grant list identified by executable and class. The hint only
    /// chooses among windows Noctis was already allowed to move, so a title
    /// nobody can vouch for cannot widen anything — at worst it fails to narrow,
    /// and the selection stays ambiguous.
    ///
    /// A hint matching several candidates narrows nothing and is left alone.
    pub fn narrow_by_title(self, hint: &str) -> Self {
        let Self::Ambiguous(candidates) = self else {
            return self;
        };

        let needle = hint.trim().to_lowercase();

        if needle.is_empty() {
            return Self::Ambiguous(candidates);
        }

        let matching: Vec<&'a WindowIdentity> = candidates
            .iter()
            .copied()
            .filter(|window| window.title.to_lowercase().contains(&needle))
            .collect();

        match matching.as_slice() {
            // The evidence is rebuilt as a title match rather than carried from
            // the original: what identified this window among its siblings was
            // the title, and the record should say so.
            [window] => Self::One(
                window,
                MatchEvidence {
                    launch_correlated: false,
                    executable_matched: true,
                    class_matched: true,
                    title_matched: true,
                },
            ),
            _ => Self::Ambiguous(candidates),
        }
    }
}

/// Picks the one window a placement request meant.
///
/// Identity answers "is this VS Code"; it does not answer "*which* VS Code". A
/// developer with two workspaces open has two windows that match a target
/// perfectly, and `EnumWindows` does not promise which comes back first — so
/// taking the first match would make placement depend on enumeration order,
/// which is the opposite of the deterministic regions this crate exists for.
///
/// Launch correlation settles it when Noctis opened the window itself. Otherwise
/// one candidate is the answer and several is a question, because choosing which
/// of somebody's editors to rearrange is not a choice to make on their behalf.
pub fn select_window<'a>(
    windows: &'a [WindowIdentity],
    target: &ApplicationTarget,
    correlation: Option<&str>,
) -> Selection<'a> {
    let candidates: Vec<(&'a WindowIdentity, MatchEvidence)> = windows
        .iter()
        .filter(|window| is_protected(window).is_none())
        .map(|window| (window, evaluate(window, target, correlation)))
        .filter(|(_, evidence)| evidence.is_actionable())
        .collect();

    let correlated: Vec<&(&'a WindowIdentity, MatchEvidence)> = candidates
        .iter()
        .filter(|(_, evidence)| evidence.launch_correlated)
        .collect();

    // Exactly one correlated window is the strongest answer available: Noctis
    // started that process for this piece of work and can prove it. More than
    // one is still a question, because a correlation that matches twice has not
    // narrowed anything.
    if let [(window, evidence)] = correlated.as_slice() {
        return Selection::One(window, *evidence);
    }

    match candidates.as_slice() {
        [] => Selection::Absent,
        [(window, evidence)] => Selection::One(window, *evidence),
        several => Selection::Ambiguous(several.iter().map(|(window, _)| *window).collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::fixtures::{vscode_target, window, VSCODE_PATH};

    fn granted() -> Vec<ApplicationTarget> {
        vec![vscode_target()]
    }

    #[test]
    fn admits_a_granted_application() {
        let editor = window(
            "Chrome_WidgetWin_1",
            "Visual Studio Code",
            Some(VSCODE_PATH),
        );
        let grants = granted();

        let (target, evidence) = admit(&editor, &grants, None).expect("admitted");

        assert_eq!(target.id, "vscode");
        assert!(evidence.is_actionable());
    }

    #[test]
    fn refuses_an_application_nobody_granted() {
        let slack = window("Chrome_WidgetWin_1", "Slack", Some("C:\\slack\\slack.exe"));

        assert_eq!(admit(&slack, &granted(), None), Err(Refusal::NotGranted));
    }

    #[test]
    fn refuses_the_taskbar() {
        let taskbar = window("Shell_TrayWnd", "", Some("C:\\Windows\\explorer.exe"));

        assert!(matches!(
            admit(&taskbar, &granted(), None),
            Err(Refusal::Protected { .. })
        ));
    }

    #[test]
    fn refuses_the_desktop_itself() {
        let desktop = window(
            "Progman",
            "Program Manager",
            Some("C:\\Windows\\explorer.exe"),
        );

        assert!(is_protected(&desktop).is_some());
    }

    #[test]
    fn refuses_the_consent_prompt() {
        let uac = window(
            "#32770",
            "User Account Control",
            Some("C:\\Windows\\System32\\consent.exe"),
        );

        assert!(matches!(
            admit(&uac, &granted(), None),
            Err(Refusal::Protected { .. })
        ));
    }

    #[test]
    fn refuses_the_credential_dialog_by_class_when_its_process_is_unreadable() {
        let credentials = window("Credential Dialog Xaml Host", "Windows Security", None);

        assert!(is_protected(&credentials).is_some());
    }

    /// THE GATE: Phase 9 says system and security windows cannot be moved. A
    /// grant wide enough to name one still must not reach it.
    #[test]
    fn refuses_a_protected_window_even_when_a_grant_would_have_matched_it() {
        let over_broad = ApplicationTarget {
            id: "everything".to_owned(),
            executable_names: vec!["consent.exe".to_owned()],
            executable_paths: Vec::new(),
            class_names: Vec::new(),
            title_contains: None,
        };
        let uac = window(
            "#32770",
            "User Account Control",
            Some("C:\\Windows\\System32\\consent.exe"),
        );

        // The grant genuinely matches, which is the point of the test.
        assert!(crate::identity::evaluate(&uac, &over_broad, None).is_actionable());
        assert!(matches!(
            admit(&uac, &[over_broad], None),
            Err(Refusal::Protected { .. })
        ));
    }

    /// Two VS Code workspaces open at once is the ordinary case, not the exotic
    /// one — the qualification probe found exactly this on the first machine it
    /// ran on.
    fn two_editors() -> Vec<WindowIdentity> {
        vec![
            WindowIdentity {
                handle: 0x109b6,
                title: "Noctis-OS - Visual Studio Code".to_owned(),
                ..window("Chrome_WidgetWin_1", "", Some(VSCODE_PATH))
            },
            WindowIdentity {
                handle: 0x109be,
                title: "JOBS - Visual Studio Code".to_owned(),
                ..window("Chrome_WidgetWin_1", "", Some(VSCODE_PATH))
            },
        ]
    }

    #[test]
    fn selects_the_only_window_an_application_has() {
        let one = vec![window("Chrome_WidgetWin_1", "Noctis-OS", Some(VSCODE_PATH))];

        assert!(matches!(
            select_window(&one, &vscode_target(), None),
            Selection::One(..)
        ));
    }

    /// THE GATE: `EnumWindows` promises no order, so picking the first match
    /// would make which editor gets moved depend on the order Windows happened
    /// to return today.
    #[test]
    fn refuses_to_guess_between_two_windows_of_the_same_application() {
        let editors = two_editors();

        match select_window(&editors, &vscode_target(), None) {
            Selection::Ambiguous(candidates) => assert_eq!(candidates.len(), 2),
            other => panic!("expected an ambiguous selection, got {other:?}"),
        }
    }

    /// The reason launch correlation is worth carrying at all: it is the one
    /// signal that distinguishes two otherwise identical windows.
    #[test]
    fn picks_the_window_noctis_opened_out_of_several() {
        let mut editors = two_editors();
        editors[1].launch_correlation_id = Some("run-7".to_owned());

        match select_window(&editors, &vscode_target(), Some("run-7")) {
            Selection::One(window, evidence) => {
                assert_eq!(window.handle, 0x109be);
                assert!(evidence.launch_correlated);
            }
            other => panic!("expected one window, got {other:?}"),
        }
    }

    /// A correlation that matches twice has narrowed nothing, and pretending
    /// otherwise would move whichever of them came back first.
    #[test]
    fn stays_ambiguous_when_the_correlation_matches_more_than_one_window() {
        let mut editors = two_editors();
        editors[0].launch_correlation_id = Some("run-7".to_owned());
        editors[1].launch_correlation_id = Some("run-7".to_owned());

        assert!(matches!(
            select_window(&editors, &vscode_target(), Some("run-7")),
            Selection::Ambiguous(_)
        ));
    }

    /// The `discovers` half of Phase 9's outcome: two editors are open and the
    /// Objective knows which workspace it is about.
    #[test]
    fn narrows_two_editors_by_the_workspace_the_objective_names() {
        let editors = two_editors();

        match select_window(&editors, &vscode_target(), None).narrow_by_title("Noctis-OS") {
            Selection::One(window, evidence) => {
                assert_eq!(window.handle, 0x109b6);
                assert!(evidence.title_matched);
                assert!(!evidence.launch_correlated);
            }
            other => panic!("expected one window, got {other:?}"),
        }
    }

    #[test]
    fn narrows_case_insensitively() {
        let editors = two_editors();

        assert!(matches!(
            select_window(&editors, &vscode_target(), None).narrow_by_title("jobs"),
            Selection::One(..)
        ));
    }

    /// THE GATE: a hint is not authority. It chooses among windows the grant list
    /// already admitted, so a hint that matches nothing admitted stays ambiguous
    /// rather than reaching outside the candidates.
    #[test]
    fn does_not_let_a_hint_reach_a_window_the_grant_list_refused() {
        let mut windows = two_editors();
        windows.push(WindowIdentity {
            title: "Noctis-OS — Slack".to_owned(),
            ..window("Chrome_WidgetWin_1", "", Some("C:\\slack\\slack.exe"))
        });

        // "Noctis-OS" matches the Slack window's title too, and it must not be
        // reachable: it was never a candidate.
        match select_window(&windows, &vscode_target(), None).narrow_by_title("Noctis-OS") {
            Selection::One(chosen, _) => assert_eq!(chosen.handle, 0x109b6),
            other => panic!("expected the editor, got {other:?}"),
        }
    }

    #[test]
    fn stays_ambiguous_when_a_hint_matches_nothing() {
        let editors = two_editors();

        assert!(matches!(
            select_window(&editors, &vscode_target(), None).narrow_by_title("some other repo"),
            Selection::Ambiguous(_)
        ));
    }

    #[test]
    fn stays_ambiguous_when_a_hint_matches_everything() {
        let editors = two_editors();

        assert!(matches!(
            select_window(&editors, &vscode_target(), None).narrow_by_title("Visual Studio Code"),
            Selection::Ambiguous(_)
        ));
    }

    /// An empty hint is the absence of a hint, not a match on every title.
    #[test]
    fn treats_a_blank_hint_as_no_hint() {
        let editors = two_editors();

        assert!(matches!(
            select_window(&editors, &vscode_target(), None).narrow_by_title("   "),
            Selection::Ambiguous(_)
        ));
    }

    #[test]
    fn leaves_an_unambiguous_selection_alone() {
        let one = vec![window("Chrome_WidgetWin_1", "Noctis-OS", Some(VSCODE_PATH))];

        assert!(matches!(
            select_window(&one, &vscode_target(), None).narrow_by_title("something else entirely"),
            Selection::One(..)
        ));
    }

    #[test]
    fn finds_nothing_when_the_application_is_not_running() {
        let others = vec![window(
            "Chrome_WidgetWin_1",
            "Slack",
            Some("C:\\slack\\slack.exe"),
        )];

        assert_eq!(
            select_window(&others, &vscode_target(), None),
            Selection::Absent
        );
    }

    /// Selection filters protected windows itself rather than trusting the
    /// caller to have done it, because it is the function a caller reaches for.
    #[test]
    fn never_selects_a_protected_window() {
        let over_broad = ApplicationTarget {
            id: "everything".to_owned(),
            executable_names: vec!["explorer.exe".to_owned()],
            executable_paths: Vec::new(),
            class_names: Vec::new(),
            title_contains: None,
        };
        let taskbar = vec![window(
            "Shell_TrayWnd",
            "",
            Some("C:\\Windows\\explorer.exe"),
        )];

        assert_eq!(
            select_window(&taskbar, &over_broad, None),
            Selection::Absent
        );
    }

    #[test]
    fn leaves_an_ordinary_explorer_window_alone_to_the_grant_list() {
        let folder = window(
            "CabinetWClass",
            "Downloads",
            Some("C:\\Windows\\explorer.exe"),
        );

        assert!(is_protected(&folder).is_none());
        assert_eq!(admit(&folder, &granted(), None), Err(Refusal::NotGranted));
    }
}

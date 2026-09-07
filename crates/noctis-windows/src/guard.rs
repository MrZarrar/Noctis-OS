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

//! The read-only instrument the Windows qualification runbook uses.
//!
//! Prints the display arrangement, this process's DPI awareness, and every
//! top-level window with the identity verdict the placement layer would reach.
//! It moves nothing and asks for no authority, so it is safe to run at any point
//! in a qualification pass — including before deciding whether a machine is one
//! Noctis can place windows on at all.
//!
//! `cargo run -p noctis-windows --example qualify`

use noctis_windows::guard::{is_protected, select_window, Selection};
use noctis_windows::identity::ApplicationTarget;
use noctis_windows::monitor::MonitorRole;
use noctis_windows::region::{resolve, PlacementRequest, RegionName};
use noctis_windows::win32;

/// The targets the Phase 9 vertical slice cares about.
///
/// `emulator` is a fixture until an emulator is installed on a qualification
/// machine: the entry proves the grant list handles a target that matches
/// nothing, which is the state every target is in before its application is
/// running.
fn targets() -> Vec<ApplicationTarget> {
    vec![
        ApplicationTarget {
            id: "vscode".to_owned(),
            executable_names: vec!["code.exe".to_owned()],
            executable_paths: Vec::new(),
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

fn main() {
    let aware = win32::is_per_monitor_dpi_aware();

    println!("per-monitor DPI aware: {aware}");

    if !aware {
        // Said plainly rather than footnoted. Every number below this line is
        // virtualized into the primary display's DPI space when it is false, so
        // a qualification pass run in this state proves nothing about a scaled
        // display.
        println!("  WARNING: coordinates below are virtualized; placement would be wrong");
        println!("  (the Tauri shell sets per-monitor v2 via tao when its event loop starts)");
    }

    println!("\ndisplays");

    for monitor in win32::monitors() {
        let area = monitor.work_area;
        println!(
            "  {:<16} work {:>6},{:<6} {:>5}x{:<5} scale {:>3}%{}",
            monitor.id,
            area.x,
            area.y,
            area.width,
            area.height,
            monitor.scale_percent,
            if monitor.primary { "  primary" } else { "" }
        );
    }

    let granted = targets();
    let windows = win32::top_level_windows();
    let displays = win32::monitors();

    // Every window, not only the matches. A target whose class name has drifted
    // looks exactly like a target whose application is not running, and only the
    // full list tells the two apart.
    println!("\n{} top-level windows", windows.len());

    for window in &windows {
        let verdict = match is_protected(window) {
            Some(reason) => format!("refused: {reason}"),
            None => granted
                .iter()
                .find(|target| {
                    matches!(
                        select_window(std::slice::from_ref(window), target, None),
                        Selection::One(..)
                    )
                })
                .map_or_else(
                    || "not granted".to_owned(),
                    |target| format!("-> {}", target.id),
                ),
        };

        println!(
            "  hwnd {:#010x} pid {:<6} {:<28} {:<14} {}",
            window.handle,
            window.process_id,
            truncate(&window.class_name, 28),
            verdict,
            truncate(&window.title, 60)
        );
        println!(
            "      {}",
            window
                .executable_path
                .as_deref()
                .unwrap_or("<unreadable: higher integrity>")
        );
    }

    // The question the placement layer actually asks, per target. This is the
    // line a qualification pass reads: `ambiguous` is a real outcome, not a bug,
    // and it is the one a machine with two editors open produces.
    println!("\nselection per target");

    // The hint an Objective about this repository would carry. Passed to every
    // target so the output shows what it does and does not narrow.
    let hint = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "Noctis-OS".to_owned());

    println!("  (narrowing hint: {hint:?} — pass one as the first argument)");

    for target in &granted {
        match select_window(&windows, target, None).narrow_by_title(&hint) {
            Selection::One(window, evidence) => {
                println!(
                    "  {:<10} one window, hwnd {:#010x}  (launch {} exe {} class {} title {})",
                    target.id,
                    window.handle,
                    evidence.launch_correlated,
                    evidence.executable_matched,
                    evidence.class_matched,
                    evidence.title_matched
                );
            }
            Selection::Ambiguous(candidates) => {
                println!(
                    "  {:<10} AMBIGUOUS, {} candidates — placement would have to ask",
                    target.id,
                    candidates.len()
                );
                for candidate in candidates {
                    println!("             {}", truncate(&candidate.title, 70));
                }
            }
            Selection::Absent => println!("  {:<10} not running", target.id),
        }
    }

    // The focus-mode layout, resolved but not applied. Nothing below moves a
    // window; it prints the rectangles a placement would ask for, so a
    // qualification pass can check them against the display arrangement above
    // before anything is granted.
    println!("\nfocus-mode layout, resolved (nothing is moved)");

    for (label, monitor, region) in [
        ("vscode", MonitorRole::Primary, RegionName::LeftTwoThirds),
        ("emulator", MonitorRole::Primary, RegionName::RightThird),
        ("noctis", MonitorRole::Secondary, RegionName::Full),
    ] {
        let request = PlacementRequest {
            monitor,
            region,
            minimum_dip: (600, 400),
        };

        match resolve(request, &displays, None) {
            Some(resolution) => println!(
                "  {:<10} {:<16} {:>6},{:<6} {:>5}x{:<5} {:?}",
                label,
                resolution.monitor_id,
                resolution.placement.x,
                resolution.placement.y,
                resolution.placement.width,
                resolution.placement.height,
                resolution.notes
            ),
            None => println!("  {label:<10} no display to place on"),
        }
    }
}

fn truncate(text: &str, width: usize) -> String {
    let characters: Vec<char> = text.chars().collect();

    if characters.len() <= width {
        return text.to_owned();
    }

    characters[..width.saturating_sub(1)]
        .iter()
        .collect::<String>()
        + "…"
}

//! Keeping Noctis out of the way of what it just arranged.
//!
//! Section 11.2: "compose Noctis with native windows without covering critical
//! controls." Focus mode puts the tools on one display and Noctis on another —
//! the layout has always said so — but Noctis has to actually move for that to
//! be true, and it is the one window Noctis may move without asking anybody,
//! because it is its own.

use crate::geometry::{fit, overlaps, Placement};
use crate::monitor::Monitor;

/// The smallest Noctis's own window is ever shrunk to, in physical pixels.
///
/// Matches the shell's own `MIN_SIZE`. A Noctis window narrower than this cannot
/// show a Surface, and a plan Surface nobody can read is not a retained plan.
const MIN_SIZE: (u32, u32) = (800, 600);

/// Where Noctis should move so it is not covering the window just placed.
///
/// `None` means stay put, and it means that for two quite different reasons
/// which the caller does not need to tell apart: either Noctis is already out
/// of the way, or there is nowhere better to go. Both come out as "do nothing",
/// and the second is honest — a single-display machine running focus mode has
/// genuinely nowhere to put Noctis that is not on top of the work.
///
/// Deliberately not "always move to the secondary display". Somebody who has
/// put Noctis where they want it should not have it relocated because a
/// placement happened somewhere it was never in the way of.
pub fn make_room(
    noctis: &Placement,
    placed: &Placement,
    monitors: &[Monitor],
) -> Option<Placement> {
    if !overlaps(noctis, placed) {
        return None;
    }

    // A display the placed window is not on. Ordered by device name rather than
    // by position so that two candidate displays resolve the same way twice.
    let mut elsewhere: Vec<&Monitor> = monitors
        .iter()
        .filter(|monitor| {
            !overlaps(
                placed,
                &Placement {
                    x: monitor.work_area.x,
                    y: monitor.work_area.y,
                    width: monitor.work_area.width,
                    height: monitor.work_area.height,
                    maximized: false,
                },
            )
        })
        .collect();

    elsewhere.sort_by(|left, right| left.id.cmp(&right.id));

    let destination = elsewhere.first()?;
    let area = destination.work_area;

    Some(fit(
        Placement {
            x: area.x,
            y: area.y,
            width: area.width,
            height: area.height,
            // Un-maximized on purpose. A maximized window ignores a position,
            // so moving one to another display sets coordinates that never
            // apply — the caller has to clear the state before it means
            // anything.
            maximized: false,
        },
        &area,
        MIN_SIZE,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monitor::fixtures::{monitor, primary};

    fn desk() -> Vec<Monitor> {
        vec![
            primary(monitor("\\\\.\\DISPLAY1", 0, 0, 2560, 1440, 100)),
            monitor("\\\\.\\DISPLAY2", 2560, 252, 1920, 1080, 100),
        ]
    }

    fn placement(x: i32, y: i32, width: u32, height: u32) -> Placement {
        Placement {
            x,
            y,
            width,
            height,
            maximized: false,
        }
    }

    /// The case that was reported: Noctis full-screen on the primary, the editor
    /// arranged into the left two thirds of that same display. The arrangement
    /// was right and invisible.
    #[test]
    fn moves_noctis_off_the_display_it_would_be_covering() {
        let noctis = placement(0, 0, 2560, 1440);
        let editor = placement(0, 0, 1706, 1440);

        let moved = make_room(&noctis, &editor, &desk()).expect("somewhere to go");

        assert_eq!((moved.x, moved.y), (2560, 252));
        assert_eq!((moved.width, moved.height), (1920, 1080));
    }

    /// The case that already worked, and must keep working: Noctis on the
    /// secondary display is not in the way, so it stays exactly where it is.
    #[test]
    fn leaves_noctis_alone_when_it_is_already_out_of_the_way() {
        let noctis = placement(2560, 252, 1920, 1080);
        let editor = placement(0, 0, 1706, 1440);

        assert_eq!(make_room(&noctis, &editor, &desk()), None);
    }

    /// THE GATE: somebody who has put Noctis where they want it should not have
    /// it relocated because a placement happened somewhere it was never covering.
    #[test]
    fn leaves_noctis_alone_when_it_shares_a_display_but_not_the_region() {
        // Noctis in the right third, the editor in the left two thirds. Same
        // display, no overlap — which is the layout working, not a collision.
        let noctis = placement(1706, 0, 854, 1440);
        let editor = placement(0, 0, 1706, 1440);

        assert_eq!(make_room(&noctis, &editor, &desk()), None);
    }

    /// A single display has nowhere to put Noctis that is not on top of the
    /// work. Saying so by doing nothing is better than shuffling it somewhere
    /// equally covered.
    #[test]
    fn stays_put_when_there_is_no_other_display() {
        let one = vec![primary(monitor("\\\\.\\DISPLAY1", 0, 0, 2560, 1440, 100))];
        let noctis = placement(0, 0, 2560, 1440);
        let editor = placement(0, 0, 1706, 1440);

        assert_eq!(make_room(&noctis, &editor, &one), None);
    }

    /// Moving a maximized window sets coordinates Windows ignores, so the
    /// destination is never itself maximized.
    #[test]
    fn never_asks_for_a_maximized_destination() {
        let noctis = Placement {
            maximized: true,
            ..placement(0, 0, 2560, 1440)
        };

        let moved = make_room(&noctis, &placement(0, 0, 1706, 1440), &desk()).expect("a move");

        assert!(!moved.maximized);
    }

    #[test]
    fn resolves_the_same_destination_whatever_order_the_displays_arrive_in() {
        let displays = desk();
        let reversed: Vec<Monitor> = displays.iter().rev().cloned().collect();
        let noctis = placement(0, 0, 2560, 1440);
        let editor = placement(0, 0, 1706, 1440);

        assert_eq!(
            make_room(&noctis, &editor, &displays),
            make_room(&noctis, &editor, &reversed)
        );
    }

    #[test]
    fn has_nowhere_to_go_when_no_display_is_known() {
        assert_eq!(
            make_room(&placement(0, 0, 800, 600), &placement(0, 0, 800, 600), &[]),
            None
        );
    }
}

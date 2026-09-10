//! Rectangle arithmetic shared by Noctis's own crash-safe restore and by the
//! placement of other applications' windows.
//!
//! One implementation deliberately: "put this rectangle somewhere it can
//! actually be seen" is the same problem in both cases, and two copies of it
//! would be two copies that disagree the first time one of them is fixed.

use serde::{Deserialize, Serialize};

/// A window rectangle in virtual-screen physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Placement {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

/// A monitor's work area: the part of it a window may occupy, so the taskbar is
/// already excluded. Coordinates are virtual-screen, so a monitor to the left of
/// the primary has a negative `x`, which is why nothing here clamps to zero.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkArea {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// How much of a rectangle still falls on a monitor. Zero means the monitor it
/// was on is gone, or moved, or resized out from under it.
pub fn overlap(area: &WorkArea, placement: &Placement) -> i64 {
    let width = span(area.x, area.width, placement.x, placement.width);
    let height = span(area.y, area.height, placement.y, placement.height);

    width * height
}

fn span(area_start: i32, area_size: u32, saved_start: i32, saved_size: u32) -> i64 {
    let area_end = i64::from(area_start) + i64::from(area_size);
    let saved_end = i64::from(saved_start) + i64::from(saved_size);
    let overlap = area_end.min(saved_end) - i64::from(area_start).max(i64::from(saved_start));

    overlap.max(0)
}

fn clamp_position(area_start: i32, area_size: u32, wanted: i32, size: u32) -> i32 {
    let last = i64::from(area_start) + i64::from(area_size) - i64::from(size);
    let clamped = i64::from(wanted).clamp(
        i64::from(area_start).min(last),
        last.max(i64::from(area_start)),
    );

    i32::try_from(clamped).unwrap_or(area_start)
}

/// Slides and shrinks `wanted` until it sits fully inside `area`.
///
/// `minimum` is in the same physical pixels as everything else here; a caller
/// holding a minimum size in device-independent pixels must scale it for this
/// monitor first, because 800 logical pixels is 1200 physical ones at 150%.
///
/// A window whose monitor is gone needs no separate case: clamping a position
/// that is nowhere near this monitor slides it fully onto it, which is the whole
/// requirement.
pub fn fit(wanted: Placement, area: &WorkArea, minimum: (u32, u32)) -> Placement {
    let width = wanted.width.clamp(minimum.0.min(area.width), area.width);
    let height = wanted.height.clamp(minimum.1.min(area.height), area.height);

    Placement {
        x: clamp_position(area.x, area.width, wanted.x, width),
        y: clamp_position(area.y, area.height, wanted.y, height),
        width,
        height,
        maximized: wanted.maximized,
    }
}

/// Whether a window has been moved or resized away from where it was put.
///
/// This is how Noctis notices that a person disagreed with it. There is no hook
/// and no polling: the only moment the answer matters is when Noctis is about to
/// place the same window again, so it is asked then, by comparing the window's
/// position now against the position Noctis last observed after placing it.
///
/// `tolerance` is not zero because an application is entitled to adjust its own
/// size a moment after being placed — an editor settling on its minimum width is
/// not a person dragging a window, and treating it as one would hand every
/// window an override nobody asked for.
///
/// A maximized window is never a position preference, and this is the correction
/// to a rule that had it backwards.
///
/// Maximizing *is* unmistakably somebody's decision — but it is a decision about
/// state, not about position, and a maximized window's rectangle is not a place
/// anybody chose. It is the display. Treating it as a preference stored "always
/// fill the screen", which is the opposite of a named region, and made a
/// maximized window that was correctly un-maximized and then placed at its
/// "preferred" full-display position look exactly like one that had never been
/// un-maximized at all.
///
/// So somebody who maximizes a window and then asks Noctis to arrange it is
/// asking for the region. Somebody who wants it maximized simply does not ask.
pub fn moved_by_hand(placed: &Placement, now: &Placement, tolerance: i32) -> bool {
    if now.maximized {
        return false;
    }

    let shifted = (placed.x - now.x).abs() > tolerance || (placed.y - now.y).abs() > tolerance;
    let resized = placed.width.abs_diff(now.width) > tolerance.unsigned_abs()
        || placed.height.abs_diff(now.height) > tolerance.unsigned_abs();

    shifted || resized
}

/// Whether two rectangles share any pixel at all.
pub fn overlaps(one: &Placement, other: &Placement) -> bool {
    let width = span(one.x, one.width, other.x, other.width);
    let height = span(one.y, one.height, other.y, other.height);

    width > 0 && height > 0
}

/// The work area a rectangle has most of itself on, or `None` when nothing is
/// known about the displays — in which case any correction would be a guess
/// dressed up as a fact.
pub fn home_area<'a>(areas: &'a [WorkArea], placement: &Placement) -> Option<&'a WorkArea> {
    areas.iter().max_by_key(|area| overlap(area, placement))
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRIMARY: WorkArea = WorkArea {
        x: 0,
        y: 0,
        width: 2560,
        height: 1400,
    };
    /// A monitor physically to the left of the primary: the case that breaks any
    /// arithmetic that treats a negative coordinate as invalid.
    const LEFT: WorkArea = WorkArea {
        x: -1920,
        y: 0,
        width: 1920,
        height: 1080,
    };

    fn placement(x: i32, y: i32, width: u32, height: u32) -> Placement {
        Placement {
            x,
            y,
            width,
            height,
            maximized: false,
        }
    }

    #[test]
    fn leaves_a_rectangle_alone_when_it_already_fits() {
        let wanted = placement(100, 120, 1280, 800);

        assert_eq!(fit(wanted, &PRIMARY, (800, 600)), wanted);
    }

    #[test]
    fn fits_a_rectangle_onto_a_monitor_at_negative_coordinates() {
        let wanted = placement(-1800, 40, 1280, 800);

        assert_eq!(fit(wanted, &LEFT, (800, 600)), wanted);
    }

    #[test]
    fn pulls_a_rectangle_hanging_off_the_edge_fully_back_on() {
        let fitted = fit(placement(2500, 1380, 1280, 800), &PRIMARY, (800, 600));

        assert_eq!(fitted.x, 2560 - 1280);
        assert_eq!(fitted.y, 1400 - 800);
    }

    #[test]
    fn shrinks_a_rectangle_larger_than_the_work_area() {
        let fitted = fit(placement(0, 0, 4000, 3000), &LEFT, (800, 600));

        assert_eq!((fitted.width, fitted.height), (LEFT.width, LEFT.height));
    }

    #[test]
    fn never_fits_a_rectangle_below_the_minimum_size() {
        let fitted = fit(placement(10, 10, 200, 100), &PRIMARY, (800, 600));

        assert_eq!((fitted.width, fitted.height), (800, 600));
    }

    /// A minimum larger than the monitor is the monitor's problem, not a reason
    /// to place a window wider than the screen it is going on.
    #[test]
    fn lets_the_work_area_win_when_the_minimum_will_not_fit_on_it() {
        let tiny = WorkArea {
            x: 0,
            y: 0,
            width: 640,
            height: 480,
        };

        let fitted = fit(placement(0, 0, 200, 100), &tiny, (800, 600));

        assert_eq!((fitted.width, fitted.height), (640, 480));
    }

    #[test]
    fn preserves_maximized() {
        let wanted = Placement {
            maximized: true,
            ..placement(100, 100, 1280, 800)
        };

        assert!(fit(wanted, &PRIMARY, (800, 600)).maximized);
    }

    #[test]
    fn picks_the_monitor_a_rectangle_has_most_of_itself_on() {
        let saved = placement(-1800, 40, 1280, 800);

        assert_eq!(home_area(&[PRIMARY, LEFT], &saved), Some(&LEFT));
    }

    #[test]
    fn knows_nothing_about_a_home_when_no_monitor_is_known() {
        assert_eq!(home_area(&[], &placement(0, 0, 100, 100)), None);
    }

    #[test]
    fn sees_no_hand_on_a_window_still_where_it_was_put() {
        let placed = placement(0, 0, 1706, 1440);

        assert!(!moved_by_hand(&placed, &placed, 2));
    }

    /// THE GATE: a person dragging a window Noctis placed is the signal that
    /// their position wins from then on. Missing it means Noctis moves it back.
    #[test]
    fn sees_a_hand_on_a_window_somebody_dragged() {
        let placed = placement(0, 0, 1706, 1440);
        let dragged = placement(400, 120, 1706, 1440);

        assert!(moved_by_hand(&placed, &dragged, 2));
    }

    #[test]
    fn sees_a_hand_on_a_window_somebody_resized() {
        let placed = placement(0, 0, 1706, 1440);

        assert!(moved_by_hand(&placed, &placement(0, 0, 1200, 1440), 2));
        assert!(moved_by_hand(&placed, &placement(0, 0, 1706, 900), 2));
    }

    /// An application settling on its own minimum size a moment after being
    /// placed is not somebody's decision, and treating it as one would hand
    /// every window an override nobody asked for.
    #[test]
    fn ignores_a_shift_inside_the_tolerance() {
        let placed = placement(300, 200, 900, 700);

        assert!(!moved_by_hand(&placed, &placement(301, 199, 902, 698), 2));
    }

    /// THE GATE: a maximized window is not a position preference, and this test
    /// replaces one that asserted the opposite.
    ///
    /// The reported symptom was a maximized window that "never un-maximized".
    /// It did — and was then placed at the position that had been recorded as
    /// preferred, which was the whole display, so it looked identical. A
    /// maximized rectangle is the display's, not anybody's choice.
    #[test]
    fn takes_no_preference_from_a_maximized_window() {
        let placed = placement(0, 0, 1706, 1440);
        let maximized = Placement {
            maximized: true,
            x: -8,
            y: -8,
            width: 2576,
            height: 1456,
        };

        assert!(!moved_by_hand(&placed, &maximized, 2));
    }

    /// Un-maximizing to somewhere specific *is* a position, and is honoured.
    #[test]
    fn sees_a_hand_when_a_window_is_un_maximized_somewhere_of_its_own() {
        let maximized = Placement {
            maximized: true,
            ..placement(0, 0, 2560, 1440)
        };

        assert!(moved_by_hand(
            &maximized,
            &placement(400, 200, 1200, 800),
            2
        ));
    }

    /// Un-maximizing back to where Noctis put it is not a new preference.
    #[test]
    fn sees_no_hand_when_a_window_returns_to_where_it_was_placed() {
        let placed = placement(0, 0, 1706, 1440);
        let maximized = Placement {
            maximized: true,
            ..placed
        };

        assert!(!moved_by_hand(&maximized, &placed, 2));
    }

    /// The comparison must not overflow on a window at an absurd coordinate,
    /// which is what a window on a monitor that has just been unplugged looks
    /// like.
    #[test]
    fn survives_comparing_rectangles_at_the_edges_of_the_coordinate_space() {
        let far = placement(i32::MIN / 2, i32::MAX / 2, 1, 1);
        let near = placement(0, 0, 1, 1);

        assert!(moved_by_hand(&far, &near, 2));
        assert!(moved_by_hand(&near, &far, 2));
    }
}

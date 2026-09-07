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
}

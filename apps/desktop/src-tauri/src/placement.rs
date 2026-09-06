use std::path::Path;

use serde::{Deserialize, Serialize};

/// The window is never restored smaller than this, whatever was saved.
pub const MIN_SIZE: (u32, u32) = (800, 600);

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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkArea {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// How much of a saved window still falls on a monitor. Zero means the monitor
/// it was on is gone, or moved, or resized out from under it.
fn overlap(area: &WorkArea, saved: &Placement) -> i64 {
    let width = span(area.x, area.width, saved.x, saved.width);
    let height = span(area.y, area.height, saved.y, saved.height);

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

/// Puts a saved window back somewhere it can actually be seen.
///
/// Deliberately deterministic and monitor-driven: the saved rectangle is a
/// request, and the display arrangement at this moment decides what is honoured.
/// A window whose monitor is still there does not move; one that hangs off an
/// edge, is larger than its monitor, or was on a monitor that is now gone is
/// slid and shrunk until it is fully on a monitor that exists.
pub fn restore(saved: Placement, monitors: &[WorkArea]) -> Placement {
    // The monitor the window still has most of itself on; failing that, whichever
    // one comes last, since every candidate overlaps it by nothing.
    let Some(home) = monitors
        .iter()
        .copied()
        .max_by_key(|area| overlap(area, &saved))
    else {
        // Nothing is known about the displays, so anything this function did
        // would be a guess dressed up as a correction.
        return saved;
    };

    let width = saved.width.clamp(MIN_SIZE.0.min(home.width), home.width);
    let height = saved.height.clamp(MIN_SIZE.1.min(home.height), home.height);

    // A window whose monitor is gone needs no separate case: clamping a position
    // that is nowhere near this monitor slides it fully onto it, which is the
    // whole requirement. Centring it instead was a branch no test could tell
    // apart from this one, which is how sabotage found it.
    Placement {
        x: clamp_position(home.x, home.width, saved.x, width),
        y: clamp_position(home.y, home.height, saved.y, height),
        width,
        height,
        maximized: saved.maximized,
    }
}

pub fn load(path: &Path) -> Option<Placement> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// Written through a temporary file and renamed into place.
///
/// This is called on every move and resize rather than only on exit, so that a
/// crash keeps the last position instead of the position from the last clean
/// shutdown. Writing in place that often is how you end up restoring from a
/// half-written file.
pub fn save(path: &Path, placement: &Placement) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let temporary = path.with_extension("tmp");
    let body = serde_json::to_vec_pretty(placement).map_err(std::io::Error::other)?;

    std::fs::write(&temporary, body)?;
    std::fs::rename(&temporary, path)
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
    /// restore that treats a negative coordinate as invalid.
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
    fn leaves_a_window_where_it_was_when_its_monitor_is_still_there() {
        let saved = placement(100, 120, 1280, 800);

        assert_eq!(restore(saved, &[PRIMARY, LEFT]), saved);
    }

    #[test]
    fn keeps_a_window_on_a_monitor_at_negative_coordinates() {
        let saved = placement(-1800, 40, 1280, 800);

        assert_eq!(restore(saved, &[PRIMARY, LEFT]), saved);
    }

    #[test]
    fn brings_a_window_back_to_the_primary_when_its_monitor_is_gone() {
        let saved = placement(-1800, 40, 1280, 800);

        let restored = restore(saved, &[PRIMARY]);

        assert_eq!(restored.width, 1280);
        assert_eq!(restored.height, 800);
        assert!(restored.x >= PRIMARY.x);
        assert!(restored.x + 1280 <= PRIMARY.x + i32::try_from(PRIMARY.width).expect("width"));
    }

    #[test]
    fn pulls_a_window_hanging_off_the_edge_fully_back_on() {
        let restored = restore(placement(2500, 1380, 1280, 800), &[PRIMARY]);

        assert_eq!(restored.x, 2560 - 1280);
        assert_eq!(restored.y, 1400 - 800);
    }

    #[test]
    fn shrinks_a_window_larger_than_the_work_area() {
        let restored = restore(placement(0, 0, 4000, 3000), &[LEFT]);

        assert_eq!((restored.width, restored.height), (LEFT.width, LEFT.height));
    }

    #[test]
    fn never_restores_a_window_below_the_minimum_size() {
        let restored = restore(placement(10, 10, 200, 100), &[PRIMARY]);

        assert_eq!((restored.width, restored.height), MIN_SIZE);
    }

    #[test]
    fn preserves_maximized() {
        let saved = Placement {
            maximized: true,
            ..placement(100, 100, 1280, 800)
        };

        assert!(restore(saved, &[PRIMARY]).maximized);
    }

    #[test]
    fn leaves_the_placement_alone_when_no_monitor_is_known() {
        let saved = placement(-9000, -9000, 1280, 800);

        assert_eq!(restore(saved, &[]), saved);
    }

    #[test]
    fn round_trips_through_a_file() {
        let directory =
            std::env::temp_dir().join(format!("noctis-placement-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("directory");
        let path = directory.join("window.json");
        let saved = placement(12, 34, 1280, 800);

        save(&path, &saved).expect("save");

        assert_eq!(load(&path), Some(saved));

        std::fs::remove_dir_all(&directory).expect("cleanup");
    }

    #[test]
    fn treats_an_unreadable_placement_as_no_placement() {
        let directory = std::env::temp_dir().join(format!("noctis-corrupt-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("directory");
        let path = directory.join("window.json");

        std::fs::write(&path, "half a file").expect("write");

        assert_eq!(load(&path), None);
        assert_eq!(load(&directory.join("absent.json")), None);

        std::fs::remove_dir_all(&directory).expect("cleanup");
    }
}

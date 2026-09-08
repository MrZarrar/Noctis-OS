use std::path::Path;

use noctis_windows::geometry::{fit, home_area};
pub use noctis_windows::geometry::{Placement, WorkArea};

/// The window is never restored smaller than this, whatever was saved.
pub const MIN_SIZE: (u32, u32) = (800, 600);

/// Puts a saved window back somewhere it can actually be seen.
///
/// Deliberately deterministic and monitor-driven: the saved rectangle is a
/// request, and the display arrangement at this moment decides what is honoured.
/// A window whose monitor is still there does not move; one that hangs off an
/// edge, is larger than its monitor, or was on a monitor that is now gone is
/// slid and shrunk until it is fully on a monitor that exists.
///
/// The arithmetic lives in `noctis-windows` because placing another
/// application's window into a named region is the same problem, and two copies
/// of it would be two copies that disagree the first time one is fixed.
pub fn restore(saved: Placement, monitors: &[WorkArea]) -> Placement {
    // The monitor the window still has most of itself on. Nothing known about
    // the displays means anything this function did would be a guess dressed up
    // as a correction.
    let Some(home) = home_area(monitors, &saved) else {
        return saved;
    };

    fit(saved, home, MIN_SIZE)
}

/// Reads a JSON file, or `None` for any reason it could not be read.
///
/// Generic because Phase 9 stores a second thing the same way — the positions a
/// person moved a window to, which must survive a restart or "the user always
/// wins" would only mean "until Noctis is restarted". One atomic
/// write-and-rename rather than two.
pub fn load<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// Written through a temporary file and renamed into place.
///
/// This is called on every move and resize rather than only on exit, so that a
/// crash keeps the last position instead of the position from the last clean
/// shutdown. Writing in place that often is how you end up restoring from a
/// half-written file.
pub fn save<T: serde::Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let temporary = path.with_extension("tmp");
    let body = serde_json::to_vec_pretty(value).map_err(std::io::Error::other)?;

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

        assert_eq!(load::<Placement>(&path), None);
        assert_eq!(load::<Placement>(&directory.join("absent.json")), None);

        std::fs::remove_dir_all(&directory).expect("cleanup");
    }
}

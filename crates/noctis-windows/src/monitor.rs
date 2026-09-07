//! The display arrangement a placement is resolved against.
//!
//! Nothing here talks to Win32. The live inventory is read in `win32` and
//! handed in as data, so every rule below is provable on any machine and the
//! qualification fixtures are the same type the real enumeration produces.

use serde::{Deserialize, Serialize};

use crate::geometry::WorkArea;

/// One display.
///
/// `scale_percent` is the monitor's DPI scaling — 100, 125, 150, 175, 200. Work
/// areas are already in physical pixels, so the scale is not applied to them; it
/// exists to convert a minimum window size expressed in device-independent
/// pixels into the physical pixels a placement is measured in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Monitor {
    /// The stable device name, `\\.\DISPLAY1` and friends. Used as evidence and
    /// for tie-breaking, never as an ordering the caller can rely on.
    pub id: String,
    pub work_area: WorkArea,
    pub scale_percent: u32,
    pub primary: bool,
}

impl Monitor {
    /// Converts a size in device-independent pixels to this monitor's physical
    /// pixels. 800 DIP is 1200 physical pixels at 150%, and a minimum size that
    /// skipped this step would be a third too small on a scaled display.
    pub fn to_physical(&self, dip: (u32, u32)) -> (u32, u32) {
        let scale = |value: u32| {
            u32::try_from(u64::from(value) * u64::from(self.scale_percent) / 100).unwrap_or(value)
        };

        (scale(dip.0), scale(dip.1))
    }
}

/// Which display a named region belongs to.
///
/// Deliberately a role rather than an index: an index is a coordinate by another
/// name, and Win32 does not promise a stable enumeration order between calls,
/// let alone across a disconnect and reconnect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MonitorRole {
    Primary,
    Secondary,
}

/// Orders displays left to right, then top to bottom, then by device name.
///
/// The device name is the last tie-break rather than the first, so two monitors
/// stacked at the same `x` still resolve deterministically, and the answer does
/// not change because Windows enumerated them the other way round this time.
fn arranged(monitors: &[Monitor]) -> Vec<&Monitor> {
    let mut ordered: Vec<&Monitor> = monitors.iter().collect();

    ordered.sort_by(|left, right| {
        (left.work_area.x, left.work_area.y, left.id.as_str()).cmp(&(
            right.work_area.x,
            right.work_area.y,
            right.id.as_str(),
        ))
    });

    ordered
}

/// The display a role names, and whether the answer had to be degraded.
///
/// A `Secondary` request on a one-monitor machine resolves to the primary and
/// says so, rather than silently doing the right thing or silently doing
/// nothing. Section 11.2 asks for a visible degrade, not a guess.
pub fn select(monitors: &[Monitor], role: MonitorRole) -> Option<(&Monitor, bool)> {
    let ordered = arranged(monitors);
    let primary = ordered
        .iter()
        .copied()
        .find(|monitor| monitor.primary)
        // A display set with no primary flag is malformed rather than empty, and
        // the leftmost display is a better answer than refusing to place at all.
        .or_else(|| ordered.first().copied())?;

    match role {
        MonitorRole::Primary => Some((primary, false)),
        MonitorRole::Secondary => match ordered
            .iter()
            .copied()
            .find(|monitor| monitor.id != primary.id)
        {
            Some(secondary) => Some((secondary, false)),
            None => Some((primary, true)),
        },
    }
}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    pub fn monitor(id: &str, x: i32, y: i32, width: u32, height: u32, scale: u32) -> Monitor {
        Monitor {
            id: id.to_owned(),
            work_area: WorkArea {
                x,
                y,
                width,
                height,
            },
            scale_percent: scale,
            primary: false,
        }
    }

    pub fn primary(monitor: Monitor) -> Monitor {
        Monitor {
            primary: true,
            ..monitor
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    #[test]
    fn scales_a_minimum_size_into_a_monitors_physical_pixels() {
        assert_eq!(
            monitor("A", 0, 0, 2560, 1440, 100).to_physical((800, 600)),
            (800, 600)
        );
        assert_eq!(
            monitor("A", 0, 0, 2560, 1440, 150).to_physical((800, 600)),
            (1200, 900)
        );
        assert_eq!(
            monitor("A", 0, 0, 2560, 1440, 175).to_physical((800, 600)),
            (1400, 1050)
        );
    }

    #[test]
    fn finds_the_primary_display() {
        let displays = [
            monitor("B", 2560, 0, 1920, 1080, 100),
            primary(monitor("A", 0, 0, 2560, 1440, 100)),
        ];

        let (chosen, degraded) = select(&displays, MonitorRole::Primary).expect("a display");

        assert_eq!(chosen.id, "A");
        assert!(!degraded);
    }

    #[test]
    fn finds_the_secondary_display() {
        let displays = [
            primary(monitor("A", 0, 0, 2560, 1440, 100)),
            monitor("B", 2560, 252, 1920, 1080, 100),
        ];

        let (chosen, degraded) = select(&displays, MonitorRole::Secondary).expect("a display");

        assert_eq!(chosen.id, "B");
        assert!(!degraded);
    }

    /// Win32 does not promise an enumeration order, so the same arrangement
    /// handed over in a different order has to give the same answer.
    #[test]
    fn resolves_the_same_secondary_whatever_order_the_displays_arrive_in() {
        let left = monitor("LEFT", -1920, 0, 1920, 1080, 100);
        let centre = primary(monitor("CENTRE", 0, 0, 2560, 1440, 100));
        let right = monitor("RIGHT", 2560, 252, 1920, 1080, 100);

        let one_order = [left.clone(), centre.clone(), right.clone()];
        let other_order = [right, centre, left];

        let one = select(&one_order, MonitorRole::Secondary).map(|(monitor, _)| monitor.id.clone());
        let other =
            select(&other_order, MonitorRole::Secondary).map(|(monitor, _)| monitor.id.clone());

        assert_eq!(one, Some("LEFT".to_owned()));
        assert_eq!(one, other);
    }

    #[test]
    fn degrades_a_secondary_request_to_the_primary_and_says_so() {
        let displays = [primary(monitor("A", 0, 0, 2560, 1440, 100))];

        let (chosen, degraded) = select(&displays, MonitorRole::Secondary).expect("a display");

        assert_eq!(chosen.id, "A");
        assert!(
            degraded,
            "a caller that cannot see the degrade will report a lie"
        );
    }

    #[test]
    fn has_no_answer_when_no_display_is_known() {
        assert!(select(&[], MonitorRole::Primary).is_none());
    }

    #[test]
    fn falls_back_to_the_leftmost_display_when_nothing_claims_to_be_primary() {
        let displays = [
            monitor("B", 2560, 0, 1920, 1080, 100),
            monitor("A", 0, 0, 2560, 1440, 100),
        ];

        let (chosen, _) = select(&displays, MonitorRole::Primary).expect("a display");

        assert_eq!(chosen.id, "A");
    }
}

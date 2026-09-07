//! Named regions, and the transform from a name to a rectangle.
//!
//! Section 11.2: the crate "works with semantic placement requests, not
//! model-provided coordinates". A caller — a model, a Mission, a Surface — names
//! `LeftTwoThirds` of the `Primary` display. It never names pixels, so it cannot
//! name pixels that are off the screen, on a monitor that no longer exists, or
//! on top of the taskbar.

use serde::{Deserialize, Serialize};

use crate::geometry::{fit, overlap, Placement};
use crate::monitor::{select, Monitor, MonitorRole};

/// A horizontal band of a display's work area, always full height.
///
/// Full height because every layout Phase 9 needs is a vertical split, and a
/// region type carrying two unused vertical fractions is two fields that no test
/// can constrain. A horizontal band is added when a layout wants one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RegionName {
    Full,
    LeftHalf,
    RightHalf,
    LeftTwoThirds,
    RightThird,
}

impl RegionName {
    /// The region's left and right edges as fractions of the work area's width.
    ///
    /// Edges rather than an offset plus a width, so that regions meant to sit
    /// beside each other share a boundary exactly. `LeftTwoThirds` ending at 2/3
    /// and `RightThird` starting at 2/3 tile a 2560px display with no gap;
    /// computing each width independently rounds 1706 and 853 and leaves a
    /// one-pixel seam that shows as a stripe of desktop between two windows.
    fn edges(self) -> ((u32, u32), (u32, u32)) {
        match self {
            Self::Full => ((0, 1), (1, 1)),
            Self::LeftHalf => ((0, 1), (1, 2)),
            Self::RightHalf => ((1, 2), (1, 1)),
            Self::LeftTwoThirds => ((0, 1), (2, 3)),
            Self::RightThird => ((2, 3), (1, 1)),
        }
    }
}

fn edge(start: i32, size: u32, (numerator, denominator): (u32, u32)) -> i32 {
    let offset = i64::from(size) * i64::from(numerator) / i64::from(denominator);

    i32::try_from(i64::from(start) + offset).unwrap_or(start)
}

/// A semantic request for where a window should go.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlacementRequest {
    pub monitor: MonitorRole,
    pub region: RegionName,
    /// The target application's minimum window size in device-independent
    /// pixels, scaled to the chosen monitor before it is applied.
    pub minimum_dip: (u32, u32),
}

/// Why the resolved rectangle is not simply the region that was asked for.
///
/// Every one of these is rendered rather than logged: a window that ended up
/// somewhere unexpected with no stated reason is the thing that makes a user
/// stop trusting focus mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolutionNote {
    /// A `Secondary` region on a machine with one display.
    DegradedToPrimary,
    /// A saved user override replaced the named region entirely.
    HonouredUserOverride,
    /// The rectangle had to be moved to sit fully on the work area — a stale
    /// override for a display arrangement that has since changed.
    ClampedToWorkArea,
    /// The region was narrower than the application's minimum size at this
    /// monitor's scaling.
    RaisedToMinimumSize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolution {
    pub placement: Placement,
    pub monitor_id: String,
    pub notes: Vec<ResolutionNote>,
}

/// Turns a named region into the rectangle a window should occupy right now.
///
/// `user_override` wins over the named region outright — Phase 9's gate says
/// user overrides are respected, and a region that quietly reasserted itself
/// after the user dragged a window would be Noctis arguing with its owner. The
/// override is still fitted to a display that currently exists, because
/// respecting a preference is not the same as restoring a window to a monitor
/// that has been unplugged.
pub fn resolve(
    request: PlacementRequest,
    monitors: &[Monitor],
    user_override: Option<Placement>,
) -> Option<Resolution> {
    let mut notes = Vec::new();

    let (monitor, wanted) = match user_override {
        Some(saved) => {
            notes.push(ResolutionNote::HonouredUserOverride);

            // The display the user actually left it on, not the one the region
            // named — that is what makes it an override rather than a hint.
            let monitor = monitors
                .iter()
                .max_by_key(|monitor| overlap(&monitor.work_area, &saved))?;

            (monitor, saved)
        }
        None => {
            let (monitor, degraded) = select(monitors, request.monitor)?;

            if degraded {
                notes.push(ResolutionNote::DegradedToPrimary);
            }

            let area = &monitor.work_area;
            let (left, right) = request.region.edges();
            let x = edge(area.x, area.width, left);
            let width = u32::try_from(i64::from(edge(area.x, area.width, right)) - i64::from(x))
                .unwrap_or(area.width);

            (
                monitor,
                Placement {
                    x,
                    y: area.y,
                    width,
                    height: area.height,
                    maximized: false,
                },
            )
        }
    };

    let minimum = monitor.to_physical(request.minimum_dip);
    let placement = fit(wanted, &monitor.work_area, minimum);

    if placement.width > wanted.width || placement.height > wanted.height {
        notes.push(ResolutionNote::RaisedToMinimumSize);
    }

    if (placement.x, placement.y) != (wanted.x, wanted.y)
        || placement.width < wanted.width
        || placement.height < wanted.height
    {
        notes.push(ResolutionNote::ClampedToWorkArea);
    }

    Some(Resolution {
        placement,
        monitor_id: monitor.id.clone(),
        notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monitor::fixtures::{monitor, primary};

    /// This machine, as detected on 2026-09-07: a 2560x1440 primary at the
    /// origin and a 1920x1080 secondary offset downward by 252 pixels. The
    /// offset is the point — a second display is almost never at y = 0, and an
    /// implementation that assumes it is passes every test written on one
    /// monitor.
    fn desk() -> Vec<Monitor> {
        vec![
            primary(monitor("\\\\.\\DISPLAY1", 0, 0, 2560, 1440, 100)),
            monitor("\\\\.\\DISPLAY2", 2560, 252, 1920, 1080, 100),
        ]
    }

    fn request(monitor: MonitorRole, region: RegionName) -> PlacementRequest {
        PlacementRequest {
            monitor,
            region,
            minimum_dip: (400, 300),
        }
    }

    #[test]
    fn fills_a_display_with_the_full_region() {
        let resolved = resolve(
            request(MonitorRole::Primary, RegionName::Full),
            &desk(),
            None,
        )
        .expect("a resolution");

        assert_eq!(resolved.placement.x, 0);
        assert_eq!(resolved.placement.y, 0);
        assert_eq!(resolved.placement.width, 2560);
        assert_eq!(resolved.placement.height, 1440);
        assert!(resolved.notes.is_empty());
    }

    /// THE GATE: the two regions focus mode uses side by side have to tile the
    /// display exactly. A one-pixel seam is the visible symptom of computing two
    /// widths independently instead of sharing a boundary.
    #[test]
    fn tiles_the_two_thirds_and_the_third_with_no_seam() {
        let displays = desk();
        let left = resolve(
            request(MonitorRole::Primary, RegionName::LeftTwoThirds),
            &displays,
            None,
        )
        .expect("a resolution");
        let right = resolve(
            request(MonitorRole::Primary, RegionName::RightThird),
            &displays,
            None,
        )
        .expect("a resolution");

        let left_edge = left.placement.x + i32::try_from(left.placement.width).expect("width");

        assert_eq!(
            left_edge, right.placement.x,
            "a gap between the two windows"
        );
        assert_eq!(
            right.placement.x + i32::try_from(right.placement.width).expect("width"),
            2560,
            "the pair does not reach the right edge of the display"
        );
    }

    #[test]
    fn tiles_the_two_halves_with_no_seam() {
        let displays = desk();
        let left = resolve(
            request(MonitorRole::Primary, RegionName::LeftHalf),
            &displays,
            None,
        )
        .expect("a resolution");
        let right = resolve(
            request(MonitorRole::Primary, RegionName::RightHalf),
            &displays,
            None,
        )
        .expect("a resolution");

        assert_eq!(
            left.placement.x + i32::try_from(left.placement.width).expect("width"),
            right.placement.x
        );
        assert_eq!(left.placement.width + right.placement.width, 2560);
    }

    /// The secondary display on this desk starts at y = 252, not y = 0.
    #[test]
    fn honours_a_secondary_displays_vertical_offset() {
        let resolved = resolve(
            request(MonitorRole::Secondary, RegionName::Full),
            &desk(),
            None,
        )
        .expect("a resolution");

        assert_eq!(resolved.monitor_id, "\\\\.\\DISPLAY2");
        assert_eq!((resolved.placement.x, resolved.placement.y), (2560, 252));
        assert_eq!(resolved.placement.height, 1080);
    }

    #[test]
    fn places_on_the_primary_and_says_so_when_the_second_display_is_gone() {
        let one = vec![primary(monitor("\\\\.\\DISPLAY1", 0, 0, 2560, 1440, 100))];

        let resolved = resolve(
            request(MonitorRole::Secondary, RegionName::Full),
            &one,
            None,
        )
        .expect("a resolution");

        assert_eq!(resolved.monitor_id, "\\\\.\\DISPLAY1");
        assert!(resolved.notes.contains(&ResolutionNote::DegradedToPrimary));
    }

    /// A third of a 1920 display is 640 physical pixels, which is under an
    /// 800-DIP minimum even at 100%, and well under it at 150%.
    #[test]
    fn widens_a_region_narrower_than_the_applications_minimum() {
        let displays = desk();
        let wide_minimum = PlacementRequest {
            minimum_dip: (900, 300),
            ..request(MonitorRole::Secondary, RegionName::RightThird)
        };

        let resolved = resolve(wide_minimum, &displays, None).expect("a resolution");

        assert_eq!(resolved.placement.width, 900);
        assert!(resolved
            .notes
            .contains(&ResolutionNote::RaisedToMinimumSize));
    }

    #[test]
    fn scales_the_minimum_by_the_monitors_dpi() {
        let scaled = vec![primary(monitor("\\\\.\\DISPLAY1", 0, 0, 2560, 1440, 150))];
        let wide_minimum = PlacementRequest {
            minimum_dip: (800, 300),
            ..request(MonitorRole::Primary, RegionName::RightThird)
        };

        let resolved = resolve(wide_minimum, &scaled, None).expect("a resolution");

        // 800 DIP is 1200 physical pixels at 150%, and a third of 2560 is 854.
        assert_eq!(resolved.placement.width, 1200);
    }

    /// THE GATE: Phase 9 says user overrides are respected. A saved override is
    /// not a hint the named region gets to overrule.
    #[test]
    fn lets_a_user_override_beat_the_named_region() {
        let saved = Placement {
            x: 2700,
            y: 400,
            width: 1200,
            height: 700,
            maximized: false,
        };

        let resolved = resolve(
            request(MonitorRole::Primary, RegionName::LeftTwoThirds),
            &desk(),
            Some(saved),
        )
        .expect("a resolution");

        assert_eq!(resolved.placement, saved);
        assert_eq!(resolved.monitor_id, "\\\\.\\DISPLAY2");
        assert!(resolved
            .notes
            .contains(&ResolutionNote::HonouredUserOverride));
    }

    /// Respecting a preference is not restoring a window to a monitor that has
    /// been unplugged.
    #[test]
    fn fits_a_stale_override_back_onto_a_display_that_still_exists() {
        let one = vec![primary(monitor("\\\\.\\DISPLAY1", 0, 0, 2560, 1440, 100))];
        let saved = Placement {
            x: 2700,
            y: 400,
            width: 1200,
            height: 700,
            maximized: false,
        };

        let resolved = resolve(
            request(MonitorRole::Primary, RegionName::Full),
            &one,
            Some(saved),
        )
        .expect("a resolution");

        assert_eq!(resolved.monitor_id, "\\\\.\\DISPLAY1");
        assert!(resolved.placement.x + 1200 <= 2560);
        assert!(resolved.notes.contains(&ResolutionNote::ClampedToWorkArea));
        assert!(resolved
            .notes
            .contains(&ResolutionNote::HonouredUserOverride));
    }

    #[test]
    fn resolves_nothing_when_no_display_is_known() {
        assert!(resolve(request(MonitorRole::Primary, RegionName::Full), &[], None).is_none());
    }

    /// Region names cross the process boundary as JSON, so the wire spelling is
    /// part of the contract rather than an implementation detail.
    #[test]
    fn spells_region_names_the_way_the_contract_does() {
        let json = serde_json::to_string(&RegionName::LeftTwoThirds).expect("json");

        assert_eq!(json, "\"left_two_thirds\"");
    }
}

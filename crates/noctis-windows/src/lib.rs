//! Identity-safe discovery and deterministic placement of native Windows
//! windows.
//!
//! Master plan Section 11.2. The crate takes semantic placement requests — a
//! named region on a named display role — and never coordinates, so a caller
//! that cannot be trusted with pixels does not have to be.
//!
//! Everything in this module tree is pure and platform-independent on purpose.
//! The Win32 calls that read the live display inventory and move a window are a
//! thin layer above it, so the rules that decide *whether* to move a window are
//! provable on any machine and in any test run, while the layer that *does* the
//! moving stays small enough to qualify by hand.

pub mod compose;
pub mod geometry;
pub mod guard;
pub mod identity;
pub mod monitor;
pub mod region;

/// The Win32 layer. Absent on other platforms rather than stubbed, so that a
/// caller which forgets to handle "this machine cannot place windows" fails to
/// compile there instead of quietly doing nothing at runtime.
#[cfg(windows)]
pub mod win32;

pub use compose::make_room;
pub use geometry::{fit, home_area, moved_by_hand, overlap, overlaps, Placement, WorkArea};
pub use guard::{admit, is_protected, select_window, Refusal, Selection};
pub use identity::{evaluate, ApplicationTarget, MatchEvidence, WindowIdentity};
pub use monitor::{select, Monitor, MonitorRole};
pub use region::{resolve, PlacementRequest, RegionName, Resolution, ResolutionNote};

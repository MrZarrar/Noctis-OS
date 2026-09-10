//! The thin layer that actually talks to Win32.
//!
//! Deliberately small. Every rule about *whether* a window may be moved lives in
//! the pure modules beside this one, so what is left here is reading what
//! Windows says and asking it to move something. The parts of this file that can
//! be wrong without a display attached — the DPI arithmetic and the frame inset
//! correction — are split out as pure functions and tested.

use serde::{Deserialize, Serialize};
use std::time::Instant;

use windows::core::BOOL;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, LPARAM, POINT, RECT, TRUE};
use windows::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFOEXW,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::HiDpi::{
    GetAwarenessFromDpiAwarenessContext, GetDpiForMonitor, GetThreadDpiAwarenessContext,
    DPI_AWARENESS_PER_MONITOR_AWARE, MDT_EFFECTIVE_DPI,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowLongPtrW, GetWindowPlacement, GetWindowRect,
    GetWindowTextW, GetWindowThreadProcessId, IsHungAppWindow, IsWindowVisible, IsZoomed,
    SetWindowPlacement, SetWindowPos, ShowWindow, GWL_EXSTYLE, HWND_TOP, MONITORINFOF_PRIMARY,
    SET_WINDOW_POS_FLAGS, SWP_NOACTIVATE, SWP_NOZORDER, SW_RESTORE, SW_SHOWMAXIMIZED,
    WINDOWPLACEMENT, WINDOWPLACEMENT_FLAGS, WS_EX_TOOLWINDOW,
};

use crate::geometry::{Placement, WorkArea};
use crate::identity::WindowIdentity;
use crate::monitor::Monitor;

/// Windows reports DPI against this baseline; 96 is 100% scaling.
const DEFAULT_DPI: u32 = 96;

/// How far a placement may land from where it was asked to before the result is
/// reported as a partial failure.
///
/// Not zero, because an application is entitled to refuse a size: an editor with
/// a minimum width honours the move and keeps its width, and calling that a
/// failure would be Noctis disputing an application's own rules. Wider than a
/// pixel, because rounding through a scaled monitor legitimately lands one out.
const TOLERANCE: i32 = 2;

/// Whether this process can believe the coordinates Windows gives it.
///
/// A process that is not per-monitor aware is handed *virtualized* coordinates:
/// monitor work areas and window rectangles come back scaled into the primary
/// display's DPI space rather than in physical pixels. Placement computed from
/// those is wrong by the scale factor on every other display, and wrong in a way
/// that looks like an arithmetic bug rather than a missing declaration.
///
/// Tauri's own manifest declares no DPI awareness; `tao` calls
/// `SetProcessDpiAwarenessContext` when it builds the event loop, and falls back
/// through per-monitor v1 to system-aware. So this is checked rather than
/// assumed, and a caller that finds it false should degrade to an open-only
/// handoff instead of placing windows it cannot measure.
pub fn is_per_monitor_dpi_aware() -> bool {
    // SAFETY: both calls take no pointers and no handles this process owns.
    let awareness = unsafe { GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()) };

    awareness == DPI_AWARENESS_PER_MONITOR_AWARE
}

/// Converts a monitor's effective DPI into a percentage scale.
///
/// Rounded to the nearest whole percent rather than truncated: 144 DPI is
/// exactly 150%, but 168 DPI is 175.0% and a truncating conversion turns the
/// common 175% setting into 174%, which then shrinks every minimum size by a
/// pixel or two for no reason anybody could find later.
fn scale_percent(dpi: u32) -> u32 {
    (dpi * 100 + DEFAULT_DPI / 2) / DEFAULT_DPI
}

fn work_area(rect: RECT) -> WorkArea {
    WorkArea {
        x: rect.left,
        y: rect.top,
        width: rect.right.saturating_sub(rect.left).max(0) as u32,
        height: rect.bottom.saturating_sub(rect.top).max(0) as u32,
    }
}

fn wide_to_string(buffer: &[u16]) -> String {
    let end = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());

    String::from_utf16_lossy(&buffer[..end])
}

unsafe extern "system" fn collect_monitor(
    handle: HMONITOR,
    _context: HDC,
    _clip: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    let found = &mut *(lparam.0 as *mut Vec<Monitor>);

    let mut info = MONITORINFOEXW::default();
    info.monitorInfo.cbSize = u32::try_from(size_of::<MONITORINFOEXW>()).unwrap_or_default();

    if !GetMonitorInfoW(handle, std::ptr::addr_of_mut!(info).cast()).as_bool() {
        // One unreadable monitor is not a reason to abandon the others; the
        // arrangement is simply reported without it.
        return TRUE;
    }

    let mut dpi_x = DEFAULT_DPI;
    let mut dpi_y = DEFAULT_DPI;
    // A failure here leaves the 96 default, which is the honest fallback: it
    // means "assume no scaling" rather than "assume whatever was left in the
    // variable".
    let _ = GetDpiForMonitor(handle, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y);

    found.push(Monitor {
        id: wide_to_string(&info.szDevice),
        work_area: work_area(info.monitorInfo.rcWork),
        scale_percent: scale_percent(dpi_x),
        primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
    });

    TRUE
}

/// The display arrangement as it is right now.
///
/// Read fresh on every placement rather than cached. A cached arrangement is
/// exactly what puts a window on a monitor that was unplugged a minute ago.
pub fn monitors() -> Vec<Monitor> {
    let mut found: Vec<Monitor> = Vec::new();

    // SAFETY: the callback receives `&mut found` for the duration of the call
    // and nothing retains it afterwards.
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(collect_monitor),
            LPARAM(std::ptr::addr_of_mut!(found) as isize),
        );
    }

    found
}

/// Whether the compositor is hiding this window.
///
/// A cloaked window is one a virtual desktop or a suspended packaged app is
/// holding off-screen. It is visible by `IsWindowVisible` and is not somewhere a
/// user can see, so moving it produces no effect anybody can observe.
unsafe fn is_cloaked(handle: HWND) -> bool {
    let mut cloaked: u32 = 0;

    DwmGetWindowAttribute(
        handle,
        DWMWA_CLOAKED,
        std::ptr::addr_of_mut!(cloaked).cast(),
        u32::try_from(size_of::<u32>()).unwrap_or_default(),
    )
    .is_ok()
        && cloaked != 0
}

unsafe fn executable_path(process_id: u32) -> Option<String> {
    // `PROCESS_QUERY_LIMITED_INFORMATION` deliberately: it is the least this
    // needs, and it is the one a medium-integrity process is allowed to ask for.
    // A higher-integrity process still refuses, which is why the path is an
    // `Option` and why an absent path is never treated as a wildcard.
    let process: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id).ok()?;

    let mut buffer = [0u16; 1024];
    let mut length = u32::try_from(buffer.len()).unwrap_or_default();
    let read = QueryFullProcessImageNameW(
        process,
        PROCESS_NAME_WIN32,
        windows::core::PWSTR(buffer.as_mut_ptr()),
        &mut length,
    );

    let _ = CloseHandle(process);

    read.ok()?;

    Some(wide_to_string(&buffer[..length as usize]))
}

unsafe extern "system" fn collect_window(handle: HWND, lparam: LPARAM) -> BOOL {
    let found = &mut *(lparam.0 as *mut Vec<WindowIdentity>);

    if !IsWindowVisible(handle).as_bool() || is_cloaked(handle) {
        return TRUE;
    }

    // Tool windows are palettes and overlays. They belong to applications Noctis
    // may well be granted, and moving one is never what a region request meant.
    if GetWindowLongPtrW(handle, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0 {
        return TRUE;
    }

    let mut class = [0u16; 256];
    let class_length = GetClassNameW(handle, &mut class);

    let mut title = [0u16; 512];
    let title_length = GetWindowTextW(handle, &mut title);

    let mut process_id = 0u32;
    GetWindowThreadProcessId(handle, Some(&mut process_id));

    found.push(WindowIdentity {
        handle: handle.0 as u64,
        process_id,
        executable_path: executable_path(process_id),
        class_name: wide_to_string(&class[..class_length.max(0) as usize]),
        title: wide_to_string(&title[..title_length.max(0) as usize]),
        // Filled in by the caller, which is the only thing that knows what it
        // launched. Discovery has no way to prove it and does not guess.
        launch_correlation_id: None,
    });

    TRUE
}

/// Every top-level window a user could plausibly see.
///
/// This is `window.discover`, and it is deliberately unfiltered by grant: the
/// caller needs to be able to say "excluded: system window" rather than silently
/// returning a shorter list. `guard::admit` is what narrows it.
pub fn top_level_windows() -> Vec<WindowIdentity> {
    let mut found: Vec<WindowIdentity> = Vec::new();

    // SAFETY: as `monitors`.
    unsafe {
        let _ = EnumWindows(
            Some(collect_window),
            LPARAM(std::ptr::addr_of_mut!(found) as isize),
        );
    }

    found
}

/// The window's exact state before Noctis touched it.
///
/// `raw` is the `WINDOWPLACEMENT` Section 11.2 asks to be preserved, and it is
/// private on purpose: it restores a maximized window to the size it would
/// return to when un-maximized, which a plain rectangle cannot express. It never
/// leaves this process, because it is a Win32 structure rather than evidence
/// anybody can read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Saved {
    /// The readable form, for the authority decision's execution evidence.
    pub placement: Placement,
    /// `showCmd` and `rcNormalPosition` out of the `WINDOWPLACEMENT` read before
    /// the move: exactly the two fields `SetWindowPlacement` needs handed back.
    ///
    /// Stored as plain numbers rather than the Win32 structure so the record can
    /// be written to disk. Storing the structure meant "put it back" could not
    /// survive a restart of the shell, and a window Noctis moved and can no
    /// longer return is worse than one it never moved.
    ///
    /// `rcNormalPosition` is in workspace coordinates, which are not screen
    /// coordinates when a taskbar is present — so these are the values Win32
    /// gave, kept verbatim and handed straight back. Deriving them from
    /// `GetWindowRect` instead would be off by the taskbar on every restore.
    show_cmd: u32,
    normal: [i32; 4],
}

impl Saved {
    pub fn placement(&self) -> Placement {
        self.placement
    }
}

fn rect_to_placement(rect: RECT, maximized: bool) -> Placement {
    Placement {
        x: rect.left,
        y: rect.top,
        width: rect.right.saturating_sub(rect.left).max(1) as u32,
        height: rect.bottom.saturating_sub(rect.top).max(1) as u32,
        maximized,
    }
}

/// Reads and preserves a window's placement. Always called before a move.
pub fn capture(handle: u64) -> Option<Saved> {
    let handle = HWND(handle as *mut std::ffi::c_void);

    let mut raw = WINDOWPLACEMENT {
        length: u32::try_from(size_of::<WINDOWPLACEMENT>()).unwrap_or_default(),
        ..Default::default()
    };
    let mut rect = RECT::default();

    // SAFETY: both calls write into stack structures sized above.
    unsafe {
        GetWindowPlacement(handle, &mut raw).ok()?;
        GetWindowRect(handle, &mut rect).ok()?;
    }

    Some(Saved {
        placement: rect_to_placement(rect, raw.showCmd == SW_SHOWMAXIMIZED.0 as u32),
        show_cmd: raw.showCmd,
        normal: [
            raw.rcNormalPosition.left,
            raw.rcNormalPosition.top,
            raw.rcNormalPosition.right,
            raw.rcNormalPosition.bottom,
        ],
    })
}

/// How much bigger a window's rectangle is than the part of it you can see.
///
/// Windows 10 and 11 put an invisible resize border outside the visible frame.
/// `SetWindowPos` positions the rectangle including that border, so two windows
/// placed in regions that share a boundary overlap by roughly fourteen pixels
/// and neither of their visible edges lands where the region said. Correcting
/// for it is the difference between a tiling that looks deliberate and one that
/// looks approximate.
fn frame_inset(outer: RECT, visible: RECT) -> (i32, i32, i32, i32) {
    (
        visible.left - outer.left,
        visible.top - outer.top,
        outer.right - visible.right,
        outer.bottom - visible.bottom,
    )
}

/// Grows a target rectangle so the *visible* frame lands on it.
fn inflate(target: Placement, inset: (i32, i32, i32, i32)) -> Placement {
    let (left, top, right, bottom) = inset;

    Placement {
        x: target.x - left,
        y: target.y - top,
        width: (i64::from(target.width) + i64::from(left) + i64::from(right)).max(1) as u32,
        height: (i64::from(target.height) + i64::from(top) + i64::from(bottom)).max(1) as u32,
        maximized: target.maximized,
    }
}

/// Why a window could not be placed, with enough detail to render.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlacementError {
    /// The window stopped existing between discovery and placement.
    Gone,
    /// The application is not pumping messages. Section 11.2's "degrade to an
    /// instruction/open-only handoff when control is unsupported".
    NotResponding,
    /// `SetWindowPos` refused. Almost always a window owned by a process at a
    /// higher integrity level than Noctis, which no amount of retrying fixes.
    Refused { code: u32 },
    /// The call succeeded and the window is somewhere else anyway — an
    /// application enforcing its own minimum size, or refusing to be moved.
    NotHonoured { asked: Placement, got: Placement },
}

pub struct Applied {
    pub placement: Placement,
    pub elapsed_ms: u64,
}

/// Moves one window, and proves it moved.
///
/// The verification afterwards is the point. `SetWindowPos` returning true means
/// the request was accepted, not that the window is where it was asked to be: an
/// application is free to clamp the size in `WM_WINDOWPOSCHANGING`, and a
/// maximized window ignores the position entirely. Reading the rectangle back is
/// the only honest evidence.
pub fn apply(handle: u64, target: Placement) -> Result<Applied, PlacementError> {
    let window = HWND(handle as *mut std::ffi::c_void);
    let started = Instant::now();

    // SAFETY: `window` is checked for existence by the first call; every later
    // call writes only into stack structures.
    unsafe {
        let mut outer = RECT::default();

        if GetWindowRect(window, &mut outer).is_err() {
            return Err(PlacementError::Gone);
        }

        // Before the move, not after: a hung application blocks `SetWindowPos`
        // for as long as it stays hung, because the position change is delivered
        // to a message loop that is not running.
        if IsHungAppWindow(window).as_bool() {
            return Err(PlacementError::NotResponding);
        }

        // A maximized window ignores a position entirely, so `SetWindowPos`
        // would report success and change nothing. Un-maximizing first is the
        // whole of the fix, and it has to happen before the position is set
        // rather than after — the same order Noctis's own window needs in
        // `compose_around`, for the same reason.
        //
        // The prior state is already captured, so the window can still be put
        // back maximized: `Saved` keeps the `showCmd` that says so.
        if IsZoomed(window).as_bool() {
            let _ = ShowWindow(window, SW_RESTORE);
        }

        let mut visible = RECT::default();
        let inset = if DwmGetWindowAttribute(
            window,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            std::ptr::addr_of_mut!(visible).cast(),
            u32::try_from(size_of::<RECT>()).unwrap_or_default(),
        )
        .is_ok()
        {
            frame_inset(outer, visible)
        } else {
            // No compositor answer means no correction, which is right for the
            // windows that have no invisible border in the first place.
            (0, 0, 0, 0)
        };

        let wanted = inflate(target, inset);
        let flags: SET_WINDOW_POS_FLAGS = SWP_NOZORDER | SWP_NOACTIVATE;

        if let Err(error) = SetWindowPos(
            window,
            Some(HWND_TOP),
            wanted.x,
            wanted.y,
            i32::try_from(wanted.width).unwrap_or(i32::MAX),
            i32::try_from(wanted.height).unwrap_or(i32::MAX),
            flags,
        ) {
            return Err(PlacementError::Refused {
                code: error.code().0 as u32,
            });
        }

        let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

        let mut settled = RECT::default();

        if GetWindowRect(window, &mut settled).is_err() {
            return Err(PlacementError::Gone);
        }

        let got = rect_to_placement(settled, target.maximized);
        let landed = rect_to_placement(
            RECT {
                left: settled.left + inset.0,
                top: settled.top + inset.1,
                right: settled.right - inset.2,
                bottom: settled.bottom - inset.3,
            },
            target.maximized,
        );

        if (landed.x - target.x).abs() > TOLERANCE || (landed.y - target.y).abs() > TOLERANCE {
            return Err(PlacementError::NotHonoured { asked: target, got });
        }

        Ok(Applied {
            placement: landed,
            elapsed_ms,
        })
    }
}

/// Puts a window back exactly as it was.
///
/// Section 11.2: "restore only windows Noctis moved and only when their identity
/// still matches". Neither half is checked here, deliberately — this function
/// cannot know either, and a restore that verified its own preconditions would
/// be the place someone later forgets to check them from.
pub fn restore(handle: u64, saved: &Saved) -> Result<(), PlacementError> {
    let window = HWND(handle as *mut std::ffi::c_void);

    // Rebuilt from the two fields that were kept rather than held as a struct,
    // so a restore works just as well after the shell has been restarted.
    let raw = WINDOWPLACEMENT {
        length: u32::try_from(size_of::<WINDOWPLACEMENT>()).unwrap_or_default(),
        flags: WINDOWPLACEMENT_FLAGS(0),
        showCmd: saved.show_cmd,
        ptMinPosition: POINT { x: 0, y: 0 },
        ptMaxPosition: POINT { x: 0, y: 0 },
        rcNormalPosition: RECT {
            left: saved.normal[0],
            top: saved.normal[1],
            right: saved.normal[2],
            bottom: saved.normal[3],
        },
    };

    // SAFETY: `raw` is sized and filled above, and `SetWindowPlacement` reads it
    // without retaining it.
    unsafe {
        SetWindowPlacement(window, &raw).map_err(|error| PlacementError::Refused {
            code: error.code().0 as u32,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_common_scalings_as_whole_percentages() {
        assert_eq!(scale_percent(96), 100);
        assert_eq!(scale_percent(120), 125);
        assert_eq!(scale_percent(144), 150);
        assert_eq!(scale_percent(192), 200);
    }

    /// 168 DPI is 175%. Truncating integer division gives 174, which then makes
    /// every minimum size on that monitor a couple of pixels short.
    #[test]
    fn rounds_the_awkward_scaling_rather_than_truncating_it() {
        assert_eq!(scale_percent(168), 175);
        assert_eq!(scale_percent(240), 250);
    }

    #[test]
    fn measures_the_invisible_resize_border() {
        let outer = RECT {
            left: 0,
            top: 0,
            right: 1000,
            bottom: 800,
        };
        let visible = RECT {
            left: 7,
            top: 0,
            right: 993,
            bottom: 793,
        };

        assert_eq!(frame_inset(outer, visible), (7, 0, 7, 7));
    }

    /// THE GATE: the rectangle handed to `SetWindowPos` has to be bigger than the
    /// region, or the visible edges land inside it and two tiled windows show a
    /// gap where the region boundary was.
    #[test]
    fn asks_for_a_bigger_rectangle_so_the_visible_frame_lands_on_the_region() {
        let region = Placement {
            x: 0,
            y: 0,
            width: 1706,
            height: 1440,
            maximized: false,
        };

        let asked = inflate(region, (7, 0, 7, 7));

        assert_eq!(asked.x, -7);
        assert_eq!(asked.y, 0);
        assert_eq!(asked.width, 1706 + 14);
        assert_eq!(asked.height, 1440 + 7);
    }

    #[test]
    fn leaves_a_window_with_no_invisible_border_alone() {
        let region = Placement {
            x: 100,
            y: 200,
            width: 800,
            height: 600,
            maximized: false,
        };

        assert_eq!(inflate(region, (0, 0, 0, 0)), region);
    }

    #[test]
    fn reads_a_rectangle_as_a_placement() {
        let rect = RECT {
            left: 2560,
            top: 252,
            right: 4480,
            bottom: 1332,
        };

        let placement = rect_to_placement(rect, false);

        assert_eq!((placement.x, placement.y), (2560, 252));
        assert_eq!((placement.width, placement.height), (1920, 1080));
    }

    /// A window reported as an empty or inverted rectangle is a window that has
    /// just been destroyed. It must not produce a zero size, because `Placement`
    /// promises a positive one and the contract schema enforces it.
    #[test]
    fn never_reads_a_degenerate_rectangle_as_a_zero_sized_window() {
        let collapsed = RECT {
            left: 10,
            top: 10,
            right: 10,
            bottom: 4,
        };

        let placement = rect_to_placement(collapsed, false);

        assert!(placement.width >= 1 && placement.height >= 1);
    }

    /// THE GATE: "put it back" has to survive a restart of the shell, and it
    /// only can if what was preserved is data rather than a Win32 structure. A
    /// window Noctis moved and can no longer return is worse than one it never
    /// moved.
    #[test]
    fn round_trips_a_preserved_placement_through_json() {
        let saved = Saved {
            placement: Placement {
                x: 15,
                y: 65,
                width: 491,
                height: 437,
                maximized: true,
            },
            show_cmd: SW_SHOWMAXIMIZED.0 as u32,
            // Workspace coordinates as Win32 gave them, which is why they are
            // kept verbatim rather than recomputed from the rectangle above.
            normal: [100, 120, 1380, 920],
        };

        let json = serde_json::to_string(&saved).expect("json");
        let read: Saved = serde_json::from_str(&json).expect("read back");

        assert_eq!(read, saved);
        assert!(read.placement.maximized);
    }

    #[test]
    fn reads_a_null_terminated_wide_string() {
        let buffer = [0x43u16, 0x6f, 0x64, 0x65, 0x00, 0x99, 0x99];

        assert_eq!(wide_to_string(&buffer), "Code");
    }

    #[test]
    fn reads_a_wide_string_that_fills_its_buffer() {
        assert_eq!(wide_to_string(&[0x41u16, 0x42]), "AB");
    }

    /// Not a test of the display arrangement — that is the qualification
    /// runbook's job — but of the fact that enumeration returns without
    /// panicking, on a CI runner with one virtual display as much as on a desk
    /// with two.
    #[test]
    fn enumerates_the_displays_this_machine_actually_has() {
        let found = monitors();

        for monitor in &found {
            assert!(!monitor.id.is_empty(), "a display with no device name");
            assert!(monitor.scale_percent >= 100);
            assert!(monitor.work_area.width > 0 && monitor.work_area.height > 0);
        }

        assert!(
            found.iter().filter(|monitor| monitor.primary).count() <= 1,
            "two displays both claiming to be primary"
        );
    }

    #[test]
    fn enumerates_top_level_windows_without_panicking() {
        for window in top_level_windows() {
            assert_ne!(window.handle, 0);
        }
    }

    /// Waits for a process Noctis started to put a window on screen.
    ///
    /// This is the launch-correlation problem in miniature: a spawned process
    /// has a pid immediately and a window some time later, and there is no
    /// event to wait on that does not involve a message loop.
    fn wait_for_window(process_id: u32, patience: std::time::Duration) -> Option<u64> {
        let deadline = Instant::now() + patience;

        while Instant::now() < deadline {
            if let Some(window) = top_level_windows()
                .into_iter()
                .find(|window| window.process_id == process_id)
            {
                return Some(window.handle);
            }

            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        None
    }

    /// The write half of the Windows qualification matrix.
    ///
    /// Ignored by default, and deliberately so: it puts a real window on a real
    /// screen and moves it. CI has no desk to qualify, and a developer running
    /// the suite should not have something appear in front of them. Run it as
    /// part of a qualification pass:
    ///
    /// `cargo test -p noctis-windows -- --ignored --nocapture`
    ///
    /// Character Map is the subject because it is a classic Win32 application
    /// that ships with Windows, opens exactly one window, and does not hand off
    /// to an already-running instance the way the packaged applications do.
    ///
    /// Note that `cargo test` is not per-monitor DPI aware, so this proves the
    /// coordinate arithmetic only on a display running at 100%. Qualifying a
    /// scaled display means running the same sequence from the shell.
    #[test]
    #[ignore = "moves a real window on a real screen; part of a qualification pass, not the suite"]
    fn places_and_restores_a_real_window() {
        let mut child = std::process::Command::new("charmap.exe")
            .spawn()
            .expect("Character Map should start");

        let outcome = (|| {
            let handle = wait_for_window(child.id(), std::time::Duration::from_secs(10))
                .ok_or("no window appeared")?;

            let saved = capture(handle).ok_or("could not capture the placement")?;
            let before = saved.placement();
            println!("before:  {before:?}");

            let target = Placement {
                x: 300,
                y: 200,
                width: 900,
                height: 700,
                maximized: false,
            };

            let applied = apply(handle, target).map_err(|error| format!("{error:?}"))?;
            println!(
                "applied: {:?} in {}ms",
                applied.placement, applied.elapsed_ms
            );

            // Position is the assertion. Size deliberately is not: Character Map
            // is entitled to refuse a size, and an application enforcing its own
            // minimum is honouring the move rather than failing it.
            if (applied.placement.x - target.x).abs() > TOLERANCE
                || (applied.placement.y - target.y).abs() > TOLERANCE
            {
                return Err(format!(
                    "visible frame landed at {},{} not {},{}",
                    applied.placement.x, applied.placement.y, target.x, target.y
                ));
            }

            restore(handle, &saved).map_err(|error| format!("{error:?}"))?;

            let after = capture(handle)
                .ok_or("could not re-read the placement")?
                .placement();
            println!("after:   {after:?}");

            // THE GATE: Section 11.2 asks for `WINDOWPLACEMENT` to be preserved
            // before movement. Preserved means the window goes back, not that
            // the bytes were stored somewhere.
            if (after.x - before.x).abs() > TOLERANCE || (after.y - before.y).abs() > TOLERANCE {
                return Err(format!("restored to {after:?} rather than {before:?}"));
            }

            Ok::<(), String>(())
        })();

        // Killed whatever happened, so a failing assertion does not leave a
        // window on somebody's screen.
        let _ = child.kill();
        let _ = child.wait();

        outcome.expect("place and restore");
    }
}

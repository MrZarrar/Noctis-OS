# The Windows qualification runbook

Phase 9's gate is "the Windows qualification matrix passes on the intended PC/display
configurations". This is that matrix, and it is a procedure a person runs rather than a suite CI
runs, for a reason worth stating: a hosted runner has one virtual display, no scaling, no second
monitor to unplug, and nobody to watch a window move to the wrong place. Everything about placement
that can be proven without a desk is already in `cargo test`; what is left needs a desk.

Record the output of each step. The point of the runbook is not that it passes — it is that what
passed is written down next to the display arrangement it passed on.

## The intended configuration

Chosen deliberately rather than guessed, and narrow on purpose: fixtures for hardware nobody has
prove nothing.

| Display        | Resolution | Position   | Scaling |
| -------------- | ---------- | ---------- | ------- |
| `\\.\DISPLAY1` | 2560×1440  | `0,0`      | 100%    |
| `\\.\DISPLAY2` | 1920×1080  | `2560,252` | 100%    |

`DISPLAY1` is primary. The `252` vertical offset on the secondary matters: a second display is
almost never at `y = 0`, and an implementation that assumes it is passes every test written on one
monitor.

Also required: Visual Studio Code installed for the current user. No emulator is needed — the
`emulator` target is expected to report `not running`, and that is one of the cases.

## Step 1 — the read-only probe

Moves nothing, asks for no authority, and safe to run at any point.

```powershell
cargo run -p noctis-windows --example qualify
```

Expect, on the configuration above:

```
per-monitor DPI aware: false
  WARNING: coordinates below are virtualized; placement would be wrong

displays
  \\.\DISPLAY1     work      0,0       2560x1440  scale 100%  primary
  \\.\DISPLAY2     work   2560,252     1920x1080  scale 100%

focus-mode layout, resolved (nothing is moved)
  vscode     \\.\DISPLAY1          0,0       1706x1440  []
  emulator   \\.\DISPLAY1       1706,0        854x1440  []
  noctis     \\.\DISPLAY2       2560,252     1920x1080  []
```

Three things to check rather than skim:

- **The work areas match the Windows display settings.** If they do not, the taskbar is somewhere
  the work area is not accounting for, and every placement will be off by its height.
- **`1706 + 854 = 2560` exactly.** The pair of regions focus mode uses side by side must tile the
  display with no gap. A one-pixel seam here is a visible stripe of desktop between two windows.
- **`per-monitor DPI aware: false` is correct here** and is the check working. The probe is a plain
  console application with no event loop, so it is not DPI aware; the warning is what a machine
  where placement genuinely cannot be trusted would also print. Inside the shell, `tao` sets
  per-monitor v2 and the same line reads `true`.

The probe also lists every top-level window with the verdict the placement layer reaches. Read the
`not granted` rows: an application whose window class has drifted looks exactly like an application
that is not running, and only this list tells the two apart.

## Step 2 — the write path, on a window nothing else owns

```powershell
cargo test -p noctis-windows -- --ignored --nocapture
```

This starts Character Map, places it, and puts it back. Character Map is the subject because it is
classic Win32, opens exactly one window, and does not hand off to an already-running instance the
way the packaged applications do — so the test owns the window it moves.

Expect three lines, and check that the middle one is exact rather than close:

```
before:  Placement { x: 15, y: 65, width: 491, height: 437, maximized: false }
applied: Placement { x: 300, y: 200, width: 900, height: 700, maximized: false }
after:   Placement { x: 15, y: 65, width: 491, height: 437, maximized: false }
```

`applied` landing on `300,200` to the pixel is the frame-inset correction working. Windows puts an
invisible resize border outside the visible frame and `SetWindowPos` positions the outer rectangle,
so an uncorrected implementation lands about seven pixels off in each direction — close enough to
look like rounding and wrong enough to show as a gap between two tiled windows.

`after` matching `before` is `WINDOWPLACEMENT` preservation. Preserved means the window goes back,
not that the bytes were stored somewhere.

This step runs at whatever scaling the display is set to, and `cargo test` is not per-monitor DPI
aware, so it proves the arithmetic only at 100%. Qualifying a scaled display means Step 4.

## Step 3 — focus mode, end to end

Needs the core and the shell running together. From `docs/operations/desktop.md`:

```powershell
# terminal one
$env:NOCTIS_CORE_TOKEN = "<at least 32 characters>"
$env:NOCTIS_DATABASE_PATH = "$env:LOCALAPPDATA\Noctis\core.db"
node apps/core/dist/main.js

# terminal two
npm run build
npm --workspace @noctis/desktop run dev
```

Then, in the shell:

1. Open VS Code on this repository, and only this repository, before activating anything.
2. Propose an Objective whose title contains `Noctis-OS`, and activate it.
3. A **Native application** Surface appears carrying two rows: `vscode` and `emulator`.

| Case                                                      | Expected                                                                                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| The editor, with one window open                          | `open, not arranged`, and an **Arrange this window** action                                                                       |
| The emulator, not installed                               | `not running`, no action, and the sentence asking you to start it — Section 11.2's open-only handoff                              |
| **Arrange this window**, with no Objective active         | cannot happen; the Surface only exists under an active Objective                                                                  |
| **Arrange this window**, Objective active                 | the editor moves to the left two thirds of the primary display, with no prompt. `local_reversible_edit` under an active Objective |
| The same, with the Objective paused first                 | `waiting for you`, and the decision appears as an approval rather than the window moving                                          |
| **Put it back**                                           | the editor returns to exactly where it was, and the row reads `put back`                                                          |
| A second VS Code window open on another folder            | `more than one window`, both titles listed, and no window moved until one is chosen                                               |
| A second window open, Objective titled `Noctis-OS`        | the `Noctis-OS` editor is chosen and arranged; the other is untouched                                                             |
| Unplug `DISPLAY2`, then arrange something intended for it | it is placed on the primary and the row says "there is no second display, so it went to the primary one"                          |
| Drag the editor somewhere yourself, then arrange again    | your position is kept, and the row says "you had placed this window yourself, so that was kept"                                   |
| The same again after restarting the shell                 | still your position. The override is written to `window-overrides.json` beside the shell's own placement                          |
| **Use the intended region instead**, after that           | the override is forgotten and the editor moves to the region. The action only appears while an override is being honoured         |
| Resize the editor by a pixel or two, then arrange         | no override is taken; the region applies. Only a move past four pixels counts as somebody's decision                              |
| Maximize the editor first, then arrange                   | it is un-maximized and placed. `Saved` keeps the `showCmd`, so **Put it back** returns it maximized                               |
| Restart the shell, then **Put it back**                   | still works. The records are in `window-moved.json`; the handle is re-verified against the process id and class before any move   |
| Arrange the taskbar, by any means you can contrive        | refused. There is no UI path to try, which is the first half of the answer                                                        |

## Step 4 — a scaled display, only if the configuration ever changes

**Not part of this qualification.** The gate is worded "the intended PC/display configurations", and
the intended configuration is 100% on both displays — chosen deliberately at the start of the phase,
not defaulted into. A scaling nobody sets is not an untested gap; it is a configuration this desk
does not have.

The DPI transform is unit-tested, and this step is written down so that whoever does change a display
to a scaled setting knows what to look at. Until that happens it is neither passed nor failed.

Set the display to 150%, restart the shell, and place onto it. The thing to check is the **minimum
size**: `vscode` declares an 800×600 minimum in device-independent pixels, which is 1200×900 physical
pixels at 150%, so a region narrower than 1200 should come back wider than asked with the note "the
region was narrower than this application's minimum width". A placement that honoured 800 physical
pixels has skipped the conversion, and the window will be a third too small.

## Known gaps, so a failure here is not a surprise

None outstanding for the rows above. The two gaps this runbook used to carry are implemented, and
their rows now expect a pass rather than a failure:

- **A maximized window is un-maximized before placement.** `SetWindowPos` does not move a maximized
  window at all, so the un-maximize has to come first — the same ordering Noctis's own window needs.
  The `showCmd` is preserved, so **Put it back** returns it maximized.
- **What Noctis moved is written to `window-moved.json`.** It used to live only in the shell's
  memory, so a restart lost the ability to put anything back — a window Noctis moved and can no
  longer return is worse than one it never moved. The window handle survives as long as the window
  does, and it is still re-checked against the process id and class before anything moves, because a
  recycled handle is a different window wearing the same number.

What remains untested rather than unimplemented is Step 4: both displays on the qualification machine
run at 100%, so the DPI transform has never faced a real scaled display.

Every clause of Phase 9's gate is implemented, so running this runbook is what decides whether the
phase closes.

## What to record

For a pass, write into `docs/acceptance/IMPLEMENTATION-STATUS.md`: the display arrangement, the
Step 1 output verbatim, the three Step 2 lines, and which rows of the Step 3 table were run with
what result. A row nobody ran is recorded as not run, never as passed.

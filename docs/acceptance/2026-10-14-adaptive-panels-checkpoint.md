# Adaptive panels: paused checkpoint, 14 October 2026

The owner requested a graceful stop and a push of all outstanding repository code, docs and plans. This is a work-in-progress checkpoint, not final acceptance or deployment.

## Reviewed and pushed

The implementation through `202fc6a` has completed task review and scoped fixes:

- P8/P13/P17: read-only documents, timeline and verification panels, message choices with captured thread ownership and 44px targets.
- P9/P10/P11: pinned placement/restore, thread recall with Open in Vault, bounded written-file panels and refresh/retry. Windows case-equivalent paths retain panel identity and dismissal.
- P12/P16/P18: companion focus and restoration, the owner + picker and reusable utility page panels, retirement of Command and migrated keyboard acceptance. Missions opens the selected turn's exact thread.
- P19/P20: atomic placement/swap, manual overflow, pointer cancellation, persisted bounded resizing, keyboard sizing and reset. Overlay sizing uses its semantic override without invalid column geometry.

## Current P21 source checkpoint

The pending source adds one pop-out coordinator per Noctis tab, shared by thread, Objective and Presence panels. Existing live frames render into a shared PiP or normal browser window. Controls, choices, live updates, return, dismissal, owner cleanup and keyboard focus are implemented. Normal fallback windows have distinct per-tab names and an explicit not-always-on-top label. Pagehide, a closed-window observer and parent focus/visibility checks restore panels after child closure.

The core keeps owning composition. A pinned panel returns to its saved manual region; an unpinned panel follows the current composition and may return to accessible overflow after higher-priority arrivals. Opening or closing a pop-out does not silently pin it. Exiting and dismissed panels are excluded.

Observed before cancellation, on Node 22.23.2 with the existing lock:

| Check                                                                | Result                      |
| -------------------------------------------------------------------- | --------------------------- |
| Focused Workbench/layout/surface units                               | 68 tests passed in 14 files |
| Real installed Edge PiP, fallback, overflow and owner/Presence gates | 4 passed                    |
| Existing pointer/resize, overlay-size and keyboard regressions       | 3 passed                    |
| Root diff whitespace check                                           | Passed                      |

Earlier integration typecheck and web build passed. The final lint/type/build invocation was interrupted and its output was lost; those final results are unconfirmed. A test callback typing correction and lifecycle filtering still require fresh checks. P21 has not received independent review. Headless Edge acceptance does not verify physical always-on-top behavior, requested size, screen position or multiple monitors. Computer Use had no available browser; rendered browser captures are retained locally.

## Resume

1. Inspect the checkpoint diff and fresh repository state; do not repeat completed tasks 1-4.
2. Finish P21 self-review, typecheck, web build, changed-path lint/format checks and independent task review; fix and re-review any blockers.
3. Complete P14: full Vitest run, final browser regression suites, settled visual review, broad independent review and reconciliation of the adaptive plan, master-plan row 4.7 and implementation status.
4. Record final evidence before calling the plan complete. Production deployment remains unperformed and requires its own authorization.

Local detailed handoffs and red/green logs are under `.superpowers/sdd/2026-10-09-adaptive-panels/`; screenshots/recordings are under `.noctis/panels/`. These ignored test artifacts and the generated `debug.log` are preserved locally. The tracked source and this checkpoint are the remote resume record. No dependency, donor port, live Vault, metered API, autostart or production configuration change was made.

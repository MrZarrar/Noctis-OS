# Owner decisions and discussion: 16 October 2026

Follows `2026-10-13-owner-decisions.md`. Each item is marked **Decided**, **Built**, **Open** or **Deferred**.

## 1. glycolens Plan 2: the Health panel

**Decided:** the decisions table in `docs/superpowers/plans/2026-10-16-glycolens-noctis-integration.md` stands:
the report is stored on the core, the weekly run is a core timer, Health has a rail tab with a badge, Run now is
on the panel, and allowing health grants standing permissions.

**Decided (today):** visuals are not left to the end or handed off last. They are designed and built alongside
the data work. The plan's Task 7 ("Astra builds the visuals last") was replaced: Claude designed and built the
visuals, and Codex made the mockups that set the target look.

**Built:** Tasks 1–8. See the 2026-10-16 entry in `docs/acceptance/IMPLEMENTATION-STATUS.md`.

Design choices made while building:

- "Your glucose day" has two views: a wide **ribbon** (the default, taken from the Codex mockups because it reads
  best on a phone) and a 24 h **clock**. The owner's choice is remembered in the browser.
- Time-in-range bands are patterned (cross, hatch, solid, dots) as well as coloured, so a low and a high never
  differ by hue alone.
- Only numbers glycolens wrote are labelled. Thresholds (3.9, 10.0, 13.9, "+2.0 at 4h") are drawn as fixed
  references. No animated number tickers, because their in-between values are numbers the report never wrote.
- The run's failure reason is shown to the owner on the Health page. Codex had removed it from `GET /glucose` for
  privacy, and Claude restored it: that endpoint already serves the whole report to the same authenticated owner.
  The test now pins the real risk, which is that the reason never reaches a log line.

## 2. Dependencies and motion across the app

**Decided:** new libraries are welcome. The owner does not mind dependencies; looking great matters. The owner
thinks parts of the app were held back because earlier work avoided them. The rules that still apply: exact
versions published at least two weeks ago, nothing that phones home or needs a server, `prefers-reduced-motion`
honoured, and never meaning by colour alone.

**Built:** `motion`, `d3-array`, `d3-scale`, `d3-shape` and `lucide-react` in `@noctis/web`. `framer-motion`,
`motion-dom` and `motion-utils` are pinned to 13.5.0 through root `overrides`, because 13.5.1 is under two weeks
old.

**Open:** the app-wide upgrade. Codex's audit (`docs/handoffs/2026-10-16-app-motion-audit-report.md`) ranks:

1. panel arrival and focus/return continuity;
2. stronger hierarchy for reminders, tasks and notes;
3. one-time message arrivals and smoother conversation selection;
4. Files/media skeletons and preview transitions;
5. local Inter fonts (`@fontsource/inter`) and consistent shell navigation motion.

It also suggests `sonner` for save/copy toasts, and `@tanstack/react-virtual` only once long lists are measured
to need it. Waiting on the owner's go-ahead.

## 3. Codex

**Decided:** Codex runs as `gpt-6.1-sol` at high reasoning (`-m gpt-6.1-sol -c model_reasoning_effort=high`),
not `gpt-6-astra`. The Codex CLI was upgraded from 0.147.0 to 0.163.0, because 0.147 could not run current
models. `~/.codex/config.toml` was left unchanged.

## 4. Deploy

**Open:** the work-PC core is not redeployed. The deploy script was blocked in this session (the permission
classifier refused `-ExecutionPolicy Bypass`). The owner runs `scripts/deploy/work-pc.ps1`, then restarts the
home node. Owner steps for Health are at the end of the status entry.

## 5. Knowing when a glucose swing was the gym

The question: did a high or low come from insulin and carbs, or from the gym? Options weighed: guess from the
usual 19:00 to 22:00, log it by hand, the pump's Exercise Activity, an Apple Watch workout, or the phone's
location.

**Decided:**

- **Location.** The phone's Shortcuts app runs an "Arrive" and a "Leave" automation for each place and POSTs
  `{ place, transition }` to `POST /places/events`. The geofence stays on the phone; the core only hears the name.
- **Not the pump's Exercise Activity.** The owner trains anaerobic then cardio and is not sure how the mode
  behaves, so it stays off for now. No pump reminder either.
- **Not the Apple Watch.** It is often flat, and starting a workout by hand will not happen.
- **No time-of-day guess.** It would mark every evening swing as gym, rest days included.
- **Places beyond the gym.** Home, work and gym to start, named in Settings, so other automations can use them later
  (Phase 13 Sense / Automations).

**Built:**

- Settings has an **Automations** section: the places, "Count a visit after (minutes)" (default 20, so driving past
  is not a visit), the phone setup steps with the link, and recent visits.
- The phone's link is its own bearer, derived from the core token and a counter like a node credential, so nothing
  secret is stored. It can only report arrivals. "New link" rotates it; rotating the core token does too.
- A visit is an arrive and the next leave. A stay over 12 hours is treated as a lost leave and dropped.

**Open:**

- Sending gym visits to glycolens. glycolens needs a way to take them (a file or a CLI argument) and rules that
  leave gym-affected windows out of the ratio and sensitivity checks. That is a glycolens change first.
- An undo for a wrong visit, if false visits turn up.
- If arrivals get lost while Tailscale is off, OwnTracks (buffers offline) is the fallback.

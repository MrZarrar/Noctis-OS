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
to need it.

**Decided:** the owner asked for all five.

**Built:**

1. Panels rise into place once when they open. Focusing a floating panel, and leaving focus, glides it from where
   it was to where it lands, instead of jumping. Newly opened windows now stack newest on top whichever owner
   announces first, which also fixed a flaky two-owner panel test.
2. Reminders read as a time-led agenda (Overdue, Due now, Due soon, Upcoming, with a symbol as well as colour),
   snoozed rows are dashed and done ones sit in a Done group. A to-do shows "Completed" when the core confirms it.
   Notes have a stronger title, a three-line preview and edit in place. Scheduled tasks show On / Paused /
   Suggested changes with a symbol, and run history is a compact strip. The editor sits under the list (Codex).
3. Messages, turns, approvals and the streaming reply come in once, when they arrive. History, a thread loading
   and the committed message that replaces a stream do not replay.
4. Files holds the folder's shape while it loads, marks the open file like the current page, fades a newly opened
   preview in, reveals images once decoded, and the phone viewer rises from the bottom. File panels use the same
   loading shapes.
5. Inter is bundled locally (`@fontsource/inter` 5.2.6, weights 400 to 700). Pages fade in on arrival (Nodes is
   left out because the remote screen lives there), the rail and tab bar have one marker that travels to the chosen
   page, and the More sheet rises.

Everything honours reduced motion: CSS animations stop, and every Motion default becomes instant.

**Deferred:** `sonner` toasts and list virtualisation, until something needs them.

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

## 6. Agent questions in the thread

The owner saw Claude's AskUserQuestion arrive as a "Requested action: call AskUserQuestion" card with only
Confirm and Decline. The question, its options and anywhere to type an answer were missing, and the agent went
on with its own defaults.

**Decided:**

- **Questions are not approvals.** The node no longer raises an approval for AskUserQuestion. It tells the agent
  the owner has the questions and to end its turn.
- **The answer is the next message.** The thread reads the questions from the tool call and shows each one with
  its options. Picking options and pressing "Send answer" sends one message, each question beside its pick, on
  the model that asked. Typing in the composer works as well.
- Only the newest turn's questions can be answered, so an old one is not answered twice.

**Built:** the node change and the question card in Threads. The node on each PC needs a restart to pick it up.

## 7. Seeing sub-agents, background work, panels and readability

The owner could not see what sub-agents were doing. Agents that ran in the background and reported back while
nobody was chatting hit "no Noctis turn is running", and the owner had to send a message to revive the chat. Vesper
promised a review before pushing READMEs but gave a chat summary and no panel, and it said there were no images to
use instead of taking screenshots or asking. The panel menu's glass let the thread show through it.

**Found:** the turn ended when Vesper's message ended, while its background sub-agents kept going. Claude Code wakes
itself when a background task finishes and answers again, but with no turn open that answer had nowhere to go and
every tool call in it was refused. A thread with no turn for 10 minutes also had its CLI closed, which killed any
sub-agents still running.

**Decided and built:**

- **A turn stays open while its background work runs.** It ends with the answer that follows the last task. A new
  message from the owner takes over the background work, so a question mid-work is answered straight away rather
  than queued.
- **Sub-agents are listed on the turn,** outside Details: each one's label, a status dot and a line on what it is
  doing now (Claude Code's progress summaries are switched on).
- **Vesper's card says to show and not summarise:** drafts for review open as a document panel with actions, and
  missing images, screenshots or data are fetched (browser screenshots, search, shared folders) or asked for.
- **Readability:** cards and menus are nearly solid, the panel menu closes when the + (or anywhere outside it) is
  clicked, every dialog dims what is behind it, and the menu's Cancel is red.

**Open:** a background task that never ends (a dev server left running) keeps the turn Working until the owner sends
a message or presses Cancel.

## 8. Panels as the main way work is shown

The owner's worry: the earlier panel instruction only covered reviews. Vesper should always show its work in
panels, live while it happens rather than at the end, and a panel should be the real visual thing (diagrams,
images, interactive figures), not the same text summary. The owner also asked for the Anatomy skill
(github.com/wheresryan22/anatomy), which explains ideas as interactive isometric figures.

**Decided (owner, from three options each):**

- **Interactive figures run in a sandboxed panel.** A new `visual` panel kind shows an `.html` or `.svg` page the
  agent built. The core serves it from `/visuals/content` with `sandbox allow-scripts` and `default-src 'none'`,
  and the panel frames it with `sandbox="allow-scripts"`. Scripts run, but the page has an opaque origin and no
  network, so it cannot reach the session, the core or the owner's files. Rejected: static SVG only (nothing
  moves) and a link to a new tab (not in the panel).
- **The agent can keep updating one panel across turns.** A proposal can carry a `panelId`. The same kind and
  `panelId` in a thread is the same panel, so live work updates one place. Without one, each turn still gets its
  own panel.
- **Anatomy is installed for Claude Code and Codex,** cloned at a pinned commit and reviewed before it was
  enabled, not through its npx installer.

**Built:**

- Vesper's card and the panel tool now say, for any work beyond a quick answer: open a panel when you start, keep
  it updated under one `panelId`, show the full result with its diagrams, images and screenshots, build
  interactive figures (Anatomy) as visual panels, and put decisions in panels with actions.
- The agent names a visual by its absolute path. The core finds the shared folder holding it on the turn's PC and
  refuses a path outside every shared folder, a `..` path, or anything but `.html`, `.htm` and `.svg`. A page is at
  most 2 MB.
- Mermaid diagrams draw in messages and document panels, as a `blob:` image so the page CSP stays as it is
  (Codex built this, pinned at mermaid 12.1.0). Mermaid's measuring step logs CSP errors in the console while it
  draws; the diagram itself is right. 12.1.0 carries a low KaTeX advisory that 12.2.0 fixes, but 12.2.0 is under
  two weeks old.
- Images in messages and document panels load when given by absolute path inside a shared folder (Codex built
  this). Anything else shows its alt text.
- Anatomy was installed with its gallery publishing removed (`scripts/publish.mjs`, `scripts/session.mjs`,
  `scripts/fingerprint.mjs`, their tests, `references/publish.md`, `.github/`), after a Codex security review:
  publishing read Claude session logs and could force-push to GitHub. Nothing else reaches the network, and its
  figures are self-contained pages of 130 KB to 1.5 MB. The source commit is in `.source-commit` in the skill
  folder.
- Checked in Chrome under the real policies: a Mermaid diagram draws under the page CSP, and an Anatomy figure
  runs inside the sandboxed visual frame.

## 9. The deploy that never handed back

The owner saw the restart finish while the agent kept waiting on it. The deploy script started the core with
`Start-Process -RedirectStandardOutput`, which starts the child with handle inheritance on, so the core also
inherited the pipe the script's own output went to. Whatever ran the deploy then waited for that pipe to close,
which only happens when the core exits.

**Built:** `scripts/deploy/start-hidden.ps1` starts a program through `cmd` by the shell, which inherits no
handles, and lets `cmd` write the log files. The deploy starts the core and, new, restarts this PC's node agent
through it, after stopping both before `npm ci`. A test runs it under a pipe, as a tool does, and fails if the
caller has to wait for the child.

**Also found while checking:** `/visuals/content` was not in the core's API path list, so on the real core it
answered with the app's own page instead of the figure. It is in the list now.

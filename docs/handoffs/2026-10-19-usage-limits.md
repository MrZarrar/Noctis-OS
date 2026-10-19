# Usage limits on Presence (2026-10-19)

The owner wants to see their Claude and Codex subscription limits on Presence: the 5-hour
window and the weekly window, each with percent used and when it resets. Not on a page of its
own: on Presence.

**Hard rule from the owner:** the numbers come from the providers themselves. Never estimate,
add up tokens, or compute usage from transcripts. If the provider cannot be asked, show that it
is unavailable, nothing else.

## How the numbers are read (already decided, already probed live)

- Claude: `GET https://api.anthropic.com/api/oauth/usage` with the Claude Code OAuth token, the
  same endpoint Claude Code's `/usage` reads. Returns `five_hour` and `seven_day`, each
  `{ utilization, resets_at }`. Undocumented, so a failure must read as "unavailable".
- Codex: `account/rateLimits/read` on `codex app-server`. Returns `rateLimits.primary` (300 min)
  and `secondary` (10080 min), each `{ usedPercent, windowDurationMins, resetsAt }`.

## Shape of the work

A new node capability `usage.limits` (already added in `packages/contracts/src/node.ts`:
`UsageLimitsPayloadSchema`, `UsageLimitsEvidenceSchema`, `UsageWindowSchema`, types
`UsageLimits`, `UsageWindow`). A `runtime.turn` grant covers it, so no new grant. Payload is
`{ rootGrantId, providerId }`; evidence is `{ fiveHour?, weekly? }`, each window
`{ usedPercent, resetsAt? }` with `resetsAt` an ISO UTC timestamp.

Three slices, three writers. Do not touch another slice's files.

1. **Node agent (Claude Code is doing this):** `apps/node-agent/src/runtimes/{Runtime,claude,codex}.ts`,
   `apps/node-agent/src/adapters.ts`.
2. **Core endpoint (Codex run A).**
3. **Presence card (Claude Code; started by Codex run B, taken back under the owner's frontend split).**

## The HTTP contract between core and web

`GET /limits` answers 200 with:

```json
{
  "limits": [
    {
      "providerId": "claude",
      "hostId": "MUSHAF-PC",
      "fiveHour": { "usedPercent": 19, "resetsAt": "2026-10-19T18:30:00.442Z" },
      "weekly": { "usedPercent": 68, "resetsAt": "2026-10-22T10:00:00.442Z" }
    },
    { "providerId": "codex", "problem": "No connected PC runs Codex" }
  ]
}
```

Always exactly two entries, Claude then Codex. An entry has either the windows (each optional)
or a `problem` string the page can show as is. One provider failing never fails the other.

## Slice A: core (`apps/core`)

- Add `limits(context, at: { nodeId, rootGrantId, providerId })` to the file gateway in
  `apps/core/src/files/gateway.ts`, reusing its existing `run()` (widen its capability union to
  include `"usage.limits"`). It already handles enqueue, timeout and job-failed rejection.
- Add `GET /limits` in `apps/core/src/api/http.ts`, next to `GET /sessions` (`handleSessions`
  is the model). For each of `claude`, `codex`: pick the first candidate from
  `listRuntimeCandidates(db, isConnected, [], now)` (`apps/core/src/nodes/registry.ts`) whose
  `probe.providerId` matches, `connected && granted`, with at least one root; ask that node with
  its first root's `grantId`. No candidate: `problem` "No connected PC runs Claude" (or Codex).
  A rejected ask: `problem` is the error message. Run both with `Promise.allSettled`.
- Same auth as the other owner GET routes.
- Test first (AGENTS.md): look at how `GET /sessions` or the file gateway is integration-tested
  in `apps/core/src` and add a focused test for `/limits`, including one provider failing while
  the other answers. Verify red, then green.

## Slice B: Presence card (`apps/web`)

- `apps/web/src/pages/usage-limits-view.ts` + `usage-limits-view.test.ts`: zod schema for the
  response above and pure formatting helpers, tested first. Reset text: under 24h shows a
  countdown like `2h 14m` (or `38m`); further out shows weekday and local time like `Thu 11:00`.
  A severity per window for colour: under 80% normal, 80 to 94 warning, 95+ error.
- `apps/web/src/pages/UsageLimits.tsx`: fetches `GET /limits` through the `transport` on mount
  and every 5 minutes (not faster: each read is a job on the PC). Re-renders countdowns from a
  `now: Date` prop. Renders nothing while there is no transport.
- Wire it into `apps/web/src/pages/Presence.tsx` in the top row, left of the clock (the row that
  holds the Jester marker and the `<time>`; the clock keeps `marginLeft: auto`). Pass Presence's
  existing `now`. On mobile it sits on its own line above the clock.
- Look: compact and quiet, like the clock's secondary lines. Two rows (CLAUDE, CODEX) in the mono
  family at 12px with letter-spacing like the Jester marker; per row two thin bars labelled `5H`
  and `WK`, percent, and the reset text. Colours from `@noctis/ui` (`typography.color.muted`,
  `semantic.warning`, `semantic.error`, `material.border` for the bar track). A `problem` shows as
  muted text in place of the bars. Accessible: each bar is a `role="meter"` with
  `aria-valuenow`, and a label like "Claude 5-hour limit, 19% used, resets in 2h 14m".

## Rules for every slice

- Read `AGENTS.md`. Test first, red then green. Comments only for a non-obvious why, written as a
  person would; never cite docs or file paths in comments.
- Do not commit, push, or run git commands that change state. The orchestrator reviews and commits.
- Run your slice's tests plus `npx tsc -b --pretty false` scoped as far as practical; report what
  passed and failed.
- Report back: files changed, test commands and results, anything left open.

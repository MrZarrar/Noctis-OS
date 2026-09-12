# Slice 1 live evidence — the procedure

Fixture proof (fake runtime, real core, real node agent) is in the test suite. Live proof needs a
signed-in Codex and Claude on a real machine, so it is run by the owner and recorded here. Record
host, versions, auth modes, models, the prompt, the items that appeared, and what was refused.

Everything below runs on the home PC against the home development core. Repeat on the work-PC
topology once [work-pc-core.md](work-pc-core.md) is done.

## 0. Gates (once, before any live run)

```powershell
npm run format:check; npm run lint; npm run typecheck
npm run test:unit; npm run test:integration; npm run build; npm run build:web
npm run test:boundary
npm run test:e2e          # needs Playwright Chromium; chat.test.mjs drives the fake runtime end to end
```

Expected: all green. `chat.test.mjs` asserts a committed message, a `command` item, an approval card
that Confirm turns into `→ hi`, and a `proposal` item from `PROPOSE: plan`.

## 1. Start the core and a worker with the real runtimes

Terminal 1 (core; set the two variables in the user environment first, see work-pc-core.md):

```powershell
node apps\core\dist\main.js
```

Terminal 2 (pair and grant, once):

```powershell
$H = @{ Authorization = "Bearer $env:NOCTIS_CORE_TOKEN"; "Content-Type" = "application/json" }
$code = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:7717/commands/node.issue_pairing_code -Headers $H `
  -Body (@{ idempotencyKey = [guid]::NewGuid().ToString(); hostId = "home" } | ConvertTo-Json)
node apps\node-agent\dist\main.js pair --core http://127.0.0.1:7717 --code $code.code --host home
```

Grant `runtime.turn` with the 0.18 roots exactly as in [nodes.md](nodes.md#granting-runtimeturn),
`providers = @("codex", "claude")`. Then start the agent:

```powershell
node apps\node-agent\dist\main.js
```

Check `GET /nodes` (with the bearer): the node is `online` and `providers[]` shows
`codex / chatgpt / available: true` with `gpt-5.6-sol` in its models, and
`claude / claude_ai / available: true` with `sonnet` and `opus`. An `api_key` mode or
`available: false` here is the probe telling you the login is wrong; fix it before sending anything.

## 2. Pick the models

In the web page (Settings → Default model) or over HTTP:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:7717/commands/identity.set_default_model -Headers $H `
  -Body (@{ idempotencyKey = [guid]::NewGuid().ToString(); identityId = "vesper"; model = @{ providerId = "codex"; model = "gpt-5.6-sol" } } | ConvertTo-Json -Depth 4)
```

`GET /models` should list the catalogue from the node and `defaults.vesper`.

## 3. Checkpoint 1A — the recorded prompt, Codex, free chat (no Objective)

Web page: `cd apps/web; $env:VITE_CORE_URL="http://127.0.0.1:7717"; $env:VITE_CORE_TOKEN=$env:NOCTIS_CORE_TOKEN; npm run dev`
(browser transport: items and messages arrive by polling; token deltas only show in the desktop
shell). Or the desktop shell with `NOCTIS_CORE_URL=http://127.0.0.1:7717` for deltas.

Send, in Presence or Chat, with `gpt-5.6-sol` selected:

> Look at the newest three files in my Downloads folder, tell me what they are, and move any
> screenshots into Documents\Screenshots (create it if needed).

Expected, with no Objective active (sandbox read-only, so every write asks):

1. The turn appears as `running`; `command` items for the directory listing complete without asking
   (read-only heads are `read_inspect`).
2. The move is surfaced as a `command` or `file_change` ask. Because there is no active Objective,
   an approval card appears in Chat (`require_confirmation`, reason `objective_not_active`). The
   runtime is blocked until you answer; the job stays `running` (frames renew the lease).
3. **Confirm** → the node receives `allow`, Codex performs the move, the item completes, the reply
   message lands. **Decline** instead → the item shows `declined`, the reply explains, and
   `GET /approvals` shows `declinedAt`.
4. `GET /threads/<id>/turns`: the turn is `completed`, `model` is `codex/gpt-5.6-sol`,
   `provider_decisions` (via the turn's `decision` or the DB) names the node and the reason codes.
5. Restart the core and the agent. Chat reloads the same messages; the next prompt on the thread
   carries `sessionRef` (the Codex thread id) and is pinned to the same node.

Record: what the three files were, whether the move asked (it must), which ask kind it arrived as,
and the exact reason codes.

## 4. Same prompt, Claude, under a fresh active Objective

Create an Objective for Vesper (`objective.create` status `draft`, then `objective.change_status` to
`active`), open Chat on it (the Objective's thread is created on first send), select `claude/sonnet`,
send the same prompt.

Expected: sandbox `workspaceWrite` on the granted roots; the listing runs; the move is classified
`local_reversible_edit` inside `documents`/`downloads` and is **auto-allowed and audited** (an
`approvals` row with outcome `allow`, no card). Anything outside the roots or reaching the network
still asks. Deltas stream token by token in the desktop shell.

Record: the Claude session id landed as `sessionRef`, the items, and any ask that did appear.

## 5. What is not proven yet, and is not claimed

- Phone (Slice 2), Hermes/Jester (Slice 4; the probe reports `slice_4`), Windows desktop control
  (Slice 3).
- Token deltas in a browser (Slice 2's SSE); the browser transport polls.
- The two-PC topology: repeat 1–4 with the core on the work PC and this machine paired as `home`.

## Evidence log

| Date | Host | Core | Agent | Provider / auth / model | Prompt | Items | Asks and answers | Result |
| ---- | ---- | ---- | ----- | ----------------------- | ------ | ----- | ---------------- | ------ |
|      |      |      |       |                         |        |       |                  |        |

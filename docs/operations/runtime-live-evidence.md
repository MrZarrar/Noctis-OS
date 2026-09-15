# Slice 1 live evidence — the procedure

Fixture proof (fake runtime, real core, real node agent) is in the test suite. Live proof needs a
signed-in Codex and Claude on a real machine, so it is run by the owner and recorded here. Record
host, versions, auth modes, models, the prompt, the items that appeared, and what was refused.

Sections 0–4 run on the personal PC (`zarrarpc`, user `mmush`) against its local development core.
Section 5 moves the authoritative core to the work PC (`mushafzarrar`, user `mushaf.zarrar`) and
pairs the personal PC as its worker. The two hostnames read backwards from what you would guess;
check `hostname` before acting on either.

## 0. Gates (once, before any live run)

```powershell
foreach ($g in "format:check","lint","typecheck","test:unit","test:integration","test:migrations","build","build:web","test:boundary","test:e2e") {
  Write-Host "=== $g ===" -ForegroundColor Cyan
  npm.cmd run $g
  if ($LASTEXITCODE -ne 0) { Write-Host "FAILED: $g" -ForegroundColor Red; break }
}
```

`npm.cmd`, not `npm`: PowerShell's default execution policy refuses to load the `npm.ps1` shim, and
the resulting `PSSecurityException` does not set `$LASTEXITCODE`, so a loop written with bare `npm`
reports nine identical failures and never breaks. `npm.cmd` is a real process and works whatever the
policy is. The alternative is `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, once.

Expected: all green. `test:e2e` needs Playwright Chromium (installed) or
`$env:NOCTIS_E2E_BROWSER_CHANNEL="msedge"`. `chat.test.mjs` drives the fake runtime end to end: a
committed message, a `command` item, an approval card that Confirm turns into `→ hi`, and a
`proposal` item from `PROPOSE: plan`.

## 1. Environment (once, user scope)

```powershell
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$token = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
[Environment]::SetEnvironmentVariable("NOCTIS_CORE_TOKEN", $token, "User")
[Environment]::SetEnvironmentVariable("NOCTIS_DATABASE_PATH", "$env:LOCALAPPDATA\Noctis\core.db", "User")
[Environment]::SetEnvironmentVariable("NOCTIS_ALLOWED_ORIGINS", "http://localhost:5173", "User")
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\Noctis" | Out-Null
"token set, $($token.Length) chars"
```

Each machine gets its own token; they are never shared. Do not print or paste the token — every
command below reads `$env:NOCTIS_CORE_TOKEN`, so you never need to see it. A token that has been
shown on screen should be regenerated and every node re-paired (see
[work-pc-core.md](work-pc-core.md#stop-rotate-recover)).

Do not use a character-pool one-liner with `Get-Random -Count`: it samples without replacement, so a
36-character pool silently caps the token at 36 characters however many you ask for.

`NOCTIS_ALLOWED_ORIGINS` is the **web page's** origin, not the core's. The core emits no permissive
CORS headers by design (Section 9.2), so a browser Origin it does not list is refused outright.

These are permanent. Set them once and every terminal opened afterwards inherits them.

**Then restart VS Code** (or whatever your terminals are hosted in) before going further. This is the
only step people skip, and it is the one that wastes the next twenty minutes. A terminal inherits its
environment from its parent process, and VS Code's integrated terminal inherits from the VS Code
process — which started long before these variables existed. Opening a new tab therefore changes
nothing, and `$null.Length` reports a perfectly innocent `0` rather than an error, so it reads as
though the variables were never set.

After the restart, check once in any terminal:

```powershell
$env:NOCTIS_CORE_TOKEN.Length   # must print 64
```

If you would rather not restart right now, this pulls the values into the session you are in. It is a
patch for one terminal, not a habit:

```powershell
foreach ($v in "NOCTIS_CORE_TOKEN", "NOCTIS_DATABASE_PATH", "NOCTIS_ALLOWED_ORIGINS") {
  Set-Item -Path "Env:$v" -Value ([Environment]::GetEnvironmentVariable($v, "User"))
}
```

## 2. Start the core and a worker with the real runtimes

**Terminal A — the core.** Leave it running.

```powershell
cd C:\Users\mmush\Documents\Jarvis\Noctis-OS
node apps\core\dist\main.js
```

Expect `core listening` on port 7717 with `schemaVersion: 6`.

**Terminal B — pair and grant.** Once per machine.

```powershell
cd C:\Users\mmush\Documents\Jarvis\Noctis-OS
$C = "http://127.0.0.1:7717"
$H = @{ Authorization = "Bearer $env:NOCTIS_CORE_TOKEN"; "Content-Type" = "application/json" }

$code = Invoke-RestMethod -Method Post -Uri "$C/commands/node.issue_pairing_code" -Headers $H `
  -Body (@{ idempotencyKey = [guid]::NewGuid().ToString(); hostId = "home" } | ConvertTo-Json)

$paired = node apps\node-agent\dist\main.js pair --core $C --code $code.code --host home
$nodeId = ($paired -replace '.*Paired as node ', '').Trim()
$nodeId
```

Then the grant. Paths live on the grant; a turn only ever names a `grantId` (owner decision 0.18).

```powershell
$grant = @{
  idempotencyKey = [guid]::NewGuid().ToString()
  nodeId = $nodeId
  capability = "runtime.turn"
  constraints = @{
    providers = @("codex", "claude")
    roots = @(
      @{ grantId = "jarvis-noctis"; path = "C:\Users\mmush\Documents\Jarvis\Noctis-OS"; mode = "write" },
      @{ grantId = "jarvis-donor";  path = "C:\Users\mmush\Documents\Jarvis\Jarvis-Sub-Agent-Dashboard"; mode = "read" },
      @{ grantId = "downloads";     path = "C:\Users\mmush\Downloads"; mode = "write" },
      @{ grantId = "documents";     path = "C:\Users\mmush\Documents"; mode = "write" },
      @{ grantId = "vault";         path = "C:\Users\mmush\OneDrive\MindVault"; mode = "read" },
      @{ grantId = "inbox";         path = "C:\Users\mmush\OneDrive\MindVault\inbox"; mode = "write" }
    )
  }
} | ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Post -Uri "$C/commands/node.grant_capability" -Headers $H -Body $grant
```

**Terminal C — the agent.** Leave it running.

```powershell
cd C:\Users\mmush\Documents\Jarvis\Noctis-OS
node apps\node-agent\dist\main.js
```

**Check what it found**, back in terminal B:

```powershell
Invoke-RestMethod "$C/nodes/$nodeId" -Headers $H | ConvertTo-Json -Depth 6
```

Expected: `status: "online"`, and `providers` showing `codex / chatgpt / available: true` with
`gpt-5.6-sol` among its models, plus `claude / claude_ai / available: true` with `sonnet` and
`opus`. An `api_key` mode, or `available: false`, is the probe telling you the login is wrong. Fix
that before sending anything: a metered credential is refused at dispatch by design (ADR-0023).

## 3. Pick the models

```powershell
Invoke-RestMethod -Method Post -Uri "$C/commands/identity.set_default_model" -Headers $H `
  -Body (@{ idempotencyKey = [guid]::NewGuid().ToString(); identityId = "vesper"; model = @{ providerId = "codex"; model = "gpt-5.6-sol" } } | ConvertTo-Json -Depth 4)

Invoke-RestMethod "$C/models" -Headers $H | ConvertTo-Json -Depth 5
```

`GET /models` should list the catalogue assembled from the connected node, and `defaults.vesper`.

## 4. Checkpoint 1A — the recorded prompt, Codex, free chat (no Objective)

**Terminal D — the page.** The page talks to Vite, which proxies the core, so both share an origin.
`VITE_CORE_URL` is therefore the **web** URL, not the core's.

```powershell
cd C:\Users\mmush\Documents\Jarvis\Noctis-OS\apps\web
$env:NOCTIS_CORE_PROXY_TARGET = "http://127.0.0.1:7717"
$env:VITE_CORE_URL = "http://localhost:5173"
$env:VITE_CORE_TOKEN = $env:NOCTIS_CORE_TOKEN
npm run dev
```

Open <http://localhost:5173>, go to Chat, confirm the model selector offers `GPT-5.6-Sol (codex)`.
The browser transport polls, so items and messages arrive within about half a second but token
deltas do not. For deltas, run the desktop shell with `NOCTIS_CORE_URL=http://127.0.0.1:7717`
instead.

Send, with `gpt-5.6-sol` selected and no Objective active:

> Look at the newest three files in my Downloads folder, tell me what they are, and move any
> screenshots into Documents\Screenshots (create it if needed).

Expected, because no Objective is active and the sandbox is therefore read-only:

1. The turn goes `running`. `command` items for the directory listing complete without asking:
   read-only heads classify as `read_inspect`.
2. The move is surfaced as an ask. An approval card appears in Chat with outcome
   `require_confirmation` and reason code `objective_not_active`. The runtime is blocked until you
   answer, and the job stays `running` because every frame renews its lease.
3. **Confirm** sends `allow` to the node, Codex performs the move, the item completes, the reply
   lands. **Decline** instead gives the item `declined` status and `GET /approvals` shows
   `declinedAt`.
4. `GET /threads/<id>/turns` shows the turn `completed` with model `codex / gpt-5.6-sol`.
5. Stop and restart both the core and the agent. Chat reloads the same messages, and the next
   prompt on that thread carries `sessionRef` and is pinned to the same node.

Record: what the three files were, that the move asked (it must), which ask kind it arrived as, and
the exact reason codes.

### 4b. Same prompt, Claude, under an active Objective

Create an Objective for Vesper and activate it:

```powershell
$obj = Invoke-RestMethod -Method Post -Uri "$C/commands/objective.create" -Headers $H `
  -Body (@{ idempotencyKey = [guid]::NewGuid().ToString(); title = "Tidy Downloads"; intent = "Sort the newest downloads and file screenshots"; status = "draft"; identityId = "vesper" } | ConvertTo-Json)
Invoke-RestMethod -Method Post -Uri "$C/commands/objective.change_status" -Headers $H `
  -Body (@{ idempotencyKey = [guid]::NewGuid().ToString(); objectiveId = $obj.id; expectedRevision = $obj.revision; status = "active" } | ConvertTo-Json)
```

Open Chat on that Objective, select `claude / sonnet`, send the same prompt.

Expected: the sandbox is `workspaceWrite` on the granted roots, so the move classifies as
`local_reversible_edit` inside `downloads`/`documents` and is **auto-allowed and audited** — an
`approvals` row with outcome `allow`, no card (owner decision 0.4). Anything outside the roots, or
reaching the network, still asks. In the desktop shell the reply streams token by token.

Record: the Claude session id landed as `sessionRef`, the items, and any ask that did appear.

## 5. The work PC core, the home PC as its worker

Full runbook in [work-pc-core.md](work-pc-core.md). Short form, once sections 0–4 are green:

1. **Work PC** (`mushafzarrar`, repo at `C:\Users\mushaf.zarrar\Documents\Noctis-OS`): `npm ci`,
   `npm run build`, set the three variables (its **own** token), `node apps\core\dist\main.js`, then
   `tailscale serve --bg 7717` → `https://mushafzarrar.tail9594ed.ts.net`. Never `tailscale funnel`.
2. **Work PC:** pair its own node with `--host work` and grant `runtime.turn` with the work roots
   only.
3. **Personal PC** (`zarrarpc`): stop its local core, then pair against the Serve URL with
   `--host home` and the same six roots as section 2. The agent accepts `https://` and dials `wss://`.
4. Re-run the section 4 prompt from the work PC's page. The turn must be pinned to the personal
   node, because only that node holds those roots. The work PC never receives a personal-root grant
   (0.30), so the pinning is what enforces the boundary rather than anyone's care.

## What is not proven yet, and is not claimed

- Phone (Slice 2), Hermes/Jester (Slice 4; the probe reports `slice_4`), Windows desktop control
  (Slice 3).
- Token deltas in a browser (Slice 2's SSE). The browser transport polls; the desktop shell streams.
- Anything about the work PC until section 5 is done.

## Evidence log

| Date       | Host | Provider / auth / model        | Prompt             | Result                                             |
| ---------- | ---- | ------------------------------ | ------------------ | -------------------------------------------------- |
| 2026-09-15 | home | codex / chatgpt / gpt-5.6-luna | Checkpoint 1A (§4) | failed, `lease_expired` (agent restarted mid-turn) |
| 2026-09-15 | home | codex / chatgpt / gpt-5.6-luna | Checkpoint 1A (§4) | completed, read real Downloads, moved nothing      |
| 2026-09-15 | home | codex / chatgpt / gpt-5.6-luna | Checkpoint 1A (§4) | completed, **moved a real screenshot**, audited    |

### 2026-09-15 — the first live turn

Home PC, core `237df2b`+, node `home` online, Codex 0.154.0-alpha.6.2 on a ChatGPT login,
model `gpt-5.6-luna`, under the active Objective "Qualify Phase 9 on Noctis-OS".

Vesper read the Vault's `agent/brain.md` through the read-only `vault` root, listed the three newest
files in `Downloads`, and reported them: two Roblox installers and a benefits PDF. **None were
screenshots, so it moved nothing and did not create `Documents\Screenshots`.** It declined to invent
the work it had been asked to do conditionally, which is the right answer and not one a fixture
could have proved.

What this establishes: prompt → turn → Codex App Server spawned on the node → a real command against
real files → items and reply persisted → thread history. `identity_sessions` holds the Codex thread
id, so the next prompt resumes rather than starting fresh. `provider_decisions` records
`gpt-5.6-luna` with cost class `subscription`.

Two things happened on the way, both recorded because they are the evidence:

- **The first turn failed with `lease_expired`,** because its agent was restarted underneath it to
  pick up a classifier fix. The turn completed as `failed` with the reason named, rather than hanging
  or being silently retried — `runtime.turn` is deliberately never re-run blind.
- **Its first command was `declined`,** and the runtime adapted: _"The first read-only shell check
  was rejected before it ran, so I'm retrying with a narrower command."_ The decline reached the
  runtime and changed its behaviour, which is the ask boundary working in the direction that matters.

### 2026-09-15 — the move, and the audit behind it

Same thread, same model, with one real screenshot now in `Downloads`. Vesper listed the three newest
files, identified `Screenshot 2026-09-15 165831.png` as the screenshot, created
`Documents\Screenshots`, and moved it there. Confirmed on disk by the owner and by
`ls Documents\Screenshots`.

**Noctis touched the owner's files for the first time.** Three approvals were written for that turn,
each `local_reversible_edit` with outcome `allow` and reason code `objective_active_scope`:

| operationClass          | outcome | reasonCodes              |
| ----------------------- | ------- | ------------------------ |
| `local_reversible_edit` | `allow` | `objective_active_scope` |

That reason code is the whole of owner decision 0.4 made checkable. The edit was auto-allowed
**because an Objective was active and the path sat inside a granted write root**, and it was recorded
anyway — so "why did it move my file" is a query, not a reconstruction. Under no Objective the same
edit produces a card instead; the reason code is what tells the two cases apart afterwards.

Still unproven after these runs, and not claimed:

- **Claude.** No live turn on the `claude` route yet; the probe reports it available.
- **Token streaming in a browser** (Slice 2 adds SSE; the desktop shell streams today).
- **The two-PC topology** (§5), and a deliberate decline answered from the page rather than the API.

# Operating Noctis nodes

A node is a machine that executes work for the core. It dials the core; the core never dials it, and
the agent opens no listening socket of its own (`apps/node-agent/src/no-listener.test.ts` asserts this
against the shipped source).

Phase 3 granted three read-only capabilities: `environment.inspect`, `file.search`, and
`verification.noop`. Slice 1 adds `runtime.turn`: one conversational turn on a model runtime the node
spawns (Codex App Server or Claude Code), with the consequential acts inside it asking through the
authority boundary (ADR-0020, ADR-0021).

## Pairing a node

Pairing is a one-time code, redeemed once, expiring after 15 minutes.

1. On the core operator's machine, cut a code for the host you are about to pair:

   ```powershell
   $body = @{ idempotencyKey = [guid]::NewGuid().ToString(); hostId = "workstation" } | ConvertTo-Json
   Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:7717/commands/node.issue_pairing_code" `
     -Headers @{ Authorization = "Bearer $env:NOCTIS_CORE_TOKEN"; "Content-Type" = "application/json" } `
     -Body $body
   ```

   The response carries `code` **once**. The core stores only its SHA-256 digest, so a repeat of the
   same command answers with the code's id and expiry but never the code again.

2. On the node's machine:

   ```powershell
   node apps/node-agent/dist/main.js pair --core http://127.0.0.1:7717 --code <code> --host workstation
   ```

   `--host` must match the `hostId` the code was cut for. The agent writes
   `%NOCTIS_NODE_HOME%\node.json` (default `~/.noctis/node.json`, mode 0600) and prints the node id.

3. Grant it a capability — the node can do nothing until you do:

   ```powershell
   $body = @{
     idempotencyKey = [guid]::NewGuid().ToString()
     nodeId = "<node id>"
     capability = "file.search"
     constraints = @{ roots = @(@{ grantId = "notes"; path = "C:\Users\me\Notes" }) }
   } | ConvertTo-Json -Depth 5
   Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:7717/commands/node.grant_capability" ...
   ```

   A grant never names its own operation class: it is derived from the capability, so a grant cannot
   understate what it permits. `expiresAt` is optional and honoured by the router.

4. Run the agent:

   ```powershell
   node apps/node-agent/dist/main.js
   ```

## Granting `runtime.turn`

The grant names the runtimes the node may spawn and the folders they may see. Paths live on the grant;
a turn names a grant id.

```powershell
$body = @{
  idempotencyKey = [guid]::NewGuid().ToString()
  nodeId = "<node id>"
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
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:7717/commands/node.grant_capability" ...
```

- `mode: "write"` roots become the runtime's writable sandbox when the turn's Objective is active;
  otherwise the sandbox is read-only and every write asks. `mode: "read"` roots need nothing extra:
  a workspace-write sandbox can read anywhere.
- `localOnly: true` on a root means only a `local` auth-mode runtime (Slice 4's Hermes on LM
  Studio) may be routed a turn that uses it.
- The node reports what it found at start-up in its `hello` (`GET /nodes/<id>` shows
  `providers[]` with auth mode and models). Only `chatgpt`, `claude_ai` and `local` auth modes
  are routable; an `api_key` login is refused at dispatch (ADR-0023).
- A turn is pinned to the node that holds its session; `GET /jobs/<id>` shows
  `pinned_node_unavailable` while that node is offline.
- Set `NOCTIS_RUNTIME=fake` on the agent to run the scripted fake runtime (CI and E2E only).

## What a request may name

A `file.search` job names a **grant id**, never a path. The path lives on the grant, chosen by you at
grant time. `nameContains` is a case-insensitive substring, not a regular expression, because the value
can come from a model and a model-supplied regex is a denial of service against the node. The walk is
bounded (20,000 entries, 12 levels deep) and never descends a symlink or junction.

## Starting without a person (ADR-0036)

Default off. A worker that comes back from a reboot or a wake and never dials the core is a machine
that is up and cannot run a turn — `docs/operations/WOL.md` §5. Register this only on a host whose
autostart the owner has approved by name; it was approved for `zarrarpc` on 2026-09-22.

**Run as the owner, never as `LocalSystem`.** Two independent reasons, and both bite silently:

- The runtimes authenticate out of the owner's profile (`~/.codex`, `~/.claude`). As SYSTEM those
  directories do not exist, every probe reports unavailable, and ADR-0023 leaves nothing to fall back
  to — so the node would connect, look healthy, and refuse every turn.
- `machineFingerprint()` in `main.ts` hashes `userInfo().username`. A different account is a
  different node to the core, so an agent started under the wrong identity does not reconnect — it
  asks to be paired again.

Registered with `-LogonType S4U`, which runs as that account with no logon session and **no stored
password**. Windows' other option for "whether the user is logged on or not" is to keep the account's
password in the credential store; a worker that needs a copy of the owner's Windows password lying on
it to start a process is a worse trade than the one thing S4U gives up (see below). Run this in
**elevated PowerShell** — an at-startup trigger needs it — while logged in as the owner:

```powershell
$repo = "C:\Users\mmush\Documents\Jarvis\Noctis-OS"
$node = "C:\Program Files\nodejs\node.exe"   # must be the version in .nvmrc

$action    = New-ScheduledTaskAction -Execute $node `
  -Argument "$repo\apps\node-agent\dist\main.js" -WorkingDirectory $repo
$trigger   = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$env:USERNAME" `
  -LogonType S4U -RunLevel Limited
# Restart rather than sit dead: a worker that gave up once is a worker nobody
# notices is gone until a turn is refused.
$settings  = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "Noctis node agent" -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings
```

**What S4U gives up, and how it would show.** An S4U logon has the owner's identity and profile but
no credentials for Windows authentication, and it cannot unwrap DPAPI data protected by the password.
Outbound TLS to the core carries a bearer token, not a Windows credential, so the agent itself is
unaffected. The runtimes are the open question: if a provider keeps its token in a plain file under
the profile it is fine, and if it uses DPAPI it will fail. **The symptom is specific** — the node
comes online and every provider reports unavailable in `hello.providers[]`. If that happens,
re-register with `-User`/`-Password` instead of `-Principal` and accept the stored password.

Check it the only way that means anything — **Restart**, do not log in for a minute, then read the
core's node list from another machine and confirm the host is online **and that its providers are
available**. A task that shows `Ready` in Task Scheduler has proved nothing, and a node that is
online but refuses every turn is the failure this section is most likely to produce.

**Restart, not Shut down.** With Fast Startup on (`HiberbootEnabled = 1`, the Windows default), Shut
down logs the user off and _hibernates_ session 0 rather than ending it, and power-on resumes it —
the event log records `Kernel-Boot` 27 with boot type `1`, and `LastBootUpTime` does not move. The
agent lives in session 0, so it survives a Shut down with its process intact and the at-startup
trigger never fires. That is a real test of reconnection (its socket is dead on resume) and no test
of the trigger at all. Only Restart, boot type `0`, proves the trigger.

**The tailnet has to be there before anyone logs in.** Tailscale on Windows follows the signed-in
user unless it runs in unattended mode (`tailscale set --unattended`, off by default). Without it a
worker can be running, retrying, and unable to reach the core until someone logs in — "reachable"
and "worker authenticated" both wait on the login this section exists to make unnecessary.

To remove it: `Unregister-ScheduledTask -TaskName "Noctis node agent" -Confirm:$false`.

**The version matters.** `.nvmrc`, `engines` and CI all pin Node 22.23.2. Pointing `$node` at
whatever happens to be on `PATH` is how a worker ends up on a different runtime from CI without
anyone deciding to.

**What this does not give you.** The agent may now be running in a session with no desktop — before
anyone logs in, and, under ADR-0035, in a console session an RDP connection has just evicted. Headless
turns are fine there; GUI tools are not. "Desktop ready" stays something the node reports separately
from "worker authenticated", and neither is assumed from the other.

## Credentials

The core stores no node secret. A credential is derived from `NOCTIS_CORE_TOKEN`, the node id, and a
generation counter, and is rotated on every connection — the agent receives the next one in its
`welcome` frame and persists it. The previous generation stays valid, so an agent that dies before
writing the new value reconnects on the old one.

Two consequences worth knowing:

- **Rotating `NOCTIS_CORE_TOKEN` invalidates every node credential.** Every node must re-pair. That is
  the correct blast radius for a compromised core token, but plan for it.
- A credential two rotations old is refused. An agent offline across two of _its own_ reconnects is
  unaffected; only a copy of an old credential is.

## Revoking a node

```powershell
$body = @{ idempotencyKey = [guid]::NewGuid().ToString(); nodeId = "<node id>" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:7717/commands/node.revoke" ...
```

Revocation drops the node's socket immediately, revokes every grant it held, refuses its credential on
any future connection, and stops the router placing work on it. A revoked node can be brought back only
by redeeming a fresh pairing code, which is an explicit act by you; the re-instatement is recorded as a
`node.status_changed.v1` event.

## Reading the state

- `GET /nodes` — every node, with a live `connected` flag from the socket map rather than the row.
- `GET /nodes/<id>` — one node plus its grants.
- `GET /jobs/<id>` — the job, its evidence, and, while it is still `queued`, a `routingReason`.

`routingReason` is computed when you read it, so it is the reason _now_:

| Reason                    | Meaning                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `mission_is_core_only`    | The job's Mission is `core_only`; no node may run it.              |
| `no_paired_node`          | No node exists, or every one is revoked.                           |
| `no_node_for_host`        | The Mission names a host and no node is on it.                     |
| `no_node_with_capability` | No node on the eligible hosts holds the capability.                |
| `grant_expired`           | The capability is granted but the grant has lapsed or was revoked. |
| `no_online_node`          | A capable node exists but nothing is connected.                    |
| `pinned_node_unavailable` | The job is pinned to a node that is offline or revoked.            |

## Leases

A leased job holds its lease for 30 seconds. A lapsed lease is swept every 5 seconds:
`read_inspect` jobs are requeued up to 3 attempts and then cancelled; anything else stays `expired`
(`runtime.turn` included: a turn may have edited files before its lease lapsed),
which means _somebody has to find out what actually happened_. That is deliberate — re-running a
consequential operation blind is how one uncertain write becomes two.

## The browser a runtime is lent

`@playwright/mcp` ships with the node agent, so nothing is installed per node — but it drives a
real browser, and the node PC needs one: `npx playwright install chrome` (or an installed Chrome).
Without it the first `browser_navigate` fails with Playwright's own message; the tools still exist.

- **One profile per thread**, at `%NOCTIS_NODE_HOME%\browser\<threadId>` (`~\.noctis\browser\…`
  when the variable is unset). A site signed into inside one thread is signed in for that thread's
  later turns and nowhere else. Deleting the folder signs that thread out.
- **Screenshots and traces** go to `…\<threadId>\output`, never the granted root, so a file arriving
  on disk is still a file something asked about.
- **Five tools**: `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`,
  `browser_take_screenshot`. Every one of them is an ask, classed `external_write`. Everything else
  the server offers — `browser_evaluate`, `browser_run_code_unsafe`, the storage and cookie tools —
  is refused by the node without asking you.
- **Claude turns only.** Codex's app-server raises no approval for an MCP tool call (verified against
  its 0.154 protocol schema), so attaching a browser there would be a browser nothing asks about.

## Limits in this phase

- **The core is loopback-only by default.** A node on another machine needs
  `NOCTIS_ALLOW_NON_LOOPBACK=true` and a network path you have arranged yourself. Phase 4 owns the
  transport; until then, prefer a node on the same machine.
- **No rate limiting** on `/node/pair` (ADR-0010, ADR-0014). A pairing code is 128 random bits with a
  15-minute life, which is not brute-forceable over a loopback bind, but it stops being the whole story
  the moment the core is reachable from elsewhere.
- **Progress frames are validated, counted, and dropped**, but every frame about a job renews its
  lease, which is how a long turn stays alive. Stream, delta and ask frames go to the conversation
  service; a `runtime.turn` job has a budget of 100 000 frames.
- **No grant-level revocation command.** Revoke the node, or set `expiresAt` when you grant.

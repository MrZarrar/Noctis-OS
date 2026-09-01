# Operating Noctis nodes

A node is a machine that executes work for the core. It dials the core; the core never dials it, and
the agent opens no listening socket of its own (`apps/node-agent/src/no-listener.test.ts` asserts this
against the shipped source).

Phase 3 grants three read-only capabilities: `environment.inspect`, `file.search`, and
`verification.noop`.

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

## What a request may name

A `file.search` job names a **grant id**, never a path. The path lives on the grant, chosen by you at
grant time. `nameContains` is a case-insensitive substring, not a regular expression, because the value
can come from a model and a model-supplied regex is a denial of service against the node. The walk is
bounded (20,000 entries, 12 levels deep) and never descends a symlink or junction.

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

## Leases

A leased job holds its lease for 30 seconds. A lapsed lease is swept every 5 seconds:
`read_inspect` jobs are requeued up to 3 attempts and then cancelled; anything else stays `expired`,
which means _somebody has to find out what actually happened_. That is deliberate — re-running a
consequential operation blind is how one uncertain write becomes two.

## Limits in this phase

- **The core is loopback-only by default.** A node on another machine needs
  `NOCTIS_ALLOW_NON_LOOPBACK=true` and a network path you have arranged yourself. Phase 4 owns the
  transport; until then, prefer a node on the same machine.
- **No rate limiting** on `/node/pair` (ADR-0010, ADR-0014). A pairing code is 128 random bits with a
  15-minute life, which is not brute-forceable over a loopback bind, but it stops being the whole story
  the moment the core is reachable from elsewhere.
- **Progress frames are validated, counted, and dropped.** Nothing renders progress yet.
- **No grant-level revocation command.** Revoke the node, or set `expiresAt` when you grant.

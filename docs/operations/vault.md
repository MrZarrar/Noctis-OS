# The Vault, live

Slice 2 task 2.5 (ADR-0029). The core indexes the owner's real Obsidian Vault, reads from it to
inform a turn, and writes nothing except one appended bullet in the Agent Brain.

This is written for whoever is configuring a Noctis core on a machine that has the real Vault on it —
today the work PC, `mushafzarrar`.

## What "live" means and what it does not

| Switch                      | Default | What it turns on                                                                                           |
| --------------------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `NOCTIS_VAULT_ROOT`         | unset   | The Vault at all. Unset means no indexing, no recall, and no brain — every Vault feature is simply absent. |
| `NOCTIS_VAULT_ALLOW_LIVE`   | unset   | Permission for that root to be the owner's **real** notes rather than a fixture. Read-only.                |
| `NOCTIS_VAULT_ALLOW_WRITES` | unset   | Writing. Opens exactly one file to a runtime: `agent/brain.md`, through the Agent Brain's own rules.       |

The three are independent, and that is the point. Reading a real Vault and writing to one are
different consequences, and neither implies the other.

`NOCTIS_VAULT_ALLOW_LIVE` exists because the core refuses to index a path that looks like real notes
unless somebody said so. The check is two independent signals — a path segment named `OneDrive`,
`OneDrive - <org>` or `MindVault`, or a `.obsidian` directory in the root — and it is deliberately
eager. A stale environment variable or a copied command line must not quietly point the core at the
canonical Vault.

## Configure it (work PC)

```powershell
# The real Vault. Resolve it rather than typing a path: the OneDrive root differs per machine.
$vaultRoot = Join-Path $env:OneDrive 'MindVault'
Test-Path (Join-Path $vaultRoot 'agent\brain.md')   # must be True before going further

setx NOCTIS_VAULT_ROOT       $vaultRoot
setx NOCTIS_VAULT_ALLOW_LIVE true
```

Open a new terminal (`setx` does not affect the one you are in) and restart the core. It logs
`vault root resolved` with `live: true` on the way up. If it refuses to start, the message names the
path it resolved and which switch is missing — a refusal at start-up is the design, not a fault.

Then index once:

```powershell
# Through the core, with the core token. Reindexing is idempotent.
curl.exe -X POST "$env:NOCTIS_CORE_URL/commands/vault.reindex" `
  -H "authorization: Bearer $env:NOCTIS_CORE_TOKEN" `
  -H "content-type: application/json" `
  -d '{\"idempotencyKey\":\"reindex-first\"}'
```

## What recall does to a turn

Every `conversation.send` runs one focused recall against the prompt before the job is enqueued. When
the Vault has something to say, the evidence goes **in front of** the prompt, one line per quote:

```
From the owner's Vault, which may be out of date — each line names its note and how fresh it is:
- projects/noctis.md (current): The work PC runs the core
- people/astra.md (stale): Astra owns the visual language after Slice 3

<what the owner typed>
```

Three things to know about it:

- **Provenance is not optional.** Every line names its note and its freshness. A quote a model repeats
  can be traced back to the file it came from, and a note that has been edited since it was indexed
  says `stale` rather than pretending to be current.
- **`unavailable` and `unknown` are never carried.** A note that has been deleted, or a query nobody
  could look up, contributes nothing rather than an apology the model has to reason about.
- **The owner's words are last.** Context never displaces the instruction.

Nothing is recorded for these. `vault_recalls` is the audit table for a recall the owner asked for;
one of these happens on every single turn, and filling an audit table with them would make it useless.

There is a real ceiling here, recorded in `apps/core/src/conversation/recall-context.ts`: the whole
prompt is the query, matched with `LIKE` against entity names and keys, so a long prompt matches
nothing. Short prompts that name a project or a person work; a paragraph does not. Which terms should
be extracted is the sort of thing the live evidence should decide, so it is deliberately unbuilt.

## Writes

The Vault service refuses every write unless `NOCTIS_VAULT_ALLOW_WRITES=true`, and even then it
refuses any file that changed since it was read — so no automated write can overwrite something
edited in Obsidian.

Two paths exist, and only two:

1. **The `inbox` grant.** A runtime writes into `<vault>\inbox\` because a node grant names that
   folder as a writable root, exactly like any other granted folder. Nothing Vault-specific happens:
   the authority evaluator decides, the node writes a file. Grant it with `node.grant_capability`
   naming `<vault>\inbox` and nothing above it.
2. **The Agent Brain.** A runtime calls the `noctis_remember_preference` MCP tool with one bullet.
   The tool records a proposal; the **core** applies it, under the brain's own rules:
   - the bullet is refused if `agent/brain.md` already contains it (compared on normalized text),
   - refused if the file is already at 150 lines,
   - refused if the file does not exist — a runtime does not bring a Vault structure into being,
   - and written atomically against the hash read a moment earlier, so a brain edited in Obsidian
     mid-turn refuses rather than losing the human's edit.

   A refusal is logged with its reason and the turn carries on. A turn that learned something and
   could not write it down is still a turn that did its work.

Grant the `inbox` root, never the Vault root. A writable grant over the whole Vault would make every
note reachable by every turn, and the conflict check is a safety net for accidents, not a permission
system.

## When it looks wrong

| Symptom                                         | Cause                                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Core refuses to start, naming the Vault path    | `NOCTIS_VAULT_ALLOW_LIVE` is unset and the root looks live. Set it, or point at a fixture.            |
| Core starts, `vault root resolved` never logged | `NOCTIS_VAULT_ROOT` is unset in the core's own environment. `setx` needs a new terminal.              |
| Recall returns nothing for an obvious note      | Either the index is empty (run `vault.reindex`) or the prompt is too long — see the ceiling above.    |
| Every recall line says `stale`                  | The Vault was indexed and then edited. Reindex.                                                       |
| `runtime proposal skipped … writes_disabled`    | `NOCTIS_VAULT_ALLOW_WRITES` is unset. That is the default and is not a fault.                         |
| `runtime proposal skipped … brain_missing`      | `agent/brain.md` does not exist under the resolved root. Check the root is the Vault, not its parent. |

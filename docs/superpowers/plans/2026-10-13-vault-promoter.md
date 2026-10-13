# Vault Promoter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The second brain grows again: agents capture to `inbox/`, and a scheduled Vesper turn promotes inbox notes into add-only edits to `people/`, `reference/` and `projects/`, applied automatically, listed with Undo, while anything that would change existing text waits in Approvals.

**Architecture:** The model proposes, deterministic core code writes (AGENTS.md). A promoter run is an ordinary Vesper turn in a dedicated "Vault upkeep" thread; its prompt carries a batch of unpromoted inbox notes. The agent answers through three new Noctis tools (`noctis_vault_fact`, `noctis_vault_note`, `noctis_vault_revision`) that become `RuntimeProposal` kinds. `applyProposal` hands them to a new `vault/promote.ts`, which writes through the existing `writeNoteAtomically` (hash-checked, atomic) and records every edit in a `vault_edits` table so it can be listed, undone, or approved.

**Tech Stack:** TypeScript, Node 22.23.2, `node:sqlite`, zod 4, vitest 4, React 18. No new dependencies.

**Depends on:** [Settings in the UI](2026-10-13-settings-in-the-ui.md), built first: the promoter's time is the `promoterAt` setting and Vault writes are the `vaultWrites` setting, both on the Settings page.

**Spec:** The owner's decisions in conversation on 2026-10-13: (1) every agent has the whole MindVault to hand without being asked (commit `cf85612`); (2) promotion auto-applies add-only edits and shows them in the digest with Undo; (3) anything that would change or remove existing text goes to Approvals. Background: Jarvis's entity engine (`server/lib/vault-engine.js`, not ported — `DONOR-PORT-LEDGER.md`) last promoted on 2026-08-14; `inbox/` holds 59 unpromoted notes.

## Global Constraints

- Node.js 22.23.2 and the exact package lock; no new packages.
- Failing test first for every behaviour; record red and green.
- Default-off: nothing runs unless the **File the inbox nightly** setting has a time or the owner presses **Promote now**. Writes need the **Let Noctis write to the Vault** setting. Both are set on the Settings page, never by editing code or the environment.
- Never rewrite or delete text the owner wrote. Auto-applied edits only insert inside a Noctis-owned block or create a note that does not exist.
- Every write goes through `writeNoteAtomically` (`apps/core/src/vault/writes.ts`), so a note edited in Obsidian since it was read refuses the write.
- Paths are Vault-relative; facts and new notes only under `people/`, `reference/`, `projects/`.
- Sensitive notes (`sensitive: true`) are never edited by the promoter.
- Prose in UI and docs: plain British English, no em-dash fragments, matching the existing status log.

## Review Focus

1. **A note edited in Obsidian between the agent reading it and the write**: the write is refused with a conflict, recorded as `conflict`, and nothing is overwritten. (Task 2 test "refuses a fact when the note changed under it".)
2. **Undo after the owner has edited the note since the promotion**: Undo refuses with a clear reason instead of reverting their edit. (Task 2 test "will not undo over the owner's later edit".)
3. **The same inbox note offered twice** (a retried run, or a turn that failed): a note is offered again only if its last offer failed or its content changed, so one fact is not appended twice. (Task 4 test "offers a note once, again after a failed run or an edit".)
4. **An agent proposing a path outside the allowed folders, `..` traversal, or into a sensitive note**: refused and recorded, never written. (Task 2 test "refuses paths outside people, reference and projects, and sensitive notes".)
5. **A duplicate fact** (the agent restates something the note's block already says): skipped as `already_known`, like the Agent Brain. (Task 2 test "skips a fact the block already holds".)

---

## File Structure

| File                                                                      | Responsibility                                                                                               |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/contracts/src/runtime.ts`                                       | Three new `RuntimeProposal` kinds                                                                            |
| `apps/node-agent/src/noctis-mcp.ts`                                       | Three new tools that record those proposals                                                                  |
| `apps/core/migrations/0019_vault_edits.sql`                               | `vault_edits`, `vault_promotions`, `vault_promoter` tables                                                   |
| `apps/core/src/vault/promote.ts` (new)                                    | Apply, undo, approve, decline Vault edits; the only writer for promotion                                     |
| `apps/core/src/vault/promoter.ts` (new)                                   | Pick the inbox batch, build the prompt, start the run                                                        |
| `apps/core/src/conversation/proposals.ts`                                 | Route the new proposal kinds to `promote.ts`                                                                 |
| `packages/contracts/src/command.ts`, `apps/core/src/api/http.ts`          | `vault.promote_now`, `vault.undo_edit`, `vault.apply_revision`, `vault.decline_revision`; `GET /vault/edits` |
| `apps/core/src/server.ts`                                                 | The nightly timer, beside the digest's                                                                       |
| `apps/core/src/notify/digest.ts`                                          | Count promoted and waiting edits                                                                             |
| `apps/web/src/pages/Vault.tsx`, `apps/web/src/pages/VaultEdits.tsx` (new) | "From the inbox" list with Undo; pending revisions with Apply/Decline                                        |
| `apps/node-agent/src/runtimes/identity.ts`                                | Tell agents to capture to `inbox/` when it is writable                                                       |

---

### Task 1: The proposal kinds and their tools

**Files:**

- Modify: `packages/contracts/src/runtime.ts:118-153`
- Modify: `apps/node-agent/src/noctis-mcp.ts:28,47-66`
- Test: `packages/contracts/src/runtime.test.ts`

**Interfaces:**

- Produces: `RuntimeProposal` gains
  - `{ kind: "vault_fact"; path: string; fact: string; source: string }`
  - `{ kind: "vault_note"; path: string; title: string; body: string; source: string }`
  - `{ kind: "vault_revision"; path: string; find: string; replace: string; reason: string; source: string }`
- `VaultEditPathSchema`: a Vault-relative `.md` path under `people/`, `reference/` or `projects/`, no `..`.

- [ ] **Step 1: Write the failing test** (append to `packages/contracts/src/runtime.test.ts`)

```ts
describe("Vault edit proposals", () => {
  it("accepts a fact, a new note and a revision under people, reference and projects", () => {
    expect(
      RuntimeProposalSchema.parse({
        kind: "vault_fact",
        path: "people/tolga.md",
        fact: "Moved to the Istanbul office in October 2026. [[Travel Vogue]]",
        source: "inbox/2026-10-13-tolga.md",
      }).kind,
    ).toBe("vault_fact");
    expect(
      RuntimeProposalSchema.parse({
        kind: "vault_note",
        path: "reference/hyperframes.md",
        title: "Hyperframes",
        body: "A short-form video template. Used by [[Thought Unfolds]].",
        source: "inbox/2026-10-06-hyperframes-workflow-skills-lesson.md",
      }).kind,
    ).toBe("vault_note");
    expect(
      RuntimeProposalSchema.parse({
        kind: "vault_revision",
        path: "people/tolga.md",
        find: "Works in London.",
        replace: "Works in Istanbul.",
        reason: "inbox note of 13 October says he moved",
        source: "inbox/2026-10-13-tolga.md",
      }).kind,
    ).toBe("vault_revision");
  });

  it.each([
    "inbox/x.md",
    "agent/brain.md",
    "people/../agent/brain.md",
    "/people/x.md",
    "C:/people/x.md",
    "people/x.txt",
  ])("refuses a path the promoter may not write: %s", (path) => {
    expect(
      RuntimeProposalSchema.safeParse({
        kind: "vault_fact",
        path,
        fact: "A fact.",
        source: "inbox/a.md",
      }).success,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run packages/contracts/src/runtime.test.ts -t "Vault edit proposals"`
Expected: FAIL, the discriminator rejects `vault_fact`.

- [ ] **Step 3: Implement** — in `runtime.ts`, before `RuntimeProposalSchema`:

```ts
/** Where promotion may write: the structured folders, never inbox/, agent/ or daily/. */
export const VaultEditPathSchema = z
  .string()
  .trim()
  .max(300)
  .regex(/^(people|reference|projects)\/[^\\:]+\.md$/)
  .refine((path) => !path.split("/").includes(".."), "may not leave its folder");

const InboxSourceSchema = z
  .string()
  .trim()
  .max(300)
  .regex(/^inbox\/[^\\:]+\.md$/);
```

and add three members to the union:

```ts
  /** One line added to a note's Noctis block. Add-only, so it applies without asking. */
  z
    .object({
      kind: z.literal("vault_fact"),
      path: VaultEditPathSchema,
      fact: z.string().trim().min(3).max(500),
      source: InboxSourceSchema,
    })
    .strict(),
  /** A note that does not exist yet. Refused if it does. */
  z
    .object({
      kind: z.literal("vault_note"),
      path: VaultEditPathSchema,
      title: z.string().trim().min(1).max(200),
      body: z.string().trim().min(1).max(8000),
      source: InboxSourceSchema,
    })
    .strict(),
  /** A change to the owner's own words. Never applied without the owner. */
  z
    .object({
      kind: z.literal("vault_revision"),
      path: VaultEditPathSchema,
      find: z.string().min(1).max(2000),
      replace: z.string().max(2000),
      reason: z.string().trim().min(3).max(500),
      source: InboxSourceSchema,
    })
    .strict(),
```

In `noctis-mcp.ts` change line 28 to
`const [surface, objective, preference, vaultFact, vaultNote, vaultRevision] = RuntimeProposalSchema.options;`
and register before `server.connect`:

```ts
server.registerTool(
  "noctis_vault_fact",
  {
    description:
      "Add one fact to a MindVault note under people/, reference/ or projects/, with [[wikilinks]] for every name. Noctis adds it to the note's Noctis block and the owner can undo it. Name the inbox note it came from.",
    inputSchema: vaultFact.omit({ kind: true }),
  },
  (args) => record(RuntimeProposalSchema.parse({ kind: "vault_fact", ...args })),
);

server.registerTool(
  "noctis_vault_note",
  {
    description:
      "Create a MindVault note that does not exist yet, under people/, reference/ or projects/. Use the note's kebab-case name as the file name. Refused if the note exists: add a fact to it instead.",
    inputSchema: vaultNote.omit({ kind: true }),
  },
  (args) => record(RuntimeProposalSchema.parse({ kind: "vault_note", ...args })),
);

server.registerTool(
  "noctis_vault_revision",
  {
    description:
      "Propose changing text the owner wrote in a MindVault note: quote it exactly in `find`. Nothing changes until the owner approves it.",
    inputSchema: vaultRevision.omit({ kind: true }),
  },
  (args) => record(RuntimeProposalSchema.parse({ kind: "vault_revision", ...args })),
);
```

- [ ] **Step 4: Run it to see it pass**, then `npm run typecheck` (the union widening makes `applyProposal` non-exhaustive only if it switches exhaustively; it does not, so it compiles; Task 3 adds the branches).

- [ ] **Step 5: Commit** — `feat(contracts): Vault fact, note and revision proposals`

---

### Task 2: Applying, undoing and approving edits

**Files:**

- Create: `apps/core/migrations/0019_vault_edits.sql`
- Create: `apps/core/src/vault/promote.ts`
- Test: `apps/core/src/vault/promote.test.ts`
- Modify: `apps/core/src/db/migrate.test.ts` (version 19), `apps/core/src/api/headless.integration.test.ts:333` (schemaVersion 19)

**Interfaces:**

- Consumes: `writeNoteAtomically`, `hashOf`, `resolveWritePath`, `VaultConflict`, `VaultWriteRefused` from `./writes.js`; `parseNote`, `isSensitiveNote` from `@noctis/domain`; `Kernel` from `../kernel.js`.
- Produces:

```ts
export type VaultEditStatus = "applied" | "undone" | "pending" | "declined" | "refused";
export interface VaultEdit {
  id: string;
  kind: "fact" | "note" | "revision";
  path: string;
  source: string;
  text: string;
  status: VaultEditStatus;
  reason?: string;
  turnId?: string;
  createdAt: string;
  decidedAt?: string;
}
export interface PromoteDeps {
  kernel: Kernel;
  root: VaultRoot | undefined;
  env: Readonly<Record<string, string | undefined>>;
}
export function addFact(
  deps: PromoteDeps,
  input: { path: string; fact: string; source: string; turnId?: string },
): VaultEdit;
export function createNote(
  deps: PromoteDeps,
  input: { path: string; title: string; body: string; source: string; turnId?: string },
): VaultEdit;
export function proposeRevision(
  deps: PromoteDeps,
  input: {
    path: string;
    find: string;
    replace: string;
    reason: string;
    source: string;
    turnId?: string;
  },
): VaultEdit;
export function undoEdit(deps: PromoteDeps, id: string): VaultEdit;
export function applyRevision(deps: PromoteDeps, id: string): VaultEdit;
export function declineRevision(deps: PromoteDeps, id: string): VaultEdit;
export function listEdits(db: NoctisDatabase, limit: number): VaultEdit[];
export const FACTS_OPEN = "<!-- noctis:facts -->";
export const FACTS_CLOSE = "<!-- /noctis:facts -->";
```

- [ ] **Step 1: The migration** (`0019_vault_edits.sql`)

```sql
-- apps/core/migrations/0019_vault_edits.sql
-- Every edit the promoter made or proposed, so each can be listed, undone or
-- approved. `before_contents` is the whole note before an applied edit (NULL for
-- a note the edit created); `after_hash` is what undo expects to find.
CREATE TABLE vault_edits (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('fact', 'note', 'revision')),
  path            TEXT NOT NULL,
  source          TEXT NOT NULL,
  text            TEXT NOT NULL,
  replace_text    TEXT,
  status          TEXT NOT NULL CHECK (status IN ('applied', 'undone', 'pending', 'declined', 'refused')),
  reason          TEXT,
  before_contents TEXT,
  after_hash      TEXT,
  turn_id         TEXT,
  created_at      TEXT NOT NULL,
  decided_at      TEXT
);
CREATE INDEX vault_edits_by_time ON vault_edits (created_at);

-- Which inbox notes, at which content, a promoter turn was given.
CREATE TABLE vault_promotions (
  path         TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  turn_id      TEXT NOT NULL,
  offered_at   TEXT NOT NULL,
  PRIMARY KEY (path, content_hash, turn_id)
);

-- One row: the thread promoter turns run in.
CREATE TABLE vault_promoter (
  id        INTEGER PRIMARY KEY CHECK (id = 1),
  thread_id TEXT NOT NULL
);
```

- [ ] **Step 2: Write the failing tests** (`promote.test.ts`). Use the same kernel and fixture helpers as `vault.integration.test.ts` (copy `makeKernel`, `scratch` and `vaultRoot` from its top 90 lines), with `const env = { NOCTIS_VAULT_ALLOW_WRITES: "true" }`.

```ts
describe("a promoted fact", () => {
  it("is added inside the note's Noctis block and leaves the owner's text byte-identical", () => {
    const { deps, root } = setup();
    const before = readNote(root.path, "people/alex-kerr.md");

    const edit = addFact(deps, {
      path: "people/alex-kerr.md",
      fact: "Moved to [[Acme Travel]] in October.",
      source: "inbox/loose-thought.md",
    });
    const after = readNote(root.path, "people/alex-kerr.md");

    expect(edit.status).toBe("applied");
    expect(after.startsWith(before.trimEnd())).toBe(true);
    expect(after).toContain(
      `${FACTS_OPEN}\n- Moved to [[Acme Travel]] in October. (from [[loose-thought]])\n${FACTS_CLOSE}`,
    );
  });

  it("adds a second fact to the same block rather than a second block", () => {
    const { deps, root } = setup();
    addFact(deps, {
      path: "people/alex-kerr.md",
      fact: "First.",
      source: "inbox/loose-thought.md",
    });
    addFact(deps, {
      path: "people/alex-kerr.md",
      fact: "Second.",
      source: "inbox/loose-thought.md",
    });

    expect(readNote(root.path, "people/alex-kerr.md").split(FACTS_OPEN)).toHaveLength(2);
  });

  it("skips a fact the block already holds", () => {
    const { deps } = setup();
    addFact(deps, {
      path: "people/alex-kerr.md",
      fact: "First.",
      source: "inbox/loose-thought.md",
    });

    const again = addFact(deps, {
      path: "people/alex-kerr.md",
      fact: "first.",
      source: "inbox/loose-thought.md",
    });

    expect(again).toMatchObject({ status: "refused", reason: "already_known" });
  });

  it("refuses paths outside people, reference and projects, and sensitive notes", () => {
    const { deps, root } = setup();
    writeFileSync(join(root.path, "people/secret.md"), "---\nsensitive: true\n---\n# Secret\n");

    expect(
      addFact(deps, { path: "agent/brain.md", fact: "x y z", source: "inbox/a.md" }).reason,
    ).toBe("path_not_allowed");
    expect(
      addFact(deps, { path: "people/../agent/brain.md", fact: "x y z", source: "inbox/a.md" })
        .reason,
    ).toBe("path_not_allowed");
    expect(
      addFact(deps, { path: "people/secret.md", fact: "x y z", source: "inbox/a.md" }).reason,
    ).toBe("sensitive");
    expect(
      addFact(deps, { path: "people/nobody.md", fact: "x y z", source: "inbox/a.md" }).reason,
    ).toBe("note_missing");
  });

  it("refuses a fact when the note changed under it", () => {
    const { deps, root } = setup();
    const file = join(root.path, "people/alex-kerr.md");
    // Simulates Obsidian saving between the read and the rename.
    const edit = addFact(
      { ...deps, beforeWrite: () => appendFileSync(file, "\nEdited.\n") },
      {
        path: "people/alex-kerr.md",
        fact: "A fact.",
        source: "inbox/a.md",
      },
    );

    expect(edit).toMatchObject({ status: "refused", reason: "conflict" });
    expect(readFileSync(file, "utf8")).not.toContain(FACTS_OPEN);
  });

  it("is refused, and recorded, when writes are off", () => {
    const { deps } = setup();
    expect(
      addFact(
        { ...deps, env: {} },
        { path: "people/alex-kerr.md", fact: "A fact.", source: "inbox/a.md" },
      ).reason,
    ).toBe("writes_disabled");
  });
});

describe("undo", () => {
  it("puts the note back exactly as it was", () => {
    const { deps, root } = setup();
    const before = readNote(root.path, "people/alex-kerr.md");
    const edit = addFact(deps, {
      path: "people/alex-kerr.md",
      fact: "A fact.",
      source: "inbox/a.md",
    });

    expect(undoEdit(deps, edit.id).status).toBe("undone");
    expect(readNote(root.path, "people/alex-kerr.md")).toBe(before);
  });

  it("removes a note the promoter created", () => {
    const { deps, root } = setup();
    const edit = createNote(deps, {
      path: "reference/hyperframes.md",
      title: "Hyperframes",
      body: "A template.",
      source: "inbox/a.md",
    });

    undoEdit(deps, edit.id);

    expect(existsSync(join(root.path, "reference/hyperframes.md"))).toBe(false);
  });

  it("will not undo over the owner's later edit", () => {
    const { deps, root } = setup();
    const edit = addFact(deps, {
      path: "people/alex-kerr.md",
      fact: "A fact.",
      source: "inbox/a.md",
    });
    appendFileSync(join(root.path, "people/alex-kerr.md"), "\nThe owner's own line.\n");

    expect(undoEdit(deps, edit.id)).toMatchObject({ status: "applied", reason: "changed_since" });
    expect(readNote(root.path, "people/alex-kerr.md")).toContain("The owner's own line.");
  });
});

describe("a new note", () => {
  it("is written with frontmatter naming its source, and refused when the note exists", () => {
    const { deps, root } = setup();
    const edit = createNote(deps, {
      path: "reference/hyperframes.md",
      title: "Hyperframes",
      body: "A template.",
      source: "inbox/a.md",
    });

    expect(edit.status).toBe("applied");
    expect(readNote(root.path, "reference/hyperframes.md")).toBe(
      "---\ntitle: Hyperframes\ntags: []\ncreated: 2026-09-06\nsource: noctis-promoter\n---\n\n# Hyperframes\n\nA template.\n\nFrom [[a]].\n",
    );
    expect(
      createNote(deps, {
        path: "people/alex-kerr.md",
        title: "Alex",
        body: "x",
        source: "inbox/a.md",
      }).reason,
    ).toBe("note_exists");
  });
});

describe("a revision", () => {
  it("waits for the owner, then replaces the quoted text exactly once", () => {
    const { deps, root } = setup();
    const edit = proposeRevision(deps, {
      path: "people/alex-kerr.md",
      find: "Prefers async updates.",
      replace: "Prefers calls.",
      reason: "inbox says so",
      source: "inbox/a.md",
    });

    expect(edit.status).toBe("pending");
    expect(readNote(root.path, "people/alex-kerr.md")).toContain("Prefers async updates.");

    expect(applyRevision(deps, edit.id).status).toBe("applied");
    expect(readNote(root.path, "people/alex-kerr.md")).toContain("Prefers calls.");
  });

  it("is refused when the quoted text is no longer there, and can be declined", () => {
    const { deps } = setup();
    const missing = proposeRevision(deps, {
      path: "people/alex-kerr.md",
      find: "Not in the note.",
      replace: "x",
      reason: "r r r",
      source: "inbox/a.md",
    });
    expect(missing).toMatchObject({ status: "refused", reason: "find_not_found" });

    const edit = proposeRevision(deps, {
      path: "people/alex-kerr.md",
      find: "Prefers async updates.",
      replace: "x",
      reason: "r r r",
      source: "inbox/a.md",
    });
    expect(declineRevision(deps, edit.id).status).toBe("declined");
  });
});
```

`setup()` returns `{ deps: { kernel, root, env }, root }` after `indexVault`. `readNote(rootPath, path)` is `readFileSync(join(rootPath, path), "utf8")`. The kernel clock starts at `2026-09-06T12:00:00Z`, which is why `created: 2026-09-06`.

- [ ] **Step 3: Run them to see them fail** — `npx vitest run apps/core/src/vault/promote.test.ts` → FAIL, module not found.

- [ ] **Step 4: Implement `promote.ts`**

```ts
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { basename } from "node:path";

import { isSensitiveNote, parseNote } from "@noctis/domain";

import type { NoctisDatabase } from "../db/connection.js";
import type { Kernel } from "../kernel.js";
import type { VaultRoot } from "./root.js";
import {
  VaultConflict,
  VaultWriteRefused,
  hashOf,
  resolveWritePath,
  writeNoteAtomically,
  writesEnabled,
} from "./writes.js";

export const FACTS_OPEN = "<!-- noctis:facts -->";
export const FACTS_CLOSE = "<!-- /noctis:facts -->";
const ALLOWED = /^(people|reference|projects)\/[^\\:]+\.md$/;

export type VaultEditStatus = "applied" | "undone" | "pending" | "declined" | "refused";
export interface VaultEdit {
  id: string;
  kind: "fact" | "note" | "revision";
  path: string;
  source: string;
  text: string;
  status: VaultEditStatus;
  reason?: string;
  turnId?: string;
  createdAt: string;
  decidedAt?: string;
}
export interface PromoteDeps {
  kernel: Kernel;
  root: VaultRoot | undefined;
  env: Readonly<Record<string, string | undefined>>;
  /** Tests only: runs between the read and the write, to stage a conflict. */
  beforeWrite?: () => void;
}

interface Row {
  id: string;
  kind: VaultEdit["kind"];
  path: string;
  source: string;
  text: string;
  replace_text: string | null;
  status: VaultEditStatus;
  reason: string | null;
  before_contents: string | null;
  after_hash: string | null;
  turn_id: string | null;
  created_at: string;
  decided_at: string | null;
}

const toEdit = (row: Row): VaultEdit => ({
  id: row.id,
  kind: row.kind,
  path: row.path,
  source: row.source,
  text: row.text,
  status: row.status,
  ...(row.reason === null ? {} : { reason: row.reason }),
  ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
  createdAt: row.created_at,
  ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
});

function now(deps: PromoteDeps): string {
  return new Date(deps.kernel.clock.now()).toISOString();
}

function record(deps: PromoteDeps, edit: Omit<Row, "id" | "created_at" | "decided_at">): VaultEdit {
  const id = deps.kernel.ids.nextId();
  const at = now(deps);
  deps.kernel.db
    .prepare(
      `INSERT INTO vault_edits (id, kind, path, source, text, replace_text, status, reason, before_contents, after_hash, turn_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      edit.kind,
      edit.path,
      edit.source,
      edit.text,
      edit.replace_text,
      edit.status,
      edit.reason,
      edit.before_contents,
      edit.after_hash,
      edit.turn_id,
      at,
    );
  return getEdit(deps.kernel.db, id) as VaultEdit;
}

function getRow(db: NoctisDatabase, id: string): Row | undefined {
  return db.prepare(`SELECT * FROM vault_edits WHERE id = ?`).get(id) as Row | undefined;
}

export function getEdit(db: NoctisDatabase, id: string): VaultEdit | undefined {
  const row = getRow(db, id);
  return row === undefined ? undefined : toEdit(row);
}

export function listEdits(db: NoctisDatabase, limit: number): VaultEdit[] {
  return (
    db
      .prepare(`SELECT * FROM vault_edits ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as unknown as Row[]
  ).map(toEdit);
}

/** Why a write may not happen, before any bytes are read. */
function refusalFor(deps: PromoteDeps, path: string): string | undefined {
  if (deps.root === undefined) return "no_vault";
  if (!writesEnabled(deps.env)) return "writes_disabled";
  if (!ALLOWED.test(path) || path.split("/").includes("..")) return "path_not_allowed";
  return undefined;
}

/** Writes, mapping the write service's refusals to reasons. */
function write(
  deps: PromoteDeps,
  path: string,
  contents: string,
  expectedHash: string | undefined,
): string | undefined {
  try {
    deps.beforeWrite?.();
    writeNoteAtomically(
      { root: deps.root as VaultRoot, env: deps.env },
      { path, contents, ...(expectedHash === undefined ? {} : { expectedHash }) },
    );
    return undefined;
  } catch (error) {
    if (error instanceof VaultConflict) return "conflict";
    if (error instanceof VaultWriteRefused) return "path_not_allowed";
    throw error;
  }
}

const sourceLink = (source: string): string => `[[${basename(source, ".md")}]]`;

export function addFact(
  deps: PromoteDeps,
  input: { path: string; fact: string; source: string; turnId?: string },
): VaultEdit {
  const base = {
    kind: "fact" as const,
    path: input.path,
    source: input.source,
    text: input.fact,
    replace_text: null,
    turn_id: input.turnId ?? null,
  };
  const refused = (reason: string): VaultEdit =>
    record(deps, { ...base, status: "refused", reason, before_contents: null, after_hash: null });
  const early = refusalFor(deps, input.path);
  if (early !== undefined) return refused(early);

  const file = resolveWritePath(deps.root as VaultRoot, input.path);
  if (!existsSync(file)) return refused("note_missing");

  const raw = readFileSync(file, "utf8");
  if (isSensitiveNote(parseNote(raw))) return refused("sensitive");

  const line = `- ${input.fact.trim()} (from ${sourceLink(input.source)})`;
  const open = raw.indexOf(FACTS_OPEN);
  const close = raw.indexOf(FACTS_CLOSE);
  let next: string;

  if (open !== -1 && close > open) {
    const block = raw.slice(open, close).toLowerCase();
    if (block.includes(`- ${input.fact.trim().toLowerCase()}`)) return refused("already_known");
    next = `${raw.slice(0, close)}${line}\n${raw.slice(close)}`;
  } else {
    next = `${raw.trimEnd()}\n\n${FACTS_OPEN}\n${line}\n${FACTS_CLOSE}\n`;
  }

  const failed = write(deps, input.path, next, hashOf(raw));
  if (failed !== undefined) return refused(failed);

  return record(deps, {
    ...base,
    status: "applied",
    reason: null,
    before_contents: raw,
    after_hash: hashOf(next),
  });
}

export function createNote(
  deps: PromoteDeps,
  input: { path: string; title: string; body: string; source: string; turnId?: string },
): VaultEdit {
  const base = {
    kind: "note" as const,
    path: input.path,
    source: input.source,
    text: input.body,
    replace_text: null,
    turn_id: input.turnId ?? null,
  };
  const refused = (reason: string): VaultEdit =>
    record(deps, { ...base, status: "refused", reason, before_contents: null, after_hash: null });
  const early = refusalFor(deps, input.path);
  if (early !== undefined) return refused(early);
  if (existsSync(resolveWritePath(deps.root as VaultRoot, input.path)))
    return refused("note_exists");

  const created = now(deps).slice(0, 10);
  const contents = `---\ntitle: ${input.title}\ntags: []\ncreated: ${created}\nsource: noctis-promoter\n---\n\n# ${input.title}\n\n${input.body.trim()}\n\nFrom ${sourceLink(input.source)}.\n`;
  const failed = write(deps, input.path, contents, undefined);
  if (failed !== undefined) return refused(failed === "conflict" ? "note_exists" : failed);

  return record(deps, {
    ...base,
    status: "applied",
    reason: null,
    before_contents: null,
    after_hash: hashOf(contents),
  });
}

export function proposeRevision(
  deps: PromoteDeps,
  input: {
    path: string;
    find: string;
    replace: string;
    reason: string;
    source: string;
    turnId?: string;
  },
): VaultEdit {
  const base = {
    kind: "revision" as const,
    path: input.path,
    source: input.source,
    text: input.find,
    replace_text: input.replace,
    turn_id: input.turnId ?? null,
  };
  const early = refusalFor(deps, input.path);
  const file =
    early === undefined ? resolveWritePath(deps.root as VaultRoot, input.path) : undefined;
  const raw = file !== undefined && existsSync(file) ? readFileSync(file, "utf8") : undefined;
  const reason =
    early ??
    (raw === undefined
      ? "note_missing"
      : isSensitiveNote(parseNote(raw))
        ? "sensitive"
        : raw.split(input.find).length !== 2
          ? "find_not_found"
          : undefined);

  return record(deps, {
    ...base,
    status: reason === undefined ? "pending" : "refused",
    reason: reason ?? input.reason,
    before_contents: null,
    after_hash: null,
  });
}

function decide(
  deps: PromoteDeps,
  id: string,
  status: VaultEditStatus,
  reason: string | null,
  fields: { before?: string; after?: string } = {},
): VaultEdit {
  deps.kernel.db
    .prepare(
      `UPDATE vault_edits SET status = ?, reason = COALESCE(?, reason), decided_at = ?, before_contents = COALESCE(?, before_contents), after_hash = COALESCE(?, after_hash) WHERE id = ?`,
    )
    .run(status, reason, now(deps), fields.before ?? null, fields.after ?? null, id);
  return getEdit(deps.kernel.db, id) as VaultEdit;
}

export function applyRevision(deps: PromoteDeps, id: string): VaultEdit {
  const row = getRow(deps.kernel.db, id);
  if (row === undefined || row.status !== "pending" || row.replace_text === null) {
    throw new VaultWriteRefused("Only a pending revision can be applied.");
  }
  const early = refusalFor(deps, row.path);
  if (early !== undefined) return decide(deps, id, "pending", early);

  const raw = readFileSync(resolveWritePath(deps.root as VaultRoot, row.path), "utf8");
  if (raw.split(row.text).length !== 2) return decide(deps, id, "refused", "find_not_found");

  const next = raw.replace(row.text, row.replace_text);
  const failed = write(deps, row.path, next, hashOf(raw));
  return failed === undefined
    ? decide(deps, id, "applied", null, { before: raw, after: hashOf(next) })
    : decide(deps, id, "pending", failed);
}

export function declineRevision(deps: PromoteDeps, id: string): VaultEdit {
  const row = getRow(deps.kernel.db, id);
  if (row === undefined || row.status !== "pending") {
    throw new VaultWriteRefused("Only a pending revision can be declined.");
  }
  return decide(deps, id, "declined", null);
}

export function undoEdit(deps: PromoteDeps, id: string): VaultEdit {
  const row = getRow(deps.kernel.db, id);
  if (row === undefined || row.status !== "applied" || row.after_hash === null) {
    throw new VaultWriteRefused("Only an applied edit can be undone.");
  }
  const early = refusalFor(deps, row.path);
  if (early !== undefined) return decide(deps, id, "applied", early);

  const file = resolveWritePath(deps.root as VaultRoot, row.path);
  const onDisk = existsSync(file) ? hashOf(readFileSync(file)) : undefined;
  if (onDisk !== row.after_hash) return decide(deps, id, "applied", "changed_since");

  if (row.before_contents === null) {
    unlinkSync(file);
    return decide(deps, id, "undone", null);
  }

  const failed = write(deps, row.path, row.before_contents, row.after_hash);
  return failed === undefined
    ? decide(deps, id, "undone", null)
    : decide(deps, id, "applied", failed);
}
```

- [ ] **Step 5: Say so in `writes.ts`.** Its header comment and its refusal message name the inbox grant and the Agent Brain as the only writers. Add the promoter: "…the inbox grant a runtime writes through, the Agent Brain append in vault/brain.ts, and the promoter's add-only edits in vault/promote.ts." Update any test that matches the old message text (`grep -rn "opens exactly two things" apps`).

- [ ] **Step 6: Run the tests to see them pass**; bump `migrate.test.ts` to `toBe(19)` and assert `vault_edits` exists; bump `headless.integration.test.ts:333` to `18`. Run `npx vitest run apps/core/src/vault apps/core/src/db apps/core/src/api`.

- [ ] **Step 7: Commit** — `feat(vault): apply, undo and approve promoted edits`

---

### Task 3: Proposals reach `promote.ts`

**Files:**

- Modify: `apps/core/src/conversation/proposals.ts:27-62`
- Test: `apps/core/src/conversation/proposals.test.ts` (create if absent, using the kernel helper pattern from `vault.integration.test.ts`)

**Interfaces:**

- Consumes: `addFact`, `createNote`, `proposeRevision` (Task 2); `ProposalDeps` already carries `vaultRoot` and `vaultEnv`.

- [ ] **Step 1: Failing test**

```ts
it("applies a fact a turn proposed, and records the turn", () => {
  const { kernel, root } = indexedWithWrites();
  applyProposal(
    kernel,
    context,
    turnFor(kernel),
    {
      kind: "vault_fact",
      path: "people/alex-kerr.md",
      fact: "Likes tea.",
      source: "inbox/loose-thought.md",
    },
    "k-1",
    { vaultRoot: root, vaultEnv: { NOCTIS_VAULT_ALLOW_WRITES: "true" } },
  );

  const [edit] = listEdits(kernel.db, 5);
  expect(edit).toMatchObject({ kind: "fact", status: "applied", turnId: turnFor(kernel).id });
});
```

`turnFor(kernel)` builds a `Turn` literal with `id: "0199a000-0000-7000-8000-0000000000a1"`, `identityId: "vesper"`, and the other required `Turn` fields set to fixed test values (read the `Turn` interface at `service.ts:57`).

- [ ] **Step 2: Run, see it fail** (no edit listed).

- [ ] **Step 3: Implement** — at the top of `applyProposal`, after `skip`:

```ts
if (
  proposal.kind === "vault_fact" ||
  proposal.kind === "vault_note" ||
  proposal.kind === "vault_revision"
) {
  const promote = { kernel, root: deps.vaultRoot, env: deps.vaultEnv ?? {} };
  const edit =
    proposal.kind === "vault_fact"
      ? addFact(promote, {
          path: proposal.path,
          fact: proposal.fact,
          source: proposal.source,
          turnId: turn.id,
        })
      : proposal.kind === "vault_note"
        ? createNote(promote, {
            path: proposal.path,
            title: proposal.title,
            body: proposal.body,
            source: proposal.source,
            turnId: turn.id,
          })
        : proposeRevision(promote, {
            path: proposal.path,
            find: proposal.find,
            replace: proposal.replace,
            reason: proposal.reason,
            source: proposal.source,
            turnId: turn.id,
          });

  kernel.logger.log(edit.status === "refused" ? "warn" : "info", "vault edit", {
    turnId: turn.id,
    kind: edit.kind,
    status: edit.status,
    reason: edit.reason,
  });
  return;
}
```

- [ ] **Step 4: Pass.** **Step 5: Commit** — `feat(core): route Vault edit proposals to the promoter's writer`

---

### Task 4: The promoter run

**Files:**

- Create: `apps/core/src/vault/promoter.ts`
- Test: `apps/core/src/vault/promoter.test.ts`
- Modify: `packages/contracts/src/command.ts` (add `PromoteVaultCommandSchema = z.object({ ...CommandBase }).strict()`, its type, and `"vault.promote_now"` in the command list beside `"vault.recall"`)
- Modify: `apps/core/src/api/http.ts` (register `vault.promote_now`)
- Modify: `apps/core/src/server.ts:225-250` (nightly timer)

**Interfaces:**

- Consumes: `ConversationService.createThread`, `ConversationService.sendMessage`; `listVaultItems` (`indexer.ts`); `hashOf`.
- Produces:

```ts
export const BATCH = 8;
export interface InboxNote {
  path: string;
  hash: string;
  text: string;
}
export function nextInboxBatch(db: NoctisDatabase, root: VaultRoot, max?: number): InboxNote[];
export function promoterPrompt(batch: readonly InboxNote[]): string;
export function promoteNow(
  deps: { kernel: Kernel; conversations: ConversationService; root: VaultRoot | undefined },
  context: CommandContext,
  idempotencyKey: string,
): Result<{ turnId: string; notes: number } | { notes: 0 }>;
```

- [ ] **Step 1: Failing tests**

```ts
it("offers a note once, again after a failed run or an edit", () => {
  const { db, root } = indexed();
  const first = nextInboxBatch(db, root);
  expect(first.map((note) => note.path)).toEqual(["inbox/loose-thought.md"]);

  offer(db, first, "turn-1"); // inserts vault_promotions rows
  setTurnStatus(db, "turn-1", "completed");
  expect(nextInboxBatch(db, root)).toEqual([]);

  setTurnStatus(db, "turn-1", "failed");
  expect(nextInboxBatch(db, root).map((note) => note.path)).toEqual(["inbox/loose-thought.md"]);

  setTurnStatus(db, "turn-1", "completed");
  appendFileSync(join(root.path, "inbox/loose-thought.md"), "\nMore.\n");
  expect(nextInboxBatch(db, root).map((note) => note.path)).toEqual(["inbox/loose-thought.md"]);
});

it("asks for facts with links and quotes each note with its path", () => {
  const prompt = promoterPrompt([
    { path: "inbox/a.md", hash: "h", text: "Tolga moved to Istanbul." },
  ]);

  expect(prompt).toContain("noctis_vault_fact");
  expect(prompt).toContain("noctis_vault_revision");
  expect(prompt).toContain("--- inbox/a.md ---\nTolga moved to Istanbul.");
});
```

`offer` and `setTurnStatus` are test helpers: `offer` is exported from `promoter.ts` (it is what `promoteNow` calls), `setTurnStatus` updates `identity_turns.status` for a turn row the test inserts (copy the minimal insert from an existing conversation test).

- [ ] **Step 2: Run, see them fail.**

- [ ] **Step 3: Implement `promoter.ts`**

```ts
export const BATCH = 8;

/** Inbox notes not yet given to a run that succeeded or is still going, oldest first. */
export function nextInboxBatch(db: NoctisDatabase, root: VaultRoot, max = BATCH): InboxNote[] {
  const notes: InboxNote[] = [];
  const settled = db.prepare(
    `SELECT 1 FROM vault_promotions p LEFT JOIN identity_turns t ON t.id = p.turn_id
      WHERE p.path = ? AND p.content_hash = ? AND COALESCE(t.status, 'running') <> 'failed' AND COALESCE(t.status, 'running') <> 'cancelled'
      LIMIT 1`,
  );

  for (const item of listVaultItems(db)
    .filter((i) => i.path.startsWith("inbox/"))
    .sort((a, b) => a.path.localeCompare(b.path))) {
    if (notes.length >= max) break;
    const raw = readFileSync(resolveWritePath(root, item.path));
    const hash = hashOf(raw);
    if (settled.get(item.path, hash) === undefined) {
      notes.push({ path: item.path, hash, text: raw.toString("utf8").slice(0, 6000) });
    }
  }
  return notes;
}

export function offer(
  db: NoctisDatabase,
  batch: readonly InboxNote[],
  turnId: string,
  at = new Date().toISOString(),
): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO vault_promotions (path, content_hash, turn_id, offered_at) VALUES (?, ?, ?, ?)`,
  );
  for (const note of batch) insert.run(note.path, note.hash, turnId, at);
}

export function promoterPrompt(batch: readonly InboxNote[]): string {
  return [
    "Vault upkeep. These inbox notes have not been filed into the owner's MindVault yet. For each durable fact about a person, project or topic:",
    "- if a note for it exists under people/, reference/ or projects/, call noctis_vault_fact with one line and [[wikilinks]] for every name;",
    "- if none exists and it deserves one, call noctis_vault_note;",
    "- if the inbox contradicts something the owner wrote, call noctis_vault_revision quoting their exact words; the owner decides.",
    "Search the MindVault first so you link to notes that exist and never add a fact a note already states. Name the inbox note as the source. Skip chatter, tasks and anything already filed. Reply with one line per inbox note saying what you did.",
    "",
    ...batch.map((note) => `--- ${note.path} ---\n${note.text}`),
  ].join("\n");
}
```

`promoteNow`: read the batch; if empty return `ok({ value: { notes: 0 }, events: [] })`-style result consistent with `Result` (read `packages/domain/src/result.ts` for the constructor); else get or create the thread (`SELECT thread_id FROM vault_promoter WHERE id = 1`, else `conversations.createThread(context, { idempotencyKey: \`${idempotencyKey}-thread\`, identityId: "vesper", title: "Vault upkeep" })`and insert the row), then`conversations.sendMessage(context, { idempotencyKey, identityId: "vesper", threadId, text: promoterPrompt(batch) })`, then `offer(db, batch, turn.id)`.

Register in `http.ts` beside `vault.recall`:

```ts
  "vault.promote_now": defineDepsCommand(
    PromoteVaultCommandSchema,
    (deps, context, command) =>
      promoteNow({ kernel: deps.kernel, conversations: deps.conversation, root: deps.vaultRoot }, context, command.idempotencyKey),
    () => undefined,
  ),
```

(`ApiDeps.conversation` is the `ConversationService`; copy `vault.reindex`'s replay argument).

In `server.ts`, a second `createDailyTimer` (from the settings plan, Task 2) with `at: () => readSetting(db, env, "promoterAt")`, restarted by `onSettingChange` for `promoterAt`, whose `run` calls `promoteNow` with `idempotencyKey: \`promoter-${new Date(clock.now()).toISOString().slice(0, 10)}\`` and a system context (`actorType: "system", actorId: "promoter"`), and logs the outcome. Stop it where the digest timer is stopped.

- [ ] **Step 4: Pass**, plus `npx vitest run apps/core packages/contracts`.

- [ ] **Step 5: Commit** — `feat(vault): a promoter run files inbox notes, nightly or on demand`

---

### Task 5: Seeing and undoing what was filed

**Files:**

- Modify: `apps/core/src/api/http.ts` (`GET /vault/edits`; commands `vault.undo_edit`, `vault.apply_revision`, `vault.decline_revision` with `{ ...CommandBase, editId: UuidSchema }` schemas added to `command.ts`)
- Modify: `apps/core/src/notify/digest.ts` (`vault: { filed: number; waiting: number }`; `digestLine` adds "filed N facts from the inbox, M changes wait for you" when non-zero)
- Create: `apps/web/src/pages/VaultEdits.tsx`; Modify: `apps/web/src/pages/Vault.tsx` (render it under the note panel), `apps/web/src/pages/waiting.ts` (count pending revisions)
- Test: `apps/core/src/api/headless.integration.test.ts`, `apps/core/src/notify/digest.test.ts`, `apps/web/src/pages/VaultEdits.test.ts`

**Interfaces:**

- Consumes: `listEdits`, `undoEdit`, `applyRevision`, `declineRevision` (Task 2).
- Produces: `GET /vault/edits` → `{ edits: VaultEdit[] }`; `VaultEdits({ edits, onUndo, onApply, onDecline })` presentational component.

- [ ] **Step 1: Failing tests**

```ts
// headless.integration.test.ts, in the graph describe, with a core started with NOCTIS_VAULT_ALLOW_WRITES=true
it("lists a filed fact and undoes it", async () => {
  const env = { NOCTIS_VAULT_ALLOW_WRITES: "true" };
  const { core, vault } = await indexedCoreWithPath(env); // indexedCore, also returning the Vault directory
  const root = resolveVaultRoot({ NOCTIS_VAULT_ROOT: vault });
  addFact(
    { kernel: core.core.kernel, root, env },
    { path: "people/alex-kerr.md", fact: "Likes tea.", source: "inbox/loose-thought.md" },
  );
  const listed = await read(core, "/vault/edits");
  const [edit] = listed.body.edits as Array<{ id: string; status: string }>;
  expect(edit?.status).toBe("applied");

  const undone = await command(core, "vault.undo_edit", {
    idempotencyKey: "u-1",
    editId: edit?.id,
  });
  expect(undone.status).toBe(200);
  expect(
    ((await read(core, "/vault/edits")).body.edits as Array<{ status: string }>)[0]?.status,
  ).toBe("undone");
});
```

```ts
// digest.test.ts
it("says how much was filed from the inbox and how much waits", () => {
  expect(digestLine({ ...emptyDigest, vault: { filed: 3, waiting: 1 } })).toContain(
    "filed 3 facts from the inbox, 1 change waits for you",
  );
});
```

```ts
// VaultEdits.test.ts
it("offers Undo on a filed fact and Apply or Decline on a waiting change", () => {
  const markup = renderToStaticMarkup(
    createElement(VaultEdits, {
      edits: [
        {
          id: "a",
          kind: "fact",
          path: "people/tolga.md",
          source: "inbox/t.md",
          text: "Moved.",
          status: "applied",
          createdAt: "2026-10-13T03:00:00Z",
        },
        {
          id: "b",
          kind: "revision",
          path: "people/tolga.md",
          source: "inbox/t.md",
          text: "London",
          status: "pending",
          reason: "moved",
          createdAt: "2026-10-13T03:00:00Z",
        },
      ],
      onUndo: () => undefined,
      onApply: () => undefined,
      onDecline: () => undefined,
    }),
  );
  expect(markup).toContain(">Undo<");
  expect(markup).toContain(">Apply<");
  expect(markup).toContain(">Decline<");
  expect(markup).toContain("people/tolga.md");
});
```

(`indexedCoreWithPath(env)` is `indexedCore` with the env passed to `startTestCore` and `{ core, vault }` returned; `emptyDigest` is the zero digest the existing digest tests build.)

- [ ] **Step 2: Run, see them fail.**

- [ ] **Step 3: Implement.** Commands map `VaultWriteRefused` to 409 the way other conflicts do. `readDigest` adds:

```ts
const vault = db
  .prepare(`SELECT SUM(status = 'applied' AND kind IN ('fact', 'note')) AS filed, SUM(status = 'pending') AS waiting
              FROM vault_edits WHERE created_at >= ? AND created_at < ?`)
  .get(from, to) as { filed: number | null; waiting: number | null };
// ...
vault: { filed: vault.filed ?? 0, waiting: vault.waiting ?? 0 },
```

`VaultEdits` lists the newest 50: path, the text (via `<Markdown>`), source, and a button per status (`applied` → Undo, `pending` → Apply and Decline, otherwise the reason in muted text). `Vault.tsx` fetches `GET /vault/edits` with the graph and re-fetches after each action.

- [ ] **Step 4: Pass**; `npx vitest run apps/core apps/web/src`.

- [ ] **Step 5: Commit** — `feat(vault): list, undo and approve what the promoter filed`

---

### Task 6: Agents capture to the inbox

**Files:**

- Modify: `apps/node-agent/src/runtimes/identity.ts` (`mindVaultNote`)
- Test: `apps/node-agent/src/runtimes/identity.test.ts`

**Interfaces:**

- `mindVaultNote(readable?: readonly string[], writable?: readonly string[])`; `identityCard` gains `writable?: readonly string[]`, passed by `claude.ts`, `codex.ts`, `hermes.ts` (`roots.writable`) and to `jesterSoul`.

- [ ] **Step 1: Failing test**

```ts
it("tells the agent to capture to the inbox when it may write there", () => {
  const vault = sharedVault();
  mkdirSync(join(vault, "inbox"));
  const card = identityCard({
    identityId: "vesper",
    runtime: "claude",
    model: "sonnet",
    env: {},
    readable: [vault],
    writable: [join(vault, "inbox")],
  });

  expect(card).toContain(`write new notes to ${join(vault, "inbox")}`);
  expect(card).toContain("source:");
});
```

- [ ] **Step 2: Run, see it fail.**

- [ ] **Step 3: Implement** — when a writable root is `join(vault, "inbox")` (compare with `path.relative`), append:

```ts
`When you learn something durable about the owner's world, write new notes to ${inbox}: one Markdown file per fact,
named YYYY-MM-DD-short-title.md, with frontmatter title, tags: [], created: <ISO date> and source: noctis-<your runtime>,
literal dates, and [[wikilinks]] for every person, project and topic. Never edit notes outside the inbox; Noctis files
them into the Vault.`;
```

- [ ] **Step 4: Pass.** **Step 5: Commit** — `feat(node): agents capture what they learn to the inbox`

---

### Task 7: Record, deploy notes

- [ ] Append a `2026-10-1x Vault promoter` entry to `docs/acceptance/IMPLEMENTATION-STATUS.md` with the clause table and commands, in the format of the entries above it.
- [ ] Owner steps in the entry: deploy the work-PC core (migration 0019); on the Settings page turn on **Let Noctis write to the Vault** and set **File the inbox nightly** to a time; share `MindVault\inbox` with **write** for every agent on each PC; press **Promote now** on the Vault page once and read what it filed.
- [ ] Commit and push — `docs: record the Vault promoter`.

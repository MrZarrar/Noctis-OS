import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createIdFactory } from "@noctis/domain";
import { createTestVault } from "@noctis/test-kit";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../db/connection.js";
import type { NoctisDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { createEventBroker } from "../events/broker.js";
import type { Kernel } from "../kernel.js";
import { createLogger } from "../logging.js";
import {
  FACTS_CLOSE,
  FACTS_OPEN,
  addFact,
  applyRevision,
  createNote,
  declineRevision,
  proposeRevision,
  undoEdit,
} from "./promote.js";
import type { PromoteDeps } from "./promote.js";
import { nextInboxBatch, offer, promoterPrompt } from "./promoter.js";
import type { VaultRoot } from "./root.js";
import { resolveVaultRoot } from "./root.js";

let directories: string[] = [];
let databases: NoctisDatabase[] = [];

function scratch(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const db of databases) db.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  databases = [];
  directories = [];
});

function promoteSetup(): { deps: PromoteDeps; root: VaultRoot } {
  const db = openDatabase(join(scratch("noctis-promote-db-"), "core.db"));
  databases.push(db);
  let now = Date.parse("2026-09-06T12:00:00.000Z");
  const clock = { now: () => (now += 1) };
  migrate(db, { directory: join(process.cwd(), "apps/core/migrations"), clock });
  const kernel: Kernel = {
    db,
    clock,
    ids: createIdFactory(clock),
    broker: createEventBroker(),
    logger: createLogger({ sink: () => undefined, level: "error" }),
  };
  const path = scratch("noctis-promote-vault-");
  createTestVault(path);
  const root = resolveVaultRoot({ NOCTIS_VAULT_ROOT: path }) as VaultRoot;
  return { deps: { kernel, root, env: { NOCTIS_VAULT_ALLOW_WRITES: "true" } }, root };
}

const setup = promoteSetup;
const readNote = (root: VaultRoot, path: string): string =>
  readFileSync(join(root.path, path), "utf8");

describe("a promoted fact", () => {
  it("is added inside the note's Noctis block and leaves the owner's text byte-identical", () => {
    const { deps, root } = setup();
    const before = readNote(root, "people/alex-kerr.md");

    const edit = addFact(deps, {
      path: "people/alex-kerr.md",
      fact: "Moved to [[Acme Travel]] in October.",
      source: "inbox/loose-thought.md",
    });
    const after = readNote(root, "people/alex-kerr.md");

    expect(edit.status).toBe("applied");
    expect(after.startsWith(before.trimEnd())).toBe(true);
    expect(after).toContain(
      `${FACTS_OPEN}\n- Moved to [[Acme Travel]] in October. (from [[loose-thought]])\n${FACTS_CLOSE}`,
    );
  });

  it("adds a second fact to the same block, and skips one the block already holds", () => {
    const { deps, root } = setup();
    const fact = { path: "people/alex-kerr.md", source: "inbox/loose-thought.md" };
    addFact(deps, { ...fact, fact: "First." });
    addFact(deps, { ...fact, fact: "Second." });

    expect(readNote(root, "people/alex-kerr.md").split(FACTS_OPEN)).toHaveLength(2);
    expect(addFact(deps, { ...fact, fact: "first." })).toMatchObject({
      status: "refused",
      reason: "already_known",
    });
  });

  it("refuses paths outside people, reference and projects, and sensitive notes", () => {
    const { deps, root } = setup();
    writeFileSync(join(root.path, "people/secret.md"), "---\nsensitive: true\n---\n# Secret\n");
    const reason = (path: string) =>
      addFact(deps, { path, fact: "x y z", source: "inbox/a.md" }).reason;

    expect(reason("agent/brain.md")).toBe("path_not_allowed");
    expect(reason("people/../agent/brain.md")).toBe("path_not_allowed");
    expect(reason("people/secret.md")).toBe("sensitive");
    expect(reason("people/nobody.md")).toBe("note_missing");
  });

  it("refuses a fact when the note changed under it", () => {
    const { deps, root } = setup();
    const file = join(root.path, "people/alex-kerr.md");
    const edit = addFact(
      { ...deps, beforeWrite: () => appendFileSync(file, "\nEdited.\n") },
      { path: "people/alex-kerr.md", fact: "A fact.", source: "inbox/a.md" },
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
  it("puts the note back exactly as it was, and removes a note the promoter created", () => {
    const { deps, root } = setup();
    const before = readNote(root, "people/alex-kerr.md");
    const fact = addFact(deps, {
      path: "people/alex-kerr.md",
      fact: "A fact.",
      source: "inbox/a.md",
    });
    const note = createNote(deps, {
      path: "reference/hyperframes.md",
      title: "Hyperframes",
      body: "A template.",
      source: "inbox/a.md",
    });

    expect(undoEdit(deps, fact.id).status).toBe("undone");
    expect(readNote(root, "people/alex-kerr.md")).toBe(before);
    undoEdit(deps, note.id);
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
    expect(readNote(root, "people/alex-kerr.md")).toContain("The owner's own line.");
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
    expect(readNote(root, "reference/hyperframes.md")).toBe(
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
    expect(readNote(root, "people/alex-kerr.md")).toContain("Prefers async updates.");
    expect(applyRevision(deps, edit.id).status).toBe("applied");
    expect(readNote(root, "people/alex-kerr.md")).toContain("Prefers calls.");
  });

  it("is refused when the quoted text is not there, and can be declined", () => {
    const { deps } = setup();
    const revision = {
      path: "people/alex-kerr.md",
      replace: "x",
      reason: "r r r",
      source: "inbox/a.md",
    };

    expect(proposeRevision(deps, { ...revision, find: "Not in the note." })).toMatchObject({
      status: "refused",
      reason: "find_not_found",
    });
    const edit = proposeRevision(deps, { ...revision, find: "Prefers async updates." });
    expect(declineRevision(deps, edit.id).status).toBe("declined");
  });
});

describe("the promoter's batch", () => {
  it("offers a note once, again after a failed run or an edit", () => {
    const { deps, root } = setup();
    const db = deps.kernel.db;
    const paths = () => nextInboxBatch(db, root).map((note) => note.path);
    expect(paths()).toEqual(["inbox/loose-thought.md"]);

    offer(db, nextInboxBatch(db, root), "turn-1", "2026-09-06T12:00:00Z");
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(
      `INSERT INTO identity_turns (id, thread_id, user_message_id, provider_id, model_json, status, started_at)
       VALUES ('turn-1', 't', 'm', 'claude', '{}', 'completed', '2026-09-06T12:00:00Z')`,
    ).run();
    expect(paths()).toEqual([]);

    db.prepare(`UPDATE identity_turns SET status = 'failed' WHERE id = 'turn-1'`).run();
    expect(paths()).toEqual(["inbox/loose-thought.md"]);

    db.prepare(`UPDATE identity_turns SET status = 'completed' WHERE id = 'turn-1'`).run();
    appendFileSync(join(root.path, "inbox/loose-thought.md"), "\nMore.\n");
    expect(paths()).toEqual(["inbox/loose-thought.md"]);
  });

  it("asks for facts with links and quotes each note with its path", () => {
    const prompt = promoterPrompt([
      { path: "inbox/a.md", hash: "h", text: "Tolga moved to Istanbul." },
    ]);

    expect(prompt).toContain("noctis_propose_vault_fact");
    expect(prompt).toContain("noctis_propose_vault_revision");
    expect(prompt).toContain("--- inbox/a.md ---\nTolga moved to Istanbul.");
  });
});

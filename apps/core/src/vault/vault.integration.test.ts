import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TEST_VAULT_FILES, createTestVault } from "@noctis/test-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../db/migrate.js";
import { openDatabase } from "../db/connection.js";
import type { NoctisDatabase } from "../db/connection.js";
import { createEventBroker } from "../events/broker.js";
import { createLogger } from "../logging.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { indexVault } from "./indexer.js";
import { recallFor, recordRecall } from "./recall.js";
import type { VaultRoot } from "./root.js";
import { resolveVaultRoot } from "./root.js";
import { VaultConflict, VaultWriteRefused, writeNoteAtomically } from "./writes.js";

import { createIdFactory } from "@noctis/domain";

const START = Date.parse("2026-09-06T12:00:00.000Z");

let directories: string[] = [];
let databases: NoctisDatabase[] = [];
let keys = 0;

const context: CommandContext = {
  correlationId: "01941f29-7c00-7000-8000-0000000000ff",
  actorType: "user",
  actorId: "local",
};

function key(): string {
  keys += 1;
  return `vault-${String(keys)}`;
}

function scratch(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

function makeKernel(): Kernel {
  const directory = scratch("noctis-vault-db-");
  const db = openDatabase(join(directory, "core.db"));
  databases.push(db);

  let now = START;
  const clock = {
    now: () => {
      now += 1;
      return now;
    },
  };

  migrate(db, { directory: join(process.cwd(), "apps/core/migrations"), clock });

  return {
    db,
    clock,
    ids: createIdFactory(clock),
    broker: createEventBroker(),
    logger: createLogger({ sink: () => undefined, level: "error" }),
  };
}

function vaultRoot(): VaultRoot {
  const root = scratch("noctis-vault-");
  createTestVault(root);

  const resolved = resolveVaultRoot({ NOCTIS_VAULT_ROOT: root });

  if (resolved === undefined) {
    throw new Error("the fixture Vault did not resolve");
  }

  return resolved;
}

afterEach(() => {
  for (const db of databases) {
    db.close();
  }

  databases = [];

  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }

  directories = [];
});

beforeEach(() => {
  keys = 0;
});

interface VaultCounts {
  items: number;
  entities: number;
  edges: number;
  mentions: number;
  layout: number;
}

function counts(db: NoctisDatabase): VaultCounts {
  const one = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as unknown as { count: number })
      .count;

  return {
    items: one("vault_items"),
    entities: one("vault_entities"),
    edges: one("vault_edges"),
    mentions: one("vault_mentions"),
    layout: one("vault_layout"),
  };
}

describe("indexing a test Vault", () => {
  it("THE GATE: indexes every note and leaves the prose byte-identical", () => {
    const kernel = makeKernel();
    const root = vaultRoot();
    const before = TEST_VAULT_FILES.map((file) => readNote(root.path, file.path));

    const outcome = indexVault(kernel, context, root, key());

    expect(outcome.ok).toBe(true);

    if (!outcome.ok) {
      return;
    }

    expect(outcome.value.scanned).toBe(TEST_VAULT_FILES.length);
    expect(outcome.value.added).toBe(TEST_VAULT_FILES.length);
    expect(counts(kernel.db).items).toBe(TEST_VAULT_FILES.length);

    // Markdown is the memory authority: indexing reads it and never writes it.
    expect(TEST_VAULT_FILES.map((file) => readNote(root.path, file.path))).toEqual(before);
  });

  it("THE GATE: repeated indexing is stable", () => {
    const kernel = makeKernel();
    const root = vaultRoot();

    indexVault(kernel, context, root, key());

    const first = kernel.db
      .prepare(`SELECT id, path, content_hash FROM vault_items ORDER BY path`)
      .all();
    const firstLayout = kernel.db
      .prepare(`SELECT entity_id, x, y, z FROM vault_layout ORDER BY entity_id`)
      .all();
    const firstCounts = counts(kernel.db);

    const second = indexVault(kernel, context, root, key());

    expect(second.ok).toBe(true);

    if (second.ok) {
      expect(second.value.added).toBe(0);
      expect(second.value.updated).toBe(0);
      expect(second.value.unchanged).toBe(second.value.scanned);
    }

    expect(
      kernel.db.prepare(`SELECT id, path, content_hash FROM vault_items ORDER BY path`).all(),
    ).toEqual(first);
    expect(
      kernel.db.prepare(`SELECT entity_id, x, y, z FROM vault_layout ORDER BY entity_id`).all(),
    ).toEqual(firstLayout);
    expect(counts(kernel.db)).toEqual(firstCounts);
  });

  it("THE GATE: a changed note invalidates only its own derivations", () => {
    const kernel = makeKernel();
    const root = vaultRoot();

    indexVault(kernel, context, root, key());

    const untouched = kernel.db
      .prepare(
        `SELECT m.id FROM vault_mentions m JOIN vault_items i ON i.id = m.item_id
          WHERE i.path = 'people/alex-kerr.md' ORDER BY m.id`,
      )
      .all();

    appendFileSync(join(root.path, "daily/2026-09-01.md"), "\nAlso saw [[Sam Oyelaran]].\n");

    const second = indexVault(kernel, context, root, key());

    expect(second.ok).toBe(true);

    if (second.ok) {
      expect(second.value.updated).toBe(1);
      expect(second.value.unchanged).toBe(second.value.scanned - 1);
    }

    // The edited note gained an edge; the note nobody edited kept the exact
    // mention rows it already had, ids included.
    expect(
      kernel.db
        .prepare(
          `SELECT m.id FROM vault_mentions m JOIN vault_items i ON i.id = m.item_id
            WHERE i.path = 'people/alex-kerr.md' ORDER BY m.id`,
        )
        .all(),
    ).toEqual(untouched);

    const daily = kernel.db
      .prepare(
        `SELECT COUNT(*) AS count FROM vault_edges e JOIN vault_items i ON i.id = e.source_item_id
          WHERE i.path = 'daily/2026-09-01.md'`,
      )
      .get() as { count: number };

    expect(daily.count).toBe(3);
  });

  it("keeps a note's coordinate when other notes are added", () => {
    const kernel = makeKernel();
    const root = vaultRoot();

    indexVault(kernel, context, root, key());

    const before = kernel.db
      .prepare(
        `SELECT x, y, z FROM vault_layout WHERE entity_id =
           (SELECT id FROM vault_entities WHERE key = 'alex-kerr')`,
      )
      .get();

    writeFileSync(join(root.path, "inbox/another.md"), "# Another\n\nMentions [[Alex Kerr]].\n");
    indexVault(kernel, context, root, key());

    expect(
      kernel.db
        .prepare(
          `SELECT x, y, z FROM vault_layout WHERE entity_id =
             (SELECT id FROM vault_entities WHERE key = 'alex-kerr')`,
        )
        .get(),
    ).toEqual(before);
  });

  it("resolves a link written through an alias", () => {
    const kernel = makeKernel();
    const root = vaultRoot();

    indexVault(kernel, context, root, key());

    // sam-oyelaran.md links [[Alex]], which is an alias of the Alex Kerr note.
    const edge = kernel.db
      .prepare(
        `SELECT e.lifecycle, dst.key AS dst_key, dst.item_id AS dst_item
           FROM vault_edges e
           JOIN vault_items i ON i.id = e.source_item_id
           JOIN vault_entities dst ON dst.id = e.dst_entity_id
          WHERE i.path = 'people/sam-oyelaran.md'`,
      )
      .get() as { lifecycle: string; dst_key: string; dst_item: string | null };

    expect(edge.lifecycle).toBe("resolved");
    expect(edge.dst_item).not.toBeNull();
  });

  it("keeps a link to an unwritten note as an unresolved edge", () => {
    const kernel = makeKernel();
    const root = vaultRoot();

    indexVault(kernel, context, root, key());

    const pending = kernel.db
      .prepare(
        `SELECT e.lifecycle FROM vault_edges e
           JOIN vault_entities dst ON dst.id = e.dst_entity_id
          WHERE dst.key = 'future-retrospective'`,
      )
      .get() as { lifecycle: string } | undefined;

    expect(pending?.lifecycle).toBe("unresolved");
  });

  it("resolves that edge once the note is written, without rewriting anything", () => {
    const kernel = makeKernel();
    const root = vaultRoot();

    indexVault(kernel, context, root, key());

    writeFileSync(
      join(root.path, "projects/future-retrospective.md"),
      "# Future Retrospective\n\nNow it exists.\n",
    );
    indexVault(kernel, context, root, key());

    const resolved = kernel.db
      .prepare(
        `SELECT e.lifecycle FROM vault_edges e
           JOIN vault_entities dst ON dst.id = e.dst_entity_id
          WHERE dst.key = 'future-retrospective'`,
      )
      .get() as { lifecycle: string };

    expect(resolved.lifecycle).toBe("resolved");
  });

  it("never indexes a link that only appears inside a code fence", () => {
    const kernel = makeKernel();
    const root = vaultRoot();

    indexVault(kernel, context, root, key());

    expect(
      kernel.db.prepare(`SELECT id FROM vault_entities WHERE key = 'not-a-real-link'`).get(),
    ).toBeUndefined();
  });

  it("removes a deleted note and its derivations", () => {
    const kernel = makeKernel();
    const root = vaultRoot();

    indexVault(kernel, context, root, key());
    unlinkSync(join(root.path, "daily/2026-09-01.md"));

    const outcome = indexVault(kernel, context, root, key());

    expect(outcome.ok && outcome.value.removed).toBe(1);
    expect(
      kernel.db.prepare(`SELECT id FROM vault_items WHERE path = 'daily/2026-09-01.md'`).get(),
    ).toBeUndefined();
  });
});

describe("focused recall", () => {
  it("returns provenance that points back at real prose", () => {
    const kernel = makeKernel();
    const root = vaultRoot();

    indexVault(kernel, context, root, key());

    const found = recallFor(kernel.db, "Alex Kerr", { root });

    expect(found.evidence.length).toBeGreaterThan(0);
    expect(found.freshness).toBe("current");

    for (const evidence of found.evidence) {
      const contents = readNote(root.path, evidence.path);

      expect(contents.slice(evidence.span.start, evidence.span.end)).toBe(evidence.quote);
    }
  });

  it("THE GATE: opens a subgraph, not the whole Vault", () => {
    const kernel = makeKernel();
    const root = vaultRoot();

    indexVault(kernel, context, root, key());

    const total = counts(kernel.db).entities;
    const found = recallFor(kernel.db, "Alex Kerr", { root });

    expect(found.entityIds.length).toBeGreaterThan(0);
    expect(found.entityIds.length).toBeLessThan(total);
  });

  it("THE GATE: calls evidence stale once the note behind it changes", () => {
    const kernel = makeKernel();
    const root = vaultRoot();

    indexVault(kernel, context, root, key());

    // Provenance is the note that *cites* the claim, not the note the claim is
    // about: evidence for "Alex Kerr" is sourced from jarvis-project.md, which
    // links him. Editing that note on disk without reindexing is what leaves a
    // mention holding a hash the file no longer has.
    appendFileSync(join(root.path, "projects/jarvis-project.md"), "\nEdited outside Noctis.\n");

    const found = recallFor(kernel.db, "Alex Kerr", { root });

    expect(found.evidence.some((item) => item.freshness === "stale")).toBe(true);
    expect(found.freshness).toBe("stale");
  });

  it("THE GATE: calls evidence unavailable when the note is gone", () => {
    const kernel = makeKernel();
    const root = vaultRoot();

    indexVault(kernel, context, root, key());
    // Deleted but not reindexed, which is exactly when a remembered claim has
    // to say its source is gone rather than quietly keeping it.
    unlinkSync(join(root.path, "projects/jarvis-project.md"));

    const found = recallFor(kernel.db, "Alex Kerr", { root });

    expect(found.evidence.some((item) => item.freshness === "unavailable")).toBe(true);
    expect(found.freshness).toBe("unavailable");
  });

  it("says unknown when nothing matched rather than claiming nothing exists", () => {
    const kernel = makeKernel();
    const root = vaultRoot();

    indexVault(kernel, context, root, key());

    const found = recallFor(kernel.db, "nobody has ever written this", { root });

    expect(found.evidence).toEqual([]);
    expect(found.freshness).toBe("unknown");
  });

  it("records the recall for audit, including an empty one", () => {
    const kernel = makeKernel();
    const root = vaultRoot();

    indexVault(kernel, context, root, key());

    const outcome = recordRecall(
      kernel,
      context,
      { idempotencyKey: key(), query: "nothing matches this" },
      root,
    );

    expect(outcome.ok).toBe(true);
    expect(
      (kernel.db.prepare(`SELECT COUNT(*) AS count FROM vault_recalls`).get() as { count: number })
        .count,
    ).toBe(1);
  });
});

describe("Vault writes", () => {
  it("THE GATE: are disabled by default", () => {
    const root = vaultRoot();

    expect(() =>
      writeNoteAtomically({ root, env: {} }, { path: "inbox/new.md", contents: "# New\n" }),
    ).toThrow(VaultWriteRefused);
  });

  it("refuses a path that escapes the root even when enabled", () => {
    const root = vaultRoot();
    const env = { NOCTIS_VAULT_ALLOW_WRITES: "true" };

    for (const path of ["../escape.md", "inbox/../../escape.md", "/etc/passwd", "C:\\escape.md"]) {
      expect(() => writeNoteAtomically({ root, env }, { path, contents: "x" }), path).toThrow();
    }
  });

  it("writes atomically when explicitly enabled", () => {
    const root = vaultRoot();
    const env = { NOCTIS_VAULT_ALLOW_WRITES: "true" };

    writeNoteAtomically({ root, env }, { path: "inbox/written.md", contents: "# Written\n" });

    expect(readNote(root.path, "inbox/written.md")).toBe("# Written\n");
  });

  it("refuses to overwrite a note that changed since it was read", () => {
    const root = vaultRoot();
    const env = { NOCTIS_VAULT_ALLOW_WRITES: "true" };

    expect(() =>
      writeNoteAtomically(
        { root, env },
        { path: "people/alex-kerr.md", contents: "# Replaced\n", expectedHash: "0".repeat(64) },
      ),
    ).toThrow(VaultConflict);
  });

  it("leaves no temporary file behind", () => {
    const root = vaultRoot();
    const env = { NOCTIS_VAULT_ALLOW_WRITES: "true" };

    writeNoteAtomically({ root, env }, { path: "inbox/clean.md", contents: "# Clean\n" });

    const strays = readdirSync(join(root.path, "inbox")).filter((name) => name.includes(".tmp"));

    expect(strays).toEqual([]);
  });
});

function readNote(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

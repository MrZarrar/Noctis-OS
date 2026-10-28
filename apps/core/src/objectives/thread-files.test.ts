import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdFactory, fixedClock } from "@noctis/domain";
import { VaultRecallPayloadSchema } from "@noctis/contracts";
import { createTestVault } from "@noctis/test-kit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { createEventBroker } from "../events/broker.js";
import { createLogger } from "../logging.js";
import type { Kernel } from "../kernel.js";
import { indexVault } from "../vault/indexer.js";
import { resolveVaultRoot } from "../vault/root.js";
import { proposeFor } from "./proposed-surfaces.js";
import { listSurfaceIntents } from "./surface-intents.js";

const roots = vi.hoisted(() => [
  { nodeId: "node-a", grantId: "same", path: "C:/shared" },
  { nodeId: "node-b", grantId: "same", path: "C:/shared" },
  { nodeId: "node-unc", grantId: "same", path: "\\\\server\\share" },
  { nodeId: "node-linux", grantId: "same", path: "/shared" },
]);
const turns = vi.hoisted(
  () => new Map<string, { id: string; threadId: string; nodeId: string; userMessageId: string }>(),
);
vi.mock("../nodes/registry.js", async (original) => ({
  ...(await original<object>()),
  listRuntimeRoots: () => roots,
}));
vi.mock("../conversation/service.js", async (original) => ({
  ...(await original<object>()),
  getTurn: (_db: unknown, id: string) => turns.get(id),
}));
const THREAD = "0199a000-0000-7000-8000-0000000000d1";
const OTHER = "0199a000-0000-7000-8000-0000000000d2";
let kernel: Kernel;
afterEach(() => {
  kernel?.db.close();
  turns.clear();
});
function fixture() {
  const clock = fixedClock(Date.parse("2026-09-01T12:00:00.000Z"));
  const db = openDatabase(":memory:");
  migrate(db, { directory: join(process.cwd(), "apps/core/migrations"), clock });
  kernel = {
    db,
    clock,
    ids: createIdFactory(clock),
    broker: createEventBroker(),
    logger: createLogger({ sink: () => undefined }),
  };
  for (const id of [THREAD, OTHER])
    db.prepare(
      "INSERT INTO identity_threads (id, identity_id, kind, created_at, updated_at) VALUES (?, 'vesper', 'named', ?, ?)",
    ).run(id, new Date(clock.now()).toISOString(), new Date(clock.now()).toISOString());
  return kernel;
}
function event(
  threadId = THREAD,
  nodeId = "node-a",
  paths = ["C:/shared/note.md"],
  status = "completed",
) {
  const turnId = kernel.ids.nextId();
  turns.set(turnId, { id: turnId, threadId, nodeId, userMessageId: turnId });
  return {
    id: kernel.ids.nextId(),
    sequence: 1,
    streamType: "identity" as const,
    streamId: threadId,
    type: "identity.turn_item.v1" as const,
    actorType: "identity" as const,
    actorId: "vesper",
    payloadVersion: 1,
    correlationId: kernel.ids.nextId(),
    occurredAt: new Date(kernel.clock.now()).toISOString(),
    payload: { turnId, item: { itemId: "f1", kind: "file_change", status, paths } },
  };
}
describe("files and recall proposed on threads", () => {
  it.each([
    ["node-a", "C:/shared/note.md", "c:/SHARED/NOTE.md"],
    ["node-unc", "\\\\server\\share\\note.md", "//SERVER/SHARE/NOTE.md"],
  ])(
    "keeps dismissed Windows file identity across case changes on %s",
    (nodeId, firstPath, nextPath) => {
      fixture();
      proposeFor({ kernel }, event(THREAD, nodeId, [firstPath]));
      const first = listSurfaceIntents(kernel.db, { threadId: THREAD })[0]!;
      kernel.db
        .prepare("UPDATE surface_intents SET lifecycle = 'dismissed' WHERE id = ?")
        .run(first.id);
      proposeFor({ kernel }, event(THREAD, nodeId, [nextPath]));
      expect(listSurfaceIntents(kernel.db, { threadId: THREAD })).toMatchObject([
        { id: first.id, lifecycle: "dismissed", payload: { content: { relativePath: "NOTE.md" } } },
      ]);
      expect(listSurfaceIntents(kernel.db, { threadId: THREAD })).toHaveLength(1);
    },
  );
  it("keeps differently cased Linux files distinct", () => {
    fixture();
    proposeFor({ kernel }, event(THREAD, "node-linux", ["/shared/note.md", "/shared/NOTE.md"]));
    const panels = listSurfaceIntents(kernel.db, { threadId: THREAD });
    expect(panels).toHaveLength(2);
    expect(new Set(panels.flatMap((panel) => panel.sourceIds)).size).toBe(2);
    expect(
      panels
        .map(
          (panel) => (panel.payload as { content: { relativePath: string } }).content.relativePath,
        )
        .sort(),
    ).toEqual(["NOTE.md", "note.md"]);
  });
  it("makes separate document/media panels for at most four files, including offline nodes", () => {
    fixture();
    proposeFor(
      { kernel },
      event(THREAD, "node-a", [
        "C:/shared/note.md",
        "C:/shared/summary.txt",
        "C:/shared/pic.png",
        "C:/shared/clip.mp4",
        "C:/shared/fifth.txt",
      ]),
    );
    const panels = listSurfaceIntents(kernel.db, { threadId: THREAD });
    expect(panels).toHaveLength(4);
    expect(
      panels.find((p) => (p.payload as { title: string }).title === "note.md")?.payload,
    ).toMatchObject({
      format: "markdown",
      content: { from: "file", nodeId: "node-a", grantId: "same", relativePath: "note.md" },
    });
    expect(
      panels.find((p) => (p.payload as { title: string }).title === "summary.txt")?.payload,
    ).toMatchObject({ format: "text" });
    expect(panels.filter((p) => p.kind === "media")).toHaveLength(2);
  });
  it.each([
    "app.ts",
    "view.TSX",
    "app.js",
    "build.mjs",
    "view.jsx",
    "style.css",
    "page.html",
    "page.htm",
    "icon.svg",
    "schema.xml",
    "tool.py",
    "run.sh",
    "run.ps1",
    "run.bat",
    "package.json",
    "events.jsonl",
    "config.yaml",
    "config.yml",
    "config.toml",
    "config.ini",
    "debug.log",
  ])("keeps source and working files off the canvas: %s", (name) => {
    fixture();
    proposeFor({ kernel }, event(THREAD, "node-a", [`C:/shared/${name}`]));
    expect(listSurfaceIntents(kernel.db, { threadId: THREAD })).toHaveLength(0);
  });
  it("shows documents, tables and media after skipped source files, up to four panels", () => {
    fixture();
    proposeFor(
      { kernel },
      event(THREAD, "node-a", [
        "C:/shared/app.ts",
        "C:/shared/style.css",
        "C:/shared/package.json",
        "C:/shared/build.mjs",
        "C:/shared/report.MD",
        "C:/shared/results.csv",
        "C:/shared/results.tsv",
        "C:/shared/chart.png",
        "C:/shared/fifth.txt",
      ]),
    );
    expect(
      listSurfaceIntents(kernel.db, { threadId: THREAD })
        .map((panel) => (panel.payload as { title: string }).title)
        .sort(),
    ).toEqual(["chart.png", "report.MD", "results.csv", "results.tsv"]);
  });
  it("isolates equal paths and grant IDs by node and thread; repeat writes keep their panel and dismissed state", () => {
    fixture();
    proposeFor({ kernel }, event());
    const first = listSurfaceIntents(kernel.db, { threadId: THREAD })[0]!;
    kernel.db
      .prepare("UPDATE surface_intents SET lifecycle = 'dismissed' WHERE id = ?")
      .run(first.id);
    proposeFor({ kernel }, event());
    proposeFor({ kernel }, event(THREAD, "node-b"));
    proposeFor({ kernel }, event(OTHER));
    const panels = listSurfaceIntents(kernel.db, { threadId: THREAD });
    expect(panels).toHaveLength(2);
    expect(panels.find((p) => p.id === first.id)?.lifecycle).toBe("dismissed");
    const other = listSurfaceIntents(kernel.db, { threadId: OTHER });
    expect(other).toHaveLength(1);
    expect(new Set([...panels, ...other].flatMap((p) => p.sourceIds)).size).toBe(3);
  });
  it("skips outside, traversal, unsupported, unfinished, missing-node and foreign-turn files", () => {
    fixture();
    proposeFor(
      { kernel },
      event(THREAD, "node-a", ["C:/outside/a.md", "C:/shared/../a.md", "C:/shared/a.zip"]),
    );
    proposeFor({ kernel }, event(THREAD, "node-a", ["C:/shared/a.md"], "started"));
    proposeFor({ kernel }, event(THREAD, "missing-node"));
    proposeFor({ kernel }, { ...event(), streamId: OTHER });
    expect(listSurfaceIntents(kernel.db, { threadId: THREAD })).toHaveLength(0);
    expect(listSurfaceIntents(kernel.db, { threadId: OTHER })).toHaveLength(0);
  });
  it("leaves files in the show folder to the show folder, so a page opens once and runs", () => {
    fixture();
    proposeFor(
      { kernel },
      event(THREAD, "node-a", [
        "C:/shared/noctis-show/figure.html",
        "C:/shared/Noctis-OS/noctis-show/rate-limiter/build.mjs",
      ]),
    );
    expect(listSurfaceIntents(kernel.db, { threadId: THREAD })).toHaveLength(0);
  });
  it("names in a prompt yield a recall panel; no Vault or no match yields nothing", () => {
    fixture();
    const written = event();
    const turnId = written.payload.turnId;
    kernel.db
      .prepare(
        "INSERT INTO identity_messages (id, thread_id, role, content_ref, created_at) VALUES (?, ?, 'user', '', ?)",
      )
      .run(turnId, THREAD, written.occurredAt);
    kernel.db
      .prepare(
        "INSERT INTO identity_message_content (message_id, body, created_at) VALUES (?, ?, ?)",
      )
      .run(turnId, "Tell me about Alex Kerr", written.occurredAt);
    const started = { ...written, type: "identity.turn_started.v1" as const };
    proposeFor({ kernel }, started);
    expect(listSurfaceIntents(kernel.db, { threadId: THREAD })).toHaveLength(0);
    const directory = mkdtempSync(join(tmpdir(), "panel-vault-"));
    try {
      createTestVault(directory);
      const vaultRoot = resolveVaultRoot({ NOCTIS_VAULT_ROOT: directory })!;
      indexVault(
        kernel,
        { correlationId: kernel.ids.nextId(), actorType: "user", actorId: "local" },
        vaultRoot,
        "index",
      );
      proposeFor({ kernel, vaultRoot }, started);
      expect(
        VaultRecallPayloadSchema.safeParse(
          listSurfaceIntents(kernel.db, { threadId: THREAD })[0]?.payload,
        ).success,
      ).toBe(true);
      expect(listSurfaceIntents(kernel.db, { threadId: THREAD })).toMatchObject([
        {
          kind: "vault_recall",
          persistence: "restorable",
          sourceIds: [turnId],
          payload: {
            query: "Tell me about Alex Kerr",
            freshness: "current",
          },
        },
      ]);
      expect(
        (
          listSurfaceIntents(kernel.db, { threadId: THREAD })[0]!.payload as {
            evidence: { path: string }[];
          }
        ).evidence.some((item) => item.path === "people/alex-kerr.md"),
      ).toBe(true);
      kernel.db
        .prepare(
          "UPDATE identity_message_content SET body = 'unfindable gibberish' WHERE message_id = ?",
        )
        .run(turnId);
      proposeFor({ kernel, vaultRoot }, { ...started, id: kernel.ids.nextId() });
      expect(listSurfaceIntents(kernel.db, { threadId: THREAD })).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

import { expect, it } from "vitest";
import { fixedClock } from "@noctis/domain";
import { join } from "node:path";
import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { listRuntimeRoots } from "./registry.js";

it("lists equal granted roots on each node independently, including offline nodes", () => {
  const db = openDatabase(":memory:");
  const clock = fixedClock(Date.parse("2026-09-01T12:00:00.000Z"));
  const at = new Date(clock.now()).toISOString();
  try {
    migrate(db, { directory: join(process.cwd(), "apps/core/migrations"), clock });
    const nodes = ["0199a000-0000-7000-8000-0000000000e1", "0199a000-0000-7000-8000-0000000000e2"];
    for (const nodeId of nodes) {
      db.prepare(
        "INSERT INTO nodes (id, host_id, status, fingerprint, agent_version, providers_json, created_at, updated_at) VALUES (?, ?, 'offline', ?, 'test', ?, ?, ?)",
      ).run(
        nodeId,
        nodeId,
        nodeId,
        JSON.stringify([{ providerId: "codex", available: true, authMode: "chatgpt", models: [] }]),
        at,
        at,
      );
      db.prepare(
        "INSERT INTO node_capabilities (id, node_id, capability, operation_class, constraints_version, constraints_json, granted_at) VALUES (?, ?, 'runtime.turn', 'local_reversible_edit', 1, ?, ?)",
      ).run(
        nodeId,
        nodeId,
        JSON.stringify({
          providers: ["codex"],
          roots: [{ grantId: "same", path: "C:/shared", mode: "write", localOnly: false }],
        }),
        at,
      );
    }
    const roots = listRuntimeRoots(db, () => false, clock.now());
    expect(roots.map((root) => root.nodeId)).toEqual(nodes);
    expect(roots.every((root) => !root.connected)).toBe(true);
  } finally {
    db.close();
  }
});

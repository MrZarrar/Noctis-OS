import { createIdFactory, fixedClock } from "@noctis/domain";
import { expect, it } from "vitest";
import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { createEventBroker } from "../events/broker.js";
import { createLogger } from "../logging.js";
import { connectNode, disconnectNode, getOwnerPresence, recordOwnerPresence } from "./registry.js";

it("commits owner-presence edges, rejects another actor and clears stale state on reconnect", () => {
  const db = openDatabase(":memory:");
  const clock = fixedClock(Date.parse("2026-10-14T09:00:00.000Z"));
  const kernel = {
    db,
    clock,
    ids: createIdFactory(clock),
    broker: createEventBroker(),
    logger: createLogger({ sink: () => undefined }),
  };
  const nodeId = "0199a000-0000-7000-8000-0000000000e1";
  const context = {
    correlationId: kernel.ids.nextId(),
    actorType: "node" as const,
    actorId: nodeId,
  };
  try {
    migrate(db, { directory: "apps/core/migrations", clock });
    const at = new Date(clock.now()).toISOString();
    db.prepare(
      "INSERT INTO nodes (id,host_id,status,fingerprint,agent_version,created_at,updated_at) VALUES (?,?,'online','fingerprint','test',?,?)",
    ).run(nodeId, nodeId, at, at);
    expect(getOwnerPresence(db, nodeId)).toBe(false);
    expect(
      recordOwnerPresence(
        kernel,
        { ...context, actorId: "someone-else" },
        { nodeId, present: true, idempotencyKey: "spoof" },
      ).ok,
    ).toBe(false);
    expect(
      recordOwnerPresence(kernel, context, { nodeId, present: true, idempotencyKey: "first" }).ok,
    ).toBe(true);
    expect(getOwnerPresence(db, nodeId)).toBe(true);
    recordOwnerPresence(kernel, context, { nodeId, present: true, idempotencyKey: "same" });
    expect(
      db
        .prepare("SELECT COUNT(*) c FROM orchestration_events WHERE type='node.owner_present.v1'")
        .get(),
    ).toEqual({ c: 1 });
    disconnectNode(kernel, context, { nodeId, connectionId: "one" });
    expect(getOwnerPresence(db, nodeId)).toBe(false);
    expect(
      recordOwnerPresence(kernel, context, { nodeId, present: true, idempotencyKey: "offline" }).ok,
    ).toBe(false);
    connectNode(
      kernel,
      context,
      { nodeId, connectionId: "two", agentVersion: "test", providers: [] },
      "0".repeat(32),
    );
    expect(getOwnerPresence(db, nodeId)).toBe(false);
    recordOwnerPresence(kernel, context, { nodeId, present: true, idempotencyKey: "again" });
    expect(getOwnerPresence(db, nodeId)).toBe(true);
    expect(
      db
        .prepare(
          "SELECT payload_json FROM orchestration_events WHERE type='node.owner_present.v1' ORDER BY sequence",
        )
        .all(),
    ).toEqual([
      { payload_json: JSON.stringify({ nodeId, present: true }) },
      { payload_json: JSON.stringify({ nodeId, present: false }) },
      { payload_json: JSON.stringify({ nodeId, present: true }) },
    ]);
  } finally {
    db.close();
  }
});

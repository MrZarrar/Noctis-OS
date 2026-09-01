import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OrchestrationEvent } from "@noctis/contracts";
import { conflict, createIdFactory, fixedClock, ok } from "@noctis/domain";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { createEventBroker } from "./events/broker.js";
import type { Kernel } from "./kernel.js";
import { runCommand } from "./kernel.js";
import { createLogger } from "./logging.js";
import { MIGRATIONS_DIRECTORY } from "./server.js";

const CLOCK = fixedClock(Date.parse("2026-09-01T12:00:00.000Z"));
const OBJECTIVE_ID = "0199a000-0000-7000-8000-00000000000a";

let open: Kernel | undefined;
let scratch: string | undefined;

function testKernel(path = ":memory:"): Kernel {
  const db = openDatabase(path);

  migrate(db, { directory: MIGRATIONS_DIRECTORY, clock: CLOCK });

  const kernel: Kernel = {
    db,
    clock: CLOCK,
    ids: createIdFactory(CLOCK),
    broker: createEventBroker(),
    logger: createLogger({ sink: () => undefined, clock: CLOCK }),
  };

  open = kernel;
  return kernel;
}

function insertObjective(kernel: Kernel, tx = kernel.db, id = OBJECTIVE_ID): void {
  tx.prepare(
    `INSERT INTO objectives (id, title, intent, status, identity_id, created_at, updated_at)
     VALUES (?, 'T', 'I', 'draft', 'vesper', '2026-09-01T12:00:00.000Z', '2026-09-01T12:00:00.000Z')`,
  ).run(id);
}

function draftEvent(kernel: Kernel, streamId: string) {
  return {
    id: kernel.ids.nextId(),
    streamType: "objective" as const,
    streamId,
    type: "objective.created.v1" as const,
    actorType: "user" as const,
    actorId: "local",
    payloadVersion: 1,
    payload: { title: "T" },
    correlationId: kernel.ids.nextId(),
    occurredAt: "2026-09-01T12:00:00.000Z",
  };
}

function objectiveCount(kernel: Kernel): number {
  return (kernel.db.prepare("SELECT COUNT(*) AS n FROM objectives").get() as { n: number }).n;
}

afterEach(() => {
  open?.db.close();
  open = undefined;

  if (scratch !== undefined) {
    rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});

describe("runCommand", () => {
  it("commits the state, the events, and the idempotency claim together", () => {
    const kernel = testKernel();

    const outcome = runCommand(kernel, { scope: "s", key: "k1", resultId: OBJECTIVE_ID }, (tx) => {
      insertObjective(kernel, tx);
      return ok({ value: OBJECTIVE_ID, events: [draftEvent(kernel, OBJECTIVE_ID)] });
    });

    expect(outcome).toEqual({ ok: true, value: OBJECTIVE_ID });
    expect(objectiveCount(kernel)).toBe(1);
    expect(
      kernel.db
        .prepare("SELECT result_id FROM idempotency_keys WHERE scope = 's' AND key = 'k1'")
        .get(),
    ).toEqual({ result_id: OBJECTIVE_ID });
  });

  it("refuses a replayed key without running the mutation again", () => {
    const kernel = testKernel();
    let mutations = 0;

    const run = () =>
      runCommand(kernel, { scope: "s", key: "k1", resultId: OBJECTIVE_ID }, (tx) => {
        mutations += 1;
        insertObjective(kernel, tx, kernel.ids.nextId());
        return ok({ value: "x", events: [draftEvent(kernel, OBJECTIVE_ID)] });
      });

    run();
    const second = run();

    expect(mutations).toBe(1);
    expect(second).toEqual({
      ok: false,
      conflict: { kind: "idempotent_replay", key: "k1", existingId: OBJECTIVE_ID },
    });
    expect(objectiveCount(kernel)).toBe(1);
  });

  it("releases the key when the mutation refuses, so the command can be retried", () => {
    const kernel = testKernel();

    const refused = runCommand<string>(
      kernel,
      { scope: "s", key: "k1", resultId: OBJECTIVE_ID },
      () =>
        conflict({
          kind: "forbidden_transition",
          machine: "objective",
          from: "draft",
          to: "draft",
        }),
    );

    expect(refused.ok).toBe(false);
    expect(kernel.db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get()).toEqual({ n: 0 });

    const retried = runCommand(kernel, { scope: "s", key: "k1", resultId: OBJECTIVE_ID }, (tx) => {
      insertObjective(kernel, tx);
      return ok({ value: "x", events: [draftEvent(kernel, OBJECTIVE_ID)] });
    });

    expect(retried.ok).toBe(true);
  });

  it("scopes keys, so two commands may reuse the same client-supplied string", () => {
    const kernel = testKernel();

    const first = runCommand(kernel, { scope: "a", key: "k", resultId: OBJECTIVE_ID }, (tx) => {
      insertObjective(kernel, tx);
      return ok({ value: "x", events: [draftEvent(kernel, OBJECTIVE_ID)] });
    });
    const second = runCommand(kernel, { scope: "b", key: "k", resultId: OBJECTIVE_ID }, () =>
      ok({ value: "y", events: [draftEvent(kernel, OBJECTIVE_ID)] }),
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it("publishes only after the state is visible to another connection", () => {
    // A second connection is the only honest witness. The writing connection
    // sees its own uncommitted rows, so counting on it would pass even if the
    // publish happened from inside the transaction.
    scratch = mkdtempSync(join(tmpdir(), "noctis-kernel-"));
    const kernel = testKernel(join(scratch, "core.db"));
    const observer = openDatabase(join(scratch, "core.db"));
    const seen: Array<{ events: readonly OrchestrationEvent[]; rowsElsewhere: number }> = [];

    try {
      kernel.broker.subscribe((events) => {
        seen.push({
          events,
          rowsElsewhere: (
            observer.prepare("SELECT COUNT(*) AS n FROM objectives").get() as { n: number }
          ).n,
        });
      });

      runCommand(kernel, { scope: "s", key: "k1", resultId: OBJECTIVE_ID }, (tx) => {
        insertObjective(kernel, tx);
        return ok({ value: "x", events: [draftEvent(kernel, OBJECTIVE_ID)] });
      });
    } finally {
      observer.close();
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]?.rowsElsewhere).toBe(1);
    expect(seen[0]?.events[0]?.sequence).toBe(1);
  });

  it("publishes nothing when the mutation refuses", () => {
    const kernel = testKernel();
    let published = 0;

    kernel.broker.subscribe(() => {
      published += 1;
    });

    runCommand<string>(kernel, { scope: "s", key: "k1", resultId: OBJECTIVE_ID }, () =>
      conflict({ kind: "not_found", entity: "objective", id: OBJECTIVE_ID }),
    );

    expect(published).toBe(0);
    expect(kernel.db.prepare("SELECT COUNT(*) AS n FROM orchestration_events").get()).toEqual({
      n: 0,
    });
  });

  it("rolls back state and events together when the mutation throws", () => {
    const kernel = testKernel();

    expect(() =>
      runCommand(kernel, { scope: "s", key: "k1", resultId: OBJECTIVE_ID }, (tx) => {
        insertObjective(kernel, tx);
        throw new Error("adapter exploded");
      }),
    ).toThrow("adapter exploded");

    expect(objectiveCount(kernel)).toBe(0);
    expect(kernel.db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get()).toEqual({ n: 0 });
  });
});

describe("write discipline", () => {
  /**
   * The mechanical half of "commands never touch tables directly". Phase 1 left
   * this as prose; a service that writes without going through `runCommand`
   * would skip the idempotency claim entirely, and nothing but this would say so.
   */
  it.each(["objectives/service.ts", "missions/service.ts", "authority/service.ts"])(
    "issues every write in %s on the transaction handle runCommand supplies",
    (file) => {
      const source = readFileSync(join(import.meta.dirname, file), "utf8");
      const writes = [...source.matchAll(/(\w+)\.prepare\(\s*`([\s\S]*?)`/g)].filter(([, , sql]) =>
        /INSERT INTO|UPDATE \w+\s+SET|DELETE FROM/i.test(sql ?? ""),
      );

      expect(source).toMatch(/\brunCommand\b/);
      expect(writes.length).toBeGreaterThan(0);

      // `tx` is only reachable inside the callback runCommand passes it to, and
      // that callback runs after the idempotency claim. A write on any other
      // handle — `db`, `kernel.db` — is a write outside that guarantee.
      for (const [, receiver, sql] of writes) {
        expect(receiver, `write is not on the transaction handle: ${sql?.slice(0, 60) ?? ""}`).toBe(
          "tx",
        );
      }
    },
  );
});

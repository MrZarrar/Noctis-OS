import { createIdFactory, fixedClock } from "@noctis/domain";
import { afterEach, describe, expect, it } from "vitest";

import { requestAuthority } from "../authority/service.js";
import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { createEventBroker } from "../events/broker.js";
import type { Kernel } from "../kernel.js";
import { createLogger } from "../logging.js";
import { MIGRATIONS_DIRECTORY } from "../server.js";
import { proposeFor } from "./proposed-surfaces.js";
import { changeObjectiveStatus, createObjective } from "./service.js";
import { listSurfaceIntents } from "./surface-intents.js";

const CLOCK = fixedClock(Date.parse("2026-09-01T12:00:00.000Z"));

let open: Kernel | undefined;

afterEach(() => {
  open?.db.close();
  open = undefined;
});

function createTestKernel(): Kernel {
  const db = openDatabase(":memory:");

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

/**
 * The rule, without a broker, a socket or a clock. `proposeFor` is exported
 * for exactly this: the subscription around it is three lines and the decision
 * about what goes on a canvas is all of it.
 */

const context = {
  correlationId: "0199a000-0000-7000-8000-0000000000c1",
  actorType: "user" as const,
  actorId: "local",
};

function objectiveWith(kernel: Kernel): string {
  const created = createObjective(kernel, context, {
    idempotencyKey: "create",
    title: "Ship the front door",
    intent: "Prove the phone can drive a turn",
    status: "draft",
    identityId: "vesper",
    protocolIds: [],
  });

  if (!created.ok) {
    throw new Error("could not create the objective");
  }

  const activated = changeObjectiveStatus(kernel, context, {
    idempotencyKey: "activate",
    objectiveId: created.value.id,
    expectedRevision: created.value.revision,
    status: "active",
  });

  if (!activated.ok) {
    throw new Error("could not activate the objective");
  }

  return created.value.id;
}

function pendingApproval(kernel: Kernel, objectiveId: string): string {
  const decision = requestAuthority(kernel, context, {
    idempotencyKey: "ask",
    objectiveId,
    actorId: "vesper",
    operationClass: "publish",
    capability: "release.publish",
    target: { type: "repository", id: "noctis-os" },
    consequenceSummary: "Publishes the release note publicly",
    reversibility: "partially_reversible",
  });

  if (!decision.ok) {
    throw new Error("could not record the decision");
  }

  expect(decision.value.outcome).toBe("require_confirmation");

  return decision.value.requestId;
}

describe("proposeFor", () => {
  it("puts a decision a person still has to make on the Objective's canvas", () => {
    const kernel = createTestKernel();
    const objectiveId = objectiveWith(kernel);
    const requestId = pendingApproval(kernel, objectiveId);

    proposeFor(
      { kernel },
      {
        id: "0199a000-0000-7000-8000-0000000000e1",
        sequence: 1,
        streamType: "authority",
        streamId: requestId,
        type: "authority.decision_recorded.v1",
        actorType: "user",
        actorId: "local",
        payloadVersion: 1,
        payload: { outcome: "require_confirmation" },
        correlationId: context.correlationId,
        occurredAt: "2026-09-17T12:00:00.000Z",
      },
    );

    const intents = listSurfaceIntents(kernel.db, objectiveId);

    expect(intents).toHaveLength(1);
    expect(intents[0]?.kind).toBe("approval");
    // Section 5.5: a decision Noctis is blocked on is not about the work, it is
    // about Noctis waiting — and it must never compose into overflow.
    expect(intents[0]?.role).toBe("attention");
    expect((intents[0]?.payload as { id: string }).id).toBe(requestId);
  });

  it("says nothing about a decision policy already settled", () => {
    // An allow or a deny is decided. An attention Surface asking the owner to
    // answer a decided question is the fastest way to have them ignored.
    const kernel = createTestKernel();
    const objectiveId = objectiveWith(kernel);
    const requestId = pendingApproval(kernel, objectiveId);

    proposeFor(
      { kernel },
      {
        id: "0199a000-0000-7000-8000-0000000000e2",
        sequence: 1,
        streamType: "authority",
        streamId: requestId,
        type: "authority.decision_recorded.v1",
        actorType: "user",
        actorId: "local",
        payloadVersion: 1,
        payload: { outcome: "allow" },
        correlationId: context.correlationId,
        occurredAt: "2026-09-17T12:00:00.000Z",
      },
    );

    expect(listSurfaceIntents(kernel.db, objectiveId)).toHaveLength(0);
  });

  it("gives a freshly activated Objective the three Surfaces it is born with", () => {
    // These used to be posted by whichever page did the activating, so an
    // Objective activated from the phone got a canvas the desktop never saw —
    // and vice versa. With no Vault configured there is nothing to recall, so
    // these three are the whole canvas.
    const kernel = createTestKernel();
    const objectiveId = objectiveWith(kernel);

    proposeFor(
      { kernel },
      {
        id: "0199a000-0000-7000-8000-0000000000e3",
        sequence: 1,
        streamType: "objective",
        streamId: objectiveId,
        type: "objective.activated.v1",
        actorType: "user",
        actorId: "local",
        payloadVersion: 1,
        payload: {},
        correlationId: context.correlationId,
        occurredAt: "2026-09-17T12:00:00.000Z",
      },
    );

    expect(
      listSurfaceIntents(kernel.db, objectiveId)
        .map((intent) => intent.kind)
        .sort(),
    ).toEqual(["conversation", "detail", "list"]);
  });
});

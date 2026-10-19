import { createIdFactory, fixedClock } from "@noctis/domain";
import { FileSourceSchema, MediaPayloadSchema, PANEL_PROPOSABLE_KINDS } from "@noctis/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { requestAuthority } from "../authority/service.js";
import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { createEventBroker } from "../events/broker.js";
import type { Kernel } from "../kernel.js";
import { createLogger } from "../logging.js";
import { applyProposal } from "../conversation/proposals.js";
import type { Turn } from "../conversation/service.js";
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

  db.prepare(
    "INSERT INTO identity_threads (id, identity_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
  ).run(
    "0199a000-0000-7000-8000-0000000000d1",
    "vesper",
    "2026-09-01T12:00:00.000Z",
    "2026-09-01T12:00:00.000Z",
  );

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
  it("strictly validates media sources and keeps the model allowlist bounded", () => {
    const file = {
      from: "file",
      nodeId: "node",
      grantId: "grant",
      relativePath: "images/test.png",
    };
    expect(FileSourceSchema.safeParse(file).success).toBe(true);
    for (const relativePath of ["../secret", "images\\..\\secret"]) {
      expect(FileSourceSchema.safeParse({ ...file, relativePath }).success).toBe(false);
    }
    expect(FileSourceSchema.safeParse({ ...file, extra: true }).success).toBe(false);
    expect(
      MediaPayloadSchema.safeParse({ title: "Image", mediaType: "image/png", source: file })
        .success,
    ).toBe(true);
    expect(
      MediaPayloadSchema.safeParse({
        title: "Image",
        mediaType: "image/png",
        source: { from: "attachment", attachmentId: "invalid" },
      }).success,
    ).toBe(false);
    expect(
      MediaPayloadSchema.safeParse({ title: "x".repeat(201), mediaType: "image/png", source: file })
        .success,
    ).toBe(false);
    expect([...PANEL_PROPOSABLE_KINDS]).toEqual([
      "document",
      "timeline",
      "verification",
      "list",
      "detail",
      "evidence",
      "attention",
      "visual",
      "media",
      "page",
      "options",
    ]);
  });
  const threadId = "0199a000-0000-7000-8000-0000000000d1";
  const attachmentId = "0199a000-0000-7000-8000-0000000000a1";
  function output(
    kernel: Kernel,
    extra: Record<string, unknown> = {},
    ownerThreadId = threadId,
  ): void {
    proposeFor(
      { kernel },
      {
        id: kernel.ids.nextId(),
        sequence: 1,
        streamType: "identity",
        streamId: ownerThreadId,
        type: "identity.turn_item.v1",
        actorType: "identity",
        actorId: "vesper",
        payloadVersion: 1,
        correlationId: context.correlationId,
        occurredAt: CLOCK.now().toString(),
        payload: {
          turnId: threadId,
          item: {
            itemId: "out",
            kind: "output",
            status: "completed",
            attachmentId,
            mediaType: "image/png",
            path: "folder/picture.png",
            ...extra,
          },
        },
      },
    );
  }

  it("keeps the same attachment independent across threads and dismissed repeats stable", () => {
    const kernel = createTestKernel();
    const otherThreadId = "0199a000-0000-7000-8000-0000000000d2";
    kernel.db
      .prepare(
        "INSERT INTO identity_threads (id, identity_id, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(otherThreadId, "vesper", "named", CLOCK.now().toString(), CLOCK.now().toString());
    output(kernel);
    output(kernel, {}, otherThreadId);
    const first = listSurfaceIntents(kernel.db, { threadId });
    const second = listSurfaceIntents(kernel.db, { threadId: otherThreadId });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]?.id).not.toBe(first[0]?.id);
    kernel.db
      .prepare("UPDATE surface_intents SET lifecycle = 'dismissed' WHERE id = ?")
      .run(first[0]?.id ?? "missing");
    output(kernel);
    output(kernel, {}, otherThreadId);
    expect(listSurfaceIntents(kernel.db, { threadId })).toMatchObject([
      { id: first[0]?.id, lifecycle: "dismissed" },
    ]);
    expect(listSurfaceIntents(kernel.db, { threadId: otherThreadId })).toMatchObject([
      { id: second[0]?.id, lifecycle: "proposed" },
    ]);
  });

  it.each(["image/png", "video/mp4", "audio/mpeg", "application/pdf"])(
    "opens a %s output on its thread",
    (mediaType) => {
      const kernel = createTestKernel();
      output(kernel, { mediaType });
      expect(listSurfaceIntents(kernel.db, { threadId })).toMatchObject([
        {
          kind: "media",
          role: "primary",
          sourceIds: [attachmentId],
          payload: {
            title: "picture.png",
            mediaType,
            source: { from: "attachment", attachmentId },
          },
        },
      ]);
    },
  );

  it.each([
    { attachmentId: undefined },
    { status: "started" },
    { mediaType: "application/zip" },
    { attachmentId: "bad" },
  ])("ignores unavailable or unsupported outputs %j", (extra) => {
    const kernel = createTestKernel();
    output(kernel, extra);
    expect(listSurfaceIntents(kernel.db, { threadId })).toHaveLength(0);
  });

  it("bounds output titles and keeps one dismissed output dismissed", () => {
    const kernel = createTestKernel();
    output(kernel, { path: "x".repeat(500) });
    const first = listSurfaceIntents(kernel.db, { threadId })[0];
    expect((first?.payload as { title: string }).title).toHaveLength(200);
    kernel.db
      .prepare("UPDATE surface_intents SET lifecycle = 'dismissed' WHERE id = ?")
      .run(first?.id ?? "missing");
    output(kernel, { path: "folder/" });
    expect(listSurfaceIntents(kernel.db, { threadId })).toMatchObject([
      { id: first?.id, lifecycle: "dismissed" },
    ]);
  });

  it.each([undefined, "folder/", "folder/   "])("uses Output for an empty basename %s", (path) => {
    const kernel = createTestKernel();
    output(kernel, { path });
    output(kernel, { path });
    expect(listSurfaceIntents(kernel.db, { threadId })).toMatchObject([
      { payload: { title: "Output" } },
    ]);
    expect(listSurfaceIntents(kernel.db, { threadId })).toHaveLength(1);
  });

  const turn: Turn = {
    id: threadId,
    threadId,
    identityId: "vesper",
    userMessageId: threadId,
    model: { providerId: "codex", model: "test" },
    status: "completed",
    items: [],
    startedAt: "2026-09-01T12:00:00.000Z",
  };
  function listProposal(
    kernel: Kernel,
    activeTurn = turn,
    surfaceKind = "list",
    objectiveId?: string,
  ): void {
    applyProposal(
      kernel,
      context,
      activeTurn,
      {
        kind: "surface",
        surfaceKind,
        role: "supporting",
        persistence: "restorable",
        priority: 20,
        payloadVersion: 1,
        payload: { items: [{ id: "one", label: "Plan" }] },
        ...(objectiveId === undefined ? {} : { objectiveId }),
      },
      kernel.ids.nextId(),
    );
  }

  it("accepts free chat proposals, updates one turn and preserves closed panels across turns", () => {
    const kernel = createTestKernel();
    listProposal(kernel);
    listProposal(kernel);
    const first = listSurfaceIntents(kernel.db, { threadId })[0];
    expect(first?.sourceIds).toEqual([turn.id]);
    kernel.db
      .prepare("UPDATE surface_intents SET lifecycle = 'dismissed' WHERE id = ?")
      .run(first?.id ?? "missing");
    listProposal(kernel);
    listProposal(kernel, { ...turn, id: kernel.ids.nextId() });
    expect(listSurfaceIntents(kernel.db, { threadId })).toHaveLength(2);
    expect(
      listSurfaceIntents(kernel.db, { threadId }).find((item) => item.id === first?.id)?.lifecycle,
    ).toBe("dismissed");
  });

  it.each([
    "approval",
    "vault_recall",
    "media",
    "native_application",
    "external_tool",
    "conversation",
  ])("refuses a model's %s panel", (kind) => {
    const kernel = createTestKernel();
    listProposal(kernel, turn, kind);
    expect(listSurfaceIntents(kernel.db, { threadId })).toHaveLength(0);
  });

  it("uses only an explicitly named valid Objective", () => {
    const kernel = createTestKernel();
    const objectiveId = objectiveWith(kernel);
    listProposal(kernel, { ...turn, objectiveId });
    expect(listSurfaceIntents(kernel.db, { threadId })).toHaveLength(1);
    listProposal(kernel, { ...turn, objectiveId }, "list", objectiveId);
    expect(listSurfaceIntents(kernel.db, { objectiveId })).toHaveLength(1);
    listProposal(kernel, turn, "list", kernel.ids.nextId());
    expect(listSurfaceIntents(kernel.db, { threadId })).toHaveLength(1);
  });
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

    const intents = listSurfaceIntents(kernel.db, { objectiveId });

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

    expect(listSurfaceIntents(kernel.db, { objectiveId })).toHaveLength(0);
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
      listSurfaceIntents(kernel.db, { objectiveId })
        .map((intent) => intent.kind)
        .sort(),
    ).toEqual(["conversation", "detail", "list"]);
  });
});

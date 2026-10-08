import { describe, expect, it } from "vitest";

import {
  AdoptRuntimeSessionCommandSchema,
  CreateConversationThreadCommandSchema,
} from "./command.js";
import { ConversationSummarySchema, ConversationThreadSchema } from "./identity.js";
import { CAPABILITY_CONTRACTS, CAPABILITY_OPERATION_CLASS, grantCovers } from "./node.js";
import { RuntimeTurnPayloadSchema } from "./runtime.js";

const THREAD = {
  id: "0199a000-0000-7000-8000-000000000001",
  identityId: "vesper",
  revision: 0,
  createdAt: "2026-10-08T12:00:00.000Z",
  updatedAt: "2026-10-08T12:00:00.000Z",
};

describe("sessions started outside Noctis (v1, after S4)", () => {
  it("lists a shared folder's sessions as a read the agents' grant covers", () => {
    expect(grantCovers("runtime.turn", "session.list")).toBe(true);
    expect(CAPABILITY_OPERATION_CLASS["session.list"]).toBe("read_inspect");

    const evidence = CAPABILITY_CONTRACTS["session.list"].evidence;

    expect(
      evidence.safeParse({
        sessions: [
          {
            providerId: "claude",
            sessionRef: "2d234a2a-965d-4952-9497-73754e13c865",
            title: "Video script refresh",
            lastActiveAt: "2026-10-08T15:21:21.567Z",
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      CAPABILITY_CONTRACTS["session.list"].payload.safeParse({ rootGrantId: "tu" }).success,
    ).toBe(true);
  });

  it("adopts one session into a thread pinned to its PC, folder and agent", () => {
    const adopt = {
      idempotencyKey: "k",
      identityId: "vesper",
      nodeId: "0199a000-0000-7000-8000-000000000002",
      rootGrantId: "thought-unfolds",
      providerId: "claude",
      sessionRef: "2d234a2a-965d-4952-9497-73754e13c865",
      title: "Video script refresh",
    };

    expect(AdoptRuntimeSessionCommandSchema.safeParse(adopt).success).toBe(true);
    expect(AdoptRuntimeSessionCommandSchema.safeParse({ ...adopt, sessionRef: "" }).success).toBe(
      false,
    );
  });

  it("describes a named, pinned thread, and still reads the free one as before", () => {
    expect(ConversationThreadSchema.parse(THREAD).kind).toBe("free");
    expect(
      ConversationThreadSchema.parse({
        ...THREAD,
        kind: "named",
        title: "Video script refresh",
        nodeId: "0199a000-0000-7000-8000-000000000002",
        rootGrantId: "thought-unfolds",
        providerId: "claude",
      }).title,
    ).toBe("Video script refresh");
  });

  it("opens a new conversation with an optional title", () => {
    expect(
      CreateConversationThreadCommandSchema.safeParse({ idempotencyKey: "k", identityId: "vesper" })
        .success,
    ).toBe(true);
    expect(
      CreateConversationThreadCommandSchema.safeParse({
        idempotencyKey: "k",
        identityId: "vesper",
        title: "Storyboard pass",
      }).success,
    ).toBe(true);
  });

  it("summarises a conversation for the list: when it last moved and what was said last", () => {
    expect(
      ConversationSummarySchema.safeParse({
        ...THREAD,
        kind: "named",
        lastActiveAt: "2026-10-08T15:21:21.567Z",
        preview: "Here is the revised cold open",
      }).success,
    ).toBe(true);
  });

  it("asks a turn to fork the session it resumes, so the original is never written to", () => {
    const parsed = RuntimeTurnPayloadSchema.safeParse({
      threadId: "0199a000-0000-7000-8000-000000000001",
      identityId: "vesper",
      model: { providerId: "claude", model: "sonnet" },
      userMessageId: "0199a000-0000-7000-8000-000000000003",
      prompt: "carry on",
      primaryRootGrantId: "thought-unfolds",
      sessionRef: "2d234a2a-965d-4952-9497-73754e13c865",
      forkSession: true,
      objectiveActive: false,
    });

    expect(parsed.success).toBe(true);
  });
});

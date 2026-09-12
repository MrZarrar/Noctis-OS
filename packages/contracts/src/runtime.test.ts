import { describe, expect, it } from "vitest";

import {
  CAPABILITY_OPERATION_CLASS,
  ELIGIBLE_AUTH_MODES,
  NodeFrameSchema,
  NodeServerFrameSchema,
  RuntimeGrantConstraintsSchema,
  RuntimeItemSchema,
  RuntimeTurnPayloadSchema,
  ServerFrameSchema,
} from "./index.js";

const UUID = "0199a000-0000-7000-8000-000000000001";
const MODEL = { providerId: "codex", model: "gpt-5.6-sol" };

describe("runtime contracts", () => {
  it("classes a turn as read_inspect and carries the chosen model", () => {
    expect(CAPABILITY_OPERATION_CLASS["runtime.turn"]).toBe("read_inspect");
    expect(
      RuntimeTurnPayloadSchema.safeParse({
        threadId: UUID,
        identityId: "vesper",
        model: MODEL,
        userMessageId: UUID,
        prompt: "hello",
        primaryRootGrantId: "documents",
        objectiveActive: false,
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown provider and an over-long prompt", () => {
    const base = {
      threadId: UUID,
      identityId: "vesper",
      userMessageId: UUID,
      primaryRootGrantId: "d",
      objectiveActive: false,
    };
    expect(
      RuntimeTurnPayloadSchema.safeParse({
        ...base,
        model: { providerId: "gemini", model: "x" },
        prompt: "x",
      }).success,
    ).toBe(false);
    expect(
      RuntimeTurnPayloadSchema.safeParse({ ...base, model: MODEL, prompt: "x".repeat(20_001) })
        .success,
    ).toBe(false);
  });

  it("bounds command output and delta text", () => {
    expect(
      RuntimeItemSchema.safeParse({
        kind: "command",
        itemId: "c1",
        status: "completed",
        command: "dir",
        output: "y".repeat(4_001),
      }).success,
    ).toBe(false);
    expect(
      NodeFrameSchema.safeParse({
        kind: "delta",
        envelopeVersion: 1,
        jobId: UUID,
        delta: { itemId: "m1", text: "z".repeat(2_001) },
      }).success,
    ).toBe(false);
  });

  it("carries providers with models on hello, answers on the server frame, deltas to clients", () => {
    expect(
      NodeFrameSchema.safeParse({
        kind: "hello",
        envelopeVersion: 1,
        agentVersion: "0.0.0",
        capabilities: ["runtime.turn"],
        providers: [{ providerId: "codex", available: true, authMode: "chatgpt", models: [MODEL] }],
      }).success,
    ).toBe(true);
    expect(
      NodeServerFrameSchema.safeParse({
        kind: "answer",
        envelopeVersion: 1,
        jobId: UUID,
        answer: { askId: UUID, decision: "deny", approvalId: UUID },
      }).success,
    ).toBe(true);
    expect(
      ServerFrameSchema.safeParse({
        kind: "runtime_delta",
        envelopeVersion: 1,
        threadId: UUID,
        jobId: UUID,
        itemId: "m1",
        text: "Hel",
      }).success,
    ).toBe(true);
  });

  it("roots carry a mode and a local-only flag", () => {
    expect(
      RuntimeGrantConstraintsSchema.safeParse({
        providers: ["codex", "claude"],
        roots: [
          {
            grantId: "vault",
            path: "C:\\Users\\mmush\\OneDrive\\MindVault",
            mode: "read",
            localOnly: true,
          },
          { grantId: "inbox", path: "C:\\Users\\mmush\\OneDrive\\MindVault\\inbox", mode: "write" },
        ],
      }).success,
    ).toBe(true);
  });

  it("names chatgpt, claude_ai and local as eligible", () => {
    expect([...ELIGIBLE_AUTH_MODES].sort()).toEqual(["chatgpt", "claude_ai", "local"]);
  });
});

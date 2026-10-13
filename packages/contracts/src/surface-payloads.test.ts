import { describe, expect, it } from "vitest";
import { PANEL_PROPOSABLE_KINDS, SURFACE_PAYLOAD_SCHEMAS } from "./surface-payloads.js";

export const PANEL_FIXTURES = {
  document: {
    title: "Plan",
    format: "markdown",
    content: { from: "inline", text: "# Plan\n- [ ] first step" },
  },
  timeline: {
    title: "Today",
    items: [{ id: "a", start: "09:00", end: "10:00", label: "Build", detail: "A step", due: true }],
  },
  verification: {
    title: "Checks",
    items: [{ id: "a", claim: "Build works", status: "partial", reason: "Phone pending" }],
  },
} as const;

describe("read-only panels and message choices", () => {
  it.each(Object.entries(PANEL_FIXTURES))("keeps the complete %s payload", (kind, payload) => {
    expect(PANEL_PROPOSABLE_KINDS.has(kind)).toBe(true);
    expect(SURFACE_PAYLOAD_SCHEMAS[kind]?.schema.safeParse(payload)).toMatchObject({
      success: true,
      data: payload,
    });
  });
  it.each(Object.entries(PANEL_FIXTURES))("rejects unknown %s fields", (kind, payload) => {
    expect(
      SURFACE_PAYLOAD_SCHEMAS[kind]?.schema.safeParse({ ...payload, command: "run" }).success,
    ).toBe(false);
  });
  it("accepts bounded actions while keeping legacy list payloads", () => {
    const schema = SURFACE_PAYLOAD_SCHEMAS.list!.schema;
    expect(schema.safeParse({ items: [] }).success).toBe(true);
    expect(
      schema.safeParse({ items: [], actions: [{ label: "Use this", message: "Use option A" }] })
        .success,
    ).toBe(true);
    for (const action of [
      { label: " ", message: "x" },
      { label: "x", message: " " },
      { label: "x".repeat(81), message: "x" },
      { label: "x", message: "x".repeat(4001) },
      { label: "x", message: "x", url: "https://example.com" },
      { label: "x", message: "x", command: "delete" },
    ])
      expect(schema.safeParse({ items: [], actions: [action] }).success).toBe(false);
    expect(
      schema.safeParse({
        items: [],
        actions: Array.from({ length: 9 }, () => ({ label: "x", message: "x" })),
      }).success,
    ).toBe(false);
  });
  it("bounds document text and timeline/verification rows", () => {
    expect(
      SURFACE_PAYLOAD_SCHEMAS.document?.schema.safeParse({
        ...PANEL_FIXTURES.document,
        content: { from: "inline", text: "x".repeat(50001) },
      }).success,
    ).toBe(false);
    for (const kind of ["timeline", "verification"] as const) {
      expect(
        SURFACE_PAYLOAD_SCHEMAS[kind]?.schema.safeParse({
          ...PANEL_FIXTURES[kind],
          items: Array(51).fill(PANEL_FIXTURES[kind].items[0]),
        }).success,
      ).toBe(false);
    }
  });
});

import { describe, expect, it } from "vitest";

import { REGISTRY, resolveSurface } from "./registry.js";

const CONVERSATION = { messages: [{ id: "m1", author: "Vesper", text: "Ready." }] };

describe("the Surface registry", () => {
  it("resolves a registered kind whose payload matches its schema", () => {
    const resolved = resolveSurface("conversation", 1, CONVERSATION, "wide");

    expect(resolved.status).toBe("ok");
  });

  it("falls back for a kind nothing registered", () => {
    const resolved = resolveSurface("native_application", 1, {}, "wide");

    expect(resolved).toEqual({
      status: "fallback",
      kind: "native_application",
      reason: "no renderer is registered for this kind",
    });
  });

  it("falls back rather than rendering a payload from another version", () => {
    const resolved = resolveSurface("conversation", 2, CONVERSATION, "wide");

    expect(resolved.status).toBe("fallback");
  });

  it("falls back for a size the renderer does not support", () => {
    const resolved = resolveSurface("conversation", 1, CONVERSATION, "compact");

    expect(resolved.status).toBe("fallback");
  });

  it("THE GATE: a malformed payload degrades to the fallback instead of throwing", () => {
    for (const payload of [null, "text", 7, [], {}, { messages: [{ id: "m1" }] }]) {
      expect(resolveSurface("conversation", 1, payload, "wide").status).toBe("fallback");
    }
  });

  it("refuses a payload carrying unknown fields", () => {
    const resolved = resolveSurface(
      "detail",
      1,
      { fields: [], region: "centre", x: 10 },
      "standard",
    );

    expect(resolved.status).toBe("fallback");
  });

  it("declares a schema, a version, and at least one size for every kind", () => {
    for (const [kind, entry] of Object.entries(REGISTRY)) {
      expect(entry.payloadVersion, kind).toBeGreaterThan(0);
      expect(entry.sizes.length, kind).toBeGreaterThan(0);
      expect(entry.title.length, kind).toBeGreaterThan(0);
    }
  });
});

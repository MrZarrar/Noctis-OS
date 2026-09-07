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

describe("THE GATE: a Surface cannot show what the caller may not see", () => {
  const approval = {
    id: "01941f29-7c00-7000-8000-000000000001",
    consequenceSummary: "Publish the listing",
    operationClass: "publish",
    capability: "vinted.publish",
    targetType: "listing",
    targetId: "vinted-4821",
    reversibility: "partially_reversible" as const,
    outcome: "require_confirmation" as const,
    reasonCodes: ["operation_class_default"],
  };

  it("falls back when the caller does not hold the capability the Surface requires", () => {
    const resolved = resolveSurface("approval", 1, approval, "standard", []);

    expect(resolved.status).toBe("fallback");
    expect(resolved.status === "fallback" && resolved.reason).toContain("authority.approve");
  });

  it("renders it for a caller who does", () => {
    const resolved = resolveSurface("approval", 1, approval, "standard", ["authority.approve"]);

    expect(resolved.status).toBe("ok");
  });

  it("refuses to squeeze an approval into a compact Surface", () => {
    // Not a style rule. A consequence boundary too small to show its target is
    // one that gets approved without being read.
    const resolved = resolveSurface("approval", 1, approval, "compact", ["authority.approve"]);

    expect(resolved.status).toBe("fallback");
  });

  it("leaves every Surface that gates nothing reachable without a capability", () => {
    const ungated = Object.entries(REGISTRY).filter(([, entry]) => !("requires" in entry));

    expect(ungated.length).toBeGreaterThan(0);

    for (const [kind] of ungated) {
      // Passing no capabilities must not turn an ungated Surface into a
      // fallback; only a payload or a size may do that.
      const resolved = resolveSurface(kind, 1, {}, "standard", []);

      expect(resolved.status === "fallback" ? resolved.reason : "ok").not.toContain("capability");
    }
  });
});

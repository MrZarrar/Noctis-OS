import type { ProviderDescriptor } from "@noctis/contracts";
import { ProviderClassSchema } from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import { ProviderRegistrationError, createProviderRegistry } from "./registry.js";

const CODEX: ProviderDescriptor = { id: "codex-cli", providerClass: "signed_in_runtime" };

describe("createProviderRegistry", () => {
  it("starts empty, so nothing is routable until it is registered on purpose", () => {
    expect(createProviderRegistry().list()).toEqual([]);
  });

  it("registers a signed-in runtime and a local model", () => {
    const registry = createProviderRegistry();

    registry.register(CODEX);
    registry.register({ id: "ollama-local", providerClass: "local_inference" });

    expect(registry.list()).toHaveLength(2);
    expect(registry.get("codex-cli")).toEqual(CODEX);
  });

  it("refuses a metered API", () => {
    const registry = createProviderRegistry();

    expect(() => registry.register({ id: "openai-api", providerClass: "metered_api" })).toThrow(
      ProviderRegistrationError,
    );
    expect(registry.list()).toEqual([]);
  });

  it("leaves exactly one registrable provider class unaccounted for", () => {
    // If a future phase adds a class, this fails until someone decides whether
    // it is registrable — rather than it defaulting to allowed by omission.
    expect(ProviderClassSchema.options).toEqual([
      "signed_in_runtime",
      "local_inference",
      "metered_api",
    ]);
  });

  it("refuses a descriptor that does not match the contract", () => {
    const registry = createProviderRegistry();

    expect(() => registry.register({ id: "", providerClass: "local_inference" })).toThrow();
    expect(() =>
      registry.register({ id: "x", providerClass: "free_lunch" } as unknown as ProviderDescriptor),
    ).toThrow();
  });

  it("refuses to shadow an existing provider id", () => {
    const registry = createProviderRegistry();

    registry.register(CODEX);

    expect(() => registry.register({ ...CODEX, providerClass: "local_inference" })).toThrow(
      ProviderRegistrationError,
    );
    expect(registry.get("codex-cli")?.providerClass).toBe("signed_in_runtime");
  });
});

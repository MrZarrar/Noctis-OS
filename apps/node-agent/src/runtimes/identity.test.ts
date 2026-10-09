import { describe, expect, it } from "vitest";

import { identityCard } from "./identity.js";

describe("identityCard", () => {
  it("tells Vesper which runtime and model it is running on", () => {
    const card = identityCard({
      identityId: "vesper",
      runtime: "claude",
      model: "sonnet",
      env: {},
    });

    expect(card).toMatch(/^You are Vesper/);
    expect(card).toContain("running as Claude Code on sonnet");
    expect(card).toContain("say you are Vesper, running on sonnet through Noctis");
  });

  it.each([
    ["claude", "Claude Code"],
    ["codex", "Codex"],
    ["hermes", "Hermes"],
    ["local", "a local model"],
  ] as const)("names the %s runtime", (runtime, name) => {
    expect(identityCard({ identityId: "vesper", runtime, model: "m", env: {} })).toContain(
      `running as ${name} on m`,
    );
  });

  it("gives Jester no card anywhere but Hermes, where its own soul stands", () => {
    for (const runtime of ["claude", "codex", "local"] as const) {
      expect(identityCard({ identityId: "jester", runtime, model: "m", env: {} })).toBe(undefined);
    }

    expect(identityCard({ identityId: "jester", runtime: "hermes", model: "m", env: {} })).toBe(
      undefined,
    );
  });

  it("is off when NOCTIS_IDENTITY_CARDS is 0", () => {
    expect(
      identityCard({
        identityId: "vesper",
        runtime: "codex",
        model: "m",
        env: { NOCTIS_IDENTITY_CARDS: "0" },
      }),
    ).toBe(undefined);
  });
});

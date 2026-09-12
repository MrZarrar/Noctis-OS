import { describe, expect, it } from "vitest";

import { BILLING_KEYS, childEnvironment } from "./env.js";

describe("childEnvironment", () => {
  it("drops every billing key, whatever its case, and keeps the rest", () => {
    const base: NodeJS.ProcessEnv = {
      PATH: "C:\\bin",
      HOME: "C:\\Users\\x",
      Openai_Api_Key: "sk-1",
      anthropic_api_key: "sk-2",
      CODEX_API_KEY: "sk-3",
    };

    const child = childEnvironment(base);

    expect(child).toEqual({ PATH: "C:\\bin", HOME: "C:\\Users\\x" });

    for (const key of BILLING_KEYS) {
      expect(Object.keys(child).map((k) => k.toUpperCase())).not.toContain(key);
    }
  });

  it("does not mutate the environment it copied", () => {
    const base: NodeJS.ProcessEnv = { OPENAI_API_KEY: "sk", KEEP: "1" };

    childEnvironment(base);

    expect(base.OPENAI_API_KEY).toBe("sk");
  });
});

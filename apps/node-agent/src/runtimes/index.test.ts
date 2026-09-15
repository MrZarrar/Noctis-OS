import { describe, expect, it } from "vitest";

import { FAKE_PROBE } from "./fake.js";
import { selectProbes, selectRuntimes } from "./index.js";

describe("selectProbes", () => {
  it("reports the selected runtimes' own probes under NOCTIS_RUNTIME=fake", async () => {
    const env = { NOCTIS_RUNTIME: "fake" };

    await expect(selectProbes(env, selectRuntimes(env))()).resolves.toEqual([FAKE_PROBE]);
  });
});

describe("selectRuntimes", () => {
  it("puts the scripted runtime behind codex when NOCTIS_RUNTIME is fake", async () => {
    const runtimes = selectRuntimes({ NOCTIS_RUNTIME: "fake" });

    expect(Object.keys(runtimes)).toEqual(["codex"]);
    expect(await runtimes.codex?.probe()).toEqual(FAKE_PROBE);
  });

  it("wires the real codex runtime when the operator names an executable", () => {
    const runtimes = selectRuntimes({ NOCTIS_CODEX_PATH: "C:\\tools\\codex.exe" });

    expect(runtimes.codex?.providerId).toBe("codex");
    expect(typeof runtimes.codex?.probe).toBe("function");
    expect(runtimes.claude?.providerId).toBe("claude");
    expect(runtimes.hermes).toBe(undefined);
  });

  it("wires claude whatever the machine has: the Agent SDK carries its own CLI", () => {
    const runtimes = selectRuntimes({ PATH: "" });

    expect(runtimes.claude?.providerId).toBe("claude");
  });
});

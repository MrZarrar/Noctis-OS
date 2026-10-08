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
    expect(runtimes.hermes?.providerId).toBe("hermes");
  });

  it("wires the local model runtime, at the server the operator names or LM Studio's", async () => {
    expect(selectRuntimes({ PATH: "" }).local?.providerId).toBe("local");

    // Nothing listens on port 9 (discard): the probe says so instead of failing the hello.
    const env = { PATH: "", NOCTIS_LOCAL_MODEL_URL: "http://127.0.0.1:9/v1" };
    const probe = await selectRuntimes(env).local?.probe();

    expect(probe).toMatchObject({ providerId: "local", available: false });
    expect(probe?.reason).toContain("127.0.0.1:9");
  });

  it("reports Hermes as unavailable, not missing, when it is not installed", async () => {
    const probe = await selectRuntimes({ PATH: "", NOCTIS_HERMES_PATH: "" }).hermes?.probe();

    expect(probe).toMatchObject({ providerId: "hermes", available: false });
  });

  it("wires claude whatever the machine has: the Agent SDK carries its own CLI", () => {
    const runtimes = selectRuntimes({ PATH: "" });

    expect(runtimes.claude?.providerId).toBe("claude");
  });
});

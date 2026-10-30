import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RuntimeItem } from "@noctis/contracts";

import { FAKE_PROBE } from "./fake.js";
import { selectProbes, selectRuntimes } from "./index.js";

describe("selectProbes", () => {
  it("reports the selected runtimes' own probes under NOCTIS_RUNTIME=fake", async () => {
    const env = { NOCTIS_RUNTIME: "fake" };

    await expect(selectProbes(env, selectRuntimes(env))()).resolves.toEqual([FAKE_PROBE]);
  });
});

describe("selectRuntimes", () => {
  it("keeps turns and usage working after a Codex update removes the startup executable", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "noctis-codex-update-"));
    const bin = join(scratch, "OpenAI", "Codex", "bin");
    const binary = process.platform === "win32" ? "codex.exe" : "codex";
    const oldCommand = join(bin, "old", binary);
    const newCommand = join(bin, "new", binary);
    const env = { PATH: "", LOCALAPPDATA: scratch, CODEX_HOME: join(scratch, "home") };

    mkdirSync(join(bin, "old"), { recursive: true });
    copyFileSync(process.execPath, oldCommand);
    // A real executable speaking the app-server protocol, without a model or account.
    writeFileSync(
      join(scratch, "app-server"),
      `
      const { appendFileSync } = require("node:fs");
      appendFileSync("launches.jsonl", JSON.stringify(process.execPath) + "\\n");
      const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
      require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
        const { id, method } = JSON.parse(line);
        if (id === undefined) return;
        const result = method === "account/rateLimits/read"
          ? { rateLimits: { primary: { usedPercent: 14, windowDurationMins: 300 }, secondary: null } }
          : method === "thread/start" ? { thread: { id: "thread-1" } }
          : method === "turn/start" ? { turn: { id: "turn-1" } } : {};
        send({ id, result });
        if (method === "turn/start") setTimeout(() => {
          send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1",
            item: { type: "agentMessage", id: "reply", text: "Updated executable works" } } });
          send({ method: "turn/completed", params: { threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null } } });
        }, 10);
      });
    `,
    );
    const codex = selectRuntimes(env).codex!;

    try {
      await expect(codex.readLimits!(scratch, env)).resolves.toMatchObject({
        fiveHour: { usedPercent: 14 },
      });
      mkdirSync(join(bin, "new"));
      renameSync(oldCommand, newCommand);

      const items: RuntimeItem[] = [];
      const unexpected = () => Promise.reject(new Error("no tools expected"));
      const evidence = await codex.turn(
        {
          payload: {
            threadId: "0199a000-0000-7000-8000-0000000000e1",
            identityId: "vesper",
            model: { providerId: "codex", model: "gpt-6.1-sol" },
            userMessageId: "0199a000-0000-7000-8000-0000000000e2",
            prompt: "say hello",
            primaryRootGrantId: "w",
            objectiveActive: false,
          },
          roots: { cwd: scratch, writable: [scratch], readable: [], localOnly: false },
          env,
          signal: new AbortController().signal,
        },
        {
          item: (item) => items.push(item),
          delta: () => undefined,
          ask: unexpected,
          delegate: unexpected,
          upload: unexpected,
        },
      );

      expect(evidence.sessionRef).toBe("thread-1");
      expect(items).toContainEqual(expect.objectContaining({ text: "Updated executable works" }));
      await expect(codex.readLimits!(scratch, env)).resolves.toMatchObject({
        fiveHour: { usedPercent: 14 },
      });
      expect(
        readFileSync(join(scratch, "launches.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line): unknown => JSON.parse(line)),
      ).toEqual([oldCommand, newCommand, newCommand]);
    } finally {
      await codex.close?.();
      rmSync(scratch, { recursive: true, force: true });
    }
  });

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

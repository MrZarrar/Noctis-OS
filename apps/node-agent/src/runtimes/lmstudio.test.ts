import { describe, expect, it } from "vitest";

import { createLmStudio } from "./lmstudio.js";

const QWEN = "qwen/qwen3.5-9b";

/** A scripted `lms`: records each call, answers `ls` and `ps` from what is "loaded". */
function fakeLms(loaded: Array<{ modelKey: string; identifier: string; contextLength: number }>) {
  const calls: string[][] = [];
  let release: () => void = () => undefined;
  const loading = new Promise<void>((resolve) => {
    release = resolve;
  });

  const run = async (args: readonly string[]): Promise<string> => {
    calls.push([...args]);

    switch (args[0]) {
      case "ls":
        return JSON.stringify([
          { type: "llm", modelKey: QWEN },
          { type: "llm", modelKey: "nomic/embed-text" },
        ]);
      case "ps":
        return JSON.stringify(loaded.map((model) => ({ type: "llm", ...model })));
      case "load":
        await loading;
        loaded.push({ modelKey: args[1]!, identifier: args[1]!, contextLength: 65_536 });
        return "";
      default:
        return "";
    }
  };

  return { run, calls, release };
}

describe("LM Studio, started when Noctis needs it", () => {
  it("lists the chat models on disk without loading any", async () => {
    const lms = fakeLms([]);

    expect(await createLmStudio({ run: lms.run }).downloaded()).toEqual([QWEN]);
    expect(lms.calls).toEqual([
      ["daemon", "up"],
      ["ls", "--llm", "--json"],
    ]);
  });

  it("starts the server on loopback and loads the model at Hermes's context, unloading it when idle", async () => {
    const lms = fakeLms([]);
    lms.release();

    await createLmStudio({ run: lms.run }).ensure(QWEN);

    expect(lms.calls).toEqual([
      ["daemon", "up"],
      ["server", "start", "--port", "1234", "--bind", "127.0.0.1"],
      ["ps", "--json"],
      ["load", QWEN, "--context-length", "65536", "--gpu", "max", "--ttl", "600", "--yes"],
    ]);
  });

  it("uses the model already loaded with enough context, and reloads one loaded too small", async () => {
    const ready = fakeLms([{ modelKey: QWEN, identifier: QWEN, contextLength: 65_536 }]);

    await createLmStudio({ run: ready.run }).ensure(QWEN);
    expect(ready.calls.some(([command]) => command === "load")).toBe(false);

    const small = fakeLms([{ modelKey: QWEN, identifier: "qwen-small", contextLength: 4096 }]);
    small.release();

    await createLmStudio({ run: small.run }).ensure(QWEN);
    expect(small.calls).toContainEqual(["unload", "qwen-small"]);
    expect(small.calls.at(-1)?.[0]).toBe("load");
  });

  it("loads once when two turns arrive together", async () => {
    const lms = fakeLms([]);
    const studio = createLmStudio({ run: lms.run });
    const both = Promise.all([studio.ensure(QWEN), studio.ensure(QWEN)]);

    lms.release();
    await both;

    expect(lms.calls.filter(([command]) => command === "load")).toHaveLength(1);
  });

  it("lets the next turn try again after a load fails", async () => {
    let fail = true;
    const studio = createLmStudio({
      run: (args) => {
        if (args[0] === "load" && fail) {
          fail = false;
          return Promise.reject(new Error("out of memory"));
        }

        return Promise.resolve(args[0] === "ps" ? "[]" : "");
      },
    });

    await expect(studio.ensure(QWEN)).rejects.toThrow("out of memory");
    await expect(studio.ensure(QWEN)).resolves.toBeUndefined();
  });
});

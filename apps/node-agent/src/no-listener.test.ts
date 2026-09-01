import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Section 10: "Workers expose no shell, Ollama, browser-control, file-search, or
 * desktop-control listener."
 *
 * Asserted as a property of the shipped source rather than left to a port scan
 * of one deployment, because a port scan proves something about the machine it
 * ran on and this proves something about the agent. The node dials the core; the
 * core never dials the node, so there is nothing for the agent to listen on.
 *
 * Test files are excluded: the fake-core harness in `agent.integration.test.ts`
 * does listen, and it is not part of the agent.
 */
const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ["an HTTP or net server", /\bcreateServer\b/],
  ["a WebSocket server", /\bWebSocketServer\b/],
  ["a socket listener", /\.listen\s*\(/],
  ["a raw TCP or IPC server", /\bnet\.Server\b|\bnew\s+Server\b/],
  ["a datagram socket", /\bdgram\b/],
  ["a child process", /\bchild_process\b|\bspawn\s*\(|\bexecFile\s*\(/],
];

function shippedSources(): Array<{ file: string; source: string }> {
  return readdirSync(import.meta.dirname)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({
      file: name,
      source: readFileSync(join(import.meta.dirname, name), "utf8"),
    }));
}

describe("the node agent opens no listener", () => {
  it("ships more than one source file, so an empty scan cannot pass", () => {
    expect(shippedSources().length).toBeGreaterThan(2);
  });

  it.each(FORBIDDEN)("contains no %s", (_label, pattern) => {
    for (const { file, source } of shippedSources()) {
      expect(pattern.test(source), `${file} matches ${pattern.source}`).toBe(false);
    }
  });

  it("uses ws only as a client", () => {
    for (const { file, source } of shippedSources()) {
      const imports = [...source.matchAll(/import\s+\{([^}]*)\}\s+from\s+"ws"/g)];

      for (const [, named] of imports) {
        expect(
          (named ?? "")
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry !== ""),
          `${file} imports something other than the ws client`,
        ).toEqual(["WebSocket"]);
      }
    }
  });
});

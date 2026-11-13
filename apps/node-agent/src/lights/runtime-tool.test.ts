import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createClaudeRuntime } from "../runtimes/claude.js";
import { identityCard } from "../runtimes/identity.js";

const homes: string[] = [];

function config(agents?: boolean): NodeJS.ProcessEnv & { NOCTIS_NODE_HOME: string } {
  const home = mkdtempSync(join(tmpdir(), "noctis-lights-runtime-"));
  homes.push(home);
  if (agents !== undefined) {
    writeFileSync(
      join(home, "lights.json"),
      JSON.stringify({ agents, lights: [{ name: "desk", kind: "tapo", host: "127.0.0.1" }] }),
    );
  }
  return { NOCTIS_NODE_HOME: home };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("lights tools in agent runtimes", () => {
  it.each([true, false, undefined])(
    "Claude registers lights only with agents=true (%s)",
    async (agents) => {
      const env = config(agents);
      const client = new Client({ name: "lights-test", version: "0" });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const runtime = createClaudeRuntime({
        query: ({ options }) =>
          (async function* () {
            const server = options?.mcpServers?.noctis;
            if (server === undefined || server.type !== "sdk") throw new Error("no SDK server");
            await server.instance.connect(serverSide);
            await client.connect(clientSide);
            const listed = (await client.listTools()).tools;
            expect(listed.some(({ name }) => name === "noctis_lights")).toBe(agents === true);
            if (agents === true) {
              expect(
                listed.find(({ name }) => name === "noctis_lights")?.inputSchema,
              ).toMatchObject({
                properties: {
                  scene: expect.any(Object) as unknown,
                  changes: expect.any(Object) as unknown,
                },
              });
              const reply = await client.callTool({
                name: "noctis_lights",
                arguments: { scene: "missing" },
              });
              expect(reply.isError).toBe(true);
              const extra = await client.callTool({
                name: "noctis_lights",
                arguments: { scene: "missing", unexpected: true },
              });
              expect(extra.isError).toBe(true);
              expect(JSON.stringify(extra.content)).toMatch(/expected|unrecognized/i);
              for (const arguments_ of [
                { scene: "missing", changes: [{ light: "desk", on: true }] },
                { changes: [{ light: "desk", brightness: 0 }] },
              ]) {
                expect(
                  (await client.callTool({ name: "noctis_lights", arguments: arguments_ })).isError,
                ).toBe(true);
              }
            }
            yield {
              type: "result",
              subtype: "success",
              is_error: false,
              result: "ok",
              num_turns: 1,
              usage: { input_tokens: 0, output_tokens: 0 },
              permission_denials: [],
              session_id: "lights-test",
            } as unknown as SDKMessage;
          })(),
      });
      try {
        await runtime.turn(
          {
            env,
            signal: new AbortController().signal,
            roots: { cwd: env.NOCTIS_NODE_HOME, writable: [], readable: [], localOnly: false },
            payload: {
              threadId: "0199a000-0000-7000-8000-0000000000e1",
              identityId: "vesper",
              model: { providerId: "claude", model: "sonnet" },
              userMessageId: "0199a000-0000-7000-8000-0000000000e2",
              prompt: "hello",
              primaryRootGrantId: "w",
              objectiveActive: false,
            },
          },
          {
            item: () => undefined,
            delta: () => undefined,
            ask: () => Promise.reject(new Error("unexpected approval")),
            delegate: () => Promise.reject(new Error("unexpected delegation")),
            upload: () => Promise.reject(new Error("unexpected upload")),
          },
        );
      } finally {
        await client.close();
        await runtime.close?.();
      }
    },
  );

  it.each([true, false, undefined])(
    "stdio registers lights only with agents=true (%s)",
    async (agents) => {
      const env = config(agents);
      vi.stubEnv("NOCTIS_NODE_HOME", env.NOCTIS_NODE_HOME);
      const originalArgs = process.argv;
      process.argv = [
        process.execPath,
        "noctis-mcp",
        "--proposals",
        join(env.NOCTIS_NODE_HOME, "proposals.jsonl"),
      ];
      const register = vi.spyOn(McpServer.prototype, "registerTool");
      vi.spyOn(McpServer.prototype, "connect").mockResolvedValue(undefined);
      try {
        vi.resetModules();
        await import("../noctis-mcp.js");
        expect(register.mock.calls.some((call) => call[0] === "noctis_lights")).toBe(
          agents === true,
        );
      } finally {
        process.argv = originalArgs;
        vi.unstubAllEnvs();
      }
    },
  );

  it.each(["claude", "codex", "hermes", "local"] as const)(
    "%s identity mentions lights only when its tool is available",
    (runtime) => {
      for (const agents of [true, false, undefined]) {
        const card = identityCard({
          identityId: "vesper",
          runtime,
          model: "model",
          env: config(agents),
        });
        expect(card?.includes("noctis_lights")).toBe(
          agents === true && (runtime === "claude" || runtime === "codex"),
        );
      }
    },
  );
});

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { z } from "zod";

/**
 * LM Studio driven through its own CLI, so the GPU stays free until a turn
 * needs the model (owner, 2026-10-08). The node offers what is on disk without
 * loading anything; the first local or Hermes turn starts the server on
 * loopback and loads the model at the context Hermes needs, and LM Studio
 * unloads it again once it has sat idle.
 */
export interface ModelHost {
  /** The chat models on disk, offered while nothing is loaded. */
  downloaded(): Promise<string[]>;
  /** The server up on loopback and the model loaded, before a turn asks it anything. */
  ensure(model: string): Promise<void>;
}

export interface LmStudioOptions {
  /** Runs `lms` with these arguments and gives back its stdout; rejects when it fails. */
  run?: (args: readonly string[]) => Promise<string>;
  lms?: string;
}

/** What Hermes needs to plan with tools; the plain local runtime shares the one load. */
const CONTEXT_LENGTH = 65_536;
/** Idle seconds before LM Studio unloads the model and the VRAM is free again. */
const IDLE_UNLOAD_SECONDS = 600;
/** A cold load from disk took 4.5 minutes once (scope doc 8.4). */
const LOAD_TIMEOUT_MS = 10 * 60_000;
const COMMAND_TIMEOUT_MS = 60_000;

const ListedSchema = z.array(
  z
    .object({
      type: z.string(),
      modelKey: z.string(),
      identifier: z.string().optional(),
      contextLength: z.number().optional(),
    })
    .loose(),
);

/** `lms.exe` where LM Studio's installer puts it, if it is there. */
export function resolveLms(env: NodeJS.ProcessEnv): string | undefined {
  const lms =
    env.USERPROFILE === undefined
      ? undefined
      : join(env.USERPROFILE, ".lmstudio", "bin", "lms.exe");

  return lms !== undefined && existsSync(lms) ? lms : undefined;
}

export function createLmStudio(options: LmStudioOptions): ModelHost {
  const exec = promisify(execFile);
  const run =
    options.run ??
    (async (args: readonly string[]) => {
      const { stdout } = await exec(options.lms ?? "lms", [...args], {
        timeout: args[0] === "load" ? LOAD_TIMEOUT_MS : COMMAND_TIMEOUT_MS,
        windowsHide: true,
      });

      return stdout;
    });
  /** One ensure at a time: two turns arriving together load the model once. */
  let queue: Promise<unknown> = Promise.resolve();

  async function ready(model: string): Promise<void> {
    await run(["daemon", "up"]);
    await run(["server", "start", "--port", "1234", "--bind", "127.0.0.1"]);

    const loaded = ListedSchema.parse(JSON.parse(await run(["ps", "--json"]))).filter(
      (listed) => listed.modelKey === model,
    );

    if (loaded.some((listed) => (listed.contextLength ?? 0) >= CONTEXT_LENGTH)) {
      return;
    }

    // Loaded too small for Hermes (LM Studio's own on-demand load): make room first.
    for (const listed of loaded) {
      await run(["unload", listed.identifier ?? listed.modelKey]);
    }

    await run([
      "load",
      model,
      "--context-length",
      String(CONTEXT_LENGTH),
      "--gpu",
      "max",
      "--ttl",
      String(IDLE_UNLOAD_SECONDS),
      "--yes",
    ]);
  }

  return {
    async downloaded() {
      await run(["daemon", "up"]);

      return ListedSchema.parse(JSON.parse(await run(["ls", "--llm", "--json"])))
        .filter((listed) => listed.type === "llm" && !/embed/i.test(listed.modelKey))
        .map((listed) => listed.modelKey);
    },
    ensure(model) {
      const next = queue.then(
        () => ready(model),
        () => ready(model),
      );

      queue = next.catch(() => undefined);

      return next;
    },
  };
}

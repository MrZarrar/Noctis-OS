import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type { CapabilityGrant } from "@noctis/contracts";
import {
  HealthDecidePayloadSchema,
  HealthGrantConstraintsSchema,
  HealthReportPayloadSchema,
  HealthRunPayloadSchema,
  MAX_HEALTH_REPORT_BYTES,
} from "@noctis/contracts";

import type { Adapter, AdapterContext } from "../adapters.js";
import { AdapterRefused } from "../runtimes/Runtime.js";
import { childEnvironment } from "../runtimes/env.js";
import { killProcessTree } from "../runtimes/kill-tree.js";

/**
 * glycolens on this PC (Plan 2). Noctis never imports glycolens: it runs the
 * CLI with the venv's python (Smart App Control can block glycolens.exe) and
 * reads the report it writes. Every job sends report.json afterwards, because
 * that is the only way the core learns what a run or a decision changed.
 */

type HealthCapability = "health.report" | "health.run" | "health.decide";

export interface HealthOptions {
  /** How glycolens starts. Tests swap in a fake. */
  command?: (repo: string) => { command: string; args: string[] };
  runTimeoutMs?: number;
}

const HEARTBEAT_MS = 10_000;
const DECIDE_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 15 * 60_000;

const venvPython = (repo: string) => ({
  command: join(repo, ".venv", "Scripts", "python.exe"),
  args: ["-m", "glycolens.cli"],
});

function folders(grants: readonly CapabilityGrant[], capability: HealthCapability) {
  const grant = grants.find((g) => g.capability === capability && g.revokedAt === undefined);
  if (grant === undefined) throw new AdapterRefused(`no ${capability} grant`);
  const parsed = HealthGrantConstraintsSchema.safeParse(grant.constraints);
  if (!parsed.success)
    throw new AdapterRefused(`the ${capability} grant names no glycolens folder`);
  return parsed.data;
}

interface Exit {
  code: number | null;
  stdout: string;
  stderr: string;
}

function exec(
  start: { command: string; args: string[] },
  cwd: string,
  context: AdapterContext,
  timeoutMs: number,
): Promise<Exit> {
  return new Promise((resolve, reject) => {
    const child = spawn(start.command, start.args, {
      cwd,
      env: childEnvironment(context.env),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    const stop = (): void => void killProcessTree(child);
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    // The core renews the lease on every frame; a run takes minutes.
    const heartbeat = setInterval(() => context.progress(0, "glycolens running"), HEARTBEAT_MS);
    context.signal.addEventListener("abort", stop, { once: true });
    const done = (): void => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      context.signal.removeEventListener("abort", stop);
    };
    child.once("error", (error) => {
      done();
      reject(new AdapterRefused(`could not start glycolens: ${error.message}`));
    });
    child.once("close", (code) => {
      done();
      if (timedOut)
        reject(new AdapterRefused(`glycolens timed out after ${Math.round(timeoutMs / 1000)} s`));
      else if (context.signal.aborted) reject(new AdapterRefused("job was cancelled"));
      else
        resolve({
          code,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        });
    });
  });
}

const lastLine = (text: string): string | undefined =>
  text.trim().split(/\r?\n/).at(-1)?.slice(0, 300) || undefined;

/** glycolens's exits (pipeline.run): 0 written, maybe from stored data; 1 no data at all. */
export function runOutcome(
  code: number | null,
  stderr: string,
): { outcome: "written" | "stale" | "no_data" | "no_login"; reason?: string } {
  const reason = lastLine(stderr);
  const login = stderr.includes("no Tandem Source login saved");
  if (code === 0) {
    if (login) return { outcome: "no_login", ...(reason === undefined ? {} : { reason }) };
    return reason === undefined ? { outcome: "written" } : { outcome: "stale", reason };
  }
  if (code === 1 && stderr.includes("glycolens: no data yet")) {
    return { outcome: login ? "no_login" : "no_data", ...(reason === undefined ? {} : { reason }) };
  }
  throw new AdapterRefused(`glycolens exited ${String(code)}: ${reason ?? "no output"}`);
}

/** report.json read whole and closed at once: os.replace on Windows fails while a reader holds it. */
async function sendReport(
  home: string | undefined,
  context: AdapterContext,
): Promise<"sent" | "missing" | "too_large"> {
  const path = join(home ?? join(homedir(), ".glycolens"), "report.json");
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
  if (bytes.length > MAX_HEALTH_REPORT_BYTES) return "too_large";
  await context.streamFile({
    sizeBytes: bytes.length,
    offset: 0,
    length: bytes.length,
    body: Readable.from([bytes]),
  });
  return "sent";
}

export function createHealthAdapters(
  options: HealthOptions = {},
): Record<HealthCapability, Adapter> {
  const start = options.command ?? venvPython;
  // One glycolens at a time on this PC: a decision rewrites report.json, and so does a run.
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  };
  const cli = (repo: string, args: string[]) => {
    const base = start(repo);
    return { command: base.command, args: [...base.args, ...args] };
  };

  return {
    "health.report": async (payload, context) => {
      HealthReportPayloadSchema.parse(payload);
      const { home } = folders(context.grants, "health.report");
      return serial(async () => ({ report: await sendReport(home, context) }));
    },
    "health.run": async (payload, context) => {
      HealthRunPayloadSchema.parse(payload);
      const { repo, home } = folders(context.grants, "health.run");
      return serial(async () => {
        const exit = await exec(
          cli(repo, ["run"]),
          repo,
          context,
          options.runTimeoutMs ?? RUN_TIMEOUT_MS,
        );
        const outcome = runOutcome(exit.code, exit.stderr);
        return { ...outcome, report: await sendReport(home, context) };
      });
    },
    "health.decide": async (payload, context) => {
      const request = HealthDecidePayloadSchema.parse(payload);
      const { repo, home } = folders(context.grants, "health.decide");
      return serial(async () => {
        const exit = await exec(
          cli(repo, [request.action, request.id]),
          repo,
          context,
          DECIDE_TIMEOUT_MS,
        );
        const result =
          exit.code === 2
            ? "unknown_id"
            : exit.code === 0
              ? exit.stdout.startsWith("already")
                ? "already"
                : "changed"
              : undefined;
        if (result === undefined)
          throw new AdapterRefused(
            `glycolens exited ${String(exit.code)}: ${lastLine(exit.stderr) ?? "no output"}`,
          );
        return { result, report: await sendReport(home, context) };
      });
    },
  };
}

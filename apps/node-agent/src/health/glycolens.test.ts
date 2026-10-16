import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";

import type { CapabilityGrant } from "@noctis/contracts";
import { HealthDecideEvidenceSchema, HealthRunEvidenceSchema } from "@noctis/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { AdapterContext } from "../adapters.js";
import { createHealthAdapters, runOutcome } from "./glycolens.js";

/** glycolens's behaviour, by MODE: what each real exit looks like (pipeline.py, cli.py). */
const FAKE = `
import { appendFileSync, writeFileSync } from "node:fs";
const [cmd, id] = process.argv.slice(2);
const home = process.env.FAKE_HOME, mode = process.env.FAKE_MODE ?? "ok";
appendFileSync(home + "/log", cmd + ":start\\n");
const done = (code) => { appendFileSync(home + "/log", cmd + ":end\\n"); process.exit(code); };
if (cmd === "run") {
  if (mode === "hang") setInterval(() => {}, 1000);
  else setTimeout(() => {
    if (mode === "no_data") { process.stderr.write("glycolens: no data yet (nothing fetched)\\n"); done(1); }
    if (mode === "no_login") process.stderr.write("glycolens: fetch failed, using stored data: RuntimeError: no Tandem Source login saved: run \`glycolens login\` first\\n");
    if (mode === "stale") process.stderr.write("glycolens: fetch failed, using stored data: HTTPError: 503\\n");
    writeFileSync(home + "/report.json", JSON.stringify({ schema_version: 1, glucose: "Ä" }));
    done(0);
  }, Number(process.env.FAKE_DELAY ?? 0));
} else {
  if (id === "missing") { process.stdout.write("glycolens: no suggestion with id 'missing'\\n"); done(2); }
  process.stdout.write(mode === "already" ? "already applied\\n" : id + ": proposed → applied\\n");
  done(0);
}
`;

let scratch: string | undefined;
afterEach(() => {
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

function setup(env: Record<string, string> = {}) {
  scratch = mkdtempSync(join(tmpdir(), "noctis-health-"));
  const script = join(scratch, "fake-glycolens.mjs");
  writeFileSync(script, FAKE);
  const grants: CapabilityGrant[] = (["health.report", "health.run", "health.decide"] as const).map(
    (capability, i) => ({
      id: `0199a000-0000-7000-8000-00000000010${i}`,
      nodeId: "0199a000-0000-7000-8000-0000000000aa",
      capability,
      operationClass: capability === "health.report" ? "read_inspect" : "local_reversible_edit",
      constraintsVersion: 1,
      constraints: { repo: scratch!, home: scratch! },
      grantedAt: "2026-10-16T12:00:00.000Z",
    }),
  );
  const sent: string[] = [];
  const context = (signal = new AbortController().signal): AdapterContext => ({
    grants,
    signal,
    progress: () => undefined,
    stream: () => undefined,
    delta: () => undefined,
    ask: () => Promise.reject(new Error("no ask")),
    env: { ...process.env, FAKE_HOME: scratch!, ...env },
    runtimes: {},
    fetchAttachment: () => Promise.reject(new Error("no attachment")),
    delegate: () => Promise.reject(new Error("no delegation")),
    uploadOutput: () => Promise.reject(new Error("no output")),
    async streamFile(file) {
      sent.push(await text(file.body));
    },
    streamScreen: () => Promise.reject(new Error("no screen")),
  });
  const adapters = createHealthAdapters({
    command: () => ({ command: process.execPath, args: [script] }),
    runTimeoutMs: 1_000,
  });
  return { adapters, context, sent, home: scratch };
}

describe("health adapters", () => {
  it("runs glycolens, decodes UTF-8 and streams the report it wrote", async () => {
    const { adapters, context, sent } = setup();
    const evidence = HealthRunEvidenceSchema.parse(await adapters["health.run"]({}, context()));
    expect(evidence).toEqual({ outcome: "written", report: "sent" });
    expect(JSON.parse(sent[0]!)).toEqual({ schema_version: 1, glucose: "Ä" });
  });

  it("names a missing login and a stale fetch, and still sends the report", async () => {
    const login = setup({ FAKE_MODE: "no_login" });
    expect(
      HealthRunEvidenceSchema.parse(await login.adapters["health.run"]({}, login.context())),
    ).toMatchObject({ outcome: "no_login", report: "sent" });
    const stale = setup({ FAKE_MODE: "stale" });
    const evidence = HealthRunEvidenceSchema.parse(
      await stale.adapters["health.run"]({}, stale.context()),
    );
    expect(evidence.outcome).toBe("stale");
    expect(evidence.reason).toContain("503");
  });

  it("reports no data without a report", async () => {
    const { adapters, context } = setup({ FAKE_MODE: "no_data" });
    expect(await adapters["health.run"]({}, context())).toEqual({
      outcome: "no_data",
      reason: "glycolens: no data yet (nothing fetched)",
      report: "missing",
    });
  });

  it("kills a run that outlives its timeout", async () => {
    const { adapters, context } = setup({ FAKE_MODE: "hang" });
    await expect(adapters["health.run"]({}, context())).rejects.toThrow(/timed out/);
  }, 15_000);

  it("maps decisions, including an unknown id on stdout with exit 2", async () => {
    const { adapters, context } = setup();
    expect(
      HealthDecideEvidenceSchema.parse(
        await adapters["health.decide"]({ id: "2026-W41-x", action: "mark-applied" }, context()),
      ),
    ).toMatchObject({ result: "changed" });
    expect(
      await adapters["health.decide"]({ id: "missing", action: "dismiss" }, context()),
    ).toMatchObject({ result: "unknown_id" });
    const already = setup({ FAKE_MODE: "already" });
    expect(
      await already.adapters["health.decide"](
        { id: "x", action: "mark-applied" },
        already.context(),
      ),
    ).toMatchObject({ result: "already" });
  });

  it("never starts a decision while a run is going", async () => {
    const { adapters, context, home } = setup({ FAKE_DELAY: "300" });
    await Promise.all([
      adapters["health.run"]({}, context()),
      adapters["health.decide"]({ id: "x", action: "dismiss" }, context()),
    ]);
    expect(readFileSync(join(home, "log"), "utf8").trim().split("\n")).toEqual([
      "run:start",
      "run:end",
      "dismiss:start",
      "dismiss:end",
    ]);
  });

  it("refuses without a grant and refuses a payload naming an option", async () => {
    const { adapters, context } = setup();
    await expect(
      adapters["health.decide"]({ id: "--help", action: "dismiss" }, context()),
    ).rejects.toThrow();
    await expect(adapters["health.report"]({}, { ...context(), grants: [] })).rejects.toThrow(
      /no health.report grant/,
    );
  });

  it("reads report.json whole for health.report", async () => {
    const { adapters, context, sent, home } = setup();
    expect(await adapters["health.report"]({}, context())).toEqual({ report: "missing" });
    writeFileSync(join(home, "report.json"), "{}");
    expect(await adapters["health.report"]({}, context())).toEqual({ report: "sent" });
    expect(sent).toEqual(["{}"]);
  });
});

describe("runOutcome", () => {
  it("throws for an exit it does not recognise", () => {
    expect(() => runOutcome(1, "Traceback ...\nValueError: boom")).toThrow(
      /exited 1: ValueError: boom/,
    );
  });
});

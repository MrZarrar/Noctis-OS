import { fixedClock } from "@noctis/domain";
import { describe, expect, it } from "vitest";

import { REDACTED, createLogger, redact } from "./logging.js";

const CLOCK = fixedClock(Date.parse("2026-09-01T12:00:00.000Z"));

function collect(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];

  return { lines, sink: (line) => lines.push(line) };
}

describe("redact", () => {
  it.each([
    "token",
    "coreToken",
    "NOCTIS_CORE_TOKEN",
    "authorization",
    "apiKey",
    "api_key",
    "clientSecret",
    "password",
    "passphrase",
    "recoveryKey",
    "credentialPath",
    "cookie",
    "prompt",
  ])("removes the value under a %s field", (key) => {
    expect(redact({ [key]: "s3cret" })).toEqual({ [key]: REDACTED });
  });

  it("removes sensitive values nested inside objects and arrays", () => {
    expect(redact({ request: { headers: [{ authorization: "Bearer x" }] } })).toEqual({
      request: { headers: [{ authorization: REDACTED }] },
    });
  });

  it("truncates an unbounded string rather than writing it whole", () => {
    const line = redact({ summary: "x".repeat(2000) }) as { summary: string };

    expect(line.summary.length).toBeLessThan(600);
    expect(line.summary).toContain("truncated");
  });

  it("stops descending before an attacker-supplied structure can be unbounded", () => {
    expect(redact({ a: { b: { c: { d: { e: "deep" } } } } })).toEqual({
      a: { b: { c: { d: "[truncated]" } } },
    });
  });

  it("leaves ordinary values alone", () => {
    expect(redact({ status: 200, ok: true, id: "abc", missing: null })).toEqual({
      status: 200,
      ok: true,
      id: "abc",
      missing: null,
    });
  });
});

describe("createLogger", () => {
  it("writes one JSON object per line with the injected time", () => {
    const { lines, sink } = collect();

    createLogger({ sink, clock: CLOCK }).log("info", "started", { port: 7717 });

    expect(JSON.parse(lines[0] ?? "")).toEqual({
      at: "2026-09-01T12:00:00.000Z",
      level: "info",
      message: "started",
      port: 7717,
    });
  });

  it("suppresses entries below the configured level", () => {
    const { lines, sink } = collect();
    const logger = createLogger({ sink, clock: CLOCK, level: "warn" });

    logger.log("debug", "noise");
    logger.log("info", "noise");
    logger.log("warn", "kept");
    logger.log("error", "kept");

    expect(lines).toHaveLength(2);
  });

  it("carries child fields onto every entry and still redacts them", () => {
    const { lines, sink } = collect();

    createLogger({ sink, clock: CLOCK })
      .child({ correlationId: "c1", token: "leak" })
      .log("info", "handled");

    expect(JSON.parse(lines[0] ?? "")).toMatchObject({ correlationId: "c1", token: REDACTED });
  });
});

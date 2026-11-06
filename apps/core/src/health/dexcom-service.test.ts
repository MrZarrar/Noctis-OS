import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { createDexcomService } from "./dexcom-service.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

function harness(start = "2026-11-06T10:00:00.000Z") {
  let now = Date.parse(start);
  const db = openDatabase(":memory:");
  migrate(db, { directory: "apps/core/migrations", clock: { now: () => now } });
  const calls: string[] = [];
  let nextReading: { mmol: number; trend: "flat"; at: string } | { error: string } = {
    mmol: 6.5,
    trend: "flat",
    at: new Date(now).toISOString(),
  };
  const service = createDexcomService({
    db,
    databasePath: ":memory:",
    clock: { now: () => now },
    fetchLatestReading: () => {
      calls.push("fetch");
      return "error" in nextReading
        ? Promise.reject(new Error(nextReading.error))
        : Promise.resolve(nextReading);
    },
  });
  return {
    service,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
    setNextReading: (reading: typeof nextReading) => {
      nextReading = reading;
    },
  };
}

describe("createDexcomService", () => {
  it("is not_configured before any credentials are set", () => {
    const { service } = harness();
    expect(service.live()).toEqual({ state: "not_configured" });
  });

  it("pass() is a no-op without credentials", () => {
    const { service, calls } = harness();
    service.pass();
    expect(calls).toEqual([]);
  });

  it("polls once credentials are set, then goes ok", async () => {
    const { service, calls } = harness();
    await service.setCredentials({ username: "u", password: "p" });
    expect(calls).toEqual(["fetch"]);
    expect(service.live()).toEqual({
      state: "ok",
      mmol: 6.5,
      trend: "flat",
      at: "2026-11-06T10:00:00.000Z",
    });
  });

  it("does not poll again before 5 minutes have passed", async () => {
    const { service, calls, advance } = harness();
    await service.setCredentials({ username: "u", password: "p" });
    advance(60_000);
    service.pass();
    expect(calls).toEqual(["fetch"]);
  });

  it("polls again once 5 minutes have passed", async () => {
    const { service, calls, advance } = harness();
    await service.setCredentials({ username: "u", password: "p" });
    advance(5 * 60_000 + 1);
    service.pass();
    expect(calls).toEqual(["fetch", "fetch"]);
  });

  it("reports stale once the cached reading is older than 15 minutes", async () => {
    const { service, advance } = harness();
    await service.setCredentials({ username: "u", password: "p" });
    advance(16 * 60_000);
    expect(service.live()).toMatchObject({ state: "stale" });
  });

  it("surfaces the Dexcom error from setCredentials for a bad login", async () => {
    const { service, setNextReading } = harness();
    setNextReading({ error: "Password not valid." });
    await expect(
      service.setCredentials({ username: "u", password: "wrong" }),
    ).rejects.toThrow("Password not valid.");
    expect(service.live()).toEqual({ state: "not_configured" });
  });

  it("clears credentials back to not_configured", async () => {
    const { service } = harness();
    await service.setCredentials({ username: "u", password: "p" });
    service.clearCredentials();
    expect(service.live()).toEqual({ state: "not_configured" });
  });

  it("keeps the last good reading as error after a later poll fails", async () => {
    const { service, advance, setNextReading } = harness();
    await service.setCredentials({ username: "u", password: "p" });
    setNextReading({ error: "network down" });
    advance(5 * 60_000 + 1);
    service.pass();
    // pass() is fire-and-forget, matching the repo's other .pass() sweeps; let the failed fetch's catch run.
    await Promise.resolve();
    await Promise.resolve();
    expect(service.live()).toMatchObject({ state: "stale" });
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { startCore, type RunningCore } from "../server.js";
import { createReminder, getReminder } from "./service.js";

const running: RunningCore[] = [];
afterEach(async () => {
  for (const core of running.splice(0)) await core.close();
});
describe("core productivity scheduler wiring", () => {
  it("fires with the injected clock and exposes API state without enabling agent runs", async () => {
    let now = Date.parse("2026-10-14T10:00:00Z");
    const core = await startCore({
      config: {
        bindAddress: "127.0.0.1",
        port: 0,
        token: "0".repeat(32),
        databasePath: ":memory:",
        allowedOrigins: [],
        logLevel: "error",
        sessionTtlHours: 720,
      },
      clock: { now: () => now },
      env: {},
      dispatchIntervalMs: 3_600_000,
      productivityIntervalMs: 3_600_000,
    });
    running.push(core);
    const reminder = createReminder(
      core.kernel,
      { correlationId: core.kernel.ids.nextId(), actorType: "user", actorId: "owner" },
      {
        idempotencyKey: "timer",
        identityId: "vesper",
        text: "API catch up",
        trigger: { kind: "at", at: "2026-10-14T10:01:00.000Z" },
      },
    );
    expect(reminder.ok).toBe(true);
    if (!reminder.ok) return;
    now += 60_000;
    expect(core.productivity).toBeDefined();
    core.productivity.pass();
    expect(getReminder(core.kernel.db, reminder.value.id)?.status).toBe("due");
    const response = await fetch(`http://127.0.0.1:${core.port}/reminders?status=due`, {
      headers: { authorization: `Bearer ${"0".repeat(32)}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      reminders: [{ text: "API catch up", status: "due" }],
    });
  });
});

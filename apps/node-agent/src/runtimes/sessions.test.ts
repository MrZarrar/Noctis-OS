import { expect, it } from "vitest";

import { createProcessPool, processKey } from "./sessions.js";
import type { RuntimeTurnPayload } from "@noctis/contracts";

it("reopens a session when reasoning effort changes", () => {
  const payload = {
    model: { providerId: "claude", model: "sonnet", effort: "low" },
  } as RuntimeTurnPayload;
  const roots = { cwd: "C:\\work", writable: [], readable: [], localOnly: false };
  expect(processKey(payload, roots)).not.toBe(
    processKey({ ...payload, model: { ...payload.model, effort: "high" } }, roots),
  );
});

it("does not spawn a pending first process after closeAll", async () => {
  const pool = createProcessPool();
  let opened = false;
  const run = pool
    .run(
      "thread",
      { key: "first", sessionRef: undefined },
      () => {
        opened = true;
        return { key: "first", sessionRef: undefined, alive: true, close: () => undefined };
      },
      () => Promise.resolve(),
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  await pool.closeAll();
  expect(await run).toBeInstanceOf(Error);
  expect(opened).toBe(false);
});

it("waits for exit on closeAll and prevents a queued replacement from spawning", async () => {
  const pool = createProcessPool();
  let release = (): void => undefined;
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let alive = true;
  const first = {
    key: "first",
    sessionRef: "session",
    get alive() {
      return alive;
    },
    close: () => {
      alive = false;
      return closed;
    },
  };
  await pool.run(
    "thread",
    { key: "first", sessionRef: "session" },
    () => first,
    () => Promise.resolve(),
  );
  let opened = false;
  const next = pool
    .run(
      "thread",
      { key: "second", sessionRef: "session" },
      () => {
        opened = true;
        return { ...first, key: "second", alive: true, close: () => Promise.resolve() };
      },
      () => Promise.resolve(),
    )
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  await new Promise((resolve) => setImmediate(resolve));
  let allClosed = false;
  const shutdown = pool.closeAll().then(() => {
    allClosed = true;
  });
  await Promise.resolve();
  expect(opened).toBe(false);
  expect(allClosed).toBe(false);
  release();
  await shutdown;
  expect(await next).toBeInstanceOf(Error);
  expect(opened).toBe(false);
  await pool.closeAll();
});

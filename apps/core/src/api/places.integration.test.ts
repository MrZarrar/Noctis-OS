import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { createLogger } from "../logging.js";
import { startCore, type RunningCore } from "../server.js";

const token = "0123456789abcdef0123456789abcdef";
let core: RunningCore | undefined;
let directory: string;

afterEach(async () => {
  await core?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

it("records arrivals from the phone's link and shows them to the owner", async () => {
  directory = mkdtempSync(join(tmpdir(), "noctis-places-"));
  core = await startCore({
    config: {
      bindAddress: "127.0.0.1",
      port: 0,
      token,
      databasePath: join(directory, "core.db"),
      allowedOrigins: [],
      logLevel: "error",
      sessionTtlHours: 720,
    },
    env: {},
    logger: createLogger({ sink: () => undefined }),
  });
  const base = `http://127.0.0.1:${core.port}`;
  const hoursAgo = (hours: number) =>
    new Date(Math.floor(Date.now() / 1000) * 1000 - hours * 3_600_000);
  const arrive = hoursAgo(5);
  const leave = new Date(arrive.getTime() + 90 * 60_000);
  // The phone's own format: local time with an offset.
  const local = (at: Date) =>
    `${new Date(at.getTime() + 3_600_000).toISOString().slice(0, 19)}+01:00`;
  const owner = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const phone = (link: string, body: unknown) =>
    fetch(`${base}/places/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${link}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  expect((await fetch(`${base}/places/link`)).status).toBe(401);
  const { token: link } = (await (
    await fetch(`${base}/places/link`, { headers: owner })
  ).json()) as {
    token: string;
  };

  // The core token is the owner's, not the phone's: it does not open this door.
  expect((await phone(token, { place: "gym", transition: "arrive" })).status).toBe(401);
  expect((await phone(link, { place: "gym", transition: "arrive" })).status).toBe(404);

  await fetch(`${base}/commands/settings.set`, {
    method: "POST",
    headers: owner,
    body: JSON.stringify({ idempotencyKey: "places", key: "places", value: ["home", "gym"] }),
  });

  expect((await phone(link, { place: "gym", transition: "dance" })).status).toBe(400);
  const arrived = await phone(link, {
    place: "Gym",
    transition: "arrive",
    at: local(arrive),
  });
  expect(arrived.status).toBe(200);
  expect((await phone(link, { place: "gym", transition: "leave", at: local(leave) })).status).toBe(
    200,
  );

  const view = (await (await fetch(`${base}/places`, { headers: owner })).json()) as {
    events: unknown[];
    visits: unknown[];
  };
  expect(view.events).toHaveLength(2);
  expect(view.visits).toEqual([
    { place: "gym", start: arrive.toISOString(), end: leave.toISOString(), minutes: 90 },
  ]);

  const rotated = await fetch(`${base}/places/link`, { method: "POST", headers: owner });
  expect(rotated.status).toBe(200);
  expect((await phone(link, { place: "gym", transition: "arrive" })).status).toBe(401);
});

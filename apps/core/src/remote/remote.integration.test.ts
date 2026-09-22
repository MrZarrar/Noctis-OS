import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RemoteDesktopSessionSchema } from "@noctis/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { LOGIN_PATH } from "../api/http.js";
import type { CoreConfig } from "../config/server.js";
import { createLogger } from "../logging.js";
import type { RunningCore } from "../server.js";
import { startCore } from "../server.js";

import { GATEWAY_TOKEN_LIFETIME_SECONDS } from "./gateway-token.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const REMOTE: NonNullable<CoreConfig["remoteDesktop"]> = {
  privateKey,
  targets: [
    {
      host: "zarrarpc",
      gatewayUrl: "wss://zarrarpc.tail9594ed.ts.net/jet/rdp",
      destination: "zarrarpc.tail9594ed.ts.net:3389",
    },
  ],
};

interface TestCore {
  core: RunningCore;
  base: string;
  logs: string[];
}

const started: Array<{ core: RunningCore; directory: string }> = [];

async function startTestCore(remoteDesktop?: CoreConfig["remoteDesktop"]): Promise<TestCore> {
  const directory = mkdtempSync(join(tmpdir(), "noctis-remote-"));
  const logs: string[] = [];
  const core = await startCore({
    config: {
      bindAddress: "127.0.0.1",
      port: 0,
      token: TOKEN,
      databasePath: join(directory, "core.db"),
      allowedOrigins: [],
      // Debug, so a secret that reached any log line at any level is caught.
      logLevel: "debug",
      sessionTtlHours: 720,
      ...(remoteDesktop === undefined ? {} : { remoteDesktop }),
    },
    env: {},
    logger: createLogger({ sink: (line) => logs.push(line), level: "debug" }),
  });

  started.push({ core, directory });

  return { core, base: `http://127.0.0.1:${String(core.port)}`, logs };
}

afterEach(async () => {
  while (started.length > 0) {
    const entry = started.pop();

    if (entry !== undefined) {
      await entry.core.close();
      rmSync(entry.directory, { recursive: true, force: true });
    }
  }
});

/** The panel runs in a browser session, so that is the credential these tests use. */
async function session(core: TestCore): Promise<Record<string, string>> {
  const response = await fetch(`${core.base}${LOGIN_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN }),
  });
  const { csrf } = (await response.json()) as { csrf: string };

  return {
    cookie: (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
    "x-noctis-csrf": csrf,
    "content-type": "application/json",
  };
}

async function open(
  core: TestCore,
  body: unknown,
  headers: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await fetch(`${core.base}/commands/remote.open_session`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();

  return { status: response.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

function claims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as Record<
    string,
    unknown
  >;
}

function eventsOf(core: TestCore, type: string): Array<{ payload: unknown; actorType: string }> {
  return (
    core.core.kernel.db
      .prepare("SELECT payload_json, actor_type FROM orchestration_events WHERE type = ?")
      .all(type) as Array<{ payload_json: string; actor_type: string }>
  ).map((row) => ({ payload: JSON.parse(row.payload_json) as unknown, actorType: row.actor_type }));
}

describe("remote desktop session tokens (Task 3.9, ADR-0035)", () => {
  it("is off by default: no hosts, and nothing to open", async () => {
    const core = await startTestCore();
    const headers = await session(core);

    const hosts = await fetch(`${core.base}/remote/hosts`, { headers });
    expect(await hosts.json()).toEqual({ hosts: [] });

    const opened = await open(core, { idempotencyKey: "k1", host: "zarrarpc" }, headers);
    expect(opened.status).toBe(404);
  });

  it("lists the configured hosts by name and nothing a page could redirect", async () => {
    const core = await startTestCore(REMOTE);
    const hosts = await fetch(`${core.base}/remote/hosts`, { headers: await session(core) });

    expect(await hosts.json()).toEqual({ hosts: [{ host: "zarrarpc" }] });
  });

  it("mints a short-lived token the Gateway's key verifies, for the destination the core chose", async () => {
    const core = await startTestCore(REMOTE);
    const before = Math.floor(Date.now() / 1000);
    const opened = await open(
      core,
      { idempotencyKey: "k1", host: "zarrarpc" },
      await session(core),
    );

    expect(opened.status).toBe(200);
    const body = RemoteDesktopSessionSchema.parse(opened.body);
    const [header, payload, signature] = body.token.split(".");

    expect(
      verify(
        "sha256",
        Buffer.from(`${header ?? ""}.${payload ?? ""}`),
        publicKey,
        Buffer.from(signature ?? "", "base64url"),
      ),
    ).toBe(true);
    expect(body.gatewayUrl).toBe("wss://zarrarpc.tail9594ed.ts.net/jet/rdp");
    expect(body.destination).toBe("zarrarpc.tail9594ed.ts.net:3389");

    const jwt = claims(body.token);
    expect(jwt.dst_hst).toBe("zarrarpc.tail9594ed.ts.net:3389");
    expect(jwt.jet_aid).toBe(body.associationId);
    expect(jwt.exp as number).toBeLessThanOrEqual(before + GATEWAY_TOKEN_LIFETIME_SECONDS + 1);
  });

  it("records that a session was opened, and never the token that opens it", async () => {
    const core = await startTestCore(REMOTE);
    const opened = await open(
      core,
      { idempotencyKey: "k1", host: "zarrarpc" },
      await session(core),
    );
    const token = String(opened.body.token);
    const events = eventsOf(core, "remote.session_opened.v1");

    expect(events).toEqual([
      {
        actorType: "user",
        payload: {
          host: "zarrarpc",
          destination: "zarrarpc.tail9594ed.ts.net:3389",
          gatewayUrl: "wss://zarrarpc.tail9594ed.ts.net/jet/rdp",
          associationId: opened.body.associationId,
          expiresAt: opened.body.expiresAt,
        },
      },
    ]);

    // The signature is the part that makes a token a token: search for it in
    // everything the core persisted or printed.
    const signature = token.split(".")[2] ?? "";
    const everyRow = JSON.stringify(
      core.core.kernel.db.prepare("SELECT * FROM orchestration_events").all(),
    );
    expect(signature.length).toBeGreaterThan(100);
    expect(everyRow).not.toContain(signature);
    expect(core.logs.join("\n")).not.toContain(signature);
  });

  it("refuses a host that is not on the core's allowlist, and signs nothing", async () => {
    const core = await startTestCore(REMOTE);
    const opened = await open(
      core,
      { idempotencyKey: "k1", host: "elsewhere" },
      await session(core),
    );

    expect(opened.status).toBe(404);
    expect(opened.text).not.toContain("token");
    expect(eventsOf(core, "remote.session_opened.v1")).toEqual([]);
  });

  it("refuses a password, and does not repeat it anywhere", async () => {
    const core = await startTestCore(REMOTE);
    const opened = await open(
      core,
      { idempotencyKey: "k1", host: "zarrarpc", password: "correct horse battery staple" },
      await session(core),
    );

    expect(opened.status).toBe(400);
    expect(opened.text).not.toContain("correct horse");
    expect(core.logs.join("\n")).not.toContain("correct horse");
    expect(eventsOf(core, "remote.session_opened.v1")).toEqual([]);
  });

  it("refuses a caller with no credential, and a session without its CSRF value", async () => {
    const core = await startTestCore(REMOTE);
    const headers = await session(core);
    const body = { idempotencyKey: "k1", host: "zarrarpc" };

    expect((await open(core, body, { "content-type": "application/json" })).status).toBe(401);
    expect(
      (
        await open(core, body, {
          cookie: headers.cookie ?? "",
          "content-type": "application/json",
        })
      ).status,
    ).toBe(403);
    expect(eventsOf(core, "remote.session_opened.v1")).toEqual([]);
  });

  it("does not hand out a second token for a replayed key", async () => {
    const core = await startTestCore(REMOTE);
    const headers = await session(core);

    expect((await open(core, { idempotencyKey: "k1", host: "zarrarpc" }, headers)).status).toBe(
      200,
    );

    const replay = await open(core, { idempotencyKey: "k1", host: "zarrarpc" }, headers);
    expect(replay.status).toBe(409);
    expect(replay.body.token).toBeUndefined();
    expect(eventsOf(core, "remote.session_opened.v1")).toHaveLength(1);
  });
});

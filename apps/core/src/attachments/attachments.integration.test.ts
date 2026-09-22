import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_ATTACHMENT_BYTES } from "@noctis/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { ATTACHMENT_FILENAME_HEADER, ATTACHMENT_UPLOAD_PATH } from "../api/http.js";
import type { CoreConfig } from "../config/server.js";
import { createLogger } from "../logging.js";
import type { RunningCore } from "../server.js";
import { startCore } from "../server.js";

/**
 * The upload realm and the node realm, end to end.
 *
 * What these assert that a unit test could not: that `POST /attachments` is
 * reachable with a session but not without one, that the node route accepts a
 * node credential and refuses the core token, and that an upload leaves an
 * `external_reference` behind — which is the half of Section 12.2 that would
 * otherwise be a comment rather than a behaviour.
 */

const TOKEN = "0123456789abcdef0123456789abcdef";
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082",
  "hex",
);

interface TestCore {
  core: RunningCore;
  base: string;
}

const started: Array<{ core: RunningCore; directory: string }> = [];

async function startTestCore(): Promise<TestCore> {
  const directory = mkdtempSync(join(tmpdir(), "noctis-attachments-"));
  const config: CoreConfig = {
    bindAddress: "127.0.0.1",
    port: 0,
    token: TOKEN,
    databasePath: join(directory, "core.db"),
    allowedOrigins: [],
    logLevel: "error",
    sessionTtlHours: 720,
  };

  const core = await startCore({
    config,
    env: {},
    logger: createLogger({ sink: () => undefined, level: "error" }),
  });

  started.push({ core, directory });

  return { core, base: `http://127.0.0.1:${String(core.port)}` };
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

async function upload(
  core: TestCore,
  bytes: Buffer,
  filename: string,
  mediaType: string,
  headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${core.base}${ATTACHMENT_UPLOAD_PATH}`, {
    method: "POST",
    headers: { ...headers, "content-type": mediaType, [ATTACHMENT_FILENAME_HEADER]: filename },
    body: bytes,
  });

  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function pairFake(core: TestCore): Promise<{ nodeId: string; credential: string }> {
  const issued = await fetch(`${core.base}/commands/node.issue_pairing_code`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: "code-a", hostId: "workstation" }),
  });
  const { code } = (await issued.json()) as { code: string };
  const paired = await fetch(`${core.base}/node/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      hostId: "workstation",
      fingerprint: "fingerprint-a",
      agentVersion: "0.0.0-test",
    }),
  });

  return (await paired.json()) as { nodeId: string; credential: string };
}

describe("attachments", () => {
  it("records an upload as an external reference the node can then fetch", async () => {
    const core = await startTestCore();
    const stored = await upload(core, PNG, "shot.png", "image/png");

    expect(stored.status).toBe(200);
    expect(stored.body.mediaType).toBe("image/png");
    expect(stored.body.checksum).toBe(createHash("sha256").update(PNG).digest("hex"));

    // Section 12.2: it came from outside, so nothing local holds it yet.
    const artifact = await fetch(`${core.base}/artifacts/${String(stored.body.artifactId)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(((await artifact.json()) as { kind: string }).kind).toBe("external_reference");

    const node = await pairFake(core);
    const fetched = await fetch(`${core.base}/node/attachments/${String(stored.body.id)}`, {
      headers: { authorization: `Bearer ${node.nodeId}.${node.credential}` },
    });

    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await fetched.arrayBuffer()).equals(PNG)).toBe(true);
  });

  // The phone is the front door, and the camera roll hands over HEIC. Before
  // this the one thing the phone could offer was the one thing the core refused.
  it("takes what an iPhone camera roll actually hands over", async () => {
    const core = await startTestCore();
    const heic = await upload(core, PNG, "IMG_0001.HEIC", "image/heic");

    expect(heic.status).toBe(200);
    expect(heic.body.mediaType).toBe("image/heic");

    const refused = await upload(core, PNG, "map.svg", "image/svg+xml");

    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      error: { code: "invalid_attachment", details: { reason: "unsupported_media_type" } },
    });
  });

  it("uploading the same file twice is the same attachment", async () => {
    const core = await startTestCore();
    const first = await upload(core, PNG, "shot.png", "image/png");
    const second = await upload(core, PNG, "shot.png", "image/png");

    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it("refuses a type the allowlist does not name", async () => {
    const core = await startTestCore();
    const refused = await upload(core, Buffer.from("MZ"), "tool.exe", "application/x-msdownload");

    expect(refused.status).toBe(400);
  });

  it("refuses a filename that would escape the node's staging directory", async () => {
    const core = await startTestCore();
    const refused = await upload(core, PNG, "../../shot.png", "image/png");

    expect(refused.status).toBe(400);
  });

  it("refuses a file larger than the cap without reading all of it", async () => {
    const core = await startTestCore();
    const refused = await upload(
      core,
      Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x41),
      "big.txt",
      "text/plain",
    );

    expect(refused.status).toBe(413);
  });

  it("refuses an upload with no credential at all", async () => {
    const core = await startTestCore();
    const refused = await upload(core, PNG, "shot.png", "image/png", {});

    expect(refused.status).toBe(401);
  });

  it("the node route takes a node credential, not the core token", async () => {
    const core = await startTestCore();
    const stored = await upload(core, PNG, "shot.png", "image/png");
    const refused = await fetch(`${core.base}/node/attachments/${String(stored.body.id)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(refused.status).toBe(401);
  });
});

import type { FileGateway } from "./gateway.js";
import { Readable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startCore, type RunningCore } from "../server.js";
import { createLogger } from "../logging.js";

const open = vi.hoisted(() => vi.fn<FileGateway["open"]>());
vi.mock("./gateway.js", async (original) => ({
  ...(await original<object>()),
  createFileGateway: () => ({ open, close() {} }),
}));
const TOKEN = "0123456789abcdef0123456789abcdef";
let core: RunningCore | undefined;
let directory: string;
afterEach(async () => {
  await core?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  open.mockReset();
});
async function fixture() {
  directory = mkdtempSync(join(tmpdir(), "file-preview-"));
  core = await startCore({
    config: {
      bindAddress: "127.0.0.1",
      port: 0,
      token: TOKEN,
      databasePath: join(directory, "core.db"),
      allowedOrigins: [],
      logLevel: "error",
      sessionTtlHours: 720,
    },
    env: {},
    logger: createLogger({ sink: () => undefined }),
  });
  return `http://127.0.0.1:${core.port}/files/content?node=0199a000-0000-7000-8000-0000000000d1&root=fixture&path=`;
}
describe("bounded text previews", () => {
  it("bounds the node request and the response even if the node sends excessive bytes", async () => {
    const base = await fixture();
    open.mockImplementation(() =>
      Promise.resolve({
        sizeBytes: 10_000_000,
        offset: 0,
        length: 10_000_000,
        body: Readable.from([Buffer.alloc(3 * 1024 * 1024, 120)]),
      }),
    );
    const response = await fetch(`${base}large.log&preview=1`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    const preview = (await response.json()) as { text: string; truncated: boolean };
    expect(preview.text.length).toBe(2 * 1024 * 1024);
    expect(preview.truncated).toBe(true);
    expect(open.mock.calls[0]?.[1]).toMatchObject({ offset: 0, length: 2 * 1024 * 1024 });
  });
  it("strictly rejects malformed preview switches and nontext previews", async () => {
    const base = await fixture();
    for (const suffix of [
      "note.md&preview=0",
      "note.md&preview=01",
      "note.md&preview=1&preview=1",
      "pic.png&preview=1",
      "note.md&preview=1&download=1",
    ]) {
      expect(
        (await fetch(base + suffix, { headers: { authorization: `Bearer ${TOKEN}` } })).status,
      ).toBe(400);
    }
    expect(open).not.toHaveBeenCalled();
  });
  it("keeps normal media ranges and full downloads", async () => {
    const base = await fixture();
    open.mockImplementation((_context, at) =>
      Promise.resolve({
        sizeBytes: 100,
        offset: at.offset,
        length: at.length ?? 100,
        body: Readable.from([Buffer.alloc(at.length ?? 100, 120)]),
      }),
    );
    const ranged = await fetch(`${base}clip.mp4`, {
      headers: { authorization: `Bearer ${TOKEN}`, range: "bytes=10-19" },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 10-19/100");
    expect((await ranged.arrayBuffer()).byteLength).toBe(10);
    const download = await fetch(`${base}large.log&download=1`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect((await download.arrayBuffer()).byteLength).toBe(100);
    expect(open.mock.calls[1]?.[1]).not.toHaveProperty("length");
  });
});

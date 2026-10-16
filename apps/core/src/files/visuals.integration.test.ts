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
  directory = mkdtempSync(join(tmpdir(), "file-visual-"));
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
  return `http://127.0.0.1:${core.port}/visuals/content?node=0199a000-0000-7000-8000-0000000000d1&root=fixture&path=`;
}
describe("visual pages", () => {
  const auth = { headers: { authorization: `Bearer ${TOKEN}` } };
  const serve = (bytes: number) =>
    open.mockImplementation(() =>
      Promise.resolve({
        sizeBytes: bytes,
        offset: 0,
        length: Math.min(bytes, 2 * 1024 * 1024),
        body: Readable.from([Buffer.alloc(Math.min(bytes, 2 * 1024 * 1024), 120)]),
      }),
    );

  it("serves an agent's page so its scripts run sandboxed, with no network and no way out", async () => {
    const base = await fixture();
    serve(100);
    const response = await fetch(`${base}figures/limiter.html`, auth);
    const policy = response.headers.get("content-security-policy") ?? "";

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(policy).toContain("sandbox allow-scripts");
    expect(policy).not.toContain("allow-same-origin");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'self'");
    expect(policy).not.toMatch(/connect-src/);
    expect((await response.arrayBuffer()).byteLength).toBe(100);
  });

  it("serves an SVG as an SVG", async () => {
    const base = await fixture();
    serve(10);
    const response = await fetch(`${base}plot.svg`, auth);

    expect(response.headers.get("content-type")).toBe("image/svg+xml");
  });

  it("refuses anything but a page or an SVG without asking the node", async () => {
    const base = await fixture();

    for (const path of ["notes.md", "photo.png", "run.js"]) {
      expect((await fetch(base + path, auth)).status).toBe(400);
    }
    expect((await fetch(`${base}figure.html`)).status).toBe(401);
    expect(open).not.toHaveBeenCalled();
  });

  it("refuses a page over 2 MB", async () => {
    const base = await fixture();
    serve(3 * 1024 * 1024);

    expect((await fetch(`${base}big.html`, auth)).status).toBe(413);
  });
});

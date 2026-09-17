import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { contentTypeFor, isApiPath, serveStatic } from "./static.js";

let root: string;
let outside: string;

function capture(): {
  res: ServerResponse;
  read: () => { status: number; headers: Record<string, string>; body: string };
} {
  const state = { status: 0, headers: {} as Record<string, string>, body: "" };

  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      state.status = status;
      state.headers = headers;

      return this;
    },
    end(body?: Buffer | string) {
      state.body = body === undefined ? "" : body.toString();
    },
  } as unknown as ServerResponse;

  return { res, read: () => state };
}

async function get(pathname: string): Promise<{
  status: number;
  headers: Record<string, string>;
  body: string;
}> {
  const { res, read } = capture();
  await serveStatic(root, pathname, res);

  return read();
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "noctis-web-root-"));
  outside = mkdtempSync(join(tmpdir(), "noctis-outside-"));

  writeFileSync(join(outside, "secret.txt"), "the-secret");
  writeFileSync(join(root, "index.html"), "<!doctype html><title>Noctis</title>");
  writeFileSync(join(root, "sw.js"), "self.addEventListener('install', () => {});");
  writeFileSync(join(root, "favicon.bin"), "not a known extension");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "app.js"), "export const app = 1;");
  writeFileSync(join(root, "assets", "app.css"), ".rail { color: white }");

  // A directory symlink is the escape a string filter cannot see: every segment
  // of `/escape/secret.txt` is innocent and the resolved path is still outside.
  symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("isApiPath", () => {
  it("claims every path an API route answers, so static never shadows one", () => {
    for (const pathname of [
      "/health",
      "/ready",
      "/diagnostics",
      "/session/login",
      "/session/logout",
      "/events/live",
      "/events",
      "/commands/objective.create",
      "/node/pair",
      "/objectives",
      "/objectives/01941f29-7c00-7000-8000-000000000011",
      "/identities",
      "/vault/graph",
      "/approvals",
      "/permissions",
      "/sources",
      "/artifacts",
      "/nodes",
      "/threads",
      "/turns",
      "/missions",
      "/jobs",
      "/models",
      "/ws/clients",
    ]) {
      expect(isApiPath(pathname), pathname).toBe(true);
    }
  });

  it("leaves the page's own paths to the static handler", () => {
    for (const pathname of ["/", "/index.html", "/assets/app.js", "/sw.js", "/chat", "/settings"]) {
      expect(isApiPath(pathname), pathname).toBe(false);
    }
  });
});

describe("contentTypeFor", () => {
  it("names the types a built page is made of", () => {
    expect(contentTypeFor("/index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("/assets/app.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("/assets/app.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("/icon.svg")).toBe("image/svg+xml");
  });

  it("falls back to octet-stream rather than guessing", () => {
    expect(contentTypeFor("/favicon.bin")).toBe("application/octet-stream");
    expect(contentTypeFor("/noextension")).toBe("application/octet-stream");
  });
});

describe("serveStatic", () => {
  it("serves index.html at the root", async () => {
    const response = await get("/");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.body).toContain("Noctis");
  });

  it("serves a hashed asset with the type that makes a module load", async () => {
    const response = await get("/assets/app.js");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(response.body).toContain("export const app");
  });

  it("serves the service worker from the root, where its scope has to be", async () => {
    const response = await get("/sw.js");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/javascript; charset=utf-8");
  });

  it("serves an unknown extension as octet-stream rather than sniffing it", async () => {
    const response = await get("/favicon.bin");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
  });

  it("returns index.html for a route, so a deep link opens the app", async () => {
    const response = await get("/settings");

    expect(response.status).toBe(200);
    expect(response.body).toContain("Noctis");
  });

  it("404s a missing asset rather than answering HTML a module loader will choke on", async () => {
    const response = await get("/assets/missing.js");

    expect(response.status).toBe(404);
    expect(response.body).not.toContain("<!doctype html>");
  });

  it("refuses a traversal out of the root", async () => {
    const response = await get("/../../etc/passwd");

    expect(response.status).toBe(404);
  });

  it("refuses a traversal that only exists once the path is decoded", async () => {
    for (const pathname of [
      `/..%2f..%2f${encodeURIComponent(outside)}/secret.txt`,
      "/%2e%2e/%2e%2e/etc/passwd",
      "/assets/%2e%2e%2f%2e%2e%2fsecret.txt",
    ]) {
      const response = await get(pathname);

      expect(response.status, pathname).toBe(404);
      expect(response.body, pathname).not.toContain("the-secret");
    }
  });

  it("refuses an absolute path, however it is spelled", async () => {
    const encoded = join(outside, "secret.txt").replaceAll("\\", "/");
    const response = await get(`/${encoded}`);

    expect(response.status).toBe(404);
    expect(response.body).not.toContain("the-secret");
  });

  it("refuses a symlink that leaves the root, which no string filter would catch", async () => {
    const response = await get("/escape/secret.txt");

    expect(response.status).toBe(404);
    expect(response.body).not.toContain("the-secret");
  });

  it("answers 404 and not 403, so a refusal never confirms what exists", async () => {
    // The same status for a path that is outside the root and for one that is
    // simply absent: the difference between them is exactly what a prober wants.
    expect((await get("/../../etc/passwd")).status).toBe(404);
    expect((await get("/assets/never-existed.js")).status).toBe(404);
  });

  it("does not serve a directory as if it were a file", async () => {
    const response = await get("/assets/");

    expect(response.status).toBe(404);
  });

  it("404s everything when the root holds no index.html", async () => {
    const empty = mkdtempSync(join(tmpdir(), "noctis-empty-root-"));

    try {
      const { res, read } = capture();
      await serveStatic(empty, "/settings", res);

      expect(read().status).toBe(404);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { CORE_PATH_PATTERN } from "@noctis/contracts";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { contentTypeFor, isApiPath, pageSecurityPolicy, serveStatic } from "./static.js";

let root: string;
let outside: string;
/** A real file one level above the root, so a traversal has something to reach. */
let sibling: string;

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

  // Directly beside the root, so `/..%2f<name>` names a file that *exists*.
  // Without this every traversal case 404s from ENOENT rather than from the
  // containment check, and the suite would pass against a naive `path.join`.
  sibling = `${basename(root)}-sibling.txt`;
  writeFileSync(join(root, "..", sibling), "the-secret");
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
  rmSync(join(root, "..", sibling), { force: true });
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("isApiPath", () => {
  it("claims Presence panels through static classification and the development proxy", () => {
    expect(isApiPath("/presence/surfaces")).toBe(true);
    expect(CORE_PATH_PATTERN.test("/presence/surfaces?clientId=workbench")).toBe(true);
  });

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

  it("tells the browser not to sniff a type, on every answer", async () => {
    for (const pathname of ["/", "/assets/app.js", "/favicon.bin", "/settings", "/missing.js"]) {
      // A declared type is only worth declaring if the browser is told to obey
      // it. This origin holds the session cookie.
      expect((await get(pathname)).headers["x-content-type-options"], pathname).toBe("nosniff");
    }
  });

  it("frames nowhere and loads nothing off-origin, on every answer", async () => {
    // The 200, the SPA fallback and the 404 alike: all three go through the
    // same `respond`, and a policy on only the first would leave the login
    // screen frameable at any URL that happens to miss.
    //
    // The origin gate cannot cover this. A top-level navigation and a
    // cross-site `<iframe>` both send no `Origin`, so `isOriginAllowed` says
    // yes, and `SameSite=Strict` means what a frame gets is the login form —
    // clickjacking of the field that takes the credential to two machines.
    for (const pathname of ["/", "/assets/app.js", "/settings", "/missing.js"]) {
      const headers = (await get(pathname)).headers;

      expect(headers["content-security-policy"], pathname).toContain("frame-ancestors 'none'");
      expect(headers["content-security-policy"], pathname).toContain("default-src 'self'");
      // Not widened for the app's inline styles: React `style` props are CSSOM
      // writes, which CSP does not govern, and index.html's one `<style>` block
      // became a bundled stylesheet rather than an exception in this line.
      expect(headers["content-security-policy"], pathname).not.toContain("unsafe-inline");
      // The composer previews an image the owner pasted from a blob: URL the
      // page made itself; nothing else is allowed to load an image from elsewhere.
      expect(headers["content-security-policy"], pathname).toContain("img-src 'self' blob:");
      expect(headers["x-frame-options"], pathname).toBe("DENY");
      expect(headers["referrer-policy"], pathname).toBe("no-referrer");
    }
  });

  it("caches a hashed asset forever and never the shell", async () => {
    // Vite puts the content hash in the /assets/ filename, so that URL can be
    // immutable; index.html has a stable URL and must be revalidated or a
    // deploy strands a phone on asset URLs that no longer exist.
    expect((await get("/assets/app.js")).headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect((await get("/")).headers["cache-control"]).toBe("no-cache");
    expect((await get("/settings")).headers["cache-control"]).toBe("no-cache");
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

  it("refuses a traversal that reaches a file which really is there", async () => {
    // Each of these resolves to `<tmp>/<sibling>`, which exists. A naive
    // `join(root, pathname)` answers 200 with its contents; only a containment
    // check on the resolved path refuses it. This is the case that gives the
    // rest of the traversal tests their teeth.
    for (const pathname of [
      `/../${sibling}`,
      `/%2e%2e/${sibling}`,
      `/..%2f${sibling}`,
      `/assets/../../${sibling}`,
    ]) {
      const response = await get(pathname);

      expect(response.status, pathname).toBe(404);
      expect(response.body, pathname).not.toContain("the-secret");
    }
  });

  it("refuses a traversal to a target that is not there either", async () => {
    for (const pathname of [
      "/../../etc/passwd",
      "/%2e%2e/%2e%2e/etc/passwd",
      "/assets/%2e%2e%2f%2e%2e%2fsecret.txt",
    ]) {
      const response = await get(pathname);

      expect(response.status, pathname).toBe(404);
      expect(response.body, pathname).not.toContain("the-secret");
    }
  });

  it("refuses an absolute path, however it is spelled", async () => {
    for (const pathname of [
      // A POSIX-style absolute path to a file that exists.
      `/${join(outside, "secret.txt").replaceAll("\\", "/")}`,
      // Drive-relative on Windows: no separator after the colon, so a naive
      // resolve can reinterpret it against the current directory of that drive.
      "/C:Windows/win.ini",
      "/c:/Windows/win.ini",
      // A UNC path, which names a host rather than a directory.
      "//server/share/secret.txt",
      "/%5C%5Cserver%5Cshare%5Csecret.txt",
    ]) {
      const response = await get(pathname);

      expect(response.status, pathname).toBe(404);
      expect(response.body, pathname).not.toContain("the-secret");
    }
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

describe("pageSecurityPolicy (Task 3.9)", () => {
  const base =
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'";
  const strict = `${base}; img-src 'self' blob:; media-src 'self' blob:`;

  it("is unchanged when no remote desktop is configured", () => {
    expect(pageSecurityPolicy([])).toBe(strict);
  });

  it("widens exactly as far as the remote desktop needs, for the configured Gateways only", () => {
    const policy = pageSecurityPolicy(["wss://zarrarpc.tail9594ed.ts.net"]);

    expect(policy.startsWith(base)).toBe(true);
    // WASM compiles; no string is ever evaluated, and no script is inline.
    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(policy).not.toMatch(/(^|[\s;])'unsafe-eval'/);
    // The element injects its own <style>; that is the only 'unsafe-inline'.
    expect(policy).toContain("style-src 'self' 'unsafe-inline'");
    expect(policy.split("'unsafe-inline'")).toHaveLength(2);
    // Its WASM is an inlined data: URL it fetch()es, and its cursors are data: images.
    expect(policy).toContain("connect-src 'self' data: wss://zarrarpc.tail9594ed.ts.net");
    expect(policy).toContain("img-src 'self' data: blob:");
    expect(policy).toContain("media-src 'self' blob:");
    expect(policy.split("img-src")).toHaveLength(2);
  });

  it("is the header serveStatic sends when it is given one", async () => {
    const { res, read } = capture();
    await serveStatic(root, "/", res, pageSecurityPolicy(["wss://gw.example"]));

    expect(read().headers["content-security-policy"]).toContain("wss://gw.example");
  });
});

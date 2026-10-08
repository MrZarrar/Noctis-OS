import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import {
  TOKEN,
  launchOptions,
  runOnce,
  startFakeNode,
  startProcess,
  stopProcess,
  tabTo,
  waitFor,
  waitForHttp,
} from "./harness.mjs";

/**
 * Files from a PC, the way the phone opens them (v1 S4).
 *
 * The phone signs in with a cookie, and the cookie is the only credential an
 * `<img>` or a `<video>` can carry, so this runs the page the core itself
 * serves, as `tokenless.test.mjs` does. The node is the real agent; the bytes
 * come off its disk, through the core, into the browser.
 *
 * Playwright's Chromium has no H.264, so the video is proved by what the
 * element fetches — a byte range, answered 206 — not by it playing.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const WEB_ROOT = join(REPO_ROOT, "apps/web");
const DIST = resolve(process.env.NOCTIS_E2E_DIST ?? join(WEB_ROOT, "dist"));
const AGENT_MAIN = join(REPO_ROOT, "apps/node-agent/dist/main.js");

const CORE_PORT = 8805;
const CORE_URL = `http://127.0.0.1:${CORE_PORT}`;
const PHONE = { width: 400, height: 860 };

/** A real 1x1 PNG, so the browser decodes it rather than merely receiving it. */
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
const VIDEO = Buffer.from(Array.from({ length: 50_000 }, (_, index) => index % 251));

let core;
let agent;
let browser;
let context;
let page;
let databaseDirectory;
let nodeHome;
let shared;

function readFiles() {
  return page.evaluate(() => {
    const viewer = document.querySelector('[data-region="viewer"]');
    const image = viewer?.querySelector("img");
    const video = viewer?.querySelector("video");

    return {
      hasTokenField: document.querySelector('input[type="password"]') !== null,
      heading: document.querySelector("h1")?.textContent ?? "",
      places: [...document.querySelectorAll('[aria-label="Places"] li')].map(
        (item) => item.textContent?.trim() ?? "",
      ),
      rows: [...document.querySelectorAll('[aria-label="Folder contents"] li')].map(
        (item) => item.textContent?.trim() ?? "",
      ),
      viewer: viewer?.textContent?.trim() ?? "",
      imageDrawn:
        image !== null && image !== undefined && image.complete && image.naturalWidth === 1,
      videoSrc: video?.getAttribute("src") ?? "",
      download: viewer?.querySelector("a[download]")?.getAttribute("href") ?? "",
    };
  });
}

async function press(label) {
  await tabTo(page, label);
  await page.keyboard.press("Enter");
}

/** Opens the row whose text starts with `name`, once the folder lists it. */
async function openRow(name) {
  const state = await waitFor(
    readFiles,
    (files) => files.rows.some((row) => row.startsWith(name)),
    `${name} was never listed`,
  );

  await press(state.rows.find((row) => row.startsWith(name)) ?? name);
}

describe("files on a PC, opened from a signed-in phone", () => {
  before(async () => {
    for (const built of ["packages/ui/dist/index.js", "apps/core/dist/main.js", AGENT_MAIN]) {
      assert.ok(
        existsSync(built.startsWith(REPO_ROOT) ? built : join(REPO_ROOT, built)),
        `run \`npm run build\` before the E2E suite: ${built} is missing`,
      );
    }

    // Built every run, as tokenless.test.mjs explains: a stale bundle would
    // let this pass against a page that no longer exists.
    if (process.env.NOCTIS_E2E_SKIP_BUILD === undefined || !existsSync(join(DIST, "index.html"))) {
      const env = { ...process.env };

      delete env.VITE_CORE_TOKEN;
      delete env.VITE_CORE_URL;
      await runOnce(process.execPath, [join(REPO_ROOT, "node_modules/vite/bin/vite.js"), "build"], {
        cwd: WEB_ROOT,
        env,
      });
    }

    databaseDirectory = mkdtempSync(join(tmpdir(), "noctis-e2e-files-db-"));
    nodeHome = mkdtempSync(join(tmpdir(), "noctis-e2e-files-node-"));
    shared = mkdtempSync(join(tmpdir(), "noctis-e2e-files-shared-"));
    mkdirSync(join(shared, "frames"));
    writeFileSync(join(shared, "script.md"), "# Episode one\n");
    writeFileSync(join(shared, "frames", "frame-01.png"), PIXEL);
    writeFileSync(join(shared, "render.mp4"), VIDEO);

    core = startProcess(process.execPath, [join(REPO_ROOT, "apps/core/dist/main.js")], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NOCTIS_CORE_TOKEN: TOKEN,
        NOCTIS_CORE_PORT: String(CORE_PORT),
        NOCTIS_DATABASE_PATH: join(databaseDirectory, "core.db"),
        NOCTIS_WEB_ROOT: DIST,
        NOCTIS_ALLOWED_ORIGINS: CORE_URL,
        NOCTIS_LOG_LEVEL: "error",
      },
    });

    await waitForHttp(`${CORE_URL}/health`, "the core", core);
    ({ agent } = await startFakeNode({
      coreUrl: CORE_URL,
      repoRoot: REPO_ROOT,
      agentMain: AGENT_MAIN,
      nodeHome,
      scratch: shared,
      keyPrefix: "e2e-files",
    }));

    browser = await chromium.launch(launchOptions());
    context = await browser.newContext({ viewport: PHONE });
    page = await context.newPage();
  });

  after(async () => {
    await page?.close();
    await context?.close();
    await browser?.close();
    await stopProcess(agent);
    await stopProcess(core);

    for (const directory of [databaseDirectory, nodeHome, shared]) {
      if (directory !== undefined) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it(
    "THE GATE: a storyboard frame draws and a video streams by range, from the PC, over the cookie",
    { timeout: 180_000 },
    async () => {
      await page.goto(CORE_URL);
      await waitFor(readFiles, (state) => state.hasTokenField, "no login screen");
      await press("Core token");
      await page.keyboard.type(TOKEN);
      await page.keyboard.press("Enter");

      await waitFor(readFiles, (state) => !state.hasTokenField, "the token did not sign in");
      await press("Files");

      const places = await waitFor(
        readFiles,
        (state) => state.places.some((place) => place.includes("noctis-e2e-files-shared")),
        "the shared folder never appeared as a place",
      );

      await press(places.places.find((place) => place.includes("noctis-e2e-files-shared")) ?? "");
      await openRow("frames");
      await openRow("frame-01.png");

      const frame = await waitFor(
        readFiles,
        (state) => state.imageDrawn,
        "the frame never drew in the viewer",
      );
      assert.match(frame.download, /\/files\/content\?.*download=1$/);

      await press("Close");
      await press("Up");
      await openRow("render.mp4");

      const video = await waitFor(
        readFiles,
        (state) => state.videoSrc.includes("/files/content?"),
        "the video never got a source",
      );

      // What the element does when it seeks: a range, with the cookie the
      // browser attaches on its own.
      const answer = await page.evaluate(async (src) => {
        const response = await fetch(src, { headers: { range: "bytes=100-199" } });
        const bytes = new Uint8Array(await response.arrayBuffer());

        return {
          status: response.status,
          range: response.headers.get("content-range"),
          type: response.headers.get("content-type"),
          first: bytes[0],
          length: bytes.length,
        };
      }, video.videoSrc);

      assert.deepEqual(answer, {
        status: 206,
        range: "bytes 100-199/50000",
        type: "video/mp4",
        first: 100 % 251,
        length: 100,
      });
    },
  );
});

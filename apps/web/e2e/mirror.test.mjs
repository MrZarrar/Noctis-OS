import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * The screen mirror, the way the phone opens it: signed in with the
 * cookie, because the cookie is the only credential an `<img>` can carry.
 *
 * Everything is real but the capture. The helper runs as its own process, as
 * the at-logon task runs it; the node finds it through the file it writes; the
 * fake ffmpeg behind it streams real JPEGs in ffmpeg's own framing.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const WEB_ROOT = join(REPO_ROOT, "apps/web");
const DIST = resolve(process.env.NOCTIS_E2E_DIST ?? join(WEB_ROOT, "dist"));
const AGENT_MAIN = join(REPO_ROOT, "apps/node-agent/dist/main.js");
const HELPER_FIXTURE = join(REPO_ROOT, "apps/web/e2e/screen-helper.fixture.mjs");

const CORE_PORT = 8807;
const CORE_URL = `http://127.0.0.1:${CORE_PORT}`;
const PHONE = { width: 400, height: 860 };

let core;
let agent;
let helper;
let browser;
let context;
let page;
let databaseDirectory;
let nodeHome;
let shared;
let localAppData;
let ffmpegLog;

function readMirror() {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-region="mirror"]');
    const image = panel?.querySelector("img");

    return {
      hasTokenField: document.querySelector('input[type="password"]') !== null,
      text: panel?.textContent ?? "",
      imageDrawn: image !== null && image !== undefined && image.naturalWidth === 16,
    };
  });
}

async function press(label) {
  await tabTo(page, label, 60);
  await page.keyboard.press("Enter");
}

function ffmpegAlive() {
  const { pid } = JSON.parse(readFileSync(ffmpegLog, "utf8"));

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("the screen mirror, watched from a signed-in phone", () => {
  before(async () => {
    for (const built of [
      "packages/ui/dist/index.js",
      "apps/core/dist/main.js",
      "apps/node-agent/dist/screen/helper.js",
      "apps/node-agent/dist/screen/fake-ffmpeg.js",
      AGENT_MAIN,
    ]) {
      assert.ok(
        existsSync(built.startsWith(REPO_ROOT) ? built : join(REPO_ROOT, built)),
        `run \`npm run build\` before the E2E suite: ${built} is missing`,
      );
    }

    if (process.env.NOCTIS_E2E_SKIP_BUILD === undefined || !existsSync(join(DIST, "index.html"))) {
      const env = { ...process.env };

      delete env.VITE_CORE_TOKEN;
      delete env.VITE_CORE_URL;
      await runOnce(process.execPath, [join(REPO_ROOT, "node_modules/vite/bin/vite.js"), "build"], {
        cwd: WEB_ROOT,
        env,
      });
    }

    databaseDirectory = mkdtempSync(join(tmpdir(), "noctis-e2e-mirror-db-"));
    nodeHome = mkdtempSync(join(tmpdir(), "noctis-e2e-mirror-node-"));
    shared = mkdtempSync(join(tmpdir(), "noctis-e2e-mirror-shared-"));
    // Stands in for %LOCALAPPDATA%, so the node and the helper meet where
    // they would on the PC without either touching the real one.
    localAppData = mkdtempSync(join(tmpdir(), "noctis-e2e-mirror-local-"));
    ffmpegLog = join(localAppData, "ffmpeg.json");
    mkdirSync(join(localAppData, "Noctis"));

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

    // Before the node, so it finds a helper rather than starting a real one.
    helper = startProcess(
      process.execPath,
      [HELPER_FIXTURE, join(localAppData, "Noctis", "screen-helper.json"), ffmpegLog],
      { cwd: REPO_ROOT },
    );
    await waitFor(
      () => Promise.resolve(helper.output.join("")),
      (output) => output.includes("ready"),
      "the screen helper never started",
    );

    await waitForHttp(`${CORE_URL}/health`, "the core", core);
    ({ agent } = await startFakeNode({
      coreUrl: CORE_URL,
      repoRoot: REPO_ROOT,
      agentMain: AGENT_MAIN,
      nodeHome,
      scratch: shared,
      keyPrefix: "e2e-mirror",
      env: { LOCALAPPDATA: localAppData },
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
    await stopProcess(helper);
    await stopProcess(core);

    for (const directory of [databaseDirectory, nodeHome, shared, localAppData]) {
      if (directory !== undefined) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it(
    "THE GATE: a PC is allowed, its screen draws in an <img>, and a locked PC says so",
    { timeout: 180_000 },
    async () => {
      await page.goto(CORE_URL);
      await waitFor(readMirror, (state) => state.hasTokenField, "no login screen");
      await press("Core token");
      await page.keyboard.type(TOKEN);
      await page.keyboard.press("Enter");

      await waitFor(readMirror, (state) => !state.hasTokenField, "the token did not sign in");
      await press("Nodes");

      // The node shares a folder with its agents, and that is not consent to be watched.
      await waitFor(
        readMirror,
        (state) => state.text.includes("not allowed to show its screen"),
        "the Mirror tab never explained how to allow it",
      );

      await press("Allow mirroring this PC");
      await waitFor(
        readMirror,
        (state) => state.text.includes("Not watching"),
        "allowing it did not make the PC watchable",
      );

      await press("Watch");

      const live = await waitFor(
        readMirror,
        (state) => state.imageDrawn && state.text.includes("Live"),
        "the screen never drew",
      );
      assert.match(live.text, /Live from e2e/);

      await press("Stop");
      await waitFor(
        () => Promise.resolve(ffmpegAlive()),
        (alive) => !alive,
        "ffmpeg kept capturing after the viewer stopped",
      );

      writeFileSync(`${ffmpegLog}.locked`, "");
      await press("Watch");
      await waitFor(
        readMirror,
        (state) =>
          state.text.includes("The PC is locked. Sign in at the PC, or use Remote desktop."),
        "a locked PC was not reported as locked",
      );
    },
  );
});

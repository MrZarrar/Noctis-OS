import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const WEB_ROOT = join(REPO_ROOT, "apps/web");

const TOKEN = "0123456789abcdef0123456789abcdef";
const CORE_PORT = 8791;
const WEB_PORT = 4179;
const CORE_URL = `http://127.0.0.1:${CORE_PORT}`;
const WEB_URL = `http://localhost:${WEB_PORT}`;

/**
 * Bundled Chromium by default, which is what CI installs and therefore what the
 * gate is actually proven against. `NOCTIS_E2E_BROWSER_CHANNEL` selects an
 * already-installed browser instead (`msedge`, `chrome`) for a machine that
 * cannot reach Playwright's download host — an explicit opt-in, never a silent
 * fallback, so a run always says which browser it used.
 */
const CHANNEL = process.env.NOCTIS_E2E_BROWSER_CHANNEL;

let core;
let web;
let browser;
let page;
let databaseDirectory;

/**
 * Spawns a server without a shell.
 *
 * `shell: true` on Windows makes the direct child `cmd.exe`, so `kill()` stops
 * the shell and leaves the real server running — which keeps its stdio pipes
 * attached and stops the test process from ever exiting. Spawning the binary
 * directly means the handle we hold is the process we need to stop.
 *
 * The output listeners also matter: an unread pipe fills and blocks the child
 * once it has written enough, and the tail is what a startup failure gets to
 * report instead of a bare timeout.
 */
function startProcess(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];

  const record = (chunk) => {
    output.push(chunk.toString());

    if (output.length > 40) {
      output.shift();
    }
  };

  child.stdout.on("data", record);
  child.stderr.on("data", record);
  child.output = output;

  return child;
}

function stopProcess(child) {
  if (child === undefined || child.exitCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolveExit) => {
    child.once("exit", resolveExit);
    child.kill();
    setTimeout(() => {
      child.kill("SIGKILL");
      resolveExit();
    }, 5_000).unref();
  });
}

async function waitForHttp(url, label, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const response = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });

      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }

    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${label} at ${url}; it last said: ${child.output.join("")}`,
      );
    }

    await new Promise((resolveTimer) => setTimeout(resolveTimer, 150));
  }
}

/**
 * Presses Tab until the focused element is the named control, and fails if it
 * never is.
 *
 * This is the assertion, not a way of reaching the element: a control that
 * cannot be reached by Tab fails the gate here rather than being clicked into
 * focus and silently passing.
 */
async function tabTo(label, limit = 40) {
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press("Tab");

    const focused = await page.evaluate(() => {
      const active = document.activeElement;

      if (active === null) {
        return "";
      }

      // The accessible name, in the order a screen reader would resolve it.
      // `labels` covers a wrapping `<label>` as well as a `for`/`id` pair, which
      // is how the form field here is named — it carries no `aria-label`.
      const aria = active.getAttribute("aria-label");

      if (aria !== null && aria !== "") {
        return aria;
      }

      const labelled = active.labels?.[0]?.textContent?.trim();

      return labelled !== undefined && labelled !== ""
        ? labelled
        : (active.textContent?.trim() ?? "");
    });

    if (focused === label) {
      return;
    }
  }

  throw new Error(`"${label}" is not reachable with the Tab key`);
}

/** What the canvas currently shows, in the terms the gate is written in. */
function readCanvas() {
  return page.evaluate(() => {
    const surfaces = [...document.querySelectorAll("section[aria-labelledby]")];

    return {
      heading: document.querySelector("h1")?.textContent ?? "",
      surfaces: surfaces.map((surface) => ({
        title: surface.querySelector("h2")?.textContent ?? "",
        region: surface.querySelector("select")?.value ?? "",
      })),
      reasonCodes: (
        [...document.querySelectorAll("p")]
          .map((paragraph) => paragraph.textContent ?? "")
          .find((text) => text.includes("layout.")) ?? ""
      )
        .split(" ")
        .filter((token) => token.includes(".")),
      objectives: [...document.querySelectorAll("li")].map(
        (item) => item.textContent?.trim() ?? "",
      ),
    };
  });
}

/**
 * Polls from Node rather than inside the page, so the predicate stays an
 * ordinary closure and a failure can report the canvas it actually saw.
 */
async function waitForCanvas(predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let state;

  for (;;) {
    state = await readCanvas();

    if (predicate(state)) {
      return state;
    }

    if (Date.now() > deadline) {
      throw new Error(`${label}; the canvas was ${JSON.stringify(state)}`);
    }

    await new Promise((resolveTimer) => setTimeout(resolveTimer, 100));
  }
}

describe("the Objective and Surface slice, driven only by the keyboard", () => {
  before(async () => {
    // `vite dev` resolves `@noctis/ui` and `@noctis/contracts` through their
    // package exports, which point at `dist/`. Without a build there is nothing
    // to serve, and the failure would otherwise surface as an opaque 500.
    assert.ok(
      existsSync(join(REPO_ROOT, "packages/ui/dist/index.js")),
      "run `npm run build` before the E2E suite: it serves the built workspace packages",
    );

    databaseDirectory = mkdtempSync(join(tmpdir(), "noctis-e2e-"));

    core = startProcess(process.execPath, [join(REPO_ROOT, "apps/core/dist/main.js")], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NOCTIS_CORE_TOKEN: TOKEN,
        NOCTIS_CORE_PORT: String(CORE_PORT),
        NOCTIS_DATABASE_PATH: join(databaseDirectory, "core.db"),
        NOCTIS_ALLOWED_ORIGINS: WEB_URL,
        NOCTIS_LOG_LEVEL: "error",
      },
    });

    // The dev server rather than a preview of `dist`: `VITE_CORE_URL` is inlined
    // at build time, so previewing would mean building a bundle that carries a
    // test token. Dev serves the same source and leaves no such artifact.
    web = startProcess(
      process.execPath,
      [
        join(REPO_ROOT, "node_modules/vite/bin/vite.js"),
        "--port",
        String(WEB_PORT),
        "--strictPort",
      ],
      {
        cwd: WEB_ROOT,
        env: {
          ...process.env,
          VITE_CORE_URL: WEB_URL,
          VITE_CORE_TOKEN: TOKEN,
          NOCTIS_CORE_PROXY_TARGET: CORE_URL,
        },
      },
    );

    await waitForHttp(`${CORE_URL}/health`, "the core", core);
    await waitForHttp(WEB_URL, "the web app", web);

    browser = await chromium.launch(CHANNEL === undefined ? {} : { channel: CHANNEL });
    page = await browser.newPage({ viewport: { width: 1900, height: 1000 } });
  });

  after(async () => {
    await page?.close();
    await browser?.close();
    await stopProcess(core);
    await stopProcess(web);

    if (databaseDirectory !== undefined) {
      rmSync(databaseDirectory, { recursive: true, force: true });
    }
  });

  it(
    "THE GATE: activates, arranges, dismisses, and restores without a pointer",
    { timeout: 120_000 },
    async () => {
      await page.goto(WEB_URL);
      await page.getByLabel("New Objective").waitFor();

      // Propose. Enter in the field submits the form, because it is a form.
      await tabTo("New Objective");
      await page.keyboard.type("Prove the Phase 6 slice");
      await page.keyboard.press("Enter");
      await waitForCanvas(
        (state) => state.objectives.some((entry) => entry.includes("suggested")),
        "the proposed Objective never appeared as suggested",
      );

      // suggested -> draft -> active, as two separate acts. There is no
      // shortcut control between them, so this also proves the ladder.
      await tabTo("Accept");
      await page.keyboard.press("Enter");
      await waitForCanvas(
        (state) => state.objectives.some((entry) => entry.includes("draft")),
        "Accept did not move the Objective to draft",
      );

      await tabTo("Activate");
      await page.keyboard.press("Enter");
      await waitForCanvas(
        (state) => state.surfaces.length === 3 && state.heading === "Prove the Phase 6 slice",
        "activating did not compose the Objective's Surfaces",
      );

      const composed = await readCanvas();

      assert.deepEqual(
        composed.surfaces,
        [
          { title: "Choices", region: "left" },
          { title: "Conversation", region: "centre" },
          { title: "Detail", region: "right" },
        ],
        "the wide canvas layout is not what the compositor committed",
      );
      assert.ok(composed.reasonCodes.includes("layout.canvas.split"));
      assert.ok(composed.reasonCodes.includes("display.wide"));

      // Arrange. A closed native <select> changes its value on ArrowDown and
      // fires `change`, so this is the real keyboard interaction rather than
      // Playwright's `selectOption`, which bypasses the keyboard entirely.
      await tabTo("Place Detail");
      await page.keyboard.press("ArrowDown");
      await waitForCanvas(
        (state) =>
          state.reasonCodes.includes("override.honoured") &&
          state.surfaces.some(
            (surface) => surface.title === "Detail" && surface.region === "bottom",
          ),
        "the keyboard override did not move Detail to the control strip",
      );

      // Dismiss.
      await tabTo("Dismiss Choices");
      await page.keyboard.press("Enter");
      await waitForCanvas(
        (state) =>
          state.surfaces.length === 2 &&
          !state.surfaces.some((surface) => surface.title === "Choices") &&
          state.reasonCodes.includes("lifecycle.excluded"),
        "dismissing Choices did not remove it from the composition",
      );

      const beforeReload = await readCanvas();

      // Restore. A reload is the client-side half of the restart the core
      // integration test proves: no re-activation, no Presence screen, and the
      // arrangement still in force.
      await page.reload();
      await waitForCanvas(
        (state) => state.surfaces.length === 2 && state.heading === "Prove the Phase 6 slice",
        "the workbench did not restore the active Objective after a reload",
      );

      const afterReload = await readCanvas();

      assert.deepEqual(
        afterReload.surfaces,
        beforeReload.surfaces,
        "the restored arrangement is not the one the user left",
      );
      assert.ok(
        afterReload.reasonCodes.includes("override.honoured"),
        "the user's placement did not survive the reload",
      );
    },
  );
});

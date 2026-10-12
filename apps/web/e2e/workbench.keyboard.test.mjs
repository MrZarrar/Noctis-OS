import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { TOKEN, launchOptions, startProcess, stopProcess, tabTo, waitForHttp } from "./harness.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const WEB_ROOT = join(REPO_ROOT, "apps/web");

const CORE_PORT = 8791;
const WEB_PORT = 4179;
const CORE_URL = `http://127.0.0.1:${CORE_PORT}`;
const WEB_URL = `http://localhost:${WEB_PORT}`;

let core;
let web;
let browser;
let page;
let databaseDirectory;

/** What the canvas currently shows, in the terms the gate is written in. */
function readCanvas() {
  return page.evaluate(() => {
    const surfaces = [...document.querySelectorAll("section[aria-labelledby]")];

    return {
      heading:
        [...document.querySelectorAll("h1")].find((heading) => heading.checkVisibility())
          ?.textContent ?? "",
      surfaces: surfaces.map((surface) => ({
        title: surface.querySelector("h2")?.textContent ?? "",
        region: surface.dataset.surfaceRegion ?? "",
      })),
      reasonCodes: (document.querySelector("[data-reason-codes]")?.dataset.reasonCodes ?? "").split(
        " ",
      ),
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
          // Command and Artifacts are behind the all-pages flag since v1.
          VITE_NOCTIS_ALL_PAGES: "1",
          NOCTIS_CORE_PROXY_TARGET: CORE_URL,
        },
      },
    );

    await waitForHttp(`${CORE_URL}/health`, "the core", core);
    await waitForHttp(WEB_URL, "the web app", web);

    browser = await chromium.launch(launchOptions());
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
      await tabTo(page, "Command");
      await page.keyboard.press("Enter");
      await page.getByLabel("New Objective").waitFor();

      // Propose. Enter in the field submits the form, because it is a form.
      await tabTo(page, "New Objective");
      await page.keyboard.type("Prove the Phase 6 slice");
      await page.keyboard.press("Enter");
      await waitForCanvas(
        (state) => state.objectives.some((entry) => entry.includes("suggested")),
        "the proposed Objective never appeared as suggested",
      );

      // suggested -> draft -> active, as two separate acts. There is no
      // shortcut control between them, so this also proves the ladder.
      await tabTo(page, "Accept");
      await page.keyboard.press("Enter");
      await waitForCanvas(
        (state) => state.objectives.some((entry) => entry.includes("draft")),
        "Accept did not move the Objective to draft",
      );

      await tabTo(page, "Activate");
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

      await tabTo(page, "Place Detail: Right");
      await page.keyboard.press("Enter");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await waitForCanvas(
        (state) =>
          state.reasonCodes.includes("override.honoured") &&
          state.surfaces.some(
            (surface) => surface.title === "Detail" && surface.region === "bottom",
          ),
        "the keyboard override did not move Detail to the control strip",
      );

      // Dismiss.
      await tabTo(page, "Close Choices");
      await page.keyboard.press("Enter");
      await waitForCanvas(
        (state) =>
          state.surfaces.length === 2 &&
          !state.surfaces.some((surface) => surface.title === "Choices") &&
          state.reasonCodes.includes("lifecycle.excluded"),
        "dismissing Choices did not remove it from the composition",
      );

      assert.ok(
        await page.evaluate(() => document.activeElement !== document.body),
        "Close lost keyboard focus",
      );
      const beforeReload = await readCanvas();

      await page.reload();
      await tabTo(page, "Command");
      await page.keyboard.press("Enter");
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
      const response = await fetch(`${CORE_URL}/objectives`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(response.status, 200);
      const { objectives } = await response.json();
      const objective = objectives.find((entry) => entry.title === "Prove the Phase 6 slice");
      assert.ok(objective);
      const seeded = await fetch(`${CORE_URL}/commands/surface.upsert_intent`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: "keyboard-unplaceable",
          objectiveId: objective.id,
          kind: "detail",
          role: "supporting",
          persistence: "objective",
          priority: 0,
          minSize: "stage",
          payloadVersion: 1,
          payload: { title: "Overflow detail", fields: [] },
        }),
      });
      assert.equal(seeded.status, 200);
      await page.reload();
      await tabTo(page, "Command");
      await page.keyboard.press("Enter");
      await waitForCanvas(
        (state) => state.surfaces.length === 1,
        "panels did not restore with overflow",
      );
      assert.equal(await page.locator("details:not([open])").count(), 1);
      await tabTo(page, "Close Conversation");
      await page.keyboard.press("Enter");
      await waitForCanvas((state) => state.surfaces.length === 0, "last panel did not close");
      assert.equal(
        await page.locator("details:not([open])").count(),
        1,
        "overflow must stay collapsed",
      );
      assert.equal(await page.locator("details li").count(), 1, "overflow entry must remain");
      assert.ok(
        await page.evaluate(
          () =>
            document.activeElement !== document.body && document.activeElement?.checkVisibility(),
        ),
        "closing the last panel must focus a visible surviving target",
      );
    },
  );
});

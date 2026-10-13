import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import {
  TOKEN,
  coreCommand,
  launchOptions,
  startProcess,
  stopProcess,
  tabTo,
  waitForHttp,
} from "./harness.mjs";

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

describe("Threads panels, driven only by the keyboard", () => {
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
          // Exercise every available rail destination.
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
    "THE GATE: arranges, focuses, dismisses, and restores Threads panels without a pointer",
    { timeout: 120_000 },
    async () => {
      const created = await coreCommand(CORE_URL, "conversation.create_thread", {
        idempotencyKey: "keyboard-thread",
        identityId: "vesper",
        title: "Keyboard panels",
      });
      assert.equal(created.status, 200);
      const threadId = created.body.id;
      for (const [kind, payload, preferredRegion, priority] of [
        ["list", { items: [{ id: "a", label: "First choice" }] }, "left", 50],
        ["detail", { fields: [{ label: "Status", value: "Ready" }] }, "right", 40],
      ]) {
        assert.equal(
          (
            await coreCommand(CORE_URL, "surface.upsert_intent", {
              idempotencyKey: "keyboard-" + kind,
              threadId,
              kind,
              role: "primary",
              persistence: "restorable",
              priority,
              minSize: "standard",
              preferredRegion,
              payloadVersion: 1,
              payload,
            })
          ).status,
          200,
        );
      }
      const open = async () => {
        await page.goto(WEB_URL);
        await tabTo(page, "Threads");
        await page.keyboard.press("Enter");
        await tabTo(page, "Conversations");
        await page.keyboard.press("Enter");
        await page.getByRole("button", { name: "Keyboard panels", exact: true }).waitFor();
        await tabTo(page, "Keyboard panels");
        await page.keyboard.press("Enter");
        await waitForCanvas(
          (state) => state.heading === "Threads" && state.surfaces.length > 0,
          "thread panels did not open",
        );
      };
      await open();
      assert.equal(await page.getByRole("button", { name: "Command", exact: true }).count(), 0);
      await tabTo(page, "Place Detail: Right");
      await page.keyboard.press("Enter");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await waitForCanvas(
        (state) =>
          state.surfaces.some(
            (surface) => surface.title === "Detail" && surface.region === "bottom",
          ) && state.reasonCodes.includes("override.honoured"),
        "keyboard placement did not reach Threads",
      );
      await tabTo(page, "Focus Detail");
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Show conversation", exact: true }).waitFor();
      await tabTo(page, "Show conversation");
      await page.keyboard.press("Enter");
      await page.getByRole("button", { name: "Focus Detail", exact: true }).waitFor();
      await tabTo(page, "Close Choices");
      await page.keyboard.press("Enter");
      await waitForCanvas(
        (state) => state.surfaces.length === 1 && state.reasonCodes.includes("lifecycle.excluded"),
        "keyboard close did not dismiss Choices",
      );
      assert.ok(
        await page.evaluate(() => document.activeElement !== document.body),
        "Close lost focus",
      );
      const beforeReload = await readCanvas();
      await open();
      const afterReload = await readCanvas();
      assert.deepEqual(afterReload.surfaces, beforeReload.surfaces);
      assert.ok(afterReload.reasonCodes.includes("override.honoured"));
      assert.equal(
        (
          await coreCommand(CORE_URL, "surface.upsert_intent", {
            idempotencyKey: "keyboard-overflow",
            threadId,
            kind: "verification",
            role: "supporting",
            persistence: "restorable",
            priority: 0,
            minSize: "stage",
            payloadVersion: 1,
            payload: { title: "Overflow checks", items: [] },
          })
        ).status,
        200,
      );
      await open();
      await tabTo(page, "Close Detail");
      await page.keyboard.press("Enter");
      await waitForCanvas((state) => state.surfaces.length === 0, "last drawn panel did not close");
      assert.equal(
        await page
          .getByRole("complementary", { name: "Thread panels" })
          .locator("details:not([open])")
          .count(),
        1,
      );
      assert.ok(
        await page.evaluate(
          () =>
            document.activeElement !== document.body && document.activeElement?.checkVisibility(),
        ),
        "last close lost visible keyboard focus",
      );
    },
  );
});

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { TAB_BAR_HEIGHT } from "@noctis/ui";
import { chromium } from "playwright";

import {
  TOKEN,
  launchOptions,
  startFakeNode,
  startProcess,
  stopProcess,
  tabTo,
  waitFor,
  waitForHttp,
} from "./harness.mjs";

/**
 * The phone shell, from the outside.
 *
 * The rail and the tab bar are both `<nav aria-label="Primary">` — deliberately,
 * because they are the same navigation in two shapes and a screen reader should
 * not have to learn two names for it. So this suite tells them apart the way a
 * user does: by what is in the bar and where it sits.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const WEB_ROOT = join(REPO_ROOT, "apps/web");
const AGENT_MAIN = join(REPO_ROOT, "apps/node-agent/dist/main.js");

const CORE_PORT = 8801;
const WEB_PORT = 4187;
const CORE_URL = `http://127.0.0.1:${CORE_PORT}`;
const WEB_URL = `http://localhost:${WEB_PORT}`;

/** A small phone in portrait, and the desktop the other suites run at. */
const PHONE = { width: 400, height: 860 };
const DESKTOP = { width: 1280, height: 800 };

/** Section 5.2's touch floor. */
const MIN_TARGET = 44;

/** The v1 destinations, in the order the bar and the rail show them. */
const NAV_ITEMS = ["Threads", "Files", "Nodes", "Approvals", "Vault"];

/** Every page the owner can reach without the all-pages flag, with the heading it shows. */
const V1_PAGES = [...NAV_ITEMS, "Settings"];

let core;
let agent;
let web;
let browser;
let page;
let databaseDirectory;
let nodeHome;
let scratch;

/** The primary navigation as it is actually laid out, whichever shape it is in. */
function readNav() {
  return page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Primary"]');

    if (nav === null) {
      return { present: false };
    }

    const buttons = [...nav.querySelectorAll("button")];
    // The shell the bar is fixed over, which has to reserve exactly the bar's
    // height as padding or the last row of content goes under it.
    const shell = nav.parentElement;

    return {
      present: true,
      // `position: fixed` is the tab bar's defining property, not decoration:
      // it is what keeps the bar under the thumb while the page scrolls.
      position: getComputedStyle(nav).position,
      height: nav.getBoundingClientRect().height,
      shellPaddingBottom: shell === null ? null : parseFloat(getComputedStyle(shell).paddingBottom),
      labels: buttons.map((button) => button.textContent?.trim() ?? ""),
      heights: buttons.map((button) => button.getBoundingClientRect().height),
      widths: buttons.map((button) => button.getBoundingClientRect().width),
      // The declaration, not only the outcome: `align-items: stretch` on a
      // 56px bar makes every button 48px tall whether or not it asks to be, so
      // measuring the box alone would not notice the floor being deleted.
      minHeights: buttons.map((button) => parseFloat(getComputedStyle(button).minHeight)),
    };
  });
}

/** What the page is showing, in the terms the gate is written in. */
function readPage() {
  return page.evaluate(() => ({
    heading: document.querySelector("h1")?.textContent ?? "",
    body: document.body.textContent ?? "",
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    clientWidth: document.documentElement.clientWidth,
    approvals: [...document.querySelectorAll('li[data-entry="approval"]')].map(
      (item) => item.textContent?.trim() ?? "",
    ),
    messages: [...document.querySelectorAll('li[data-entry="message"]')].map(
      (item) => item.textContent?.trim() ?? "",
    ),
    // Every control that answers a consequence, with the box a thumb has to hit.
    consequenceControls: [...document.querySelectorAll("button")]
      .filter((button) => ["Confirm", "Decline"].includes(button.textContent?.trim() ?? ""))
      .map((button) => {
        const box = button.getBoundingClientRect();

        return {
          label: button.textContent?.trim() ?? "",
          left: box.left,
          right: box.right,
          height: box.height,
          visible: button.checkVisibility(),
        };
      }),
  }));
}

/** Walks to a page with the keyboard, the way the owner's thumb would tap it. */
async function open(name) {
  await tabTo(page, name);
  await page.keyboard.press("Enter");
  await waitFor(readPage, (state) => state.heading === name, `${name} never opened`);
}

/**
 * Every control on the page a thumb could aim at, measured. Hidden ones are
 * left out: a `<details>` body or a closed sheet is not on screen to miss.
 */
function readControls() {
  return page.evaluate(() =>
    [...document.querySelectorAll("button, select, textarea, input:not([type=hidden]), a[href]")]
      .filter((element) => element.checkVisibility())
      .map((element) => {
        const box = element.getBoundingClientRect();
        const name =
          element.getAttribute("aria-label") ??
          element.labels?.[0]?.textContent?.trim() ??
          element.textContent?.trim() ??
          element.tagName;

        return { name, left: box.left, right: box.right, height: box.height };
      }),
  );
}

/** What the Files page shows before S4 gives it anything to browse. */
function readFiles() {
  return page.evaluate(() => {
    const art = document.querySelector('[data-region="viewer"] img');

    return {
      places: [...document.querySelectorAll('[aria-label="Places"] li')].map(
        (item) => item.textContent?.trim() ?? "",
      ),
      viewer: document.querySelector('[data-region="viewer"]')?.textContent?.trim() ?? "",
      artLoaded: art !== null && art.complete && art.naturalWidth > 0,
    };
  });
}

describe("the phone shell: the rail becomes a tab bar where a rail does not fit", () => {
  before(async () => {
    for (const built of ["packages/ui/dist/index.js", "apps/core/dist/main.js", AGENT_MAIN]) {
      assert.ok(
        existsSync(built.startsWith(REPO_ROOT) ? built : join(REPO_ROOT, built)),
        `run \`npm run build\` before the E2E suite: ${built} is missing`,
      );
    }

    databaseDirectory = mkdtempSync(join(tmpdir(), "noctis-e2e-phone-db-"));
    nodeHome = mkdtempSync(join(tmpdir(), "noctis-e2e-phone-node-"));
    scratch = mkdtempSync(join(tmpdir(), "noctis-e2e-phone-scratch-"));

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
    ({ agent } = await startFakeNode({
      coreUrl: CORE_URL,
      repoRoot: REPO_ROOT,
      agentMain: AGENT_MAIN,
      nodeHome,
      scratch,
      keyPrefix: "e2e-phone",
    }));
    await waitForHttp(WEB_URL, "the web app", web);

    browser = await chromium.launch(launchOptions());
    page = await browser.newPage({ viewport: PHONE });
  });

  after(async () => {
    await page?.close();
    await browser?.close();
    await stopProcess(agent);
    await stopProcess(web);
    await stopProcess(core);

    for (const directory of [databaseDirectory, nodeHome, scratch]) {
      if (directory !== undefined) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it(
    "THE GATE: the v1 tab bar instead of a rail, every target thumb-sized, and nothing to scroll sideways",
    { timeout: 120_000 },
    async () => {
      await page.setViewportSize(PHONE);
      await page.goto(WEB_URL);

      const bar = await waitFor(
        readNav,
        (nav) => nav.present === true,
        "no primary navigation rendered at all",
      );

      assert.equal(
        bar.position,
        "fixed",
        `the rail is still rendered at ${String(PHONE.width)}px: ${JSON.stringify(bar.labels)}`,
      );
      // No "More": the pages behind the flag are not offered unless it is set.
      assert.deepEqual(bar.labels, NAV_ITEMS);

      for (const [index, height] of bar.heights.entries()) {
        assert.ok(
          height >= MIN_TARGET,
          `"${bar.labels[index]}" is ${String(Math.round(height))}px tall, under the ${String(MIN_TARGET)}px touch floor`,
        );
        assert.ok(
          bar.minHeights[index] >= MIN_TARGET,
          `"${bar.labels[index]}" declares min-height ${String(bar.minHeights[index])}px; it only measures ${String(Math.round(height))}px because the bar stretches it, which stops being true the moment the bar's own height changes`,
        );
      }

      // The bar's height and the padding the page reserves for it are one
      // number in two files, so raising the touch floor or the padding slides
      // content under the bar with nothing failing unless this is asserted.
      assert.equal(bar.height, TAB_BAR_HEIGHT, "the bar is not the height it is exported as");
      assert.equal(
        bar.shellPaddingBottom,
        TAB_BAR_HEIGHT,
        "the page reserves a different amount of room than the bar occupies",
      );

      const barWidth = bar.widths.reduce((total, width) => total + width, 0);

      assert.ok(barWidth <= PHONE.width, `the bar's buttons total ${String(barWidth)}px`);
      assert.equal((await readPage()).heading, "Threads", "the phone does not open on Threads");
    },
  );

  it(
    "THE GATE: every v1 page fits a phone, with nothing under the touch floor",
    { timeout: 180_000 },
    async () => {
      await page.setViewportSize(PHONE);

      for (const name of V1_PAGES) {
        // A reload per page, so each one is measured as it first draws rather
        // than after another page left something behind.
        await page.goto(WEB_URL);
        await waitFor(readNav, (nav) => nav.present === true, "no navigation rendered");
        await open(name);
        // Long enough for the page's first read from the core to land.
        await page.waitForTimeout(500);

        const shown = await readPage();

        assert.ok(
          shown.scrollWidth <= PHONE.width,
          `${name} scrolls sideways: scrollWidth ${String(shown.scrollWidth)} at ${String(PHONE.width)}px`,
        );
        // The page scrolls inside the shell; the document itself never does,
        // or the bar rubber-bands with it.
        assert.ok(
          shown.scrollHeight <= PHONE.height,
          `${name} scrolls the whole document: scrollHeight ${String(shown.scrollHeight)}`,
        );

        for (const control of await readControls()) {
          assert.ok(
            control.left >= 0 && control.right <= PHONE.width,
            `${name}: "${control.name}" sits at ${String(Math.round(control.left))}–${String(Math.round(control.right))}px, outside a ${String(PHONE.width)}px screen`,
          );
          assert.ok(
            control.height >= MIN_TARGET,
            `${name}: "${control.name}" is ${String(Math.round(control.height))}px tall, under the ${String(MIN_TARGET)}px touch floor`,
          );
        }
      }
    },
  );

  it(
    "THE GATE: the Files page is laid out for browsing, and says plainly that it is not on yet",
    { timeout: 120_000 },
    async () => {
      await page.setViewportSize(PHONE);
      await page.goto(WEB_URL);
      await open("Files");

      const files = await waitFor(
        readFiles,
        (state) => state.places.length > 0 && state.artLoaded,
        "Files never listed the granted folders beside its empty state",
      );

      // The folder the fake node was granted, on the machine that holds it:
      // the places S4 makes browsable.
      assert.ok(
        files.places.some(
          (place) => place.includes("noctis-e2e-phone-scratch") && place.includes("e2e"),
        ),
        `the granted folder is not among the places: ${JSON.stringify(files.places)}`,
      );
      assert.match(files.viewer, /not switched on yet/);
    },
  );

  it(
    "keeps both answers to a consequence on screen at a phone's width",
    { timeout: 120_000 },
    async () => {
      await page.setViewportSize(PHONE);
      await page.goto(WEB_URL);
      await waitFor(readPage, (state) => state.heading === "Threads", "Threads never opened");

      await tabTo(page, "Message Vesper");
      await page.keyboard.type("ASK: hello");
      await page.keyboard.press("Enter");

      const asked = await waitFor(
        readPage,
        (state) => state.consequenceControls.length >= 2,
        "the runtime's ask never became an approval card with both answers",
        60_000,
      );

      assert.ok(
        asked.scrollWidth <= PHONE.width,
        `an approval card made the page scroll sideways: ${String(asked.scrollWidth)}`,
      );

      for (const control of asked.consequenceControls) {
        assert.ok(control.visible, `${control.label} is not visible`);
        assert.ok(
          control.left >= 0 && control.right <= PHONE.width,
          `${control.label} sits at ${String(Math.round(control.left))}–${String(Math.round(control.right))}px, outside a ${String(PHONE.width)}px screen`,
        );
        assert.ok(
          control.height >= MIN_TARGET,
          `${control.label} is ${String(Math.round(control.height))}px tall`,
        );
      }

      assert.deepEqual(asked.consequenceControls.map((control) => control.label).sort(), [
        "Confirm",
        "Decline",
      ]);

      // The same ask waits on the Approvals page, which is where a push
      // notification sends the owner.
      await open("Approvals");

      const listed = await waitFor(
        readPage,
        (state) => state.consequenceControls.length >= 2,
        "the ask is not on the Approvals page",
      );

      assert.ok(listed.scrollWidth <= PHONE.width, "the Approvals page scrolls sideways");
    },
  );

  it("puts the rail back where there is width for one", { timeout: 120_000 }, async () => {
    await page.setViewportSize(DESKTOP);
    await page.goto(WEB_URL);

    const rail = await waitFor(
      readNav,
      (nav) => nav.present === true && nav.labels.length === NAV_ITEMS.length + 1,
      "the rail did not come back at desktop width",
    );

    // Settings sits at the foot of the rail, apart from the destinations.
    assert.deepEqual(rail.labels, [...NAV_ITEMS, "Settings"]);
    assert.notEqual(rail.position, "fixed", "the tab bar is still rendered at desktop width");
  });
});

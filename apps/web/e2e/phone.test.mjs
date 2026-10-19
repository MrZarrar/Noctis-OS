import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { TAB_BAR_HEIGHT } from "@noctis/ui";
import { chromium } from "playwright";

import {
  TOKEN,
  coreCommand,
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

/** Where the picker and composer screenshots go, when the owner asks for them. */
const EVIDENCE = process.env.NOCTIS_PHONE_EVIDENCE;

/** Section 5.2's touch floor. */
const MIN_TARGET = 44;

/** The v1 destinations, in the order the bar and the rail show them. */
const NAV_ITEMS = ["Presence", "Threads", "Files", "Nodes", "Approvals", "Vault"];

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
  if (name === "Threads") {
    // The tab lands on the list; closing it shows the current chat.
    await tabTo(page, "Close");
    await page.keyboard.press("Enter");
  }
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
        // The part a scrolling page has not clipped away: a row below the fold
        // is not on screen, wherever its box says it is.
        let shownTop = box.top;
        let shownBottom = box.bottom;
        for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
          if (getComputedStyle(parent).overflowY === "visible") continue;
          const clip = parent.getBoundingClientRect();
          shownTop = Math.max(shownTop, clip.top);
          shownBottom = Math.min(shownBottom, clip.bottom);
        }

        return {
          name,
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          height: box.height,
          shownTop,
          shownBottom,
        };
      }),
  );
}

/** The Files page: its places, the open folder's rows, and the viewer if one is up. */
function readFiles() {
  return page.evaluate(() => {
    const viewer = document.querySelector('[data-region="viewer"]');
    const box = viewer?.getBoundingClientRect();

    return {
      places: [...document.querySelectorAll('[aria-label="Places"] li')].map(
        (item) => item.textContent?.trim() ?? "",
      ),
      rows: [...document.querySelectorAll('[aria-label="Folder contents"] li')].map(
        (item) => item.textContent?.trim() ?? "",
      ),
      viewer: viewer?.textContent?.trim() ?? "",
      viewerWidth: box?.width ?? 0,
      viewerHeight: box?.height ?? 0,
    };
  });
}

/** An open picker: its sheet's box and colour, and each row as drawn. */
function readPicker(list) {
  return list.evaluate((element) => {
    const dialog = element.closest("dialog");
    const box = dialog.getBoundingClientRect();

    return {
      background: getComputedStyle(dialog).backgroundColor,
      box: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
      rows: [...element.querySelectorAll('[role="option"]')].map((row) => ({
        text: row.textContent ?? "",
        height: row.getBoundingClientRect().height,
        bottom: row.getBoundingClientRect().bottom,
      })),
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
    // What the Files gate opens: a script and a folder of frames, as an agent leaves them.
    mkdirSync(join(scratch, "frames"));
    writeFileSync(join(scratch, "script.md"), "# Episode one\n\nCold open on the lighthouse.\n");

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

    if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });
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
      assert.equal((await readPage()).heading, "Presence", "the phone does not open on Presence");
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

        // iOS zooms into any field under 16px when it takes focus, and the
        // Home Screen app has no way back out.
        const small = await page.evaluate(() =>
          [...document.querySelectorAll("input, textarea, select")]
            .filter((field) => parseFloat(getComputedStyle(field).fontSize) < 16)
            .map((field) => field.getAttribute("aria-label") ?? field.getAttribute("placeholder")),
        );
        assert.deepEqual(small, [], `${name}: fields under 16px zoom the phone on focus`);
        assert.match(
          (await page.locator('meta[name="viewport"]').getAttribute("content")) ?? "",
          /maximum-scale=1/,
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

        // Where a row lands depends on the data (a long folder path wraps to
        // one more line), so the page's scrolling area itself must stop above
        // the core, or some row will rest under it at some scroll offset.
        const strip = await page.evaluate(() => {
          const core = document
            .querySelector('[aria-label="Open Threads"]')
            ?.getBoundingClientRect();
          const scroller = [...document.querySelectorAll("main section")]
            .find((section) => getComputedStyle(section).overflowY === "auto")
            ?.getBoundingClientRect();
          return core && scroller
            ? { coreTop: core.top, scrollerBottom: scroller.bottom }
            : undefined;
        });
        if (strip !== undefined)
          assert.ok(
            strip.scrollerBottom <= strip.coreTop + 1,
            `${name}: the page scrolls ${String(Math.round(strip.scrollerBottom - strip.coreTop))}px under the corner core`,
          );

        // The core waiting in the corner is a control too, and must not sit on
        // another one — as the page first draws, or scrolled to its very end,
        // where the last row would otherwise come to rest under it.
        for (const where of ["top", "end"]) {
          if (where === "end") {
            await page.evaluate(() => {
              for (const element of document.querySelectorAll("*")) {
                if (element.scrollHeight > element.clientHeight + 1) {
                  element.scrollTop = element.scrollHeight;
                }
              }
            });
            await page.waitForTimeout(200);
            // However short the page is today, its end must stop above the core.
            const rest = await page.evaluate(() => {
              const core = document
                .querySelector('[aria-label="Open Threads"]')
                ?.getBoundingClientRect();
              const scroller = [...document.querySelectorAll("main section")].find(
                (section) => getComputedStyle(section).overflowY === "auto",
              );
              const content = scroller?.firstElementChild?.getBoundingClientRect();
              return core && content
                ? { coreTop: core.top, contentBottom: content.bottom }
                : undefined;
            });
            if (rest !== undefined)
              assert.ok(
                rest.contentBottom <= rest.coreTop + 1,
                `${name}: scrolled to the end, the page's content runs ${String(Math.round(rest.contentBottom - rest.coreTop))}px under the corner core`,
              );
          }
          const controls = await readControls();
          const companion = controls.find((control) => control.name === "Open Threads");
          for (const control of companion === undefined ? [] : controls) {
            if (control === companion) continue;
            assert.ok(
              control.right <= companion.left ||
                control.left >= companion.right ||
                control.shownBottom <= companion.top ||
                control.shownTop >= companion.bottom,
              `${name}, at the ${where}: the corner core covers "${control.name}"`,
            );
          }
        }
      }
    },
  );

  it(
    "THE GATE: scrolled on a short phone, Presence's core goes under the header, never over it",
    { timeout: 60_000 },
    async () => {
      const SHORT = { width: 400, height: 560 };
      await page.setViewportSize(SHORT);
      await page.goto(WEB_URL);
      await waitFor(readPage, (state) => state.heading === "Presence", "Presence never drew");
      await page.evaluate(() => {
        const presence = document.querySelector('section[aria-label="Presence"]');
        presence.scrollTop = presence.scrollHeight;
      });

      const covered = await waitFor(
        () =>
          page.evaluate(() => {
            const header = document.querySelector("header");
            const dock = document.querySelector("[data-core-dock]");
            const top = header.getBoundingClientRect();
            const core = document.querySelector(".noctis-intelligence").getBoundingClientRect();
            const y = (Math.max(top.top, core.top) + top.bottom) / 2;
            // The core lets taps through, so elementFromPoint would look past
            // it whatever it painted over. Catching taps for a moment makes it
            // answer by what is actually on top.
            dock.style.pointerEvents = "auto";
            const hit = document.elementFromPoint(top.left + top.width / 2, y);
            dock.style.pointerEvents = "none";
            return {
              under: core.top < top.bottom,
              headerOnTop: header.contains(hit),
              hit: hit?.outerHTML.slice(0, 80),
            };
          }),
        (state) => state.under,
        "Presence did not scroll far enough for its core to reach the header",
      );
      assert.ok(covered.headerOnTop, `the core paints over the header: ${covered.hit}`);
    },
  );

  it("goes back with the phone's back gesture: list, then page", { timeout: 120_000 }, async () => {
    await page.setViewportSize(PHONE);
    await page.goto(WEB_URL);
    await open("Threads");
    await tabTo(page, "Conversations");
    await page.keyboard.press("Enter");
    await waitFor(readPage, (s) => s.body.includes("New conversation"), "the list never opened");

    await page.goBack();
    await waitFor(
      readPage,
      (s) => !s.body.includes("New conversation"),
      "back did not close the list",
    );
    assert.equal((await readPage()).heading, "Threads");

    await page.goBack();
    await waitFor(readPage, (s) => s.heading === "Presence", "back did not leave Threads");
  });

  it(
    "THE GATE: from the phone, a shared folder opens and a script in it fills the screen",
    { timeout: 120_000 },
    async () => {
      await page.setViewportSize(PHONE);
      await page.goto(WEB_URL);
      await open("Files");

      const files = await waitFor(
        readFiles,
        (state) => state.places.length > 0,
        "Files never listed the shared folders",
      );

      // The folder the fake node shares, on the machine that holds it.
      const place = files.places.find(
        (candidate) => candidate.includes("noctis-e2e-phone-scratch") && candidate.includes("e2e"),
      );
      assert.ok(
        place,
        `the shared folder is not among the places: ${JSON.stringify(files.places)}`,
      );

      await tabTo(page, place);
      await page.keyboard.press("Enter");

      const folder = await waitFor(
        readFiles,
        (state) => state.rows.some((row) => row.includes("script.md")),
        "opening the place never listed what is in it, through the node",
      );
      assert.ok(
        folder.rows.some((row) => row.startsWith("frames") && row.includes("folder")),
        `the subfolder is not listed as one: ${JSON.stringify(folder.rows)}`,
      );

      await tabTo(page, folder.rows.find((row) => row.startsWith("script.md")) ?? "script.md");
      await page.keyboard.press("Enter");

      const opened = await waitFor(
        readFiles,
        (state) => state.viewer.includes("# Episode one"),
        "the script never opened in the viewer",
      );

      // A phone shows a file as its own screen, not a box under the list.
      assert.equal(Math.round(opened.viewerWidth), PHONE.width);
      assert.ok(
        opened.viewerHeight >= PHONE.height - 1,
        `the viewer is ${String(opened.viewerHeight)}px tall on an ${String(PHONE.height)}px phone`,
      );

      await tabTo(page, "Close");
      await page.keyboard.press("Enter");
      await waitFor(
        readFiles,
        (state) => state.rows.length > 0 && state.viewer === "",
        "Close did not go back to the folder",
      );
    },
  );

  it(
    "opens a file an agent wrote straight from the thread it wrote it in",
    { timeout: 120_000 },
    async () => {
      await page.setViewportSize(PHONE);
      await page.goto(WEB_URL);
      await open("Threads");

      await tabTo(page, "Message Vesper");
      await page.keyboard.type("WRITE: the opening scene");
      await page.keyboard.press("Enter");

      await waitFor(
        readPage,
        (state) => state.body.includes("Open written.md"),
        "the turn's written file was never offered from the thread",
        60_000,
      );
      await tabTo(page, "Open written.md");
      await page.keyboard.press("Enter");

      await waitFor(
        readFiles,
        (state) => state.viewer.includes("# Written by the fake"),
        "the written file did not open in the viewer",
      );
    },
  );

  it(
    "THE GATE: continues a session started outside Noctis, from the phone",
    { timeout: 120_000 },
    async () => {
      await page.setViewportSize(PHONE);
      await page.goto(WEB_URL);
      await open("Threads");

      await tabTo(page, "Conversations");
      await page.keyboard.press("Enter");
      await tabTo(page, "Continue a session");
      await page.keyboard.press("Enter");

      // The folder the fake node shares, then the session its agent keeps there.
      const places = await waitFor(
        readPage,
        (state) => state.body.includes("noctis-e2e-phone-scratch"),
        "Continue a session never offered the shared folder",
      );
      const place = places.body.match(/noctis-e2e-phone-scratch-[A-Za-z0-9]+ on e2e/)?.[0];
      assert.ok(place, "no place label found");
      await tabTo(page, place);
      await page.keyboard.press("Enter");

      await waitFor(
        readPage,
        (state) => state.body.includes("Cold open from VS Code"),
        "the folder's sessions were never listed",
        30_000,
      );
      await tabTo(page, "Cold open from VS Code");
      await page.keyboard.press("Enter");

      const opened = await waitFor(
        readPage,
        (state) => state.heading === "Threads" && state.body.includes("Continuing"),
        "the session did not open as a pinned thread",
      );
      assert.ok(
        !opened.body.includes("PC and folder"),
        "a pinned thread still offers to run somewhere else",
      );

      // What was said in VS Code shows above the thread, read-only and marked as such.
      const earlier = await waitFor(
        readPage,
        (state) => state.body.includes("Find a sharper first line"),
        "the session's history from before Noctis never showed",
        30_000,
      );
      assert.ok(earlier.body.includes("Before Noctis"), "the history is not marked as earlier");
      assert.ok(
        !earlier.messages.some((m) => m.includes("Find a sharper first line")),
        "the earlier exchange shows as one of this thread's own messages",
      );

      await tabTo(page, "Message Vesper");
      await page.keyboard.type("carry on");
      await page.keyboard.press("Enter");

      // The fake says when it was asked to fork, and which session it forked.
      await waitFor(
        readPage,
        (state) => state.messages.some((m) => m.includes("forked fake-vscode-session")),
        "the first turn did not fork the adopted session",
        60_000,
      );
    },
  );

  it(
    "opens a new conversation from the list the Threads tab lands on, and lists it first",
    { timeout: 120_000 },
    async () => {
      await page.setViewportSize(PHONE);
      await page.goto(WEB_URL);
      await tabTo(page, "Threads");
      await page.keyboard.press("Enter");

      await tabTo(page, "New conversation");
      await page.keyboard.press("Enter");
      // Tabbing while the list is still up runs out of tabs before the composer.
      await waitFor(
        readPage,
        (state) => !state.body.includes("Show archived"),
        "the new conversation never opened",
      );

      await tabTo(page, "Message Vesper");
      await page.keyboard.type("a fresh topic");
      await page.keyboard.press("Enter");
      await waitFor(
        readPage,
        (state) => state.messages.some((m) => m.includes("Hello a fresh topic")),
        "the new conversation never answered",
        60_000,
      );

      await tabTo(page, "Conversations");
      await page.keyboard.press("Enter");

      const rows = page.getByRole("region", { name: "Conversations" }).locator("li > button");

      await waitFor(
        () => rows.first().getAttribute("aria-label"),
        (label) => label === "Hello a fresh topic",
        "the new conversation is not first on the list",
      );
    },
  );

  it(
    "renames a conversation, archives it off the list, and restores it, from the phone",
    { timeout: 120_000 },
    async () => {
      await page.setViewportSize(PHONE);
      await page.goto(WEB_URL);
      await open("Threads");

      await tabTo(page, "Conversations");
      await page.keyboard.press("Enter");
      await tabTo(page, "New conversation");
      await page.keyboard.press("Enter");
      await waitFor(
        readPage,
        (state) => !state.body.includes("Show archived"),
        "the new conversation never opened",
      );
      await tabTo(page, "Message Vesper");
      await page.keyboard.type("untidy name");
      await page.keyboard.press("Enter");
      await waitFor(
        readPage,
        (state) => state.messages.some((m) => m.includes("Hello untidy name")),
        "the conversation never answered",
        60_000,
      );

      await tabTo(page, "Conversations");
      await page.keyboard.press("Enter");
      await waitFor(
        readPage,
        (state) => state.body.includes("Hello untidy name"),
        "the list never showed the conversation",
      );
      // Untitled, it is named by its newest line: the reply.
      await tabTo(page, "Rename Hello untidy name");
      await page.keyboard.press("Enter");
      // The name field takes the focus as it opens: no tabbing to reach it.
      await waitFor(
        () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""),
        (focused) => focused === "Conversation name",
        "Rename did not put the focus in the name field",
      );
      await page.keyboard.press("Control+A");
      await page.keyboard.type("Hook ideas");
      await page.keyboard.press("Enter");
      await waitFor(
        readPage,
        (state) => state.body.includes("Hook ideas"),
        "the conversation was not renamed",
      );

      await tabTo(page, "Archive Hook ideas");
      await page.keyboard.press("Enter");
      await waitFor(
        readPage,
        (state) =>
          state.body.includes("Show archived") &&
          !state.body.includes("Loading…") &&
          !state.body.includes("Hook ideas"),
        "the archived conversation is still on the list",
      );

      await tabTo(page, "Show archived");
      await page.keyboard.press("Enter");
      await waitFor(
        readPage,
        (state) => state.body.includes("Hook ideas") && state.body.includes("Show current"),
        "the archive does not hold the conversation",
      );
      await tabTo(page, "Restore Hook ideas");
      await page.keyboard.press("Enter");
      await tabTo(page, "Show current");
      await page.keyboard.press("Enter");
      await waitFor(
        readPage,
        (state) => state.body.includes("Hook ideas") && state.body.includes("Show archived"),
        "the restored conversation is not back on the list",
      );
    },
  );

  it(
    "holds its place while the owner reads back, and follows again once they send",
    { timeout: 120_000 },
    async () => {
      /** The thread's scrolling box: how far from its end the owner is, and moving it. */
      const scroller = (action) =>
        page.evaluate((what) => {
          let box = document.querySelector('ul[aria-label="Conversation"]');

          while (box !== null && getComputedStyle(box).overflowY !== "auto") {
            box = box.parentElement;
          }

          if (box === null) {
            return -1;
          }

          if (what === "top") {
            box.scrollTop = 0;
          }

          return box.scrollHeight - box.scrollTop - box.clientHeight;
        }, action);

      await page.setViewportSize(PHONE);
      await page.goto(WEB_URL);
      await open("Threads");
      await tabTo(page, "Conversations");
      await page.keyboard.press("Enter");
      await tabTo(page, "New conversation");
      await page.keyboard.press("Enter");
      await waitFor(
        readPage,
        (state) => !state.body.includes("Show archived"),
        "the new conversation never opened",
      );

      // Long enough to fill the screen twice over, and slow enough to scroll during.
      await tabTo(page, "Message Vesper");
      await page.keyboard.type(`SLOW: ${"a long line to read back through ".repeat(80)}`);
      await page.keyboard.press("Enter");
      // The fake answers 600 ms into its turn: scroll up as soon as the prompt shows.
      await waitFor(
        readPage,
        (state) => state.messages.some((m) => m.startsWith("You") && m.includes("SLOW")),
        "the prompt never showed",
        30_000,
      );

      const away = await scroller("top");
      assert.ok(away > 400, `the thread is too short to scroll back through (${String(away)}px)`);
      await waitFor(
        readPage,
        (state) => state.messages.some((m) => m.includes("Hello SLOW")),
        "the reply never finished",
        30_000,
      );
      const held = await scroller("read");
      assert.ok(
        held > 400,
        `the reply pulled the owner back down (${String(held)}px from the end)`,
      );

      await tabTo(page, "Message Vesper");
      await page.keyboard.type("SLOW: and now");
      await page.keyboard.press("Enter");
      await waitFor(
        readPage,
        (state) => state.messages.some((m) => m.includes("Hello SLOW: and now")),
        "the second reply never finished",
        30_000,
      );
      // The page may still be on its way down when the reply lands.
      await waitFor(
        () => scroller("read"),
        (distance) => distance >= 0 && distance < 80,
        "sending did not follow the thread again",
        5_000,
      );
    },
  );

  it(
    "never lets the document scroll under a long thread, so no black band opens below",
    { timeout: 120_000 },
    async () => {
      await page.setViewportSize(DESKTOP);
      await page.goto(WEB_URL);
      await open("Threads");
      // Each message's spoken label is placed where its bubble is; four long
      // messages put the last one far below the screen.
      for (let index = 0; index < 4; index += 1) {
        await tabTo(page, "Message Vesper");
        await page.keyboard.type(
          `${String(index)} ${"a long line to read back through ".repeat(60)}`,
        );
        await page.keyboard.press("Enter");
        await waitFor(
          readPage,
          (state) => state.messages.filter((m) => m.startsWith("You")).length > index,
          `message ${String(index)} never showed`,
          30_000,
        );
      }

      const overflow = await page.evaluate(
        () => document.documentElement.scrollHeight - document.documentElement.clientHeight,
      );
      assert.ok(overflow <= 0, `the document scrolls ${String(overflow)}px past the screen`);
    },
  );

  it(
    "keeps Conversations on screen after reading down a long thread",
    { timeout: 120_000 },
    async () => {
      await page.setViewportSize(PHONE);
      await page.goto(WEB_URL);
      await open("Threads");
      await tabTo(page, "Message Vesper");
      await page.keyboard.type(`${"a long line to read back through ".repeat(120)}`);
      await page.keyboard.press("Enter");
      await waitFor(
        readPage,
        (state) => state.messages.some((m) => m.startsWith("You")),
        "never sent",
        30_000,
      );

      await page.evaluate(() => {
        const list = document.querySelector('ul[aria-label="Conversation"]');
        let box = list;

        while (box !== null && getComputedStyle(box).overflowY !== "auto") {
          box = box.parentElement;
        }

        box.scrollTop = box.scrollHeight;
      });

      const button = await page.getByRole("button", { name: "Conversations" }).boundingBox();
      assert.ok(
        button !== null && button.y >= 0 && button.y < 200,
        `Conversations is at ${JSON.stringify(button)}`,
      );
    },
  );

  it(
    "keeps both answers to a consequence on screen at a phone's width",
    { timeout: 120_000 },
    async () => {
      await page.setViewportSize(PHONE);
      await page.goto(WEB_URL);
      await open("Threads");

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

      // The tab says how many are waiting, and is still called Approvals.
      await waitFor(
        () =>
          page.evaluate(
            () =>
              document
                .querySelector('nav[aria-label="Primary"] button[aria-label="Approvals"]')
                ?.getAttribute("title") ?? "",
          ),
        (title) => /^[1-9]\d* waiting$/.test(title),
        "the Approvals tab does not say how many are waiting",
      );

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

  it(
    "picks the PC and folder from a sheet in the app's own glass",
    { timeout: 120_000 },
    async () => {
      await page.setViewportSize(PHONE);
      await page.goto(WEB_URL);
      await open("Threads");
      const button = page.getByRole("button", { name: /^PC and folder/ });
      const before = await button.getAttribute("aria-label");
      await button.click();
      const list = page.getByRole("listbox", { name: "PC and folder" });
      await list.waitFor();

      const sheet = await readPicker(list);
      assert.notEqual(sheet.background, "rgb(255, 255, 255)");
      // A bottom sheet: edge to edge, resting on the bottom of the screen.
      assert.equal(Math.round(sheet.box.left), 0);
      assert.equal(Math.round(sheet.box.right), PHONE.width);
      assert.equal(Math.round(sheet.box.bottom), PHONE.height);
      for (const row of sheet.rows) {
        assert.ok(row.height >= MIN_TARGET, `"${row.text}" is ${String(row.height)}px tall`);
        assert.ok(row.bottom <= PHONE.height, `"${row.text}" is below the screen`);
      }
      if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, "picker-phone.png") });

      await page.getByRole("option").nth(1).click();
      await list.waitFor({ state: "hidden" });
      assert.notEqual(await button.getAttribute("aria-label"), before, "the pick did not take");
      assert.equal(await page.locator("select").count(), 0, "a native select is still on the page");
    },
  );

  it(
    "opens a picker beside its button on a desktop, and drives it from the keyboard",
    { timeout: 120_000 },
    async () => {
      await page.setViewportSize(DESKTOP);
      await page.goto(WEB_URL);
      await open("Threads");
      // A long thread loads and follows its own end after the page opens, and a real
      // scroll closes an open picker, so wait until the entries and scroll hold still.
      let last;
      let steady = 0;
      await waitFor(
        () =>
          page.evaluate(
            () =>
              `${String(document.querySelectorAll("[data-entry]").length)}:${String(
                [...document.querySelectorAll("*")].reduce((sum, node) => sum + node.scrollTop, 0),
              )}`,
          ),
        (sample) => {
          steady = sample === last ? steady + 1 : 0;
          last = sample;
          return steady >= 5;
        },
        "the thread did not settle",
      );

      const button = page.getByRole("button", { name: /^PC and folder/ });
      const list = page.getByRole("listbox", { name: "PC and folder" });
      const focused = () =>
        page.evaluate(() => ({
          text: document.activeElement?.textContent ?? "",
          selected: document.activeElement?.getAttribute("aria-selected") ?? null,
          label: document.activeElement?.getAttribute("aria-label") ?? "",
        }));

      await button.focus();
      await page.keyboard.press("Enter");
      await list.waitFor();

      // The composer sits at the foot of the screen, so the list opens upward.
      const above = await readPicker(list);
      const anchor = await button.boundingBox();
      assert.ok(
        above.box.bottom <= anchor.y,
        `the list covers its button: ${JSON.stringify(above)}`,
      );
      assert.ok(
        above.box.top >= 0 && above.box.right <= DESKTOP.width,
        "the list leaves the screen",
      );
      assert.equal((await focused()).selected, "true", "the chosen row did not take the focus");
      if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, "picker-desktop.png") });

      const rows = above.rows.map((row) => row.text);
      await page.keyboard.press("End");
      assert.equal((await focused()).text, rows.at(-1));
      await page.keyboard.press("Home");
      assert.equal((await focused()).text, rows[0]);

      await page.keyboard.press("Escape");
      await list.waitFor({ state: "hidden" });
      assert.match((await focused()).label, /^PC and folder/, "Escape lost the focus");

      await page.keyboard.press("Enter");
      await list.waitFor();
      await page.keyboard.press("ArrowDown");
      const next = (await focused()).text;
      await page.keyboard.press("Enter");
      await list.waitFor({ state: "hidden" });
      const picked = await focused();
      assert.match(picked.label, /^PC and folder/, "picking lost the focus");
      assert.ok(next.startsWith(picked.label.replace("PC and folder: ", "")), picked.label);

      // At the top of a page there is room below, so it opens there.
      await open("Settings");
      const vesper = page.getByRole("button", { name: /^Vesper: / });
      await vesper.click();
      const below = await readPicker(page.getByRole("listbox", { name: "Vesper" }));
      const settingsAnchor = await vesper.boundingBox();
      assert.ok(
        below.box.top >= settingsAnchor.y + settingsAnchor.height,
        `the list did not open under its button: ${JSON.stringify(below.box)}`,
      );
      assert.ok(below.box.bottom <= DESKTOP.height, "the list runs off the screen");
      if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, "picker-desktop-below.png") });
      await page.mouse.click(5, 5);
      await page.getByRole("listbox", { name: "Vesper" }).waitFor({ state: "hidden" });
    },
  );

  it(
    "shows nothing of the thread under the composer on a desktop",
    { timeout: 120_000 },
    async () => {
      await page.setViewportSize(DESKTOP);
      await page.goto(WEB_URL);
      await open("Threads");
      await tabTo(page, "Message Vesper");
      await page.keyboard.type(`${"a long line to read back through ".repeat(120)}`);
      await page.keyboard.press("Enter");
      await waitFor(
        readPage,
        (state) => state.messages.some((m) => m.startsWith("You")),
        "never sent",
        30_000,
      );

      /** Scrolls the thread `up` px from its end, then finds any text drawn below the composer. */
      const underComposer = (up) =>
        page.evaluate((distance) => {
          const list = document.querySelector('ul[aria-label="Conversation"]');
          const composer = [...document.querySelectorAll("textarea")]
            .find((box) => box.checkVisibility())
            .closest("form").parentElement;
          let box = list;

          while (box !== null && getComputedStyle(box).overflowY !== "auto") {
            box = box.parentElement;
          }

          box.scrollTop = box.scrollHeight - box.clientHeight - distance;
          const floor = composer.getBoundingClientRect().bottom;
          const edge = Math.min(box.getBoundingClientRect().bottom, globalThis.innerHeight);
          const seen = [];
          const walker = document.createTreeWalker(list, globalThis.NodeFilter.SHOW_TEXT);

          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            // The 1px spoken labels are for screen readers, not drawn.
            if (node.textContent.trim() === "" || node.parentElement.clientWidth <= 1) continue;
            const range = document.createRange();
            range.selectNodeContents(node);

            for (const rect of range.getClientRects()) {
              // Range geometry extends past the scroll clip; only its painted intersection counts.
              if (rect.height > 1 && Math.min(rect.bottom, edge) > floor + 0.5 && rect.top < edge) {
                seen.push(node.textContent.trim().slice(0, 40));
              }
            }
          }

          return { gap: edge - floor, seen };
        }, up);

      const atEnd = await underComposer(0);
      assert.deepEqual(atEnd.seen, [], "thread text shows under the composer at the end");
      const readingBack = await underComposer(300);
      assert.deepEqual(readingBack.seen, [], "thread text shows under the composer");
      assert.ok(
        Math.abs(readingBack.gap) <= 1,
        `the composer floats ${String(readingBack.gap)}px above the bottom edge`,
      );
      if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, "threads-composer-desktop.png") });
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
  it(
    "THE GATE (panel present): phone tray and sheet fit with usable composer",
    { timeout: 120000 },
    async () => {
      await page.setViewportSize(PHONE);
      await page.goto(WEB_URL);
      await open("Threads");
      const thread = await coreCommand(CORE_URL, "conversation.create_thread", {
        idempotencyKey: "phone-gate-thread",
        identityId: "vesper",
        title: "Panel gate",
      });
      assert.equal(thread.status, 200);
      await page.getByRole("button", { name: "Conversations", exact: true }).click();
      await page.getByRole("button", { name: "Panel gate", exact: true }).click();
      await page
        .locator('section[aria-label="Threads"] header')
        .getByText(/Panel gate/)
        .waitFor();
      const result = await coreCommand(CORE_URL, "surface.upsert_intent", {
        idempotencyKey: "phone-gate-panel",
        threadId: thread.body.id,
        kind: "detail",
        role: "primary",
        persistence: "ephemeral",
        priority: 100,
        minSize: "compact",
        sourceIds: ["0199a000-0000-7000-8000-0000000000d1"],
        payloadVersion: 1,
        payload: { fields: [{ label: "Phone", value: "Panel present" }] },
      });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      await page.reload();
      await open("Threads");
      await page.getByRole("button", { name: "Conversations", exact: true }).click();
      await page.getByRole("button", { name: "Panel gate", exact: true }).click();
      const chip = page.getByRole("button", { name: "Open panel Detail", exact: true });
      await chip.waitFor();
      for (const opened of [false, true]) {
        if (opened) await chip.click();
        const shown = await readPage();
        assert.ok(shown.scrollWidth <= PHONE.width);
        assert.ok(shown.scrollHeight <= PHONE.height);
        for (const control of await readControls()) {
          assert.ok(control.height >= MIN_TARGET, control.name);
          assert.ok(control.left >= 0 && control.right <= PHONE.width, control.name);
        }
        assert.equal(await page.getByLabel("Message Vesper").isVisible(), true);
      }
      await page.goBack();
    },
  );
});

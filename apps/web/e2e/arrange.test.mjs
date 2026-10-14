/* global window, localStorage, Storage */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, it } from "node:test";
import { chromium } from "playwright";
import {
  TOKEN,
  coreCommand,
  startProcess,
  stopProcess,
  waitForHttp,
  waitFor,
  launchOptions,
} from "./harness.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
const CORE_URL = "http://127.0.0.1:8843";
const WEB_URL = "http://localhost:4199";
let core, web, browser, page, directory, threadId;
let sequence = 0;
const evidence = join(ROOT, ".noctis/panels");
before(async () => {
  directory = mkdtempSync(join(tmpdir(), "noctis-arrange-"));
  core = startProcess(process.execPath, [join(ROOT, "apps/core/dist/main.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      NOCTIS_CORE_TOKEN: TOKEN,
      NOCTIS_CORE_PORT: "8843",
      NOCTIS_DATABASE_PATH: join(directory, "core.db"),
      NOCTIS_ALLOWED_ORIGINS: WEB_URL,
      NOCTIS_LOG_LEVEL: "error",
    },
  });
  web = startProcess(
    process.execPath,
    [join(ROOT, "node_modules/vite/bin/vite.js"), "--port", "4199", "--strictPort"],
    {
      cwd: join(ROOT, "apps/web"),
      env: {
        ...process.env,
        VITE_CORE_URL: WEB_URL,
        VITE_CORE_TOKEN: TOKEN,
        VITE_NOCTIS_ALL_PAGES: "1",
        NOCTIS_CORE_PROXY_TARGET: CORE_URL,
      },
    },
  );
  await waitForHttp(`${CORE_URL}/health`, "arrange core", core);
  await waitForHttp(WEB_URL, "arrange web", web);
  browser = await chromium.launch(launchOptions());
  page = await browser.newPage({ viewport: { width: 2200, height: 1000 } });
  mkdirSync(evidence, { recursive: true });
});
after(async () => {
  await browser?.close();
  await stopProcess(web);
  await stopProcess(core);
  if (directory) rmSync(directory, { recursive: true, force: true });
});
async function open(title = "Arrange gate") {
  await page.goto(WEB_URL);
  await page
    .getByRole("button", { name: "Threads", exact: true })
    .or(page.getByLabel("Core token"))
    .first()
    .waitFor();
  if (await page.getByLabel("Core token").count()) {
    await page.getByLabel("Core token").fill(TOKEN);
    await page.getByLabel("Core token").press("Enter");
  }
  await page.getByRole("button", { name: "Threads", exact: true }).click();
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await page.getByRole("button", { name: title, exact: true }).click();
}
const frames = () => page.locator('[aria-label="Thread panels"] [data-surface-id]');
const panel = (id) => page.locator(`[data-surface-id="${id}"]`);
async function snapshot() {
  return frames().evaluateAll((nodes) =>
    nodes.map((node) => ({ id: node.dataset.surfaceId, region: node.dataset.surfaceRegion })),
  );
}
const box = (id) => panel(id).boundingBox();
const floating = (id) =>
  panel(id).evaluate((node) => getComputedStyle(node.parentElement).position === "fixed");
const layer = (id) =>
  panel(id).evaluate((node) => Number(getComputedStyle(node.parentElement).zIndex));
const title = (id) => panel(id).locator("h2").first();
const edge = (id, name) => page.locator(`[data-panel-window="${id}"] [data-resize-edge="${name}"]`);
async function dragBy(handle, dx, dy, cancel) {
  const from = await handle.boundingBox();
  const x = from.x + Math.min(from.width / 2, 40),
    y = from.y + from.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  if (cancel === "escape") await page.keyboard.press("Escape");
  if (cancel === "pointer") await handle.dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
}
/** The panel-enter slide must finish before a box is measured. */
const settle = () =>
  page.waitForFunction(() =>
    document
      .getAnimations()
      .filter((animation) => animation.effect?.target?.closest?.("[data-panel-window]"))
      .every((animation) => animation.playState === "finished"),
  );
function near(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 3, `${label}: expected ${expected}, got ${actual}`);
}
async function geometry() {
  return page.evaluate(() =>
    Object.fromEntries(
      Object.entries(localStorage).filter(([key]) => key.startsWith("noctis.panelGeometry:")),
    ),
  );
}
it(
  "panels float: drag anywhere, resize from edges, raise, keyboard, refusal, reload, focus and phone",
  { timeout: 120000 },
  async () => {
    const thread = await coreCommand(CORE_URL, "conversation.create_thread", {
      idempotencyKey: "arrange-thread",
      identityId: "vesper",
      title: "Arrange gate",
    });
    assert.equal(thread.status, 200);
    threadId = thread.body.id;
    const ids = [];
    for (const [name, role] of [
      ["Main", "primary"],
      ["One", "supporting"],
      ["Two", "supporting"],
      ["Controls", "control"],
    ]) {
      const created = await coreCommand(CORE_URL, "surface.upsert_intent", {
        idempotencyKey: `arrange-panel-${++sequence}`,
        threadId,
        kind: "detail",
        role,
        persistence: "restorable",
        priority: 0,
        minSize: "compact",
        payloadVersion: 1,
        payload: { fields: [{ label: name, value: `Readable ${name} content` }], actions: [] },
        sourceIds: [`01941f29-7c00-7000-8000-${String(sequence).padStart(12, "0")}`],
        artifactIds: [],
      });
      assert.equal(created.status, 200);
      ids.push(created.body.id);
    }
    // The upsert deduplication contract requires unique sources for otherwise identical kinds.
    assert.equal(new Set(ids).size, 4);
    const [mainId, one, two] = ids;
    await open();
    await waitFor(snapshot, (value) => value.length === 4, "four arrange panels did not render");
    assert.equal(await page.getByText("Readable Main content", { exact: true }).count(), 1);
    await settle();

    // No predefined places: no drop chips, separators or Place picker, and every panel floats.
    assert.equal(await page.getByRole("separator").count(), 0);
    assert.equal(await page.getByRole("button", { name: /^Place / }).count(), 0);
    for (const id of ids) assert.equal(await floating(id), true, `${id} did not float`);
    // Overlapping windows must not show through each other.
    const backing = await panel(mainId).evaluate(
      (node) => getComputedStyle(node.parentElement).backgroundColor,
    );
    assert.match(backing, /^rgb\(/, `window backing was not opaque: ${backing}`);
    const opened = await Promise.all(ids.map(box));

    for (const [index, b] of opened.entries()) {
      assert.ok(b.x + b.width <= 2200 && b.y + b.height <= 1000, "a panel opened off screen");
      for (const other of opened.slice(index + 1))
        assert.ok(
          b.x + b.width <= other.x || other.x + other.width <= b.x,
          "new panels opened on top of each other",
        );
    }
    assert.ok(Math.max(...opened.map((b) => b.x + b.width)) > 2100, "panels did not start right");

    // Drag anywhere; only the dragged panel moves.
    const start = await box(mainId);
    const others = await Promise.all([one, two].map(box));
    await dragBy(title(mainId), -900, 150);
    let moved = await box(mainId);
    near(moved.x, start.x - 900, "dragged x");
    near(moved.y, start.y + 150, "dragged y");
    assert.deepEqual(await Promise.all([one, two].map(box)), others, "a drag moved other panels");
    await dragBy(title(mainId), 300, 0, "escape");
    assert.deepEqual(await box(mainId), moved, "Escape kept a cancelled drag");
    await dragBy(title(mainId), 300, 0, "pointer");
    assert.deepEqual(await box(mainId), moved, "pointercancel kept a cancelled drag");

    // Resize from a corner and from the far edge, which stops at the kind's minimum.
    await dragBy(edge(mainId, "se"), 120, 80);
    const grown = await box(mainId);
    near(grown.width, moved.width + 120, "corner width");
    near(grown.height, moved.height + 80, "corner height");
    near(grown.x, moved.x, "corner resize kept the left edge");
    await dragBy(edge(mainId, "w"), 2000, 0);
    const narrowed = await box(mainId);
    assert.ok(narrowed.width >= 239, "panel shrank below detail minimum");
    near(narrowed.x + narrowed.width, grown.x + grown.width, "west resize kept the right edge");

    // Clicking a panel brings it to the front.
    await title(one).click();
    assert.ok((await layer(one)) > (await layer(mainId)), "clicked panel stayed behind");

    // Keyboard: arrows move, Shift+arrows resize.
    const keyed = await box(two);
    await title(two).focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Shift+ArrowDown");
    near((await box(two)).x, keyed.x - 32, "keyboard move");
    near((await box(two)).height, keyed.height + 32, "keyboard resize");

    // A refused save says so and leaves the panel where it was.
    const saved = await geometry();
    const beforeRefusal = await box(two);
    await page.evaluate(() => {
      window.arrangeSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = () => {
        throw new Error("test blocked storage");
      };
    });
    await dragBy(title(two), -200, 0);
    await page.getByRole("alert").filter({ hasText: "Could not save these panel sizes" }).waitFor();
    assert.deepEqual(await geometry(), saved);
    assert.deepEqual(await box(two), beforeRefusal, "refused storage kept the new place");
    await page.evaluate(() => {
      Storage.prototype.setItem = window.arrangeSetItem;
      delete window.arrangeSetItem;
    });

    // Places survive a reload and a switch to another thread and back.
    moved = await box(mainId);
    const twoBefore = await box(two);
    const other = await coreCommand(CORE_URL, "conversation.create_thread", {
      idempotencyKey: "arrange-other-thread",
      identityId: "vesper",
      title: "Arrange other",
    });
    assert.equal(other.status, 200);
    await coreCommand(CORE_URL, "surface.upsert_intent", {
      idempotencyKey: "arrange-other-panel",
      threadId: other.body.id,
      kind: "detail",
      role: "primary",
      persistence: "restorable",
      priority: 0,
      minSize: "compact",
      payloadVersion: 1,
      payload: { fields: [{ label: "Other", value: "Readable Other content" }], actions: [] },
    });
    await page.getByRole("button", { name: "Conversations", exact: true }).click();
    await page.getByRole("button", { name: "Arrange other", exact: true }).click();
    await page.getByText("Readable Other content", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Conversations", exact: true }).click();
    await page.getByRole("button", { name: "Arrange gate", exact: true }).click();
    await waitFor(snapshot, (value) => value.length === 4, "panels did not return after a switch");
    await settle();
    assert.deepEqual(await box(mainId), moved, "a thread switch lost the dragged panel's place");
    await page.screenshot({ path: join(evidence, "floating-arranged.png") });
    await page.reload();
    await open();
    await waitFor(snapshot, (value) => value.length === 4, "panels did not return after reload");
    await settle();
    assert.deepEqual(await box(mainId), moved, "dragged panel did not restore");
    assert.deepEqual(await box(two), twoBefore, "keyboard-moved panel did not restore");

    // Size presets resize the window and keep the semantic size.
    await title(two).click();
    await panel(two)
      .getByRole("button", { name: /^Size / })
      .click();
    await page.getByRole("option", { name: "Large", exact: true }).click();
    await waitFor(
      () => box(two),
      (value) => Math.abs(value.width - 640) < 2,
      "Large did not resize the window",
    );
    assert.equal(await panel(two).getAttribute("data-surface-size"), "wide");

    // A refused size leaves the window alone.
    const beforeRefusedSize = await geometry();
    await page.route("**/commands/surface.arrange", (route) =>
      route.fulfill({ status: 409, contentType: "application/json", body: "{}" }),
    );
    await panel(two)
      .getByRole("button", { name: /^Size / })
      .click();
    await page.getByRole("option", { name: "Small", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "refused" }).waitFor();
    assert.deepEqual(await geometry(), beforeRefusedSize);
    await page.unroute("**/commands/surface.arrange");

    // Focus takes the panel into the page; leaving focus floats it again.
    await panel(two)
      .getByRole("button", { name: /^Focus / })
      .click();
    await page.getByRole("button", { name: "Show conversation", exact: true }).waitFor();
    assert.equal(await floating(two), false, "focused panel still floated");
    await panel(two).getByRole("button", { name: "Leave focus", exact: true }).click();
    await waitFor(
      () => floating(two),
      (value) => value === true,
      "panel did not float again",
    );

    await page.setViewportSize({ width: 400, height: 860 });
    await page
      .getByRole("button", { name: /^Open panel / })
      .first()
      .waitFor();
    assert.equal(await page.locator("[data-resize-edge]").count(), 0);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false,
    );
  },
);

it(
  "overlay size choices persist semantically on desktop and phone; only the desktop window resizes",
  { timeout: 60000 },
  async () => {
    const title = "Overlay size gate";
    const thread = await coreCommand(CORE_URL, "conversation.create_thread", {
      idempotencyKey: "overlay-size-thread",
      identityId: "vesper",
      title,
    });
    assert.equal(thread.status, 200);
    const created = await coreCommand(CORE_URL, "surface.upsert_intent", {
      idempotencyKey: "overlay-size-panel",
      threadId: thread.body.id,
      kind: "attention",
      role: "attention",
      persistence: "restorable",
      priority: 0,
      minSize: "compact",
      payloadVersion: 1,
      payload: { headline: "Overlay sizing", detail: "Readable attention content", actions: [] },
    });
    assert.equal(created.status, 200);
    for (const [width, option, size] of [
      [1440, "Small", "compact"],
      [400, "Small", "compact"],
      [400, "Medium", "standard"],
    ]) {
      await page.setViewportSize({ width, height: 860 });
      await open(title);
      const overlay = panel(created.body.id);
      await overlay.getByText("Readable attention content", { exact: true }).waitFor();
      assert.equal(await overlay.getAttribute("data-surface-region"), "overlay");
      const before = await geometry();
      const response = page.waitForResponse(
        (reply) =>
          reply.url().endsWith("/commands/surface.arrange") && reply.request().method() === "POST",
      );
      await overlay.getByRole("button", { name: /^Size / }).click();
      await page.getByRole("option", { name: option, exact: true }).click();
      const saved = await response;
      assert.equal(saved.status(), 200);
      assert.equal((await saved.json()).size, size);
      await waitFor(
        () => overlay.getAttribute("data-surface-size"),
        (value) => value === size,
        "overlay semantic size did not update",
      );
      assert.equal(
        await page
          .getByRole("alert")
          .filter({ hasText: "Could not save these panel sizes" })
          .count(),
        0,
        "successful overlay size reported a false storage failure",
      );
      if (width === 400)
        assert.deepEqual(await geometry(), before, "a phone size choice wrote window geometry");
      else
        await waitFor(
          () => panel(created.body.id).boundingBox(),
          (value) => Math.abs(value.width - 340) < 2,
          "Small did not resize the floating overlay",
        );
    }
  },
);

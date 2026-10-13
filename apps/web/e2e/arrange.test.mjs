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
async function dragTitle(id, target, cancel) {
  const title = panel(id).locator("h2").first();
  const from = await title.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2, { steps: 3 });
  await page.getByLabel("Panel drop regions").waitFor();
  const box = await target.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  if (cancel === "escape") await page.keyboard.press("Escape");
  if (cancel === "pointer") await title.dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
}
async function resize(handle, dx, dy, cancel) {
  const box = await handle.boundingBox();
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 8 });
  if (cancel) await page.keyboard.press("Escape");
  await page.mouse.up();
}
async function geometry() {
  return page.evaluate(() =>
    Object.fromEntries(
      Object.entries(localStorage).filter(([key]) => key.startsWith("noctis.panelGeometry:")),
    ),
  );
}
it(
  "P19/P20: pointer snap, real swaps, manual overflow, cancel/refusal, resize/reload/reset and phone boundary",
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
    for (const [title, role] of [
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
        payload: { fields: [{ label: title, value: `Readable ${title} content` }], actions: [] },
        sourceIds: [`01941f29-7c00-7000-8000-${String(sequence).padStart(12, "0")}`],
        artifactIds: [],
      });
      assert.equal(created.status, 200);
      // Distinct kinds are not needed: source identity differentiates detail intents.
      ids.push(created.body.id);
    }
    // The upsert deduplication contract requires unique sources for otherwise identical kinds.
    assert.equal(new Set(ids).size, 4);
    await open();
    await waitFor(snapshot, (value) => value.length === 4, "four arrange panels did not render");
    assert.equal(await page.getByText("Readable Main content", { exact: true }).count(), 1);
    const before = await snapshot();
    const one = before.filter((entry) => entry.region === "right")[0].id;
    const two = before.filter((entry) => entry.region === "right")[1].id;
    const mainId = before.find((entry) => entry.region === "centre").id;
    await dragTitle(mainId, panel(one).locator("h2"));
    await waitFor(
      snapshot,
      (value) =>
        value.some((entry) => entry.id === mainId && entry.region === "right") &&
        value.some((entry) => entry.id === one && entry.region === "centre"),
      "cross-region swap did not exchange both panels",
    );
    await dragTitle(mainId, panel(one).locator("h2"));
    await waitFor(
      snapshot,
      (value) => value.some((entry) => entry.id === mainId && entry.region === "centre"),
      "cross-region restore did not exchange both panels",
    );
    await dragTitle(one, panel(two).locator("h2"));
    await waitFor(
      snapshot,
      (value) => value.filter((entry) => entry.region === "right")[0]?.id === two,
      "same-region swap did not reorder",
    );
    const swapped = await snapshot();
    await dragTitle(two, panel(one).locator("h2"), "escape");
    assert.deepEqual(await snapshot(), swapped);
    await dragTitle(two, panel(one).locator("h2"), "pointer");
    assert.deepEqual(await snapshot(), swapped);
    await dragTitle(
      two,
      page.locator('[aria-label="Panel drop regions"] [data-drop-region="left"]'),
    );
    await waitFor(
      snapshot,
      (value) => value.some((entry) => entry.id === two && entry.region === "left"),
      "left snap did not persist",
    );
    await page.reload();
    await open();
    await waitFor(
      snapshot,
      (value) => value.some((entry) => entry.id === two && entry.region === "left"),
      "left snap did not restore",
    );
    await dragTitle(
      one,
      page.locator('[aria-label="Panel drop regions"] [data-drop-region="overflow"]'),
    );
    await waitFor(
      snapshot,
      (value) => !value.some((entry) => entry.id === one),
      "manual overflow did not remove slot",
    );
    await page.locator('details[data-drop-region="overflow"] summary').click();
    assert.ok(
      await page
        .locator('details[data-drop-region="overflow"]')
        .getByText("detail", { exact: true })
        .count(),
    );
    const horizontal = page.getByRole("separator", { name: "Resize main and bottom panels" });
    const columns = page.getByRole("separator", { name: "Resize left and centre panels" });
    await columns.waitFor();
    const sizesBefore = await geometry();
    const originalWidth = (await panel(two).boundingBox()).width;
    await page.evaluate(() => {
      window.arrangeSetItem = Storage.prototype.setItem;
      Storage.prototype.setItem = () => {
        throw new Error("test blocked storage");
      };
    });
    await resize(columns, 90, 0);
    await page.getByRole("alert").filter({ hasText: "Could not save these panel sizes" }).waitFor();
    assert.deepEqual(await geometry(), sizesBefore);
    assert.ok(
      Math.abs((await panel(two).boundingBox()).width - originalWidth) < 2,
      "refused storage retained a preview",
    );
    await page.evaluate(() => {
      Storage.prototype.setItem = window.arrangeSetItem;
      delete window.arrangeSetItem;
    });
    await resize(columns, 90, 0, true);
    assert.deepEqual(await geometry(), sizesBefore);
    await resize(columns, 90, 0);
    await resize(horizontal, 0, -70);
    const widthBeforeReload = (await panel(two).boundingBox()).width;
    const resized = await geometry();
    assert.ok(Object.keys(resized).length > 0);
    await page.screenshot({ path: join(evidence, "P19-P20-arranged.png") });
    await page.reload();
    await open();
    await columns.waitFor();
    assert.deepEqual(await geometry(), resized);
    assert.ok(
      Math.abs((await panel(two).boundingBox()).width - widthBeforeReload) < 2,
      "restored panel width differed",
    );
    await resize(columns, -1500, 0);
    assert.ok((await panel(two).boundingBox()).width >= 239, "column shrank below detail minimum");
    await horizontal.dblclick();
    await columns.dblclick();
    const reset = JSON.parse(Object.values(await geometry())[0]);
    assert.deepEqual(reset.columns, {});
    assert.equal(reset.bottom, 0.3);
    await columns.focus();
    await page.keyboard.press("ArrowRight");
    assert.notDeepEqual(JSON.parse(Object.values(await geometry())[0]).columns, {});
    const beforePreset = await geometry();
    await panel(two)
      .getByRole("button", { name: /^Size / })
      .click();
    await page.getByRole("option", { name: "Large", exact: true }).click();
    await waitFor(
      geometry,
      (value) => JSON.stringify(value) !== JSON.stringify(beforePreset),
      "keyboard size preset did not update separator geometry",
    );
    await panel(two)
      .getByRole("button", { name: /^Focus / })
      .click();
    await page.getByRole("button", { name: "Show conversation", exact: true }).waitFor();
    await page.route("**/commands/surface.arrange", (route) =>
      route.fulfill({ status: 409, contentType: "application/json", body: "{}" }),
    );
    await panel(two)
      .getByRole("button", { name: /^Place / })
      .click();
    await page.getByRole("option", { name: "Bottom", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "refused" }).waitFor();
    assert.ok(await page.getByRole("button", { name: "Show conversation", exact: true }).count());
    await page.unroute("**/commands/surface.arrange");
    await panel(two)
      .getByRole("button", { name: /^Place / })
      .click();
    await page.getByRole("option", { name: "Bottom", exact: true }).click();
    await waitFor(
      snapshot,
      (value) => value.some((entry) => entry.id === two && entry.region === "bottom"),
      "successful move stayed in focused stage",
    );
    assert.equal(
      await page.getByRole("button", { name: "Show conversation", exact: true }).count(),
      0,
    );
    await page.setViewportSize({ width: 400, height: 860 });
    await page
      .getByRole("button", { name: /^Open panel / })
      .first()
      .waitFor();
    assert.equal(await page.getByRole("separator").count(), 0);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false,
    );
  },
);

it(
  "overlay size choices persist semantically on desktop and phone without saving column geometry",
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
      assert.deepEqual(await geometry(), before, "overlay size wrote unrelated frame geometry");
    }
  },
);

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { Buffer } from "node:buffer";
import { crc32, deflateSync } from "node:zlib";

import { chromium } from "playwright";
import { createTestVault } from "@noctis/test-kit";

import {
  TOKEN,
  coreRead,
  coreCommand,
  launchOptions,
  startFakeNode,
  startProcess,
  stopProcess,
  waitFor,
  waitForHttp,
} from "./harness.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const WEB_ROOT = join(REPO_ROOT, "apps/web");
const AGENT_MAIN = join(REPO_ROOT, "apps/node-agent/dist/main.js");
const CORE_PORT = 8809;
const WEB_PORT = 4189;
const CORE_URL = `http://127.0.0.1:${CORE_PORT}`;
const WEB_URL = `http://localhost:${WEB_PORT}`;
const EVIDENCE = join(REPO_ROOT, ".noctis/panels");
let core, agent, web, browser, page, context, databaseDirectory, nodeHome, scratch;
/** A valid one-pixel PNG, so two versions of one file differ by a readable colour. */
function pixelPng(r, g, b) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([size, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, r, g, b]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
async function openThreads() {
  await page.goto(WEB_URL);
  await page
    .getByRole("button", { name: "Threads", exact: true })
    .or(page.getByLabel("Core token"))
    .first()
    .waitFor();
  if (await page.locator('input[type="password"]').count()) {
    await page.getByLabel("Core token").fill(TOKEN);
    await page.getByLabel("Core token").press("Enter");
  }
  await page.getByRole("button", { name: "Threads", exact: true }).click();
  await page.getByRole("heading", { name: "Threads", exact: true }).waitFor();
  // The tab lands on the list; closing it shows the current chat.
  await page
    .getByRole("region", { name: "Conversations" })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await page.getByLabel("Message Vesper").waitFor();
}
async function prompt(text) {
  await page.getByLabel("Message Vesper").fill(text);
  await page.getByLabel("Message Vesper").press("Enter");
}
async function captureSettled(name) {
  const boxes = await waitFor(
    async () =>
      page.evaluate(() => {
        const core = document.querySelector(".noctis-intelligence");
        const slot = [...document.querySelectorAll('[data-core-slot="composer"]')].find((node) =>
          node.checkVisibility(),
        );
        const column = document.querySelector("[data-conversation-column]");
        if (!core || !slot || !column) return undefined;
        const rect = (node) => {
          const box = node.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        };
        return { core: rect(core), slot: rect(slot), column: rect(column) };
      }),
    (value) =>
      value !== undefined &&
      ["x", "y", "width", "height"].every(
        (key) => Math.abs(value.core[key] - value.slot[key]) <= 1,
      ),
    "core did not settle inside the conversation column at composer size",
  );
  assert.ok(
    boxes.core.x >= boxes.column.x &&
      boxes.core.x + boxes.core.width <= boxes.column.x + boxes.column.width,
  );
  process.stdout.write(`${name}: settled core ${JSON.stringify(boxes)}\n`);
  await page.screenshot({ path: join(REPO_ROOT, `.noctis/panels/${name}.png`) });
}

describe("Threads desktop panels", () => {
  before(async () => {
    for (const built of ["packages/ui/dist/index.js", "apps/core/dist/main.js"]) {
      assert.ok(
        existsSync(join(REPO_ROOT, built)),
        `run \`npm run build\` before the E2E suite: ${built} is missing`,
      );
    }

    assert.ok(existsSync(AGENT_MAIN), "run `npm run build` before the E2E suite: no node agent");

    databaseDirectory = mkdtempSync(join(tmpdir(), "noctis-e2e-chat-db-"));
    nodeHome = mkdtempSync(join(tmpdir(), "noctis-e2e-chat-node-"));
    scratch = mkdtempSync(join(tmpdir(), "noctis-e2e-chat-scratch-"));
    createTestVault(join(databaseDirectory, "vault"));
    writeFileSync(
      join(scratch, "frame.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
        "base64",
      ),
    );

    core = startProcess(process.execPath, [join(REPO_ROOT, "apps/core/dist/main.js")], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NOCTIS_CORE_TOKEN: TOKEN,
        NOCTIS_CORE_PORT: String(CORE_PORT),
        NOCTIS_DATABASE_PATH: join(databaseDirectory, "core.db"),
        NOCTIS_ALLOWED_ORIGINS: WEB_URL,
        NOCTIS_LOG_LEVEL: "error",
        NOCTIS_VAULT_ROOT: join(databaseDirectory, "vault"),
      },
    });

    web = startProcess(
      process.execPath,
      [
        join(REPO_ROOT, "node_modules/vite/bin/vite.js"),
        "--port",
        String(WEB_PORT),
        "--strictPort",
        "--force",
      ],
      {
        cwd: WEB_ROOT,
        env: {
          ...process.env,
          VITE_CORE_URL: WEB_URL,
          VITE_CORE_TOKEN: "",
          NOCTIS_CORE_PROXY_TARGET: CORE_URL,
        },
      },
    );

    await waitForHttp(`${CORE_URL}/health`, "the core", core);
    const indexed = await coreCommand(CORE_URL, "vault.reindex", {
      idempotencyKey: "panel-vault-index",
    });
    assert.equal(indexed.status, 200);
    ({ agent } = await startFakeNode({
      coreUrl: CORE_URL,
      repoRoot: REPO_ROOT,
      agentMain: AGENT_MAIN,
      nodeHome,
      scratch,
      keyPrefix: "e2e-chat",
    }));

    await waitForHttp(WEB_URL, "the web app", web);

    browser = await chromium.launch(launchOptions());
    mkdirSync(EVIDENCE, { recursive: true });
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      recordVideo: { dir: EVIDENCE },
    });
    page = await context.newPage();
  });

  after(async () => {
    await page?.close();
    await context?.close();
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
    "THE GATE (page panels): + works before the first turn, opens multiple pages and persists ownership",
    { timeout: 120000 },
    async () => {
      await openThreads();
      await page.getByRole("button", { name: "Add panel", exact: true }).click();
      await page.getByRole("button", { name: "Open Files panel", exact: true }).click();
      const panels = page.getByRole("complementary", { name: "Thread panels", exact: true });
      await panels.getByRole("heading", { name: "Files", exact: true, level: 1 }).waitFor();
      const conversations = await coreRead(CORE_URL, "/conversations?identityId=vesper");
      const threadId = conversations.body.conversations[0].id;
      assert.equal(
        (await coreRead(CORE_URL, `/threads/${threadId}/messages`)).body.messages.length,
        0,
      );
      await page.getByRole("button", { name: "Add panel", exact: true }).click();
      await page.getByRole("button", { name: "Open Settings panel", exact: true }).click();
      await panels.getByRole("heading", { name: "Settings", exact: true, level: 1 }).waitFor();
      assert.equal(await page.locator(".noctis-intelligence").count(), 1);
      const stored = await coreRead(
        CORE_URL,
        `/threads/${threadId}/surfaces?clientId=page-gate&fingerprint=page-gate&widthPx=1440&attentionState=active_canvas`,
      );
      assert.equal(stored.body.intents.filter((intent) => intent.kind === "page").length, 2);
      await page.getByRole("button", { name: "Presence", exact: true }).click();
      await page.getByRole("button", { name: "Add panel", exact: true }).click();
      await page.getByRole("button", { name: "Open Approvals panel", exact: true }).click();
      await page
        .getByRole("complementary", { name: "Presence panels", exact: true })
        .getByRole("heading", { name: "Approvals", level: 1, exact: true })
        .waitFor();
      const presence = await coreRead(
        CORE_URL,
        "/presence/surfaces?clientId=page-gate&fingerprint=page-gate&widthPx=1440&attentionState=active_canvas",
      );
      assert.equal(presence.body.intents.filter((intent) => intent.kind === "page").length, 1);
      // Keep the following existing no-panel gate on an empty free thread.
      await coreCommand(CORE_URL, "conversation.start_fresh", {
        idempotencyKey: "page-gate-fresh",
        identityId: "vesper",
      });
    },
  );

  it("a thread with no panels retains the 880px content width", { timeout: 120000 }, async () => {
    await openThreads();
    await prompt("hello");
    await page.locator('li[data-entry="message"][data-role="identity"]').waitFor();
    assert.equal(
      await page.locator('section[aria-label="Threads"] [data-surface-region]').count(),
      0,
    );
    const width = await page
      .locator('section[aria-label="Threads"] > div')
      .evaluate((node) => node.getBoundingClientRect().width);
    assert.ok(width <= 880);
  });
  async function namedThread(title) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openThreads();
    const created = await coreCommand(CORE_URL, "conversation.create_thread", {
      idempotencyKey: title,
      identityId: "vesper",
      title,
    });
    assert.equal(created.status, 200);
    await page.getByRole("button", { name: "Conversations", exact: true }).click();
    await page.getByRole("button", { name: title, exact: true }).click();
    await page
      .locator('section[aria-label="Threads"] header')
      .getByText(new RegExp(title))
      .waitFor();
    return created.body.id;
  }
  for (const mode of ["fallback", "pip"]) {
    it(
      `THE GATE (pop-out ${mode}): live owner actions, one window, restoration and page cleanup`,
      { timeout: 120000 },
      async () => {
        const previous = page;
        const isolated = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        if (mode === "fallback")
          await isolated.addInitScript(() => {
            Object.defineProperty(document.defaultView, "documentPictureInPicture", {
              value: undefined,
            });
          });
        page = await isolated.newPage();
        try {
          const threadId = await namedThread(`Popout ${mode}`);
          if (mode === "pip")
            assert.equal(
              await page.evaluate(() => !!document.defaultView.documentPictureInPicture),
              true,
              "real browser PiP API required for this gate",
            );
          await prompt("CHOICE: Alpha | Beta");
          const frame = page
            .locator("[data-surface-id]")
            .filter({ has: page.getByRole("heading", { name: "Choices", exact: true }) });
          await frame.waitFor();
          const id = await frame.getAttribute("data-surface-id");
          const region = await frame.getAttribute("data-surface-region");
          const parentFont = await frame.evaluate((node) => getComputedStyle(node).fontFamily);
          await frame
            .getByRole("button", { name: "Pop out Choices", exact: true })
            .waitFor({ timeout: 3000 });
          const popupEvent = isolated.waitForEvent("page", { timeout: 15000 });
          await frame
            .getByRole("button", { name: "Pop out Choices", exact: true })
            .click({ timeout: 3000 });
          const popup = await popupEvent;
          await popup.getByRole("heading", { name: "Choices", exact: true }).waitFor();
          assert.equal(
            await popup
              .locator(`[data-surface-id="${id}"]`)
              .evaluate((node) => getComputedStyle(node).fontFamily),
            parentFont,
            "popped panel body must keep the app typography",
          );
          assert.equal(
            await popup
              .locator("body > div > header")
              .evaluate((node) => getComputedStyle(node).fontFamily),
            parentFont,
            "pop-out header must use the app typography",
          );
          assert.equal(await page.locator(`[data-surface-id="${id}"]`).count(), 0);
          await popup
            .getByText(
              mode === "pip" ? "Always-on-top panels" : "Separate window (not always on top)",
              { exact: true },
            )
            .waitFor();
          await popup.getByRole("button", { name: "Use Alpha", exact: true }).click();
          await waitFor(
            async () => (await coreRead(CORE_URL, `/threads/${threadId}/messages`)).body.messages,
            (messages) =>
              messages.some((message) => message.role === "user" && message.body === "Use Alpha"),
            "child action missed its owner",
          );
          let revision = 0;
          const update = async (value) => {
            const result = await coreCommand(CORE_URL, "surface.upsert_intent", {
              idempotencyKey: `popout-${mode}-update-${++revision}`,
              threadId,
              kind: "detail",
              role: "supporting",
              persistence: "ephemeral",
              priority: 90,
              minSize: "compact",
              payloadVersion: 1,
              sourceIds: ["0199a000-0000-7000-8000-0000000000d1"],
              payload: { fields: [{ label: "Live value", value }] },
            });
            assert.equal(result.status, 200);
          };
          await update("Before update");
          await page.getByRole("button", { name: "Pop out Detail", exact: true }).click();
          await popup.getByText("Before update", { exact: true }).waitFor();
          await update("After update");
          await popup.getByText("After update", { exact: true }).waitFor();
          await popup.getByRole("button", { name: "Return Detail", exact: true }).click();
          await page.getByText("After update", { exact: true }).waitFor();
          assert.equal(
            await page
              .getByRole("button", { name: "Pop out Detail", exact: true })
              .evaluate((node) => node === node.ownerDocument.activeElement),
            true,
            "Return must restore keyboard focus to the parent panel",
          );
          await page.getByRole("button", { name: "Add panel", exact: true }).click();
          await page.getByRole("button", { name: "Open Settings panel", exact: true }).click();
          await page.getByRole("button", { name: "Pop out Settings", exact: true }).click();
          await popup.getByRole("heading", { name: "Settings", exact: true, level: 1 }).waitFor();
          assert.equal(isolated.pages().length, 2, "each panel must share one child window");
          await popup.getByRole("button", { name: /^Size Choices:/ }).click();
          await popup.getByRole("option", { name: "Large", exact: true }).focus();
          await popup.getByRole("option", { name: "Large", exact: true }).press("ArrowUp");
          assert.equal(
            await popup
              .getByRole("option", { name: "Medium", exact: true })
              .evaluate((node) => node === node.ownerDocument.activeElement),
            true,
          );
          await popup.getByRole("option", { name: "Medium", exact: true }).press("Enter");
          await popup.getByRole("button", { name: "Pin Choices", exact: true }).click();
          await popup.getByRole("button", { name: "Unpin Choices", exact: true }).waitFor();
          await popup.getByRole("button", { name: "Close Settings", exact: true }).click();
          await waitFor(
            () => popup.getByRole("heading", { name: "Settings", level: 1, exact: true }).count(),
            (count) => count === 0,
            "Close must dismiss the panel",
          );
          assert.equal(popup.isClosed(), false, "another popped panel still owns the child");
          await popup.screenshot({
            path: join(EVIDENCE, `P21-${mode}.png`),
            animations: "disabled",
          });
          await popup.close();
          const restored = page.locator(`[data-surface-id="${id}"]`);
          await restored.waitFor();
          assert.equal(await restored.getAttribute("data-surface-region"), region);
          const nextPopup = isolated.waitForEvent("page");
          await restored.getByRole("button", { name: "Pop out Choices", exact: true }).click();
          const child = await nextPopup;
          await child.getByRole("heading", { name: "Choices", exact: true }).waitFor();
          await page.getByRole("button", { name: "Presence", exact: true }).click();
          await waitFor(() => child.isClosed(), Boolean, "page unmount leaked the child");
          await page.getByRole("button", { name: "Threads", exact: true }).click();
          await page.getByRole("button", { name: `Popout ${mode}`, exact: true }).click();
          await restored.waitFor();
          await page.setViewportSize({ width: 400, height: 860 });
          await waitFor(
            () => page.getByRole("button", { name: /^Pop out / }).count(),
            (count) => count === 0,
            "phone retained desktop pop-out controls",
          );
        } finally {
          page = previous;
          await isolated.close();
        }
      },
    );
  }
  it(
    "THE GATE (pop-out overflow): unpinned returned panels stay accessible through Show",
    { timeout: 120000 },
    async () => {
      const previous = page;
      const isolated = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await isolated.addInitScript(() =>
        Object.defineProperty(document.defaultView, "documentPictureInPicture", {
          value: undefined,
        }),
      );
      page = await isolated.newPage();
      try {
        const threadId = await namedThread("Popout overflow");
        await prompt("CHOICE: One | Two");
        const choices = page
          .locator("[data-surface-id]")
          .filter({ has: page.getByRole("heading", { name: "Choices", exact: true }) });
        await choices.waitFor();
        await choices.getByRole("button", { name: "Pop out Choices", exact: true }).waitFor();
        const opened = isolated.waitForEvent("page");
        await choices.getByRole("button", { name: "Pop out Choices", exact: true }).click();
        const popup = await opened;
        await popup.getByRole("heading", { name: "Choices", exact: true }).waitFor();
        const result = await coreCommand(CORE_URL, "surface.upsert_intent", {
          idempotencyKey: "popout-overflow-detail",
          threadId,
          kind: "detail",
          role: "supporting",
          persistence: "ephemeral",
          priority: 100,
          minSize: "compact",
          payloadVersion: 1,
          sourceIds: ["0199a000-0000-7000-8000-0000000000f1"],
          payload: { fields: [{ label: "Priority", value: "Higher" }] },
        });
        assert.equal(result.status, 200);
        await page.getByText("Higher", { exact: true }).waitFor();
        await popup.close();
        const overflow = page.locator("details[data-panel-overflow]");
        await overflow.getByText("Overflow: 1 panel", { exact: true }).waitFor();
        await overflow.locator("summary").click();
        await overflow
          .locator("li")
          .filter({ hasText: "list" })
          .getByRole("button", { name: "Show", exact: true })
          .click();
        await choices.waitFor();
        assert.equal(await choices.getAttribute("data-surface-region"), "centre");
      } finally {
        page = previous;
        await isolated.close();
      }
    },
  );
  it(
    "THE GATE (pop-out owners): thread, Objective and Presence use the tab coordinator",
    { timeout: 120000 },
    async () => {
      const previous = page;
      const isolated = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await isolated.addInitScript(() =>
        Object.defineProperty(document.defaultView, "documentPictureInPicture", {
          value: undefined,
        }),
      );
      page = await isolated.newPage();
      let objectiveId;
      try {
        const created = await coreCommand(CORE_URL, "objective.create", {
          idempotencyKey: "popout-objective",
          title: "Popout owners",
          intent: "Shared browser window",
          status: "draft",
          identityId: "vesper",
        });
        assert.equal(created.status, 200);
        objectiveId = created.body.id;
        assert.equal(
          (
            await coreCommand(CORE_URL, "objective.change_status", {
              idempotencyKey: "popout-objective-active",
              objectiveId,
              expectedRevision: 0,
              status: "active",
            })
          ).status,
          200,
        );
        await openThreads();
        await page.getByRole("button", { name: "Back to the Objective", exact: true }).click();
        await prompt("popout owner thread");
        const thread = await waitFor(
          () => coreRead(CORE_URL, `/threads?identityId=vesper&objectiveId=${objectiveId}`),
          (value) => value.status === 200,
          "Objective thread not created",
        );
        const ids = [];
        for (const [index, owner] of [{ objectiveId }, { threadId: thread.body.id }].entries()) {
          const result = await coreCommand(CORE_URL, "surface.upsert_intent", {
            idempotencyKey: `popout-owner-${index}`,
            ...owner,
            kind: "detail",
            role: "primary",
            persistence: "ephemeral",
            priority: 1000,
            minSize: "compact",
            payloadVersion: 1,
            sourceIds: [`0199a000-0000-7000-8000-0000000000e${index}`],
            payload: { fields: [{ label: "Owner", value: `Popout owner ${index}` }] },
          });
          assert.equal(result.status, 200);
          ids.push(result.body.id);
          await page.locator(`[data-surface-id="${result.body.id}"]`).waitFor();
        }
        const popupEvent = isolated.waitForEvent("page");
        await page
          .locator(`[data-surface-id="${ids[0]}"]`)
          .getByRole("button", { name: "Pop out Detail", exact: true })
          .click();
        const popup = await popupEvent;
        await page
          .locator(`[data-surface-id="${ids[1]}"]`)
          .getByRole("button", { name: "Pop out Detail", exact: true })
          .click();
        await popup.getByText("Popout owner 0", { exact: true }).waitFor();
        await popup.getByText("Popout owner 1", { exact: true }).waitFor();
        assert.equal(isolated.pages().length, 2);
        for (const lifecycle of ["entering", "active", "exiting"]) {
          const changed = await coreCommand(CORE_URL, "surface.change_lifecycle", {
            idempotencyKey: `popout-objective-${lifecycle}`,
            surfaceId: ids[0],
            lifecycle,
          });
          assert.equal(changed.status, 200, JSON.stringify(changed.body));
        }
        await waitFor(
          () => popup.locator(`[data-surface-id="${ids[0]}"]`).count(),
          (count) => count === 0,
          "an exiting Objective panel remained registered",
        );
        assert.equal(popup.isClosed(), false);
        await popup.getByText("Popout owner 1", { exact: true }).waitFor();
        await page.getByRole("button", { name: "Presence", exact: true }).click();
        await waitFor(() => popup.isClosed(), Boolean, "thread owner leaked into Presence");
        await page.getByRole("button", { name: "Add panel", exact: true }).click();
        await page.getByRole("button", { name: "Open Approvals panel", exact: true }).click();
        const presenceEvent = isolated.waitForEvent("page");
        await page.getByRole("button", { name: "Pop out Approvals", exact: true }).click();
        const presenceWindow = await presenceEvent;
        await presenceWindow
          .getByRole("heading", { name: "Approvals", level: 1, exact: true })
          .waitFor();
        await page.close();
        await waitFor(() => presenceWindow.isClosed(), Boolean, "normal popup outlived its parent");
      } finally {
        page = previous;
        await isolated.close();
        if (objectiveId !== undefined)
          await coreCommand(CORE_URL, "objective.change_status", {
            idempotencyKey: "popout-objective-paused",
            objectiveId,
            expectedRevision: 1,
            status: "paused",
          });
      }
    },
  );
  it(
    "utility page controls stay in the phone sheet keyboard loop on Threads and Presence",
    { timeout: 120000 },
    async () => {
      await namedThread("Utility keyboard");
      await page.setViewportSize({ width: 400, height: 860 });
      for (const host of ["Threads", "Presence"]) {
        await page.getByRole("button", { name: host, exact: true }).click();
        if (host === "Threads") {
          // The tab lands on the list, over the conversation that stays open.
          await page
            .getByRole("region", { name: "Conversations" })
            .getByRole("button", { name: "Close", exact: true })
            .click();
        }
        await page.getByRole("button", { name: "Add panel", exact: true }).click();
        await page.getByRole("button", { name: "Open Vault panel", exact: true }).click();
        const chip = page.getByRole("button", { name: "Open panel Vault", exact: true }).last();
        await chip.waitFor();
        await chip.click();
        const sheet = page.getByRole("region", { name: "Panel sheet", exact: true });
        const search = sheet.getByPlaceholder("Ask the Vault what it knows");
        await search.fill("Travel");
        await search.press("Tab");
        assert.equal(
          await sheet
            .getByRole("button", { name: "Search", exact: true })
            .evaluate((node) => node === document.activeElement),
          true,
          `${host} skipped the Vault search input`,
        );
        if (host === "Presence") {
          await sheet.getByRole("button", { name: "Search", exact: true }).press("Tab");
          assert.equal(
            await page.evaluate(
              () => document.activeElement?.closest('[aria-label="Panel sheet"]') !== null,
            ),
            true,
            "Presence focus escaped the sheet",
          );
        }
        await page.getByRole("button", { name: "Add panel", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Add panel", exact: true });
        await dialog.getByRole("button", { name: "Open Files panel", exact: true }).press("Tab");
        assert.equal(
          await dialog
            .getByRole("button", { name: "Open Vault panel", exact: true })
            .evaluate((node) => node === document.activeElement),
          true,
          "sheet focus containment blocked the modal picker",
        );
        await page.keyboard.press("Escape");
        await page.goBack();
      }
    },
  );
  it(
    "Files fits a narrow desktop panel without clipping its browser or viewer",
    { timeout: 120000 },
    async () => {
      await namedThread("Narrow Files");
      await page.getByRole("button", { name: "Add panel", exact: true }).click();
      await page.getByRole("button", { name: "Open Files panel", exact: true }).click();
      const files = page.locator('.page-panel section[aria-label="Files"]');
      await files.waitFor();
      await files.evaluate((node) => {
        node.closest(".page-panel").style.width = "350px";
      });
      await waitFor(
        () =>
          files.evaluate((node) => {
            const grid =
              node.querySelector("[data-files-layout]") ??
              node.querySelector("header").parentElement.lastElementChild;
            return grid.scrollWidth <= grid.clientWidth + 1;
          }),
        Boolean,
        "Files columns clipped inside the panel",
      );
    },
  );
  it(
    "page-panel create and upsert refusals retry on the same created thread",
    { timeout: 120000 },
    async () => {
      await coreCommand(CORE_URL, "conversation.start_fresh", {
        idempotencyKey: "page-refusal-fresh",
        identityId: "vesper",
      });
      await openThreads();
      const before = (await coreRead(CORE_URL, "/conversations?identityId=vesper")).body
        .conversations.length;
      const choose = async () => {
        await page.getByRole("button", { name: "Add panel", exact: true }).click();
        await page.getByRole("button", { name: "Open Settings panel", exact: true }).click();
      };
      const refuse = (route) =>
        route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      await page.route("**/commands/conversation.create_thread", refuse);
      await choose();
      await page.getByRole("alert").getByText("Could not open this panel. Try again.").waitFor();
      assert.equal(
        (await coreRead(CORE_URL, "/conversations?identityId=vesper")).body.conversations.length,
        before,
      );
      await page.unroute("**/commands/conversation.create_thread", refuse);
      await page.route("**/commands/surface.upsert_intent", refuse);
      await choose();
      await page.getByRole("alert").getByText("Could not open this panel. Try again.").waitFor();
      assert.equal(
        (await coreRead(CORE_URL, "/conversations?identityId=vesper")).body.conversations.length,
        before + 1,
      );
      await page.unroute("**/commands/surface.upsert_intent", refuse);
      await choose();
      await page
        .locator(".page-panel")
        .getByRole("heading", { name: "Settings", level: 1, exact: true })
        .waitFor();
      assert.equal(
        (await coreRead(CORE_URL, "/conversations?identityId=vesper")).body.conversations.length,
        before + 1,
      );
    },
  );
  it(
    "duplicate page clicks send once and a late refusal cannot leak after an A to B to A switch",
    { timeout: 120000 },
    async () => {
      await namedThread("Page owner A");
      await coreCommand(CORE_URL, "conversation.create_thread", {
        idempotencyKey: "page-owner-b",
        identityId: "vesper",
        title: "Page owner B",
      });
      let release, received;
      const pending = new Promise((resolve) => {
        release = resolve;
      });
      const started = new Promise((resolve) => {
        received = resolve;
      });
      let requests = 0;
      const routePattern = "**/commands/surface.upsert_intent";
      await page.route(routePattern, async (route) => {
        requests += 1;
        received();
        await pending;
        await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      });
      try {
        await page.getByRole("button", { name: "Add panel", exact: true }).click();
        await page
          .getByRole("button", { name: "Open Settings panel", exact: true })
          .evaluate((node) => {
            node.click();
            node.click();
          });
        await started;
        for (const title of ["Page owner B", "Page owner A"]) {
          await page.getByRole("button", { name: "Conversations", exact: true }).click();
          await page.getByRole("button", { name: title, exact: true }).click();
          await page
            .locator('section[aria-label="Threads"] header')
            .getByText(new RegExp(title))
            .waitFor();
        }
        const response = page.waitForResponse((result) =>
          result.url().endsWith("/commands/surface.upsert_intent"),
        );
        release();
        await response;
        await page.getByRole("button", { name: "Add panel", exact: true }).waitFor();
        await waitFor(
          () => page.getByRole("button", { name: "Add panel", exact: true }).isEnabled(),
          Boolean,
          "late panel request did not finish",
        );
        assert.equal(requests, 1);
        assert.equal(
          await page.getByRole("alert").count(),
          0,
          "old owner refusal leaked after return",
        );
      } finally {
        release();
        await page.unroute(routePattern);
      }
    },
  );
  it(
    "a Missions page panel opens the selected turn's exact conversation from another named thread",
    { timeout: 120000 },
    async () => {
      const targetId = await namedThread("Mission destination B");
      await prompt("mission destination B contents");
      const turn = await waitFor(
        async () => (await coreRead(CORE_URL, `/threads/${targetId}/turns`)).body.turns.at(-1),
        (value) => value?.status === "completed",
        "mission destination turn did not complete",
      );
      const sourceId = await namedThread("Mission source A");
      await page.getByRole("button", { name: "Add panel", exact: true }).click();
      await page.getByRole("button", { name: "Open Missions panel", exact: true }).click();
      const mission = page
        .locator('.page-panel li[data-entry="mission"]')
        .filter({ hasText: turn.jobId });
      await mission.getByRole("button", { name: "Open in Chat", exact: true }).click();
      await waitFor(
        () => page.locator('ul[aria-label="Conversation"]').textContent(),
        (text) => text.includes("mission destination B contents"),
        "Missions opened another conversation instead of the selected turn's thread",
      );
      await prompt("mission destination B follow-up");
      await waitFor(
        async () => (await coreRead(CORE_URL, `/threads/${targetId}/messages`)).body.messages,
        (messages) =>
          messages.some(
            (message) =>
              message.role === "user" && message.body === "mission destination B follow-up",
          ),
        "Missions follow-up did not reach the selected thread",
      );
      assert.equal(
        (await coreRead(CORE_URL, `/threads/${sourceId}/messages`)).body.messages.length,
        0,
      );
    },
  );
  it(
    "THE GATE (companion focus): focus replaces the transcript and Show conversation and Back restore it",
    { timeout: 120000 },
    async () => {
      const previousPage = page;
      const focusContext = await browser.newContext({
        viewport: { width: 1672, height: 941 },
        recordVideo: { dir: EVIDENCE, size: { width: 1672, height: 941 } },
      });
      page = await focusContext.newPage();
      try {
        await namedThread("Companion focus");
        await page.setViewportSize({ width: 1672, height: 941 });
        await prompt("IMAGE: companion focus");
        await page.getByRole("button", { name: /^Focus / }).waitFor();
        const checkCore = async (slotName) => {
          await waitFor(
            () =>
              page.evaluate((name) => {
                const slot = document.querySelector(`[data-core-slot="${name}"]`);
                const core = document.querySelector(".noctis-intelligence");
                if (!slot || !core) return false;
                const a = slot.getBoundingClientRect(),
                  b = core.getBoundingClientRect();
                return ["x", "y", "width", "height"].every((key) => Math.abs(a[key] - b[key]) <= 2);
              }, slotName),
            Boolean,
            `core did not settle in ${slotName}`,
          );
          assert.equal(await page.locator(".noctis-intelligence").count(), 1);
        };
        await checkCore("composer");
        await page.screenshot({ path: join(EVIDENCE, "P12-canvas.png") });
        await page.getByRole("button", { name: /^Focus / }).click();
        await page.getByRole("button", { name: "Show conversation", exact: true }).waitFor();
        assert.equal(await page.locator('ul[aria-label="Conversation"]').isVisible(), false);
        assert.equal((await page.locator("[data-companion-column]").boundingBox()).width, 300);
        await checkCore("companion");
        await page.screenshot({ path: join(EVIDENCE, "P12-focus.png") });
        await page.getByRole("button", { name: "Show conversation", exact: true }).click();
        await page.locator('ul[aria-label="Conversation"]').waitFor();
        await checkCore("composer");
        await page.screenshot({ path: join(EVIDENCE, "P12-restored.png") });
        await page.getByRole("button", { name: /^Focus / }).click();
        await checkCore("companion");
        await page.goBack();
        await page.locator('ul[aria-label="Conversation"]').waitFor();
        await checkCore("composer");
      } finally {
        const video = page.video();
        await page.close();
        await focusContext.close();
        await video?.saveAs(join(EVIDENCE, "P12-focus.webm"));
        page = previousPage;
      }
    },
  );
  for (const startsFocused of [false, true]) {
    it(
      `THE GATE (focus draft ${startsFocused ? "restore" : "focus"}): text, files and selections survive one composer`,
      { timeout: 120000 },
      async () => {
        const previous = page;
        const isolated = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        await isolated.route("**/models", async (route) => {
          const response = await route.fetch();
          const body = await response.json();
          body.catalogue.push({ providerId: "codex", model: "other-model", label: "Other" });
          await route.fulfill({ response, json: body });
        });
        page = await isolated.newPage();
        try {
          const threadId = await namedThread(`Focus draft ${startsFocused}`);
          const panel = await coreCommand(CORE_URL, "surface.upsert_intent", {
            idempotencyKey: `focus-draft-${startsFocused}`,
            threadId,
            kind: "detail",
            role: "supporting",
            persistence: "ephemeral",
            priority: 90,
            minSize: "compact",
            payloadVersion: 1,
            sourceIds: ["0199a000-0000-7000-8000-0000000000d1"],
            payload: { fields: [{ label: "Draft", value: "Keep this unsent" }] },
          });
          assert.equal(panel.status, 200);
          await page.getByRole("button", { name: "Focus Detail", exact: true }).waitFor();
          if (startsFocused)
            await page.getByRole("button", { name: "Focus Detail", exact: true }).click();
          await page
            .getByLabel("Message Vesper")
            .fill("Unsent draft with its files and selections");
          await page.locator('input[type="file"]').setInputFiles({
            name: "draft.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("Keep this attachment"),
          });
          await page.getByRole("button", { name: /^Agent:/ }).click();
          await page.getByRole("option", { name: "Other (codex)", exact: true }).click();
          await page.getByRole("button", { name: /^PC and folder:/ }).click();
          await page.getByRole("option").filter({ hasText: " on e2e" }).click();
          const selectedRoot = await page
            .getByRole("button", { name: /^PC and folder:/ })
            .getAttribute("aria-label");
          await page.getByLabel("Message Vesper").evaluate((node) => {
            node.ownerDocument.defaultView.draftComposer = node;
          });
          await page
            .getByRole("button", {
              name: startsFocused ? "Show conversation" : "Focus Detail",
              exact: true,
            })
            .click();
          assert.equal(
            await page.getByLabel("Message Vesper").inputValue(),
            "Unsent draft with its files and selections",
          );
          await page.getByRole("button", { name: "Preview draft.txt", exact: true }).waitFor();
          assert.equal(
            await page.getByRole("button", { name: /^Agent:/ }).getAttribute("aria-label"),
            "Agent: Other (codex)",
          );
          assert.equal(
            await page.getByRole("button", { name: /^PC and folder:/ }).getAttribute("aria-label"),
            selectedRoot,
          );
          assert.equal(await page.getByLabel("Message Vesper").count(), 1);
          assert.equal(
            await page
              .getByLabel("Message Vesper")
              .evaluate((node) => node === node.ownerDocument.defaultView.draftComposer),
            true,
          );
          if (!startsFocused) {
            await page.getByLabel("Message Vesper").fill("Edited while focused");
            await page.goBack();
            await page.locator("[data-conversation-column]").waitFor();
            assert.equal(
              await page.getByLabel("Message Vesper").inputValue(),
              "Edited while focused",
            );
            await page.getByRole("button", { name: "Preview draft.txt", exact: true }).waitFor();
            assert.equal(
              await page.getByRole("button", { name: /^Agent:/ }).getAttribute("aria-label"),
              "Agent: Other (codex)",
            );
            assert.equal(
              await page
                .getByRole("button", { name: /^PC and folder:/ })
                .getAttribute("aria-label"),
              selectedRoot,
            );
          }
        } finally {
          page = previous;
          await isolated.close();
        }
      },
    );
  }
  it(
    "THE GATE (first binding): an unsent draft survives the unstarted thread getting its id",
    { timeout: 120000 },
    async () => {
      const previous = page;
      const isolated = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      page = await isolated.newPage();
      try {
        await openThreads();
        // No other gate speaks to Jester, so its thread really is unstarted here.
        await prompt("JESTER");
        const composer = page.getByRole("textbox", { name: "Message Jester" });
        const header = page.locator('section[aria-label="Threads"] header');
        await header.getByText("Jester · nothing said yet").waitFor();
        const draft = "Draft typed before the thread has an id";
        await composer.fill(draft);
        await composer.evaluate((node) => {
          node.ownerDocument.defaultView.firstComposer = node;
        });
        await page.getByRole("button", { name: "Add panel", exact: true }).click();
        await page.getByRole("button", { name: "Open Files panel", exact: true }).click();
        await page
          .getByRole("complementary", { name: "Thread panels", exact: true })
          .getByRole("heading", { name: "Files", exact: true, level: 1 })
          .waitFor();
        // The thread is read after the panel exists; the id arrives with it.
        await header.getByText("Jester · nothing said yet").waitFor({ state: "hidden" });
        assert.equal(await composer.inputValue(), draft);
        assert.equal(
          await composer.evaluate((node) => node === node.ownerDocument.defaultView.firstComposer),
          true,
        );
      } finally {
        // The active identity is the core's, so it would follow every later gate.
        const restored = await coreCommand(CORE_URL, "identity.activate", {
          idempotencyKey: "first-binding-restore-vesper",
          identityId: "vesper",
        });
        assert.equal(restored.status, 200);
        page = previous;
        await isolated.close();
      }
    },
  );
  it(
    "THE GATE (file media presentation): a pending rewritten image keeps the accepted pixels through pop-out, Return and region moves",
    { timeout: 120000 },
    async () => {
      const previous = page;
      const isolated = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      page = await isolated.newPage();
      try {
        const threadId = await namedThread("File media presentation");
        await prompt("WRITE: media source");
        await page
          .locator("[data-surface-id]")
          .filter({ has: page.getByRole("heading", { name: "written.md", exact: true }) })
          .getByRole("heading", { name: "Written by the fake" })
          .waitFor();
        const intents = await coreRead(
          CORE_URL,
          `/threads/${threadId}/surfaces?clientId=test&fingerprint=gate&widthPx=1440&attentionState=active_canvas`,
        );
        const source = {
          ...intents.body.intents.find((intent) => intent.kind === "document").payload.content,
          relativePath: "frame.png",
        };
        const original = readFileSync(join(scratch, "frame.png"));
        const publish = (key) =>
          coreCommand(CORE_URL, "surface.upsert_intent", {
            idempotencyKey: key,
            threadId,
            kind: "media",
            role: "primary",
            persistence: "ephemeral",
            priority: 100,
            minSize: "compact",
            sourceIds: ["0199a000-0000-7000-8000-0000000000b1"],
            payloadVersion: 1,
            payload: { title: "Rewritten frame", mediaType: "image/png", source },
          });
        try {
          writeFileSync(join(scratch, "frame.png"), pixelPng(255, 0, 0));
          assert.equal((await publish("file-media-v1")).status, 200);
          const panel = page.locator("[data-surface-id]").filter({ has: page.locator("img") });
          const pixel = (image) =>
            image.evaluate(async (img) => {
              await img.decode();
              const canvas = img.ownerDocument.createElement("canvas");
              canvas.width = canvas.height = 1;
              const context = canvas.getContext("2d");
              context.drawImage(img, 0, 0);
              return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
            });
          assert.deepEqual(await pixel(panel.locator("img")), [255, 0, 0]);
          writeFileSync(join(scratch, "frame.png"), pixelPng(0, 0, 255));
          assert.equal((await publish("file-media-v2")).status, 200);
          await panel.getByRole("button", { name: "Use new version", exact: true }).waitFor();
          const opened = isolated.waitForEvent("page");
          await panel.getByRole("button", { name: "Pop out Rewritten frame", exact: true }).click();
          const popup = await opened;
          const frame = popup.locator("[data-surface-id]");
          await frame.locator("img").waitFor();
          assert.deepEqual(await pixel(frame.locator("img")), [255, 0, 0]);
          await frame.getByRole("button", { name: "Return Rewritten frame", exact: true }).click();
          await panel.locator("img").waitFor();
          assert.deepEqual(await pixel(panel.locator("img")), [255, 0, 0]);
          // Focus and back remounts the frame: floating, into the page, floating again.
          await panel.getByRole("button", { name: "Focus Rewritten frame", exact: true }).click();
          await panel.getByRole("button", { name: "Leave focus", exact: true }).click();
          await panel.getByRole("button", { name: "Focus Rewritten frame", exact: true }).waitFor();
          await panel.locator("img").waitFor();
          assert.deepEqual(await pixel(panel.locator("img")), [255, 0, 0]);
          await panel.getByRole("button", { name: "Use new version", exact: true }).click();
          await waitFor(
            () => pixel(panel.locator("img")),
            (value) => value[2] === 255 && value[0] === 0,
            "accepted image did not show the new bytes",
          );
        } finally {
          writeFileSync(join(scratch, "frame.png"), original);
        }
      } finally {
        page = previous;
        await isolated.close();
      }
    },
  );
  it(
    "THE GATE (file presentation): pending acceptance and last-good text survive pop-out, Return and region moves",
    { timeout: 120000 },
    async () => {
      const previous = page;
      const isolated = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      page = await isolated.newPage();
      try {
        await namedThread("File presentation");
        await prompt("WRITE: accepted v1");
        const panel = page
          .locator("[data-surface-id]")
          .filter({ has: page.getByRole("heading", { name: "written.md", exact: true }) });
        await panel.getByRole("heading", { name: "Written by the fake" }).waitFor();
        await prompt("WRITE: pending v2");
        await panel.getByRole("button", { name: "Use new version", exact: true }).waitFor();
        const assertPreview = async (frame, accepted) => {
          await frame.getByText("Opening…", { exact: true }).waitFor({ state: "hidden" });
          assert.ok(
            (await frame.innerText()).includes(accepted),
            `lost accepted preview ${accepted}`,
          );
          assert.ok(
            !(await frame.innerText()).includes("WRITE: pending v2") ||
              accepted === "WRITE: pending v2",
          );
        };
        const pop = async () => {
          const opened = isolated.waitForEvent("page");
          await panel.getByRole("button", { name: "Pop out written.md", exact: true }).click();
          const popup = await opened;
          const frame = popup.locator("[data-surface-id]");
          await frame.getByRole("heading", { name: "written.md", exact: true }).waitFor();
          return { popup, frame };
        };
        const child = await pop();
        await assertPreview(child.frame, "WRITE: accepted v1");
        await child.frame.getByRole("button", { name: "Return written.md", exact: true }).click();
        await panel.waitFor();
        await assertPreview(panel, "WRITE: accepted v1");
        const move = async () => {
          // Focus and back remounts the frame: floating, into the page, floating again.
          await panel.getByRole("button", { name: "Focus written.md", exact: true }).click();
          await panel.getByRole("button", { name: "Leave focus", exact: true }).click();
          await panel.getByRole("button", { name: "Focus written.md", exact: true }).waitFor();
        };
        await move();
        await assertPreview(panel, "WRITE: accepted v1");
        await panel.getByRole("button", { name: "Use new version", exact: true }).click();
        await waitFor(
          () => panel.innerText(),
          (text) => text.includes("WRITE: pending v2"),
          "accepted v2 did not arrive",
        );
        const pattern = "**/files/content?**preview=1";
        await isolated.route(pattern, (route) =>
          route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: { message: "Presentation read failure" } }),
          }),
        );
        await prompt("WRITE: failed v3");
        await panel.getByRole("button", { name: "Use new version", exact: true }).click();
        await panel
          .getByRole("alert")
          .getByText(/Presentation read failure/)
          .waitFor();
        const failed = await pop();
        await assertPreview(failed.frame, "WRITE: pending v2");
        await failed.frame.getByRole("button", { name: "Return written.md", exact: true }).click();
        await panel.waitFor();
        await assertPreview(panel, "WRITE: pending v2");
        await move();
        await assertPreview(panel, "WRITE: pending v2");
        await isolated.unroute(pattern);
        await panel.getByRole("button", { name: "Retry file", exact: true }).click();
        await waitFor(
          () => panel.innerText(),
          (text) => text.includes("WRITE: failed v3"),
          "file retry did not recover",
        );
      } finally {
        page = previous;
        await isolated.close();
      }
    },
  );
  it(
    "THE GATE (panels, restore): placed and pinned stay; closed stays closed after reload",
    { timeout: 120000 },
    async () => {
      const threadId = await namedThread("Pinned restore");
      await prompt("IMAGE: first");
      const panels = page.getByRole("complementary", { name: "Thread panels" });
      const first = panels.locator("[data-surface-id]").first();
      await first.locator("img").waitFor({ timeout: 20000 });
      const firstId = await first.getAttribute("data-surface-id");
      await first.getByRole("button", { name: /^Pin / }).click();
      await first.getByRole("button", { name: /^Unpin / }).waitFor();
      await prompt("IMAGE: second");
      const second = await waitFor(
        async () =>
          (
            await coreRead(
              CORE_URL,
              `/threads/${threadId}/surfaces?clientId=test&fingerprint=gate&widthPx=1440&attentionState=active_canvas`,
            )
          ).body.intents.find((intent) => intent.kind === "media" && intent.id !== firstId),
        (intent) => intent !== undefined,
        "second image never arrived",
      );
      const secondId = second.id;
      await panels.locator("details summary").click();
      await panels
        .locator("details")
        .getByRole("button", { name: "Close", exact: true })
        .first()
        .click();
      await waitFor(
        () => panels.locator("details li").count(),
        (count) => count === 0,
        "closed panel still in overflow",
      );
      await prompt("PANEL: # Restore plan");
      await waitFor(
        async () =>
          (
            await coreRead(
              CORE_URL,
              `/threads/${threadId}/surfaces?clientId=test&fingerprint=gate&widthPx=1440&attentionState=active_canvas`,
            )
          ).body.intents.some((intent) => intent.kind === "document"),
        Boolean,
        "plan panel never arrived",
      );
      await prompt("IMAGE: fourth");
      await waitFor(
        async () =>
          (
            await coreRead(
              CORE_URL,
              `/threads/${threadId}/surfaces?clientId=test&fingerprint=gate&widthPx=1440&attentionState=active_canvas`,
            )
          ).body.intents.filter((intent) => intent.kind === "media").length,
        (count) => count === 3,
        "fourth image never arrived",
      );
      await panels.locator(`[data-surface-id="${firstId}"]`).waitFor();
      const read = () =>
        panels
          .locator("[data-surface-id]")
          .evaluateAll((nodes) =>
            nodes.map((node) => [node.dataset.surfaceId, node.dataset.surfaceRegion]).sort(),
          );
      const before = await read();
      await page.reload();
      await openThreads();
      await page.getByRole("button", { name: "Conversations", exact: true }).click();
      await page.getByRole("button", { name: "Pinned restore", exact: true }).click();
      await page.getByLabel("Message Vesper").waitFor();
      await waitFor(
        read,
        (value) => JSON.stringify(value) === JSON.stringify(before),
        "panel regions failed to restore",
      );
      assert.equal(await panels.locator(`[data-surface-id="${secondId}"]`).count(), 0);
      await page.screenshot({ path: join(EVIDENCE, "P9-restored.png") });
    },
  );
  it(
    "THE GATE (written file): bounded text, retry, accepted updates and phone cookie file media",
    { timeout: 120000 },
    async () => {
      const threadId = await namedThread("Written file");
      await page.route("**/files/content?**preview=1", (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "Fixture PC offline" } }),
        }),
      );
      await prompt("WRITE: first version");
      const panel = page
        .locator("[data-surface-id]")
        .filter({ has: page.getByRole("heading", { name: "written.md", exact: true }) });
      await panel
        .getByRole("alert")
        .getByText(/Fixture PC offline/)
        .waitFor({ timeout: 20000 });
      await page.unroute("**/files/content?**preview=1");
      await panel.getByRole("button", { name: "Retry file" }).click();
      await panel.getByRole("heading", { name: "Written by the fake" }).waitFor();
      const id = await panel.getAttribute("data-surface-id");
      await prompt("WRITE: second version");
      await panel.getByRole("button", { name: "Use new version" }).waitFor({ timeout: 20000 });
      assert.ok((await panel.innerText()).includes("WRITE: first version"));
      assert.ok(!(await panel.innerText()).includes("WRITE: second version"));
      await panel.getByRole("button", { name: "Use new version" }).click();
      await waitFor(
        () => panel.innerText(),
        (text) => text.includes("WRITE: second version"),
        "accepted written file did not refresh",
      );
      assert.equal(await panel.getAttribute("data-surface-id"), id);
      const intents = await coreRead(
        CORE_URL,
        `/threads/${threadId}/surfaces?clientId=test&fingerprint=gate&widthPx=1440&attentionState=active_canvas`,
      );
      const document = intents.body.intents.find((intent) => intent.id === id);
      assert.equal(document.payload.content.from, "file");
      // Reuse the same granted file path for a media URL; its bytes are a harmless image fixture.
      const media = await coreCommand(CORE_URL, "surface.upsert_intent", {
        idempotencyKey: "file-media-cookie",
        threadId,
        kind: "media",
        role: "supporting",
        persistence: "restorable",
        priority: 100,
        minSize: "compact",
        sourceIds: ["0199a000-0000-7000-8000-0000000000af"],
        payloadVersion: 1,
        payload: {
          title: "File image",
          mediaType: "image/png",
          source: { ...document.payload.content, relativePath: "frame.png" },
        },
      });
      assert.equal(media.status, 200);
      await page.setViewportSize({ width: 400, height: 860 });
      await page.getByRole("button", { name: "Open panel written.md", exact: true }).click();
      const sheet = page.getByRole("region", { name: "Panel sheet" });
      await waitFor(
        () => sheet.innerText(),
        (text) => text.includes("WRITE: second version"),
        "phone document did not load",
      );
      const downloadBox = await sheet
        .getByRole("link", { name: "Download full file" })
        .boundingBox();
      assert.ok(
        downloadBox.width >= 44 && downloadBox.height >= 44,
        "phone download touch target below 44px",
      );
      await page.screenshot({ path: join(EVIDENCE, "P11-phone-file.png") });
      await page.getByRole("button", { name: "Leave focus", exact: true }).click();
      await page.getByRole("button", { name: /^Show .* more panels/ }).click();
      // The panel keeps the accepted bytes as a blob, so the cookie request is the proof.
      const fetched = page.waitForResponse(
        (response) =>
          /\/files\/content\?node=.*root=.*path=frame.png/.test(response.url()) &&
          response.status() === 200,
      );
      await page
        .getByRole("list", { name: "More panels" })
        .getByRole("button", { name: "Open panel File image", exact: true })
        .click();
      await fetched;
      const image = sheet.locator("img");
      await image.waitFor();
      assert.equal(await image.evaluate((img) => new URL(img.src).origin), WEB_URL);
      await waitFor(
        () => image.evaluate((img) => img.complete && img.naturalWidth === 1),
        Boolean,
        "phone file image did not load with cookie",
      );
      await page.getByRole("button", { name: "Leave focus", exact: true }).click();
      await page.setViewportSize({ width: 1440, height: 900 });
    },
  );
  it(
    "file text keeps last good content, updates supporting files and discards old-owner responses",
    { timeout: 120000 },
    async () => {
      const threadId = await namedThread("File race original");
      await prompt("WRITE: original owner");
      const panel = page
        .locator("[data-surface-id]")
        .filter({ has: page.getByRole("heading", { name: "written.md", exact: true }) });
      await panel.getByRole("heading", { name: "Written by the fake" }).waitFor({ timeout: 20000 });
      await panel.getByRole("button", { name: "Pin written.md", exact: true }).click();
      await panel.getByRole("button", { name: "Unpin written.md", exact: true }).waitFor();
      const read = await coreRead(
        CORE_URL,
        `/threads/${threadId}/surfaces?clientId=test&fingerprint=gate&widthPx=1440&attentionState=active_canvas`,
      );
      const original = read.body.intents.find((intent) => intent.kind === "document");
      writeFileSync(join(scratch, "notes", "written.md"), "# Supporting new bytes\n");
      const update = (key) =>
        coreCommand(CORE_URL, "surface.upsert_intent", {
          idempotencyKey: key,
          threadId,
          kind: original.kind,
          role: "supporting",
          persistence: original.persistence,
          priority: original.priority,
          minSize: original.minSize,
          sourceIds: original.sourceIds,
          payloadVersion: original.payloadVersion,
          payload: original.payload,
        });
      await update("supporting-file-revision");
      await panel.getByRole("heading", { name: "Supporting new bytes" }).waitFor();
      const pattern = "**/files/content?**preview=1";
      await page.route(pattern, (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "Temporary read failure" } }),
        }),
      );
      await update("supporting-file-error");
      await panel
        .getByRole("alert")
        .getByText(/Temporary read failure/)
        .waitFor();
      assert.equal(
        await panel.getByRole("heading", { name: "Supporting new bytes" }).isVisible(),
        true,
      );
      await page.unroute(pattern);
      let release;
      let arrived;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      const requested = new Promise((resolve) => {
        arrived = resolve;
      });
      const handler = async (route) => {
        arrived();
        await held;
        await route
          .fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ text: "Previous owner text", truncated: false }),
          })
          .catch(() => {});
      };
      await page.route(pattern, handler);
      await panel.getByRole("button", { name: "Retry file" }).click();
      await requested;
      await page.unroute(pattern, handler);
      try {
        await namedThread("File race next");
        await prompt("WRITE: next owner");
        await panel
          .getByRole("heading", { name: "Written by the fake" })
          .waitFor({ timeout: 20000 });
        release();
        await waitFor(
          () => panel.innerText(),
          (text) => text.includes("WRITE: next owner"),
          "next owner file did not load",
        );
        assert.ok(!(await page.locator("body").innerText()).includes("Previous owner text"));
      } finally {
        release();
        await page.unroute(pattern);
      }
    },
  );
  it(
    "THE GATE (recall): Open in Vault lands on the recalled entity",
    { timeout: 120000 },
    async () => {
      await namedThread("Recall panel");
      await prompt("Tell me about Alex Kerr");
      const panels = page.getByRole("complementary", { name: "Thread panels" });
      await panels.locator("details summary").waitFor();
      await panels.locator("details summary").click();
      await panels.locator("details").getByRole("button", { name: "Show", exact: true }).click();
      await panels
        .getByRole("button", { name: "Open in Vault" })
        .first()
        .waitFor({ timeout: 20000 });
      await panels.getByRole("button", { name: "Open in Vault" }).first().click();
      await page.getByRole("heading", { name: "Vault", exact: true }).waitFor();
      await page.getByRole("region", { name: "Note: Alex Kerr", exact: true }).waitFor();
      await page.screenshot({ path: join(EVIDENCE, "P10-open-vault.png") });
    },
  );
  it(
    "THE GATE (work panels): a document and shortlist choices reach their conversation on desktop and phone",
    { timeout: 120000 },
    async () => {
      await openThreads();
      const created = await coreCommand(CORE_URL, "conversation.create_thread", {
        idempotencyKey: "work-panel-thread",
        identityId: "vesper",
        title: "Work panels",
      });
      assert.equal(created.status, 200);
      await page.getByRole("button", { name: "Conversations", exact: true }).click();
      await page.getByRole("button", { name: "Work panels", exact: true }).click();
      await page
        .locator('section[aria-label="Threads"] header')
        .getByText(/Work panels/)
        .waitFor();
      await prompt("PANEL: # Plan\n- [ ] first step");
      const document = page.getByRole("complementary", { name: "Thread panels" });
      await document
        .getByRole("heading", { name: "Plan", level: 1, exact: true })
        .waitFor({ timeout: 20000 });
      const check = document.getByRole("checkbox");
      assert.equal(await check.isChecked(), false);
      assert.equal(await check.isDisabled(), true);
      await page.screenshot({ path: join(EVIDENCE, "P8-document.png") });
      await prompt("CHOICE: Alpha | Beta");
      await document
        .getByRole("button", { name: "Use Alpha", exact: true })
        .waitFor({ timeout: 20000 });
      await waitFor(
        () => document.getByRole("button", { name: "Use Alpha", exact: true }).isEnabled(),
        Boolean,
        "choice remains disabled",
      );
      await page.route(
        "**/commands/conversation.send",
        (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
        { times: 1 },
      );
      await document.getByRole("button", { name: "Use Alpha", exact: true }).click();
      await document
        .getByRole("alert")
        .getByText(/conversation.send was refused/)
        .waitFor();
      await page.unroute("**/commands/conversation.send");
      await document.getByRole("button", { name: "Use Alpha", exact: true }).click();
      await page
        .locator('li[data-entry="message"][data-role="user"]')
        .getByText("Use Alpha", { exact: true })
        .waitFor();
      const messages = await coreRead(CORE_URL, `/threads/${created.body.id}/messages`);
      assert.ok(
        messages.body.messages.some(
          (message) => message.role === "user" && message.body === "Use Alpha",
        ),
      );
      await page.setViewportSize({ width: 400, height: 860 });
      await page.getByRole("button", { name: "Open panel Choices", exact: true }).click();
      const sheet = page.getByRole("region", { name: "Panel sheet" });
      await sheet.getByRole("button", { name: "Use Beta", exact: true }).waitFor();
      await waitFor(
        () => sheet.getByRole("button", { name: "Use Beta", exact: true }).isEnabled(),
        Boolean,
        "phone choice remains disabled",
      );
      await page.screenshot({ path: join(EVIDENCE, "P17-phone-choice.png") });
      await sheet.getByRole("button", { name: "Use Beta", exact: true }).click();
      await waitFor(
        async () => {
          const result = await coreRead(CORE_URL, `/threads/${created.body.id}/messages`);
          return result.body.messages.some(
            (message) => message.role === "user" && message.body === "Use Beta",
          );
        },
        Boolean,
        "phone choice was not sent to owning thread",
      );
      await page.getByRole("button", { name: "Leave focus", exact: true }).click();
      const shortAction = await coreCommand(CORE_URL, "surface.upsert_intent", {
        idempotencyKey: "short-panel-action",
        threadId: created.body.id,
        kind: "detail",
        role: "primary",
        persistence: "ephemeral",
        priority: 1000,
        minSize: "compact",
        payloadVersion: 1,
        sourceIds: ["0199a000-0000-7000-8000-0000000000a9"],
        payload: { fields: [], actions: [{ label: ".", message: "Continue" }] },
      });
      assert.equal(shortAction.status, 200);
      await page.getByRole("button", { name: "Open panel Detail", exact: true }).click();
      const shortButton = page
        .getByRole("region", { name: "Panel sheet" })
        .getByRole("button", { name: ".", exact: true });
      await shortButton.waitFor();
      const shortBox = await shortButton.boundingBox();
      assert.ok(
        shortBox.width >= 44 && shortBox.height >= 44,
        `short choice must meet 44px touch floor: ${JSON.stringify(shortBox)}`,
      );
      await page.getByRole("button", { name: "Leave focus", exact: true }).click();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole("button", { name: "Conversations", exact: true }).click();
      await page.getByRole("button", { name: "New conversation", exact: true }).click();
    },
  );
  it(
    "THE GATE (work panels): a delayed free-chat choice keeps its thread after another client starts fresh",
    { timeout: 120000 },
    async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openThreads();
      await prompt("CHOICE: Original | Other");
      const choice = page
        .getByRole("complementary", { name: "Thread panels" })
        .getByRole("button", { name: "Use Original", exact: true });
      await choice.waitFor({ timeout: 20000 });
      await waitFor(() => choice.isEnabled(), Boolean, "free-thread choice remains disabled");
      const original = await coreRead(CORE_URL, "/threads?identityId=vesper");
      assert.equal(original.status, 200);
      let release;
      let arrived;
      let choiceBody;
      const held = new Promise((resolve) => {
        release = resolve;
      });
      const requested = new Promise((resolve) => {
        arrived = resolve;
      });
      const route = "**/commands/conversation.send";
      await page.route(
        route,
        async (handler) => {
          choiceBody = handler.request().postDataJSON();
          arrived();
          await held;
          await handler.continue();
        },
        { times: 1 },
      );
      try {
        await choice.click();
        await requested;
        const fresh = await coreCommand(CORE_URL, "conversation.start_fresh", {
          idempotencyKey: "choice-race-fresh",
          identityId: "vesper",
        });
        assert.equal(fresh.status, 200);
        const sent = page.waitForResponse((response) =>
          response.url().endsWith("/commands/conversation.send"),
        );
        release();
        const response = await sent;
        assert.equal(response.status(), 200);
        assert.equal(
          choiceBody.threadId,
          original.body.id,
          "the delayed choice must explicitly name its original thread",
        );
        const oldMessages = await coreRead(CORE_URL, `/threads/${original.body.id}/messages`);
        assert.ok(
          oldMessages.body.messages.some(
            (message) => message.role === "user" && message.body === "Use Original",
          ),
        );
        const newFree = await coreRead(CORE_URL, "/threads?identityId=vesper");
        assert.equal(newFree.status, 404, "the old choice must not create a new free conversation");
      } finally {
        release();
        await page.unroute(route);
      }
    },
  );
  it(
    "THE GATE (panels): an image a turn makes opens beside the conversation without reload",
    { timeout: 120000 },
    async () => {
      await openThreads();
      await prompt("IMAGE: a frame");
      const image = page
        .locator('section[aria-label="Threads"] section[data-surface-region] img')
        .first();
      await image.waitFor({ timeout: 20000 });
      const output = page.locator('ul[aria-label="Outputs"] img').last();
      assert.equal(await image.getAttribute("src"), await output.getAttribute("src"));
      await waitFor(
        () => image.evaluate((node) => node.complete && node.naturalWidth > 0),
        Boolean,
        "panel image never loaded",
      );
      const panelBox = await image.boundingBox();
      const conversationBox = await page
        .getByRole("list", { name: "Conversation", exact: true })
        .boundingBox();
      // Panels float: it opens on the right, over the page, not in a column beside it.
      assert.ok(panelBox.x > conversationBox.x, "the image panel did not open on the right");
      assert.equal(await page.locator(".noctis-intelligence").count(), 1);
      await waitFor(
        async () => {
          const box = await page.locator(".noctis-intelligence").boundingBox();
          return (
            box.x >= conversationBox.x &&
            box.x + box.width <= conversationBox.x + conversationBox.width
          );
        },
        Boolean,
        "the core never settled inside the conversation column",
      );
      await captureSettled("P6-desktop-image");
    },
  );
  it(
    "failed refresh retains content, Retry recovers and primary changes wait for acceptance",
    { timeout: 120000 },
    async () => {
      const threads = await coreRead(CORE_URL, "/threads?identityId=vesper");
      const threadId = threads.body.id;
      const base = {
        threadId,
        kind: "detail",
        persistence: "ephemeral",
        priority: 100,
        minSize: "compact",
        payloadVersion: 1,
      };
      let sequence = 0;
      const upsert = async (role, title) => {
        const result = await coreCommand(CORE_URL, "surface.upsert_intent", {
          ...base,
          idempotencyKey: `panel-refresh-${++sequence}`,
          role,
          sourceIds: [
            role === "primary"
              ? "0199a000-0000-7000-8000-0000000000a1"
              : "0199a000-0000-7000-8000-0000000000a2",
          ],
          payload: { fields: [{ label: "Version", value: title }] },
        });
        assert.equal(result.status, 200, JSON.stringify(result.body));
      };
      await upsert("primary", "primary old");
      await page.getByText("primary old", { exact: true }).waitFor();
      await upsert("supporting", "support old");
      await page.getByText("support old", { exact: true }).waitFor();
      const route = "**/threads/*/surfaces?*";
      await page.route(route, async (handler) => {
        await handler.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      });
      await upsert("supporting", "support new");
      await page.getByRole("button", { name: "Retry", exact: true }).first().waitFor();
      assert.equal(await page.getByText("support old", { exact: true }).count(), 1);
      await captureSettled("P6-desktop-refresh-failed");
      await page.unroute(route);
      await page.getByRole("button", { name: "Retry", exact: true }).first().click();
      await page.getByText("support new", { exact: true }).waitFor();
      await captureSettled("P7-desktop-retry");
      await upsert("primary", "primary new");
      await page.getByRole("button", { name: "Use new version", exact: true }).waitFor();
      assert.equal(await page.getByText("primary old", { exact: true }).count(), 1);
      assert.equal(await page.getByText("primary new", { exact: true }).count(), 0);
      await captureSettled("P6-desktop-new-version");
      await page.getByRole("button", { name: "Use new version", exact: true }).click();
      await page.getByText("primary new", { exact: true }).waitFor();
    },
  );

  it(
    "switching owner clears focus and ignores the previous owner's delayed refresh",
    { timeout: 120000 },
    async () => {
      const current = await coreRead(CORE_URL, "/threads?identityId=vesper");
      await page
        .getByRole("button", { name: /^Focus / })
        .first()
        .click();
      let release;
      let arrived;
      const requested = new Promise((resolve) => {
        arrived = resolve;
      });
      const delayed = new Promise((resolve) => {
        release = resolve;
      });
      await page.route(`**/threads/${current.body.id}/surfaces?*`, async (route) => {
        const response = await route.fetch();
        arrived();
        await delayed;
        await route.fulfill({ response });
      });
      await coreCommand(CORE_URL, "surface.upsert_intent", {
        idempotencyKey: "delayed-old",
        threadId: current.body.id,
        kind: "detail",
        role: "supporting",
        persistence: "ephemeral",
        priority: 100,
        minSize: "compact",
        payloadVersion: 1,
        sourceIds: ["0199a000-0000-7000-8000-0000000000a2"],
        payload: { fields: [{ label: "Version", value: "stale owner content" }] },
      });
      await requested;
      const created = await coreCommand(CORE_URL, "conversation.create_thread", {
        idempotencyKey: "owner-new-thread",
        identityId: "vesper",
        title: "Clean owner",
      });
      assert.equal(created.status, 200);
      await page.getByRole("button", { name: "Conversations", exact: true }).click();
      await page.getByRole("button", { name: "Clean owner", exact: true }).click();
      await page
        .locator("section[aria-label=Threads] header")
        .getByText(/Clean owner/)
        .waitFor();
      assert.equal(
        await page.locator('section[aria-label="Threads"] [data-surface-region]').count(),
        0,
      );
      release();
      await page.waitForTimeout(250);
      assert.equal(await page.getByText("stale owner content", { exact: true }).count(), 0);
      assert.equal(
        await page.locator('section[aria-label="Threads"] [data-surface-region]').count(),
        0,
      );
      const width = await page
        .locator('section[aria-label="Threads"] > div')
        .evaluate((node) => node.getBoundingClientRect().width);
      assert.ok(width <= 880);
    },
  );
  it(
    "two owners recover after focused close and external removal, and focus switches sources",
    { timeout: 120000 },
    async () => {
      const created = await coreCommand(CORE_URL, "objective.create", {
        idempotencyKey: "focus-objective",
        title: "Focus recovery",
        intent: "Keep both owners accessible",
        status: "draft",
        identityId: "vesper",
      });
      assert.equal(created.status, 200);
      const objectiveId = created.body.id;
      const activated = await coreCommand(CORE_URL, "objective.change_status", {
        idempotencyKey: "focus-activate",
        objectiveId,
        expectedRevision: 0,
        status: "active",
      });
      assert.equal(activated.status, 200);
      await openThreads();
      await page.getByRole("button", { name: "Back to the Objective", exact: true }).click();
      await prompt("hello objective");
      const thread = await waitFor(
        () => coreRead(CORE_URL, `/threads?identityId=vesper&objectiveId=${objectiveId}`),
        (value) => value.status === 200,
        "Objective prompt did not create its thread",
      );
      assert.equal(thread.status, 200);
      let sequence = 0;
      const panel = async (owner, label, source) => {
        const result = await coreCommand(CORE_URL, "surface.upsert_intent", {
          idempotencyKey: `focus-panel-${++sequence}`,
          ...owner,
          kind: "detail",
          role: "primary",
          persistence: "ephemeral",
          priority: 1000,
          minSize: "compact",
          sourceIds: [source],
          payloadVersion: 1,
          payload: { fields: [{ label: "Owner", value: label }] },
        });
        assert.equal(result.status, 200, JSON.stringify(result.body));
        return page.locator(`[data-surface-id="${result.body.id}"]`);
      };
      const objectivePanel = await panel(
        { objectiveId },
        "Objective owner view",
        "0199a000-0000-7000-8000-0000000000b1",
      );
      const threadPanel = await panel(
        { threadId: thread.body.id },
        "Thread owner view",
        "0199a000-0000-7000-8000-0000000000b2",
      );
      await threadPanel.waitFor();
      await objectivePanel.waitFor();
      await threadPanel.getByRole("button", { name: /^Focus / }).click();
      await page.getByRole("button", { name: "Leave focus", exact: true }).waitFor();
      assert.equal(await objectivePanel.count(), 0);
      await page.getByRole("button", { name: "Leave focus", exact: true }).click();
      await objectivePanel.waitFor();
      await page.waitForTimeout(100);
      assert.equal(
        await page.getByLabel("Message Vesper").evaluate((node) => node === document.activeElement),
        false,
        "leaving desktop focus must not pull focus into the composer",
      );
      await objectivePanel.getByRole("button", { name: /^Focus / }).click();
      await page.getByRole("button", { name: "Leave focus", exact: true }).waitFor();
      assert.equal(await threadPanel.count(), 0);
      await page.getByRole("button", { name: "Leave focus", exact: true }).click();
      await threadPanel.waitFor();
      await threadPanel.getByRole("button", { name: /^Focus / }).click();
      await threadPanel.getByRole("button", { name: /^Close / }).click();
      await objectivePanel.waitFor({ timeout: 5000 });
      assert.equal(await page.getByRole("button", { name: "Leave focus", exact: true }).count(), 0);
      const restored = await panel(
        { threadId: thread.body.id },
        "Thread restored",
        "0199a000-0000-7000-8000-0000000000b3",
      );
      await restored.waitFor();
      await objectivePanel.getByRole("button", { name: /^Focus / }).click();
      await page.getByRole("button", { name: "Leave focus", exact: true }).waitFor();
      const id = await objectivePanel.getAttribute("data-surface-id");
      for (const lifecycle of ["dismissed"]) {
        const result = await coreCommand(CORE_URL, "surface.change_lifecycle", {
          idempotencyKey: `external-${lifecycle}`,
          surfaceId: id,
          lifecycle,
        });
        assert.equal(result.status, 200, JSON.stringify(result.body));
      }
      await restored.waitFor({ timeout: 5000 });
      assert.equal(await page.getByRole("button", { name: "Leave focus", exact: true }).count(), 0);
    },
  );
  it(
    "an old mutation refusal cannot mark owner A failed after an A to B to A switch",
    { timeout: 120000 },
    async () => {
      let release;
      let arrived;
      const requested = new Promise((resolve) => {
        arrived = resolve;
      });
      const delayed = new Promise((resolve) => {
        release = resolve;
      });
      const routePattern = "**/commands/surface.arrange";
      await page.route(routePattern, async (route) => {
        arrived();
        await delayed;
        await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      });
      const restored = page.locator("[data-surface-id]").filter({ hasText: "Thread restored" });
      await restored.getByRole("button", { name: /^Pin / }).click();
      await requested;
      await page.getByRole("button", { name: "Ask something else", exact: true }).click();
      await page.getByRole("button", { name: "Back to the Objective", exact: true }).waitFor();
      await page.getByRole("button", { name: "Back to the Objective", exact: true }).click();
      await restored.waitFor();
      const response = page.waitForResponse(
        (reply) => reply.url().endsWith("/commands/surface.arrange") && reply.status() === 503,
      );
      release();
      await response;
      await page.waitForTimeout(250);
      assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).count(), 0);
      await page.unroute(routePattern);
    },
  );
  it(
    "THE GATE (panels, phone): chip opens a sheet and Back restores its trigger",
    { timeout: 120000 },
    async () => {
      await page.setViewportSize({ width: 400, height: 860 });
      await openThreads();
      const created = await coreCommand(CORE_URL, "conversation.create_thread", {
        idempotencyKey: "phone-image-thread",
        identityId: "vesper",
        title: "Phone image",
      });
      assert.equal(created.status, 200);
      await page.getByRole("button", { name: "Conversations", exact: true }).click();
      await page.getByRole("button", { name: "Phone image", exact: true }).click();
      await page
        .locator('section[aria-label="Threads"] header')
        .getByText(/Phone image/)
        .waitFor();
      await prompt("IMAGE: on the phone");
      const chip = page.getByRole("button", { name: /^Open panel / }).first();
      await chip.waitFor({ timeout: 20000 });
      const thumbnail = chip.locator("img");
      await waitFor(
        () => thumbnail.evaluate((node) => node.complete && node.naturalWidth > 0),
        Boolean,
        "image chip did not decode",
      );
      assert.equal(await page.getByRole("region", { name: "Panel sheet" }).count(), 0);
      await captureSettled("P7-phone-chip");
      await chip.click();
      await page.getByRole("region", { name: "Panel sheet" }).waitFor();
      assert.equal(
        await page.getByRole("list", { name: "Conversation", exact: true }).isVisible(),
        false,
      );
      assert.equal(await page.getByLabel("Message Vesper").isVisible(), true);
      assert.equal(await page.getByRole("button", { name: /^Place / }).count(), 0);
      const image = page.getByRole("region", { name: "Panel sheet" }).locator("img");
      await waitFor(
        () => image.evaluate((node) => node.complete && node.naturalWidth > 0),
        Boolean,
        "sheet image did not decode",
      );
      assert.equal(await image.getAttribute("src"), await thumbnail.getAttribute("src"));
      const leave = await page
        .getByRole("button", { name: "Leave focus", exact: true })
        .boundingBox();
      const header = await page
        .locator('section[aria-label="Threads"] > div > header')
        .boundingBox();
      assert.ok(leave.y >= header.y + header.height);
      await captureSettled("P7-phone-sheet");
      await page.getByLabel("Message Vesper").fill("Composer stays usable");
      await page.getByLabel("Message Vesper").fill("");
      await page.goBack();
      await page.getByRole("list", { name: "Conversation", exact: true }).waitFor();
      assert.equal(await chip.evaluate((node) => node === document.activeElement), true);
      await captureSettled("P7-phone-back");
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
        0,
      );
    },
  );
  it(
    "phone overflow keeps both owners available and focused close restores the composer",
    { timeout: 120000 },
    async () => {
      await page.setViewportSize({ width: 400, height: 860 });
      const objective = await coreCommand(CORE_URL, "objective.create", {
        idempotencyKey: "phone-objective",
        title: "Phone owners",
        intent: "Panel isolation",
        status: "draft",
        identityId: "vesper",
      });
      assert.equal(objective.status, 200);
      await coreCommand(CORE_URL, "objective.change_status", {
        idempotencyKey: "phone-activate",
        objectiveId: objective.body.id,
        expectedRevision: 0,
        status: "active",
      });
      await openThreads();
      if (await page.getByRole("button", { name: "Back to the Objective", exact: true }).count())
        await page.getByRole("button", { name: "Back to the Objective", exact: true }).click();
      await prompt("phone owners");
      const thread = await waitFor(
        () => coreRead(CORE_URL, `/threads?identityId=vesper&objectiveId=${objective.body.id}`),
        (value) => value.status === 200 && value.body?.id !== undefined,
        "objective thread was not created",
      );
      const ids = [];
      for (let index = 0; index < 5; index++) {
        const result = await coreCommand(CORE_URL, "surface.upsert_intent", {
          idempotencyKey: `phone-panel-${index}`,
          ...(index === 0 ? { objectiveId: objective.body.id } : { threadId: thread.body.id }),
          kind: "detail",
          role: index === 0 ? "primary" : "supporting",
          persistence: "ephemeral",
          priority: index === 0 ? 1000 : 100 - index,
          minSize: "compact",
          payloadVersion: 1,
          sourceIds: [`0199a000-0000-7000-8000-0000000000c${index}`],
          payload: { fields: [{ label: "Owner", value: `phone owner ${index}` }] },
        });
        assert.equal(result.status, 200, JSON.stringify(result.body));
        ids.push(result.body.id);
      }
      const more = page.getByRole("button", { name: /^Show .* more panels/ });
      await more.waitFor();
      await more.click();
      await page.getByRole("list", { name: "More panels" }).waitFor();
      await captureSettled("P7-phone-overflow");
      await page.getByRole("list", { name: "More panels" }).getByRole("button").last().click();
      await page.getByRole("button", { name: "Leave focus", exact: true }).waitFor();
      await more.click();
      const objectiveChip = page.locator(`[data-panel-id="${ids[0]}"]`);
      await objectiveChip.click();
      await page.getByText("phone owner 0", { exact: true }).waitFor();
      assert.equal(
        await page
          .getByRole("region", { name: "Panel sheet" })
          .locator("[data-surface-id]")
          .count(),
        1,
      );
      await page.getByRole("button", { name: "Leave focus", exact: true }).click();
      await page.getByRole("list", { name: "Conversation", exact: true }).waitFor();
      await more.click();
      await objectiveChip.click();
      await page.getByRole("button", { name: "Close Detail", exact: true }).click();
      await page.getByRole("list", { name: "Conversation", exact: true }).waitFor();
      await waitFor(
        () => page.getByLabel("Message Vesper").evaluate((node) => node === document.activeElement),
        Boolean,
        "close did not restore composer focus",
      );
      await captureSettled("P7-phone-close");
    },
  );
  it(
    "a refused phone close keeps the sheet and Leave focus still restores the chip",
    { timeout: 120000 },
    async () => {
      const created = await coreCommand(CORE_URL, "conversation.create_thread", {
        idempotencyKey: "phone-refused-close-thread",
        identityId: "vesper",
        title: "Refused close",
      });
      assert.equal(created.status, 200);
      await page.getByRole("button", { name: "Conversations", exact: true }).click();
      await page.getByRole("button", { name: "Refused close", exact: true }).click();
      await page
        .locator('section[aria-label="Threads"] header')
        .getByText(/Refused close/)
        .waitFor();
      const upserted = await coreCommand(CORE_URL, "surface.upsert_intent", {
        idempotencyKey: "phone-refused-close-panel",
        threadId: created.body.id,
        kind: "detail",
        role: "primary",
        persistence: "ephemeral",
        priority: 1000,
        minSize: "compact",
        payloadVersion: 1,
        sourceIds: ["0199a000-0000-7000-8000-0000000000d1"],
        payload: { fields: [{ label: "Owner", value: "refused close" }] },
      });
      assert.equal(upserted.status, 200, JSON.stringify(upserted.body));
      const route = "**/commands/surface.change_lifecycle";
      await page.route(
        route,
        (handler) => handler.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
        { times: 1 },
      );
      const chip = page
        .getByRole("navigation", { name: "Panel tray" })
        .getByRole("button", { name: /^Open panel / })
        .first();
      await chip.click();
      const sheet = page.getByRole("region", { name: "Panel sheet" });
      await sheet.waitFor();
      const refused = page.waitForResponse(
        (reply) =>
          reply.url().endsWith("/commands/surface.change_lifecycle") && reply.status() === 503,
      );
      await sheet.getByRole("button", { name: /^Close / }).click();
      await refused;
      await page.waitForTimeout(250);
      assert.equal(await sheet.isVisible(), true);
      await page.unroute(route);
      await page.getByRole("button", { name: "Leave focus", exact: true }).click();
      await sheet.waitFor({ state: "detached" });
      await waitFor(
        () => chip.evaluate((node) => node === document.activeElement),
        Boolean,
        "Leave focus after a refused close did not restore the chip",
      );
    },
  );
});

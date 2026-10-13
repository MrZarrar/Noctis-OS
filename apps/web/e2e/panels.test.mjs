import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { Buffer } from "node:buffer";

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
      await panels.locator("details summary").waitFor();
      const surfaces = await coreRead(
        CORE_URL,
        `/threads/${threadId}/surfaces?clientId=test&fingerprint=gate&widthPx=1440&attentionState=active_canvas`,
      );
      const secondId = surfaces.body.intents.find(
        (intent) => intent.kind === "media" && intent.id !== firstId,
      ).id;
      await panels.locator("details summary").click();
      await panels
        .locator("details")
        .getByRole("button", { name: "Close", exact: true })
        .first()
        .click();
      await waitFor(
        () => panels.locator("details").count(),
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
      await page
        .getByRole("list", { name: "More panels" })
        .getByRole("button", { name: "Open panel File image", exact: true })
        .click();
      const image = sheet.locator("img");
      await image.waitFor();
      assert.match(
        await image.getAttribute("src"),
        /\/files\/content\?node=.*root=.*path=frame.png/,
      );
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
      assert.ok(panelBox.x >= conversationBox.x + conversationBox.width);
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
      const routePattern = "**/commands/surface.set_override";
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
        (reply) => reply.url().endsWith("/commands/surface.set_override") && reply.status() === 503,
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

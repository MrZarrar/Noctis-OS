import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import {
  TOKEN,
  coreRead,
  launchOptions,
  startFakeNode,
  startProcess,
  stopProcess,
  tabTo,
  waitFor,
  waitForHttp,
} from "./harness.mjs";

/**
 * Task 1.9's gate, from the outside: a prompt typed into Chat becomes a turn on
 * a paired node running the fake runtime, and what comes back — the committed
 * reply, the command item, the ask — reaches the page and can be answered.
 *
 * The browser transport polls the committed ledger and receives no token deltas
 * (Slice 2 adds SSE), so this suite asserts the committed message, the items,
 * and the approval card; the delta path is proven in useConversation.test.ts
 * through the Tauri frame contract.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const WEB_ROOT = join(REPO_ROOT, "apps/web");
const AGENT_MAIN = join(REPO_ROOT, "apps/node-agent/dist/main.js");

/**
 * What the fake runtime's `ASK:` branch asks about (`FAKE_ASK_COMMAND` in
 * `apps/node-agent/src/runtimes/fake.ts`). It must classify as `external_write`,
 * or the evaluator allows it outright and no card ever appears — which is how
 * this test caught the branch asking about `echo hi`, a read-only head.
 */
const ASK_COMMAND = "curl -X POST https://example.invalid/hook";

const CORE_PORT = 8799;
const WEB_PORT = 4185;
const CORE_URL = `http://127.0.0.1:${CORE_PORT}`;
const WEB_URL = `http://localhost:${WEB_PORT}`;

let core;
let agent;
let web;
let browser;
let page;
let databaseDirectory;
let nodeHome;
let scratch;

/** Reloads and walks to Chat with the keyboard. */
async function openChat() {
  await page.goto(WEB_URL);
  await tabTo(page, "Threads");
  await page.keyboard.press("Enter");
  await waitFor(readPage, (state) => state.heading === "Threads", "Threads never opened");
}

async function prompt(text) {
  await tabTo(page, "Message Vesper");
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

/** What Chat currently shows, in the terms the gate is written in. */
function readPage() {
  return page.evaluate(() => {
    const texts = (selector) =>
      [...document.querySelectorAll(selector)].map((node) => node.textContent?.trim() ?? "");
    const confirm = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Confirm",
    );

    return {
      heading: document.querySelector("h1")?.textContent ?? "",
      // One chronological list now, so each kind is read by its data-entry
      // rather than by its own `ul`. Document order is still time order.
      messages: texts('li[data-entry="message"]'),
      turns: [...document.querySelectorAll('li[data-entry="turn"]')].map(
        (item) => item.dataset.turnStatus ?? "",
      ),
      items: [
        ...document.querySelectorAll(
          'ul[aria-label="Turn items"] > li, ul[aria-label="Outputs"] > li',
        ),
      ].map((item) => ({
        kind: item.dataset.itemKind ?? "",
        status: item.dataset.itemStatus ?? "",
        text: item.textContent?.trim() ?? "",
      })),
      approvals: texts('li[data-entry="approval"]'),
      confirmDisabled: confirm === undefined ? null : confirm.disabled,
      // Visible only: a closed picker's rows remain in the list its button controls.
      modelOptions: [
        ...document.querySelectorAll('button[aria-haspopup="listbox"][aria-label^="Agent"]'),
      ]
        .filter((button) => button.checkVisibility())
        .flatMap((button) => [
          ...(document
            .getElementById(button.getAttribute("aria-controls") ?? "")
            ?.querySelectorAll('[role="option"]') ?? []),
        ])
        .map((option) => option.textContent ?? ""),
      errors: texts("p").filter((text) => text.includes("refused") || text.includes("could not")),
    };
  });
}

describe("Chat: a prompt becomes a turn, and the turn's ask is answered from the page", () => {
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
      keyPrefix: "e2e-chat",
    }));

    await waitForHttp(WEB_URL, "the web app", web);

    browser = await chromium.launch(launchOptions());
    page = await browser.newPage({ viewport: { width: 1900, height: 1000 } });
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
    "THE GATE: sends from Chat, shows the reply and the command, and confirms the ask",
    { timeout: 120_000 },
    async () => {
      await openChat();

      // `label ?? model (providerId)`: the fake probe labels its model "Fake".
      const empty = await waitFor(
        readPage,
        (state) => state.modelOptions.includes("Fake (codex)"),
        "the model selector never offered the fake node's model from GET /models",
      );

      assert.deepEqual(empty.messages, []);

      await prompt("ASK: hello");

      // The user's message commits inside the send; the reply commits when the
      // node's `agent_message` item completes.
      const replied = await waitFor(
        readPage,
        (state) => state.messages.length === 2,
        "the reply never committed",
      );

      assert.equal(replied.messages[0], "You: ASK: hello");
      assert.equal(replied.messages[1], "Vesper: Hello ASK: hello");

      // Free chat: the runtime's command asks, and the ask reaches Chat as a card.
      const asked = await waitFor(
        readPage,
        (state) =>
          state.approvals.length === 1 &&
          state.items.some((item) => item.kind === "command" && item.status === "in_progress"),
        "the runtime's ask never became an approval card",
      );

      assert.ok(asked.approvals[0].includes(`run ${ASK_COMMAND}`), asked.approvals[0]);
      assert.ok(asked.approvals[0].includes(`command: ${ASK_COMMAND}`), asked.approvals[0]);
      assert.equal(asked.confirmDisabled, false, "a plain confirmation is gated");
      assert.ok(
        asked.items.some((item) => item.kind === "command" && item.status === "in_progress"),
        `the command item is not waiting: ${JSON.stringify(asked.items)}`,
      );

      // A reload before answering: the pending ask must be re-read from the
      // core, not remembered by the page that happened to receive the event.
      await openChat();
      await waitFor(
        readPage,
        (state) => state.approvals.length === 1,
        "the pending approval did not survive a reload",
      );

      await tabTo(page, "Confirm");
      await page.keyboard.press("Enter");

      const done = await waitFor(
        readPage,
        (state) =>
          state.approvals.length === 0 &&
          state.items.some((item) => item.kind === "command" && item.status === "completed") &&
          state.turns.every((status) => status === "completed"),
        "confirming did not let the command finish",
      );

      const command = done.items.find((item) => item.kind === "command");

      assert.ok(command.text.includes(ASK_COMMAND), command.text);
      assert.ok(command.text.includes("→ hi"), `no output shown: ${command.text}`);
      assert.deepEqual(done.errors, []);
    },
  );

  it("shows a proposal item when the runtime proposes", { timeout: 120_000 }, async () => {
    await openChat();
    await waitFor(readPage, (state) => state.messages.length === 2, "history did not load");

    await prompt("PROPOSE: plan");

    const proposed = await waitFor(
      readPage,
      (state) =>
        state.items.some((item) => item.kind === "proposal" && item.status === "completed") &&
        state.turns.length === 2 &&
        state.turns.every((status) => status === "completed"),
      "the proposal never appeared",
    );

    const proposal = proposed.items.find((item) => item.kind === "proposal");

    assert.ok(proposal.text.includes("objective: Suggested"), proposal.text);
    assert.equal(proposed.messages.length, 4);
    assert.equal(proposed.messages[3], "Vesper: Hello PROPOSE: plan");
    assert.deepEqual(proposed.errors, []);
  });

  it(
    "a delegation is approved here, opens as its own thread with its image, and the owner continues it",
    { timeout: 120_000 },
    async () => {
      await openChat();
      await waitFor(readPage, (state) => state.messages.length === 4, "history did not load");

      await prompt("DELEGATE: frame 1");

      // Free chat, so each of the fake's two delegations asks the owner first.
      for (const brief of ["IMAGE: frame 1", "IMAGE: again, darker"]) {
        const card = `hand to codex: ${brief}`;

        await waitFor(
          readPage,
          (state) => state.approvals.some((text) => text.includes(card)),
          `the delegation of "${brief}" never asked`,
        );
        await tabTo(page, "Confirm");
        await page.keyboard.press("Enter");
        await waitFor(
          readPage,
          (state) => !state.approvals.some((text) => text.includes(card)),
          `confirming "${brief}" did not close its card`,
        );
      }

      const reported = await waitFor(
        readPage,
        (state) => state.messages.some((text) => text.startsWith("Vesper: delegated:")),
        "the parent never reported its delegations",
      );
      const [first, second] = JSON.parse(
        reported.messages.find((text) => text.startsWith("Vesper: delegated:")).slice(18),
      );

      assert.equal(first.outcome, "completed");
      assert.equal(second.threadId, first.threadId, "the second request started a new thread");

      await tabTo(page, "Delegated thread 1");
      await page.keyboard.press("Enter");

      const child = await waitFor(
        readPage,
        (state) =>
          state.messages.includes("You: IMAGE: frame 1") &&
          state.items.some((item) => item.kind === "output" && item.text.includes("image/png")),
        "the delegated thread did not open with its image",
      );

      assert.ok(child.messages.includes("You: IMAGE: again, darker"), child.messages.join(" | "));

      await prompt("IMAGE: one more");
      await waitFor(
        readPage,
        (state) =>
          state.messages.includes("Vesper: Hello IMAGE: one more") &&
          state.turns.every((status) => status === "completed"),
        "the owner's follow-up did not run on the delegated thread",
      );

      await tabTo(page, "Back");
      await page.keyboard.press("Enter");
      await waitFor(
        readPage,
        (state) => state.messages.includes("You: DELEGATE: frame 1"),
        "Back did not return to the parent thread",
      );
    },
  );

  it(
    "previews a pasted screenshot, closes with focus restored and removes it",
    { timeout: 60_000 },
    async () => {
      await openChat();
      await page.getByRole("textbox", { name: "Message Vesper" }).evaluate((textarea) => {
        const png = Uint8Array.from(
          globalThis.atob(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          ),
          (character) => character.charCodeAt(0),
        );
        const clipboard = new globalThis.DataTransfer();
        clipboard.items.add(new globalThis.File([png], "image.png", { type: "image/png" }));
        textarea.dispatchEvent(
          new globalThis.ClipboardEvent("paste", {
            clipboardData: clipboard,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      const chip = page.getByRole("button", { name: /^Preview screenshot-/ });
      await chip.click();
      const preview = page.getByRole("dialog", { name: /^screenshot-/ });
      await preview.waitFor();
      await page.waitForFunction(
        () => document.querySelector("dialog[open] img")?.naturalWidth > 0,
      );
      assert.ok((await preview.locator("img").getAttribute("src")).startsWith("blob:"));
      await preview.getByRole("button", { name: "Close", exact: true }).click();
      await preview.waitFor({ state: "hidden" });
      assert.equal(await chip.evaluate((button) => button === document.activeElement), true);
      await chip.press("Space");
      await preview.waitFor();
      await page.keyboard.press("Escape");
      await preview.waitFor({ state: "hidden" });
      await chip.press("Enter");
      await preview.waitFor();
      await page.evaluate(() => globalThis.history.back());
      await preview.waitFor({ state: "hidden" });
      await chip.click();
      await preview.getByRole("button", { name: "Remove", exact: true }).click();
      await page.getByRole("list", { name: "Attached files" }).waitFor({ state: "hidden" });
      assert.equal(
        await page
          .getByRole("textbox", { name: "Message Vesper" })
          .evaluate((textarea) => textarea === document.activeElement),
        true,
      );
    },
  );

  it(
    "attaches a screenshot pasted into the message box, and uploads it with the send",
    { timeout: 120_000 },
    async () => {
      await openChat();
      await waitFor(readPage, (state) => state.messages.length > 0, "history did not load");

      const box = page.getByRole("textbox", { name: "Message Vesper" });

      await box.focus();
      await box.evaluate((textarea) => {
        const png = Uint8Array.from(
          globalThis.atob(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          ),
          (character) => character.charCodeAt(0),
        );
        const clipboard = new globalThis.DataTransfer();

        clipboard.items.add(new globalThis.File([png], "image.png", { type: "image/png" }));
        textarea.dispatchEvent(
          new globalThis.ClipboardEvent("paste", {
            clipboardData: clipboard,
            bubbles: true,
            cancelable: true,
          }),
        );
      });

      const attached = page.getByRole("list", { name: "Attached files" });

      await attached.waitFor();
      assert.match(await attached.innerText(), /screenshot-\d{8}-\d{6}\.png/);

      const upload = page.waitForRequest(
        (request) => request.url().endsWith("/attachments") && request.method() === "POST",
      );

      await box.fill("PASTE: look at this");
      await box.press("Enter");

      const sent = await upload;

      assert.match(sent.headers()["x-noctis-filename"], /^screenshot-\d{8}-\d{6}\.png$/);
      assert.equal((await sent.response()).status(), 200);
      await waitFor(
        readPage,
        (state) =>
          // The fake runtime lists the files it was handed under its reply.
          state.messages.some(
            (text) =>
              text.startsWith("Vesper: Hello PASTE: look at this") &&
              /screenshot-\d{8}-\d{6}\.png \(image\/png\)/.test(text),
          ) && state.turns.every((status) => status === "completed"),
        "the turn with the pasted screenshot never completed",
      );
    },
  );

  it(
    "previews text safely, video inline and binary metadata on a phone",
    { timeout: 60_000 },
    async () => {
      await openChat();
      await page.setViewportSize({ width: 400, height: 850 });
      try {
        await page.evaluate(() => {
          const revoke = globalThis.URL.revokeObjectURL.bind(globalThis.URL);
          globalThis.revokedPreviewUrls = [];
          globalThis.URL.revokeObjectURL = (url) => {
            globalThis.revokedPreviewUrls.push(url);
            revoke(url);
          };
        });
        await page
          .locator('input[type="file"]')
          .filter({ visible: true })
          .setInputFiles([
            {
              name: "notes.txt",
              mimeType: "text/plain",
              buffer: Buffer.from("<b>plain text</b>" + "x".repeat(200 * 1024) + "UNREAD_TAIL"),
            },
            { name: "clip.mp4", mimeType: "video/mp4", buffer: Buffer.from("video bytes") },
            { name: "report.pdf", mimeType: "application/pdf", buffer: Buffer.from("PDF bytes") },
          ]);
        await page.getByRole("button", { name: "Preview notes.txt" }).click();
        const text = page.getByRole("dialog", { name: "notes.txt", exact: true });
        await page.waitForFunction(() =>
          document.querySelector("dialog[open] pre")?.textContent?.startsWith("<b>plain text</b>"),
        );
        assert.equal((await text.locator("pre").innerText()).length, 200 * 1024);
        assert.equal(await text.locator("b").count(), 0);
        assert.ok(!(await text.innerText()).includes("UNREAD_TAIL"));
        const bounds = await text.boundingBox();
        assert.equal(Math.round(bounds.x), 0);
        assert.equal(Math.round(bounds.width), 400);
        assert.equal(Math.round(bounds.y + bounds.height), 850);
        await page.mouse.click(200, Math.max(1, bounds.y - 10));
        await text.waitFor({ state: "hidden" });
        await page.getByRole("button", { name: "Preview clip.mp4" }).click();
        const video = page.getByRole("dialog", { name: "clip.mp4", exact: true }).locator("video");
        await video.waitFor();
        const videoUrl = await video.getAttribute("src");
        assert.ok(videoUrl.startsWith("blob:"));
        assert.equal(
          await video.evaluate((element) => element.controls && element.playsInline),
          true,
        );
        await page
          .getByRole("dialog", { name: "clip.mp4", exact: true })
          .getByRole("button", { name: "Remove", exact: true })
          .click();
        await video.waitFor({ state: "hidden" });
        assert.ok(
          await page.evaluate((url) => globalThis.revokedPreviewUrls.includes(url), videoUrl),
        );
        await page.getByRole("button", { name: "Preview report.pdf" }).click();
        const metadata = page.getByRole("dialog", { name: "report.pdf", exact: true });
        assert.match(await metadata.innerText(), /application\/pdf · 9 bytes/);
        assert.equal(await metadata.locator("img, video, pre, iframe").count(), 0);
        await metadata.getByRole("button", { name: "Close", exact: true }).click();
        await metadata.waitFor({ state: "hidden" });
      } finally {
        await page.setViewportSize({ width: 1900, height: 1000 });
      }
    },
  );

  it(
    "the picker announces details, skips disabled choices and closes when its page moves",
    { timeout: 60_000 },
    async () => {
      await page.goto(WEB_URL);
      await page.getByRole("textbox", { name: "Message Vesper" }).waitFor();
      await page.evaluate(() => import("/e2e/picker.fixture.mjs"));
      const fixture = page.getByRole("region", { name: "Picker fixture" });
      const trigger = fixture.getByRole("button", { name: /^PC and folder/ });
      const list = fixture.getByRole("listbox", { name: "PC and folder" });
      assert.equal(
        await trigger.getAttribute("aria-label"),
        "PC and folder: Documents on home, offline",
      );
      assert.equal(await trigger.getAttribute("aria-expanded"), "false");
      await trigger.click();
      await list.waitFor();
      assert.equal(await trigger.getAttribute("aria-expanded"), "true");
      await page.keyboard.press("ArrowDown");
      assert.equal(
        await page.evaluate(() => document.activeElement?.textContent?.trim()),
        "Projects on home",
      );
      const disabled = list.getByRole("option", { name: "Unavailable folder" });
      await disabled.click({ force: true });
      assert.equal(await trigger.getAttribute("aria-expanded"), "true");
      assert.equal(
        await trigger.getAttribute("aria-label"),
        "PC and folder: Documents on home, offline",
      );
      await disabled.focus();
      await page.keyboard.press("Enter");
      assert.equal(await trigger.getAttribute("aria-expanded"), "true");
      await page.keyboard.press("Space");
      assert.equal(await trigger.getAttribute("aria-expanded"), "true");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await list.waitFor({ state: "hidden" });
      assert.equal(await trigger.getAttribute("aria-label"), "PC and folder: Projects on home");
      await trigger.click();
      await list.waitFor();
      await list.dispatchEvent("scroll");
      assert.equal(await trigger.getAttribute("aria-expanded"), "true");
      await fixture.locator('[aria-label="Scrollable page"]').evaluate((element) => {
        element.scrollTop = 50;
      });
      await list.waitFor({ state: "hidden" });
      assert.equal(await trigger.getAttribute("aria-expanded"), "false");
      await trigger.click();
      await list.waitFor();
      await page.setViewportSize({ width: 1800, height: 950 });
      await list.waitFor({ state: "hidden" });
      assert.equal(await trigger.getAttribute("aria-expanded"), "false");
      await page.setViewportSize({ width: 1900, height: 1000 });
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve)),
          ),
      );
      await fixture.locator('[aria-label="Scrollable page"]').evaluate((element) => {
        element.scrollTop = 10;
        element.querySelector("button").click();
      });
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve)),
          ),
      );
      assert.equal(
        await trigger.getAttribute("aria-expanded"),
        "true",
        "a scroll queued before opening closed the picker",
      );
      await fixture.locator('[aria-label="Other scroller"]').evaluate((element) => {
        element.scrollTop = 50;
      });
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve)),
          ),
      );
      assert.equal(
        await trigger.getAttribute("aria-expanded"),
        "true",
        "a sibling scroller closed the picker",
      );
      await page.keyboard.press("Escape");
      await list.waitFor({ state: "hidden" });
      await trigger.click();
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await list.waitFor({ state: "hidden" });
      await fixture.locator('[role="listbox"]').evaluate((element) => {
        element.closest("dialog").scrollTop = 0;
      });
      await trigger.click();
      await list.waitFor();
      const selectedVisible = await list.evaluate((element) => {
        const row = element.querySelector('[aria-selected="true"]').getBoundingClientRect();
        const sheet = element.closest("dialog").getBoundingClientRect();
        return row.top >= sheet.top && row.bottom <= sheet.bottom;
      });
      assert.equal(selectedVisible, true, "the selected row is outside the visible list");
      await page.keyboard.press("Escape");
      await list.waitFor({ state: "hidden" });
    },
  );

  it("attaches a file dropped on the message box", { timeout: 60_000 }, async () => {
    await openChat();
    await waitFor(readPage, (state) => state.messages.length > 0, "history did not load");

    await page.getByRole("textbox", { name: "Message Vesper" }).evaluate((textarea) => {
      const dropped = new globalThis.DataTransfer();

      dropped.items.add(new globalThis.File(["notes"], "notes.txt", { type: "text/plain" }));
      textarea.closest("form").dispatchEvent(
        new globalThis.DragEvent("drop", {
          dataTransfer: dropped,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    const attached = page.getByRole("list", { name: "Attached files" });

    await attached.waitFor();
    assert.match(await attached.innerText(), /notes\.txt/);

    // Text dragged into the box is left to the browser, and a file dropped
    // anywhere else is stopped from replacing the app with that file.
    const prevented = await page
      .getByRole("textbox", { name: "Message Vesper" })
      .evaluate((textarea) => {
        const drop = (target, fill) => {
          const transfer = new globalThis.DataTransfer();

          fill(transfer);

          return !target.dispatchEvent(
            new globalThis.DragEvent("drop", {
              dataTransfer: transfer,
              bubbles: true,
              cancelable: true,
            }),
          );
        };

        return {
          text: drop(textarea, (transfer) => transfer.setData("text/plain", "dragged words")),
          stray: drop(document.body, (transfer) =>
            transfer.items.add(new globalThis.File(["x"], "stray.txt", { type: "text/plain" })),
          ),
        };
      });

    assert.deepEqual(prevented, { text: false, stray: true });
  });

  it("starts a new chat from Presence, keeping the old one", { timeout: 60_000 }, async () => {
    await page.goto(WEB_URL);
    await prompt("Before the new chat");
    await page.getByText("Before the new chat", { exact: true }).waitFor();
    await page.getByRole("button", { name: "New chat" }).click();
    // Free chat is empty again, so Presence no longer offers to start it over.
    await page.getByRole("button", { name: "New chat" }).waitFor({ state: "detached" });

    await openChat();
    await waitFor(readPage, (state) => state.messages.length === 0, "free chat kept its history");

    const listed = await coreRead(CORE_URL, "/conversations?identityId=vesper");

    assert.equal(listed.body.conversations.length, 1);
    assert.equal(listed.body.conversations[0].kind, "named");
  });

  it("shares a folder with the agents from Nodes", { timeout: 60_000 }, async () => {
    const folder = join(scratch, "Shared Project");

    mkdirSync(folder);
    await page.goto(WEB_URL);
    await tabTo(page, "Nodes");
    await page.keyboard.press("Enter");
    await page.getByRole("textbox", { name: "Folder path" }).fill(`"${folder}"`);
    await page.getByRole("button", { name: "Share folder" }).click();

    const shared = page.getByRole("list", { name: "Shared folders" });

    await shared.getByText(folder, { exact: true }).waitFor();

    const models = await coreRead(CORE_URL, "/models");

    assert.ok(
      models.body.roots.some(
        (root) =>
          root.grantId === "shared-project" && root.path === folder && root.mode === "write",
      ),
      JSON.stringify(models.body.roots),
    );

    // Stopping asks first, because a thread pinned to the folder can no longer run there.
    page.once("dialog", (dialog) => void dialog.accept());
    await shared.getByRole("button", { name: `Stop sharing ${folder}` }).click();
    await shared.getByText(folder, { exact: true }).waitFor({ state: "detached" });

    const after = await coreRead(CORE_URL, "/models");

    assert.ok(
      !after.body.roots.some((root) => root.grantId === "shared-project"),
      JSON.stringify(after.body.roots),
    );
    assert.ok(after.body.roots.some((root) => root.grantId === "scratch"));
  });

  it(
    "shows a session the PC's hooks report, read only, as it goes",
    { timeout: 60_000 },
    async () => {
      const { nodeId, credential } = JSON.parse(readFileSync(join(nodeHome, "node.json"), "utf8"));
      const report = (event) =>
        fetch(`${CORE_URL}/node/bridge`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${nodeId}.${credential}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            providerId: "claude",
            sessionRef: "vs-1",
            cwd: scratch,
            ...event,
          }),
        }).then((response) => assert.equal(response.status, 204));

      await report({ kind: "start" });
      await report({ kind: "prompt", text: "Fix the build" });
      await report({ kind: "reply", text: "Fixed: a missing import." });

      await openChat();
      await page.getByRole("button", { name: "Conversations", exact: true }).click();
      await page.getByRole("button", { name: /^Fix the build/ }).click();

      const live = page.getByRole("list", { name: "Live session" });

      await live.getByText("Fixed: a missing import.", { exact: true }).waitFor();
      assert.equal(await page.getByRole("textbox", { name: "Message Vesper" }).count(), 0);

      // It follows the session while it is open.
      await report({ kind: "prompt", text: "Now the tests" });
      await live.getByText("Now the tests", { exact: true }).waitFor();
    },
  );
});

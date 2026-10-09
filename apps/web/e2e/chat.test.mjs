import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

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
      // Visible only: Command stays mounted behind `display: none`, and its
      // Presence prompt carries a picker of its own. A closed picker's rows are
      // still in the page, in the list its button controls.
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
        (state) => state.approvals.length === 1,
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
});

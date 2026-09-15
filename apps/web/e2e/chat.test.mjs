import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import {
  TOKEN,
  launchOptions,
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

async function coreCommand(name, body) {
  const response = await fetch(`${CORE_URL}/commands/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return { status: response.status, body: await response.json() };
}

async function coreRead(path) {
  const response = await fetch(`${CORE_URL}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });

  return { status: response.status, body: await response.json() };
}

/** Runs a one-shot command to completion and returns what it printed. */
function runOnce(command, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolveRun(output);
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited ${String(code)}: ${output}`));
      }
    });
  });
}

/**
 * Pairs a node the way an operator does — code from the core, `pair` on the
 * agent's CLI — then grants it the runtime with one writable root and starts it
 * with the scripted runtime behind the codex slot.
 */
async function startFakeNode() {
  const issued = await coreCommand("node.issue_pairing_code", {
    idempotencyKey: "e2e-chat-pairing",
    hostId: "e2e",
  });

  assert.equal(issued.status, 200, JSON.stringify(issued.body));

  const agentEnv = { ...process.env, NOCTIS_NODE_HOME: nodeHome, NOCTIS_RUNTIME: "fake" };

  await runOnce(
    process.execPath,
    [AGENT_MAIN, "pair", "--core", CORE_URL, "--code", issued.body.code, "--host", "e2e"],
    { cwd: REPO_ROOT, env: agentEnv },
  );

  const credential = JSON.parse(readFileSync(join(nodeHome, "node.json"), "utf8"));

  const granted = await coreCommand("node.grant_capability", {
    idempotencyKey: "e2e-chat-grant",
    nodeId: credential.nodeId,
    capability: "runtime.turn",
    constraints: {
      providers: ["codex"],
      roots: [{ grantId: "scratch", path: scratch, mode: "write" }],
    },
  });

  assert.equal(granted.status, 200, JSON.stringify(granted.body));

  agent = startProcess(process.execPath, [AGENT_MAIN], { cwd: REPO_ROOT, env: agentEnv });

  const online = await waitFor(
    () => coreRead(`/nodes/${credential.nodeId}`),
    (node) => node.status === 200 && node.body.status === "online" && node.body.connected,
    `the fake node never came online; it last said: ${agent.output.join("")}`,
    30_000,
  );

  // The router only sends a turn to a node whose `hello` offered the model
  // (ADR-0023), so the fake runtime's probe has to have travelled with it.
  const codex = online.body.providers.find((probe) => probe.providerId === "codex");

  assert.ok(
    codex?.available === true && codex.models.some((model) => model.model === "fake-model"),
    `the node agent did not report the fake runtime's probe in hello; with NOCTIS_RUNTIME=fake ` +
      `main.js must send FAKE_PROBE, not the machine's installed providers. It reported: ` +
      JSON.stringify(online.body.providers),
  );
}

/** Reloads and walks to Chat with the keyboard. */
async function openChat() {
  await page.goto(WEB_URL);
  await tabTo(page, "Chat");
  await page.keyboard.press("Enter");
  await waitFor(readPage, (state) => state.heading === "Chat", "Chat never opened");
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
      items: [...document.querySelectorAll('ul[aria-label="Turn items"] > li')].map((item) => ({
        kind: item.dataset.itemKind ?? "",
        status: item.dataset.itemStatus ?? "",
        text: item.textContent?.trim() ?? "",
      })),
      approvals: texts('li[data-entry="approval"]'),
      confirmDisabled: confirm === undefined ? null : confirm.disabled,
      // Visible only: Command stays mounted behind `display: none`, and its
      // Presence prompt carries a selector of its own.
      modelOptions: [...document.querySelectorAll("select")]
        .filter((select) => select.checkVisibility())
        .flatMap((select) => [...select.options].map((option) => option.textContent ?? "")),
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
    await startFakeNode();

    // 0.3: the default is Settings data. Set through the API here; the Settings
    // control that writes it is the same command.
    const defaulted = await coreCommand("identity.set_default_model", {
      idempotencyKey: "e2e-chat-default-model",
      identityId: "vesper",
      model: { providerId: "codex", model: "fake-model" },
    });

    assert.equal(defaulted.status, 200, JSON.stringify(defaulted.body));

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
});

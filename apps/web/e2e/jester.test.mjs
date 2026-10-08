import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, it } from "node:test";

import { chromium } from "playwright";

import { launchOptions, startProcess, stopProcess, waitForHttp } from "./harness.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
const URL = "http://localhost:4193";
/** Set to a folder to keep a screenshot of Jester's core in every state. */
const EVIDENCE = process.env.NOCTIS_JESTER_EVIDENCE;
let web;
let browser;

/** A core that answers as the S6 fixture does, but knows which identity is active. */
function fixture() {
  const id = (suffix) => `0199a000-0000-7000-8000-0000000000${suffix}`;
  const at = "2026-10-08T21:00:00.000Z";
  const codex = { providerId: "codex", model: "fixture", label: "Codex" };
  const hermes = { providerId: "hermes", model: "qwen/qwen3.5-9b", label: "Qwen3.5-9B" };
  let active = "vesper";
  let sequence = 0;
  const listeners = new Set();
  const calls = [];
  const thread = () => ({
    id: id(active === "jester" ? "f2" : "f1"),
    identityId: active,
    revision: 0,
    createdAt: at,
    updatedAt: at,
  });
  const turn = {
    id: id("d1"),
    userMessageId: id("b1"),
    jobId: id("c1"),
    model: hermes,
    status: "completed",
    items: [],
    startedAt: at,
  };
  const approval = {
    id: id("a1"),
    actorId: "jester",
    operationClass: "local_reversible_edit",
    capability: "runtime.command",
    target: { type: "command", id: "save draft" },
    consequenceSummary: "Save the draft offer in the selected folder.",
    reversibility: "reversible",
    outcome: "require_confirmation",
    policyId: "default",
    reasonCodes: ["free_chat"],
    requestedAt: at,
    decidedAt: at,
    nodeJobId: turn.jobId,
  };
  let waiting = false;
  const emit = (type, streamType, streamId, payload = {}) => {
    sequence++;
    const event = {
      id: id(sequence.toString(16).padStart(2, "0")),
      sequence,
      streamType,
      streamId,
      type,
      actorType: "identity",
      actorId: active,
      payloadVersion: 1,
      payload,
      correlationId: id("fe"),
      occurredAt: at,
    };
    for (const listener of listeners)
      listener({ payload: JSON.stringify({ kind: "event", envelopeVersion: 1, event }) });
  };
  const response = (body, status = 200) => ({ status, body: JSON.stringify(body) });
  globalThis.__TAURI__ = {
    event: {
      listen: async (_, listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    core: {
      invoke: async (command, args) => {
        if (command !== "core_request") return;
        const path = args.path;
        if (path.startsWith("/commands/")) calls.push({ path, body: args.body });
        if (path === "/identities") return response({ activeIdentityId: active, threads: [] });
        if (path === "/commands/identity.activate") {
          active = args.body.identityId;
          return response({ activeIdentityId: active, thread: thread() });
        }
        if (path.startsWith("/events?")) return response({ events: [], latestSequence: sequence });
        if (path === "/models")
          return response({ catalogue: [codex, hermes], defaults: { vesper: codex }, roots: [] });
        if (path.endsWith("/messages")) return response({ messages: [] });
        if (path.endsWith("/turns"))
          return response({
            turns: [{ ...turn, threadId: thread().id, identityId: active }],
          });
        if (path.endsWith("/children")) return response({ threads: [] });
        if (path === "/approvals") return response({ approvals: waiting ? [approval] : [] });
        if (path.startsWith("/approvals/")) return response(approval);
        if (path.startsWith("/conversations")) return response({ conversations: [] });
        if (path.startsWith("/threads")) return response(thread());
        if (path === "/commands/conversation.send")
          return response({ ...turn, threadId: thread().id, identityId: active });
        return response({});
      },
    },
  };
  globalThis.jesterFixture = {
    calls: () => calls,
    set(state) {
      waiting = state === "waiting_for_approval";
      if (!waiting) emit("authority.declined.v1", "authority", approval.id);
      turn.status = state === "idle" ? "completed" : "running";
      turn.items = [
        {
          itemId: "m1",
          kind: "agent_message",
          status: state === "speaking" ? "in_progress" : "completed",
          text: state === "speaking" ? "Fine. But we are not making another list." : "",
        },
      ];
      emit("identity.turn_item.v1", "identity", thread().id, {
        turnId: turn.id,
        item: turn.items[0],
      });
      emit("identity.turn_started.v1", "identity", thread().id);
      if (waiting)
        emit("authority.decision_recorded.v1", "authority", approval.id, {
          requestId: approval.id,
          outcome: approval.outcome,
          nodeJobId: turn.jobId,
        });
    },
  };
}

before(async () => {
  web = startProcess(
    process.execPath,
    [join(ROOT, "node_modules/vite/bin/vite.js"), "--port", "4193", "--strictPort"],
    { cwd: join(ROOT, "apps/web"), env: { ...process.env, VITE_CORE_URL: URL } },
  );
  await waitForHttp(URL, "Jester preview", web);
  browser = await chromium.launch(launchOptions());
  if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });
});

after(async () => {
  await browser?.close();
  await stopProcess(web);
});

const activations = (page) =>
  page.evaluate(() =>
    globalThis.jesterFixture
      .calls()
      .filter((call) => call.path === "/commands/identity.activate")
      .map((call) => call.body.identityId),
  );

it(
  "THE GATE (Jester): switches from Presence, speaks as Jester on Hermes alone, and draws Jester's core in every state",
  { timeout: 180_000 },
  async () => {
    for (const [name, viewport] of Object.entries({
      desktop: { width: 1440, height: 900 },
      phone: { width: 400, height: 860 },
    })) {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: name === "phone" ? 2 : 1,
      });
      await context.addInitScript(fixture);
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(URL);
      const core = page.locator(".noctis-intelligence");
      await core.waitFor();
      assert.equal(await core.getAttribute("data-core-profile"), "vesper");
      assert.equal(await page.getByText("JESTER · ACTIVE").count(), 0);

      // The switch above the box.
      await page.getByRole("button", { name: "Jester", exact: true }).click();
      await page.getByText("JESTER · ACTIVE").waitFor();
      assert.deepEqual(await activations(page), ["jester"]);
      assert.equal(await core.getAttribute("data-core-profile"), "jester");
      assert.equal(
        await page
          .getByRole("button", { name: "Jester", exact: true })
          .getAttribute("aria-pressed"),
        "true",
      );
      const box = page.getByRole("textbox", { name: "Message Jester" });
      assert.equal(await box.getAttribute("placeholder"), "Ask Jester...");
      // Jester is Hermes: no other agent is offered.
      const agents = await page
        .getByRole("combobox", { name: "Agent" })
        .locator("option")
        .allTextContents();
      assert.deepEqual(agents, ["Qwen3.5-9B (hermes)"]);

      await page.waitForFunction(
        () => document.querySelector(".noctis-intelligence")?.dataset.coreRenderer === "webgl",
      );
      for (const state of ["idle", "listening", "thinking", "speaking", "waiting_for_approval"]) {
        if (state === "listening") await box.focus();
        else {
          await box.blur();
          await page.evaluate((next) => globalThis.jesterFixture.set(next), state);
        }
        await page.waitForFunction(
          (next) => document.querySelector(".noctis-intelligence")?.dataset.coreState === next,
          state,
        );
        // Long enough for the face to surface and the lerps to settle.
        await page.waitForTimeout(1200);
        if (EVIDENCE)
          await page.screenshot({ path: join(EVIDENCE, `jester-${name}-${state}.png`) });
      }
      await page.evaluate(() => globalThis.jesterFixture.set("idle"));

      // Typed alone, the activation command switches back and sends nothing.
      await box.fill("VESPER");
      await box.press("Enter");
      await page.getByRole("textbox", { name: "Message Vesper" }).waitFor();
      assert.deepEqual(await activations(page), ["jester", "vesper"]);
      assert.equal(await page.getByText("JESTER · ACTIVE").count(), 0);
      const sends = await page.evaluate(() =>
        globalThis.jesterFixture
          .calls()
          .filter((call) => call.path === "/commands/conversation.send"),
      );
      assert.deepEqual(sends, []);

      // In a sentence, the name is just a word.
      await page
        .getByRole("textbox", { name: "Message Vesper" })
        .fill("JESTER, what do you think?");
      await page.getByRole("textbox", { name: "Message Vesper" }).press("Enter");
      await page.waitForFunction(() =>
        globalThis.jesterFixture
          .calls()
          .some((call) => call.path === "/commands/conversation.send"),
      );
      assert.deepEqual(await activations(page), ["jester", "vesper"]);

      // In Threads the core sits in the composer, which never scrolls away.
      await page.getByRole("button", { name: "Open in Threads →" }).click();
      await page.getByRole("heading", { name: "Threads", exact: true }).waitFor();
      const small = page.locator('form [data-threads-core="true"] .noctis-intelligence');
      await small.waitFor();
      assert.equal(await small.isVisible(), true);
      const bounds = await small.boundingBox();
      assert.ok(
        bounds !== null && bounds.y + bounds.height <= viewport.height,
        "core below the fold",
      );
      if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, `threads-${name}.png`) });
      assert.deepEqual(errors, []);
      await context.close();
    }
  },
);

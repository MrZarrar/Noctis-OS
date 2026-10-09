import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { after, before, it } from "node:test";

import { chromium } from "playwright";

import { launchOptions, startProcess, stopProcess, waitForHttp } from "./harness.mjs";

const ROOT = resolve(import.meta.dirname, "../../..");
const URL = "http://localhost:4192";
const EVIDENCE = process.env.NOCTIS_S6_EVIDENCE;
const CORE_RECORDING = EVIDENCE && process.env.NOCTIS_S6_CORE_RECORDING === "1";
const PAGE_RECORDING = EVIDENCE && process.env.NOCTIS_S6_PAGE_RECORDING !== "0";
let web;
let browser;

function fixture() {
  const id = (suffix) => `0199a000-0000-7000-8000-0000000000${suffix}`;
  const at = "2026-10-07T15:00:00.000Z";
  const model = { providerId: "codex", model: "fixture", label: "Local verification" };
  const thread = { id: id("f1"), identityId: "vesper", revision: 0, createdAt: at, updatedAt: at };
  const turn = {
    id: id("d1"),
    threadId: thread.id,
    identityId: "vesper",
    userMessageId: id("b1"),
    jobId: id("c1"),
    model,
    status: "completed",
    items: [],
    startedAt: at,
  };
  const approval = {
    id: id("a1"),
    actorId: "vesper",
    operationClass: "local_reversible_edit",
    capability: "runtime.command",
    target: { type: "command", id: "save draft" },
    consequenceSummary: "Save the draft in the selected folder.",
    reversibility: "reversible",
    outcome: "require_confirmation",
    policyId: "default",
    reasonCodes: ["free_chat"],
    requestedAt: at,
    decidedAt: at,
    nodeJobId: turn.jobId,
  };
  let waiting = false;
  let sequence = 0;
  let messages = [];
  const listeners = new Set();
  const emit = (type, streamType, streamId, payload = {}) => {
    sequence++;
    const event = {
      id: id(sequence.toString(16).padStart(2, "0")),
      sequence,
      streamType,
      streamId,
      type,
      actorType: "identity",
      actorId: "vesper",
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
        if (path === "/identities") return response({ activeIdentityId: "vesper", threads: [] });
        if (path.startsWith("/events?")) return response({ events: [], latestSequence: sequence });
        if (path === "/models")
          return response({ catalogue: [model], defaults: { vesper: model }, roots: [] });
        if (path.endsWith("/messages")) return response({ messages });
        if (path.endsWith("/turns")) return response({ turns: [turn] });
        if (path.endsWith("/children")) return response({ threads: [] });
        if (path === "/approvals") return response({ approvals: waiting ? [approval] : [] });
        if (path.startsWith("/approvals/")) return response(approval);
        if (path.startsWith("/threads")) return response(thread);
        if (path === "/commands/conversation.send") {
          turn.status = "running";
          messages = [
            {
              id: turn.userMessageId,
              threadId: thread.id,
              role: "user",
              body: args.body.text,
              createdAt: at,
            },
          ];
          return response(turn);
        }
        return response({});
      },
    },
  };
  globalThis.s6Fixture = {
    output() {
      turn.items.push({
        itemId: "o1",
        kind: "output",
        status: "completed",
        mediaType: "image/png",
        path: "jester.png",
        attachmentId: id("e1"),
      });
      emit("identity.turn_item.v1", "identity", thread.id, {
        turnId: turn.id,
        item: turn.items.at(-1),
      });
    },
    set(state) {
      waiting = state === "waiting_for_approval";
      if (!waiting) emit("authority.declined.v1", "authority", approval.id);
      turn.status = state === "idle" ? "completed" : "running";
      turn.items = [
        {
          itemId: "m1",
          kind: "agent_message",
          status: state === "speaking" ? "in_progress" : "completed",
          text: state === "speaking" ? "Working on your request" : "",
        },
      ];
      emit("identity.turn_item.v1", "identity", thread.id, {
        turnId: turn.id,
        item: turn.items[0],
      });
      emit("identity.turn_started.v1", "identity", thread.id);
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
    [join(ROOT, "node_modules/vite/bin/vite.js"), "--port", "4192", "--strictPort"],
    { cwd: join(ROOT, "apps/web"), env: { ...process.env, VITE_CORE_URL: URL } },
  );
  await waitForHttp(URL, "S6 preview", web);
  browser = await chromium.launch(launchOptions());
  if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });
});

after(async () => {
  await browser?.close();
  await stopProcess(web);
});

it(
  "THE GATE: Presence reflects every state, draws only when active, and starts a thread",
  { timeout: 180_000 },
  async () => {
    const measurements = [];
    for (const [name, viewport] of Object.entries({
      desktop: { width: 1440, height: 900 },
      phone: { width: 400, height: 860 },
    })) {
      const context = await browser.newContext({
        viewport,
        deviceScaleFactor: name === "phone" ? 2 : 1,
        ...(PAGE_RECORDING ? { recordVideo: { dir: EVIDENCE, size: viewport } } : {}),
      });
      await context.addInitScript(fixture);
      if (CORE_RECORDING)
        await context.addInitScript(() => {
          const original = globalThis.HTMLCanvasElement.prototype.getContext;
          globalThis.HTMLCanvasElement.prototype.getContext = function (type, options) {
            return original.call(
              this,
              type,
              type.startsWith("webgl") ? { ...options, preserveDrawingBuffer: true } : options,
            );
          };
        });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      const video = page.video();
      await page.goto(URL);
      const core = page.locator(".noctis-intelligence");
      await core.waitFor();
      assert.equal(await page.locator("h1").textContent(), "Presence");
      assert.match(await page.locator("time").first().innerText(), /^\d{2}:\d{2}/);
      await page.waitForFunction(
        () => document.querySelector(".noctis-intelligence")?.dataset.coreRenderer === "webgl",
      );
      if (CORE_RECORDING)
        await core.locator("canvas").evaluate((canvas) => {
          const output = document.createElement("canvas");
          output.width = canvas.width;
          output.height = canvas.height;
          const paint = output.getContext("2d", { alpha: false });
          let frame;
          const capture = () => {
            paint.fillStyle = "#080610";
            paint.fillRect(0, 0, output.width, output.height);
            paint.drawImage(canvas, 0, 0);
            frame = globalThis.requestAnimationFrame(capture);
          };
          capture();
          const stream = output.captureStream(60);
          const chunks = [];
          const recorder = new globalThis.MediaRecorder(stream, {
            mimeType: "video/webm;codecs=vp8",
            videoBitsPerSecond: 4_000_000,
          });
          recorder.addEventListener("dataavailable", (event) => chunks.push(event.data));
          globalThis.s6Recording = async () => {
            await new Promise((done) => {
              recorder.addEventListener("stop", done, { once: true });
              recorder.stop();
            });
            stream.getTracks().forEach((track) => track.stop());
            globalThis.cancelAnimationFrame(frame);
            return await new Promise((done) => {
              const reader = new globalThis.FileReader();
              reader.onload = () => done(reader.result.split(",")[1]);
              reader.readAsDataURL(new globalThis.Blob(chunks, { type: recorder.mimeType }));
            });
          };
          recorder.start();
        });
      const cdp = await context.newCDPSession(page);
      const browserCdp = await browser.newBrowserCDPSession();
      await cdp.send("Performance.enable");
      for (const state of ["idle", "listening", "thinking", "speaking", "waiting_for_approval"]) {
        await page.getByRole("textbox", { name: "Message Vesper" }).blur();
        await page.evaluate(
          (value) => globalThis.s6Fixture.set(value === "listening" ? "idle" : value),
          state,
        );
        if (state === "listening")
          await page.getByRole("textbox", { name: "Message Vesper" }).focus();
        await page.waitForFunction(
          (value) => document.querySelector(".noctis-intelligence")?.dataset.coreState === value,
          state,
        );
        await page.waitForTimeout(350);
        if (state === "waiting_for_approval")
          await page.waitForFunction(
            () =>
              document.querySelector(".noctis-intelligence")?.dataset.coreHeartColor === "#ffc16c",
          );
        const pixelsBefore = state === "idle" ? undefined : await core.screenshot();
        const before = await core.evaluate((element) => ({ ...element.dataset }));
        const metricsBefore = await cdp.send("Performance.getMetrics");
        const processesBefore = await browserCdp.send("SystemInfo.getProcessInfo");
        const started = Date.now();
        await page.waitForTimeout(EVIDENCE ? 2400 : 500);
        const after = await core.evaluate((element) => ({ ...element.dataset }));
        const metricsAfter = await cdp.send("Performance.getMetrics");
        const processesAfter = await browserCdp.send("SystemInfo.getProcessInfo");
        const frames = Number(after.coreFrames) - Number(before.coreFrames);
        const elapsed = Date.now() - started;
        const cpu =
          ((metricsAfter.metrics.find((metric) => metric.name === "TaskDuration").value -
            metricsBefore.metrics.find((metric) => metric.name === "TaskDuration").value) /
            (elapsed / 1000)) *
          100;
        const rendererCpu =
          (processesAfter.processInfo
            .filter((process) => process.type === "renderer")
            .reduce((total, process) => {
              const previous = processesBefore.processInfo.find((entry) => entry.id === process.id);
              return total + (previous === undefined ? 0 : process.cpuTime - previous.cpuTime);
            }, 0) /
            (elapsed / 1000)) *
          100;
        if (state === "idle") assert.equal(frames, 0, `${name} ${state} keeps drawing`);
        else
          assert.ok(
            frames > 0,
            `${name} ${state} never animates: ${JSON.stringify({ before, after, errors })}`,
          );
        if (state === "idle")
          assert.equal(
            await core
              .locator("canvas")
              .evaluate((canvas) => getComputedStyle(canvas).animationName),
            "noctis-core-breathe",
          );
        if (state === "waiting_for_approval")
          assert.equal(after.coreHeartColor, "#ffc16c", "the entire centre remains violet");
        if (pixelsBefore)
          assert.notDeepEqual(
            await core.screenshot(),
            pixelsBefore,
            `${name} ${state} has no visible motion`,
          );
        measurements.push({
          viewport: name,
          state,
          elapsedMs: elapsed,
          frames,
          fps: frames / (elapsed / 1000),
          meanDrawMs: frames
            ? (Number(after.coreTotalDrawMs) - Number(before.coreTotalDrawMs)) / frames
            : 0,
          mainThreadCpuPercent: cpu,
          rendererCpuPercent: rendererCpu,
        });
        if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, `${name}-${state}.png`) });
      }
      if (CORE_RECORDING)
        writeFileSync(
          join(EVIDENCE, `${name}-core-60fps.webm`),
          Buffer.from(await page.evaluate(() => globalThis.s6Recording()), "base64"),
        );
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.evaluate(() => globalThis.s6Fixture.set("thinking"));
      await page.waitForTimeout(350);
      const staticFrames = await core.getAttribute("data-core-frames");
      await page.waitForTimeout(700);
      assert.equal(
        await core.getAttribute("data-core-frames"),
        staticFrames,
        "reduced motion keeps drawing",
      );
      await page.evaluate(() => globalThis.s6Fixture.set("idle"));
      assert.equal(
        await core.locator("canvas").evaluate((canvas) => getComputedStyle(canvas).animationName),
        "none",
      );
      if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, `${name}-reduced-motion.png`) });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await core.evaluate((element) => {
        element.style.display = "none";
      });
      await page.waitForTimeout(350);
      const hiddenFrames = await core.getAttribute("data-core-frames");
      await page.waitForTimeout(500);
      assert.equal(
        await core.getAttribute("data-core-frames"),
        hiddenFrames,
        "hidden core keeps drawing",
      );
      await core.evaluate((element) => {
        element.style.display = "";
      });
      await page.evaluate(() => globalThis.s6Fixture.set("idle"));
      await page.getByRole("textbox", { name: "Message Vesper" }).fill("Start from Presence");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      // Presence stays, so the core is seen working: the exchange shows under it.
      await page.getByText("Start from Presence", { exact: true }).waitFor();
      assert.equal(await page.locator("h1").textContent(), "Presence");
      await page.waitForFunction(
        () => document.querySelector(".noctis-intelligence")?.dataset.coreState === "thinking",
      );
      // What the turn made shows under its words, not only in Threads. This
      // transport cannot say where the bytes are, so it is named in plain text.
      await page.evaluate(() => globalThis.s6Fixture.output());
      await page.locator('[aria-live="polite"]').getByText("jester.png", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Open in Threads →" }).click();
      await page.getByRole("heading", { name: "Threads", exact: true }).waitFor();
      // And Threads carries a small core of its own.
      await page.locator('[data-threads-core="true"] .noctis-intelligence').waitFor();
      assert.equal(errors.length, 0, errors.join("\n"));
      await context.close();
      if (EVIDENCE && video) await video.saveAs(join(EVIDENCE, `${name}-all-states.webm`));
    }
    if (EVIDENCE)
      writeFileSync(
        join(EVIDENCE, "measurements.json"),
        JSON.stringify(
          {
            fixture: "Scripted local transport events, production renderer",
            browser: await browser.version(),
            pageRecording: Boolean(PAGE_RECORDING),
            coreRecording: Boolean(CORE_RECORDING),
            measurements,
          },
          null,
          2,
        ),
      );
  },
);

it("keeps every state readable when WebGL is unavailable", { timeout: 60_000 }, async () => {
  for (const [name, viewport] of Object.entries({
    desktop: { width: 1440, height: 900 },
    phone: { width: 400, height: 860 },
  })) {
    const context = await browser.newContext({ viewport });
    await context.addInitScript(fixture);
    await context.addInitScript(() => {
      const getContext = globalThis.HTMLCanvasElement.prototype.getContext;
      globalThis.HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
        return kind.startsWith("webgl") ? null : getContext.call(this, kind, ...args);
      };
    });
    const page = await context.newPage();
    await page.goto(URL);
    const core = page.locator(".noctis-intelligence");
    await core.locator("svg").waitFor();
    for (const state of ["idle", "listening", "thinking", "speaking", "waiting_for_approval"]) {
      await page.getByRole("textbox", { name: "Message Vesper" }).blur();
      await page.evaluate(
        (value) => globalThis.s6Fixture.set(value === "listening" ? "idle" : value),
        state,
      );
      if (state === "listening")
        await page.getByRole("textbox", { name: "Message Vesper" }).focus();
      await page.waitForFunction(
        (value) => document.querySelector(".noctis-intelligence")?.dataset.coreState === value,
        state,
      );
      assert.equal(await core.getAttribute("data-core-renderer"), "static");
      assert.equal(await core.getAttribute("data-core-frames"), "0");
    }
    if (EVIDENCE) await page.screenshot({ path: join(EVIDENCE, `${name}-webgl-fallback.png`) });
    await context.close();
  }
});

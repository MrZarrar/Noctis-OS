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
  startProcess,
  stopProcess,
  tabTo,
  waitFor,
  waitForHttp,
} from "./harness.mjs";

/**
 * The Phase 8 gate, from the outside.
 *
 * Everything below is driven by the keyboard, and the point of that here is not
 * only accessibility: a typed confirmation that could be satisfied by a
 * synthetic click would not be a typed confirmation. This suite types the
 * phrase character by character and watches the control stay disabled until it
 * matches, which is the behaviour the whole mechanism rests on.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const WEB_ROOT = join(REPO_ROOT, "apps/web");

const CORE_PORT = 8797;
const WEB_PORT = 4183;
const CORE_URL = `http://127.0.0.1:${CORE_PORT}`;
const WEB_URL = `http://localhost:${WEB_PORT}`;

let core;
let web;
let browser;
let page;
let databaseDirectory;

async function coreCommand(name, body) {
  const response = await fetch(`${CORE_URL}/commands/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return { status: response.status, body: await response.json() };
}

/**
 * Reloads and walks to a page with the keyboard.
 *
 * A reload is deliberate rather than a React state refresh: the rail returns to
 * Threads, so every visit re-reads the core rather than trusting what the page
 * happened to be holding.
 */
async function open(name) {
  await page.goto(WEB_URL);
  await tabTo(page, name);
  await page.keyboard.press("Enter");
  await waitFor(readPage, (state) => state.heading === name, `${name} never opened`);
}

/** What the Approvals or Artifacts page shows, in the terms the gate is written in. */
function readPage() {
  return page.evaluate(() => {
    const confirm = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Confirm",
    );
    const execute = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Execute now",
    );

    return {
      heading: document.querySelector("h1")?.textContent ?? "",
      approvals: [
        ...(document.querySelector('ul[aria-label="Approvals waiting"]')?.children ?? []),
      ].map((item) => item.textContent?.trim() ?? ""),
      artifacts: [...(document.querySelector('ul[aria-label="Artifacts"]')?.children ?? [])].map(
        (item) => item.textContent?.trim() ?? "",
      ),
      confirmDisabled: confirm === undefined ? null : confirm.disabled,
      hasExecute: execute !== undefined,
      // The live region beside the input, which is what a screen reader gets
      // instead of the disabled attribute.
      phraseState: document.querySelector("#typed-confirmation-state")?.textContent ?? "",
      errors: [...document.querySelectorAll("p")]
        .map((paragraph) => paragraph.textContent ?? "")
        .filter((text) => text.includes("already_executed") || text.includes("not_confirmed")),
    };
  });
}

describe("the consequence boundary, driven only by the keyboard", () => {
  before(async () => {
    assert.ok(
      existsSync(join(REPO_ROOT, "packages/ui/dist/index.js")),
      "run `npm run build` before the E2E suite: it serves the built workspace packages",
    );

    databaseDirectory = mkdtempSync(join(tmpdir(), "noctis-e2e-approval-"));

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
          // Command and Artifacts are behind the all-pages flag since v1.
          VITE_NOCTIS_ALL_PAGES: "1",
          NOCTIS_CORE_PROXY_TARGET: CORE_URL,
        },
      },
    );

    await waitForHttp(`${CORE_URL}/health`, "the core", core);
    await waitForHttp(WEB_URL, "the web app", web);

    browser = await chromium.launch(launchOptions());
    page = await browser.newPage({ viewport: { width: 1900, height: 1000 } });
  });

  after(async () => {
    await page?.close();
    await browser?.close();
    await stopProcess(core);
    await stopProcess(web);

    if (databaseDirectory !== undefined) {
      rmSync(databaseDirectory, { recursive: true, force: true });
    }
  });

  it(
    "THE GATE: types the phrase, confirms, executes once, and cannot execute twice",
    { timeout: 120_000 },
    async () => {
      // A spend, which Section 9.1 puts behind a typed confirmation carrying the
      // amount. Seeded through the API: preparing the request is not the part
      // this suite is testing, crossing the boundary is.
      const requested = await coreCommand("authority.request", {
        idempotencyKey: "e2e-spend",
        actorId: "vesper",
        operationClass: "spend",
        capability: "provider.purchase",
        target: { type: "provider", id: "suno" },
        consequenceSummary: "Buy a Suno credit pack",
        reversibility: "irreversible",
        estimatedCostGbp: 8,
      });

      assert.equal(requested.status, 200);
      assert.equal(requested.body.outcome, "require_typed_confirmation");

      const phrase = requested.body.confirmationPhrase;

      assert.equal(phrase, "SPEND GBP 8.00 ON provider:suno");

      await open("Approvals");

      const waiting = await waitFor(
        readPage,
        (state) => state.approvals.length === 1,
        "the approval never reached the queue",
      );

      assert.ok(
        waiting.approvals[0].includes("Buy a Suno credit pack"),
        "the approval does not say what it will do",
      );
      assert.ok(
        waiting.approvals[0].includes("provider: suno"),
        "the approval does not name its exact target",
      );
      assert.equal(
        waiting.confirmDisabled,
        true,
        "Confirm is available before the phrase has been typed",
      );
      assert.ok(!waiting.hasExecute, "an unconfirmed approval is offering an Execute control");

      // Type a near miss first. Same words, wrong case — the exact thing a
      // case-insensitive comparison would wave through.
      await tabTo(page, `Type ${phrase} to confirm`);
      await page.keyboard.type(phrase.toLowerCase());

      const nearMiss = await waitFor(
        readPage,
        (state) => state.phraseState !== "",
        "the phrase field reported nothing",
      );

      assert.equal(nearMiss.confirmDisabled, true, "a lower-case near miss enabled Confirm");
      assert.ok(nearMiss.phraseState.includes("must match exactly"));

      // Now the real one.
      await page.keyboard.press("Control+A");
      await page.keyboard.type(phrase);

      const matched = await waitFor(
        readPage,
        (state) => state.confirmDisabled === false,
        "typing the exact phrase did not enable Confirm",
      );

      assert.ok(matched.phraseState.includes("matches"));

      await tabTo(page, "Confirm");
      await page.keyboard.press("Enter");

      await waitFor(
        readPage,
        (state) => state.hasExecute,
        "confirming did not produce an Execute control",
      );

      await tabTo(page, "Execute now");
      await page.keyboard.press("Enter");

      const executed = await waitFor(
        readPage,
        (state) => state.approvals.length === 0,
        "executing did not clear the approval from the queue",
      );

      assert.equal(executed.hasExecute, false, "an executed approval still offers to execute");

      // And the boundary holds against the API too: the same consequence
      // submitted again with a fresh key is refused, not repeated.
      const again = await coreCommand("authority.execute", {
        idempotencyKey: "e2e-spend-again",
        requestId: requested.body.requestId,
        evidenceVersion: 1,
        evidence: { attempt: 2 },
      });

      assert.equal(again.status, 403);
      assert.ok(again.body.error.details.reasonCodes.includes("already_executed"));
    },
  );

  it(
    "keeps an external reference external until it is imported",
    { timeout: 120_000 },
    async () => {
      const external = await coreCommand("artifact.record", {
        idempotencyKey: "e2e-artifact",
        kind: "external_reference",
        title: "Selected Suno song",
        uri: "https://suno.example/song/9f2",
        provenanceVersion: 1,
        provenance: { selectedIn: "a native Suno session" },
      });

      assert.equal(external.status, 200);

      await open("Artifacts");

      const listed = await waitFor(
        readPage,
        (state) => state.artifacts.length === 1,
        "the artifact never appeared",
      );

      assert.ok(
        listed.artifacts[0].includes("External reference — the bytes are not here"),
        `an unimported reference must say so: ${listed.artifacts[0]}`,
      );

      await coreCommand("artifact.import", {
        idempotencyKey: "e2e-import",
        artifactId: external.body.id,
        hostId: "desk",
        uri: "file:///C:/noctis/artifacts/9f2.mp3",
        checksum: "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
      });

      await open("Artifacts");

      const afterImport = await waitFor(
        readPage,
        (state) => state.artifacts.length === 2,
        "the import did not produce a second, local artifact",
      );

      // Two rows, not one changed row: the reference is still a reference and
      // still says where the local copy went.
      assert.ok(afterImport.artifacts.some((text) => text.includes("Local artifact on desk")));
      assert.ok(afterImport.artifacts.some((text) => text.includes("Imported as")));
    },
  );
});

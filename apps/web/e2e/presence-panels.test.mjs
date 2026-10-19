import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import {
  TOKEN,
  coreCommand,
  coreRead,
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
const CORE_PORT = 8811;
const WEB_PORT = 4195;
const CORE_URL = `http://127.0.0.1:${CORE_PORT}`;
const WEB_URL = `http://localhost:${WEB_PORT}`;
const EVIDENCE = join(REPO_ROOT, ".noctis/panels");
let core, agent, web, browser, context, page, databaseDirectory, nodeHome, scratch;

async function openPresence() {
  await page.goto(WEB_URL);
  if (await page.locator('input[type="password"]').count()) {
    await page.getByLabel("Core token").fill(TOKEN);
    await page.getByLabel("Core token").press("Enter");
  }
  await page.getByRole("button", { name: "Presence", exact: true }).click();
  await page.getByLabel("Message Vesper").waitFor();
}

function boxesOverlap(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function noHorizontalOverflow() {
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
    0,
  );
}

describe("Presence live briefs", () => {
  before(async () => {
    for (const built of ["packages/ui/dist/index.js", "apps/core/dist/main.js", AGENT_MAIN]) {
      assert.ok(
        existsSync(join(REPO_ROOT, built)) || existsSync(built),
        `run npm run build: ${built}`,
      );
    }
    databaseDirectory = mkdtempSync(join(tmpdir(), "noctis-e2e-presence-db-"));
    nodeHome = mkdtempSync(join(tmpdir(), "noctis-e2e-presence-node-"));
    scratch = mkdtempSync(join(tmpdir(), "noctis-e2e-presence-scratch-"));
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
          VITE_CORE_TOKEN: "",
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
      keyPrefix: "e2e-presence",
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
      if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
    }
  });

  it(
    "THE GATE (Presence panels): a running turn shows a live brief at the side, then leaves",
    { timeout: 120000 },
    async () => {
      await openPresence();
      assert.equal(await page.locator('aside[aria-label="Presence panels"]').count(), 0);
      await page.getByLabel("Message Vesper").fill("ASK: run the nightly backup");
      await page.getByLabel("Message Vesper").press("Enter");

      const column = page.locator('aside[aria-label="Presence panels"]');
      const brief = column.locator("[data-surface-id]").filter({ hasText: "Running · " });
      await brief.waitFor({ timeout: 20000 });
      assert.match(await brief.innerText(), /Vesper/);
      assert.doesNotMatch(await brief.innerText(), /nightly backup/);
      assert.equal(await page.locator(".noctis-intelligence").count(), 1);
      const briefBox = await column.boundingBox();
      for (const selector of ['[data-core-slot="hero"]', 'textarea[aria-label="Message Vesper"]']) {
        const other = await page.locator(selector).boundingBox();
        assert.ok(!boxesOverlap(briefBox, other), `the brief covers ${selector}`);
      }
      await noHorizontalOverflow();
      await page.screenshot({ path: join(EVIDENCE, "P15-presence-desktop.png") });

      assert.equal(await column.getByLabel(/^Place /).count(), 0);

      await page.setViewportSize({ width: 400, height: 860 });
      await openPresence();
      const chip = page.getByRole("button", { name: "Open panel Vesper", exact: true });
      await chip.waitFor();
      assert.equal(await page.getByRole("region", { name: "Panel sheet" }).count(), 0);
      assert.equal(await column.count(), 0);
      await noHorizontalOverflow();
      await page.screenshot({ path: join(EVIDENCE, "P15-presence-phone-chip.png") });
      await chip.click();
      const sheet = page.getByRole("region", { name: "Panel sheet" });
      await sheet.getByText("Running · ").waitFor();
      const sheetBox = await sheet.boundingBox();
      assert.ok(sheetBox.y >= 0 && sheetBox.y < 430, `sheet opened out of view at ${sheetBox.y}`);
      assert.equal(await page.getByLabel("Message Vesper").isVisible(), true);
      assert.equal(await sheet.getByLabel(/^Place /).count(), 0);
      assert.equal(await page.locator(".noctis-intelligence").count(), 1);
      await noHorizontalOverflow();
      await page.screenshot({ path: join(EVIDENCE, "P15-presence-phone-sheet.png") });
      await page.goBack();
      await waitFor(
        () => sheet.count(),
        (count) => count === 0,
        "Back did not close the sheet",
      );
      assert.equal(await chip.evaluate((node) => node === document.activeElement), true);
      await page
        .getByRole("heading", { name: "Presence", exact: true })
        .waitFor({ state: "attached" });

      const approvals = await coreRead(CORE_URL, "/approvals");
      const pending = approvals.body.approvals.find(
        (approval) => approval.declinedAt === undefined && approval.confirmedAt === undefined,
      );
      assert.ok(pending, JSON.stringify(approvals.body));
      const declined = await coreCommand(CORE_URL, "authority.decline", {
        idempotencyKey: "presence-brief-decline",
        requestId: pending.id ?? pending.requestId,
      });
      assert.equal(declined.status, 200, JSON.stringify(declined.body));
      await waitFor(
        () => chip.count(),
        (count) => count === 0,
        "the brief outlived its turn",
        20000,
      );
    },
  );
  it(
    "a panel the chat's own turn opens shows in Presence, and its choice answers on that chat",
    { timeout: 120000 },
    async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await openPresence();
      await page.getByLabel("Message Vesper").fill("CHOICE: Alpha | Beta");
      await page.getByLabel("Message Vesper").press("Enter");

      const column = page.locator('aside[aria-label="Presence panels"]');
      const use = column.getByRole("button", { name: "Use Alpha", exact: true });
      await use.waitFor({ timeout: 20000 });
      await waitFor(() => use.isEnabled(), Boolean, "the choice stayed disabled");
      await noHorizontalOverflow();
      await use.click();
      await page.getByText("Hello Use Alpha", { exact: true }).waitFor({ timeout: 20000 });

      await page.setViewportSize({ width: 400, height: 860 });
      const chip = page.getByRole("button", { name: "Open panel Choices", exact: true });
      await chip.waitFor();
      await chip.click();
      await page
        .getByRole("region", { name: "Panel sheet" })
        .getByRole("button", { name: "Use Beta", exact: true })
        .waitFor();
      await noHorizontalOverflow();
    },
  );
});

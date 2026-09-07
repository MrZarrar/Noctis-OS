import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import { createTestVault } from "@noctis/test-kit";

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
 * The gate for the ported Vault sphere.
 *
 * It never touches the WebGL canvas, and that is the assertion. The donor
 * component had no `tabIndex`, `role`, or `aria-*` at all, so every one of its
 * behaviours was pointer-only; here the canvas is `aria-hidden` decoration and
 * the list beneath it is the real control surface. If this suite can focus a
 * note, isolate its neighbourhood, and come back out using only the keyboard,
 * then the graph is operable without a mouse, without a screen reader guessing,
 * and on a machine with no GPU.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const WEB_ROOT = join(REPO_ROOT, "apps/web");

const CORE_PORT = 8793;
const WEB_PORT = 4181;
const CORE_URL = `http://127.0.0.1:${CORE_PORT}`;
const WEB_URL = `http://localhost:${WEB_PORT}`;

let core;
let web;
let browser;
let page;
let databaseDirectory;
let vaultDirectory;

/** What the Vault page currently shows, in the terms the gate is written in. */
function readVault() {
  return page.evaluate(() => {
    const list = document.querySelector('ul[aria-label^="Vault notes"], ul[aria-label^="Focused"]');

    return {
      heading: document.querySelector("h1")?.textContent ?? "",
      listLabel: list?.getAttribute("aria-label") ?? "",
      notes: [...(list?.querySelectorAll("button") ?? [])].map((button) => ({
        text: button.textContent?.trim() ?? "",
        pressed: button.getAttribute("aria-pressed") === "true",
      })),
      // The globe must never be part of the accessibility tree: it would
      // otherwise announce as an unlabelled image of the list below it.
      canvasHidden: document.querySelector("canvas")?.closest("[aria-hidden]") !== null,
      truncation:
        [...document.querySelectorAll("p")]
          .map((paragraph) => paragraph.textContent ?? "")
          .find((text) => text.startsWith("Showing ")) ?? "",
    };
  });
}

describe("the Vault sphere, driven only by the keyboard", () => {
  before(async () => {
    assert.ok(
      existsSync(join(REPO_ROOT, "packages/ui/dist/index.js")),
      "run `npm run build` before the E2E suite: it serves the built workspace packages",
    );

    databaseDirectory = mkdtempSync(join(tmpdir(), "noctis-e2e-vault-db-"));
    vaultDirectory = mkdtempSync(join(tmpdir(), "noctis-e2e-vault-"));
    createTestVault(vaultDirectory);

    core = startProcess(process.execPath, [join(REPO_ROOT, "apps/core/dist/main.js")], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NOCTIS_CORE_TOKEN: TOKEN,
        NOCTIS_CORE_PORT: String(CORE_PORT),
        NOCTIS_DATABASE_PATH: join(databaseDirectory, "core.db"),
        NOCTIS_ALLOWED_ORIGINS: WEB_URL,
        NOCTIS_LOG_LEVEL: "error",
        // A disposable fixture Vault. `NOCTIS_VAULT_ALLOW_LIVE` is deliberately
        // absent: the core refuses to start against anything that looks live.
        NOCTIS_VAULT_ROOT: vaultDirectory,
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
    await waitForHttp(WEB_URL, "the web app", web);

    browser = await chromium.launch(launchOptions());
    page = await browser.newPage({ viewport: { width: 1900, height: 1000 } });
  });

  after(async () => {
    await page?.close();
    await browser?.close();
    await stopProcess(core);
    await stopProcess(web);

    for (const directory of [databaseDirectory, vaultDirectory]) {
      if (directory !== undefined) {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it(
    "THE GATE: indexes, focuses, and isolates a subgraph without a pointer",
    { timeout: 120_000 },
    async () => {
      await page.goto(WEB_URL);

      await tabTo(page, "Vault");
      await page.keyboard.press("Enter");
      await waitFor(readVault, (state) => state.heading === "Vault", "the Vault page never opened");

      // Index the fixture Vault. Reindexing is an explicit command, so the page
      // starts empty and this is the act that fills it.
      await tabTo(page, "Reindex");
      await page.keyboard.press("Enter");

      const indexed = await waitFor(
        readVault,
        (state) => state.notes.length > 0,
        "reindexing never produced a graph",
      );

      assert.ok(
        indexed.canvasHidden,
        "the WebGL canvas is in the accessibility tree; it must be aria-hidden decoration",
      );
      assert.ok(
        indexed.listLabel.startsWith("Vault notes"),
        `the unfocused list should be the whole Vault, not a subgraph: ${indexed.listLabel}`,
      );
      assert.equal(indexed.truncation, "", "a seven-note fixture must not report truncation");
      // Type and unwritten-ness are words, not only a colour.
      assert.ok(
        indexed.notes.some((note) => note.text.includes("· person")),
        "a note's type is not written out beside it",
      );
      assert.ok(
        indexed.notes.some((note) => note.text.includes("not written yet")),
        "the placeholder entity for an unwritten wikilink target is not announced",
      );

      const first = indexed.notes[0].text.split(" ·")[0].replace(/^●\s*/, "");

      // Focus one note. On the canvas this is a click that flies the camera;
      // here it is Enter on the note's own button.
      await tabTo(page, indexed.notes[0].text);
      await page.keyboard.press("Enter");
      await waitFor(
        readVault,
        (state) => state.notes.some((note) => note.pressed),
        `focusing "${first}" did not press its button`,
      );

      // Isolate its neighbourhood. On the canvas this is a double-click.
      await tabTo(page, "Isolate the focused note");
      await page.keyboard.press("Enter");

      const isolated = await waitFor(
        readVault,
        (state) => state.listLabel.startsWith("Focused subgraph"),
        "isolating did not narrow the list to the focused subgraph",
      );

      assert.ok(
        isolated.notes.length < indexed.notes.length,
        "isolation returned the whole Vault again, not the focused subgraph",
      );

      // And back out. Section 7 asks for a round trip, not a one-way jump.
      await tabTo(page, "Clear focus");
      await page.keyboard.press("Enter");

      const cleared = await waitFor(
        readVault,
        (state) => state.listLabel.startsWith("Vault notes"),
        "clearing the focus did not return the whole Vault",
      );

      assert.equal(cleared.notes.length, indexed.notes.length);
      assert.ok(
        !cleared.notes.some((note) => note.pressed),
        "clearing the focus left a note still marked as focused",
      );
    },
  );
});

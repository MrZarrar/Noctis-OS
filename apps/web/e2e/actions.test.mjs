import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright";
import { launchOptions, startProcess, stopProcess, waitForHttp, waitFor } from "./harness.mjs";

test(
  "Vault actions acknowledge pending work, prevent repeats and recover from failures",
  { timeout: 90000 },
  async () => {
    const url = "http://127.0.0.1:4296/e2e/actions.html";
    const web = startProcess(
      process.execPath,
      [
        "node_modules/vite/bin/vite.js",
        "apps/web",
        "--host",
        "127.0.0.1",
        "--port",
        "4296",
        "--strictPort",
      ],
      { cwd: process.cwd(), env: process.env },
    );
    let browser;
    try {
      await waitForHttp(url, "action fixture", web);
      browser = await chromium.launch(launchOptions());
      for (const viewport of [
        { width: 1280, height: 900 },
        { width: 390, height: 844 },
      ]) {
        const page = await browser.newPage({ viewport });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        await page.getByRole("button", { name: "Undo", exact: true }).waitFor();
        const reindex = page.getByRole("button", { name: "Reindex", exact: true });
        await reindex.focus();
        await page.keyboard.press("Enter");
        const indexing = page.getByRole("button", { name: "Indexing...", exact: true });
        await indexing.waitFor();
        assert.equal(await indexing.isDisabled(), true);
        assert.equal(await indexing.getAttribute("aria-busy"), "true");
        mkdirSync(".noctis/actions/evidence", { recursive: true });
        await page.screenshot({
          path: `.noctis/actions/evidence/vault-${String(viewport.width)}.png`,
        });
        await indexing.dispatchEvent("click");
        assert.equal(await page.evaluate(() => globalThis.__requests.length), 1);
        await page.evaluate(() => globalThis.__finish("/commands/vault.reindex"));
        await page.getByRole("status").filter({ hasText: "Vault index updated." }).waitFor();

        await page.getByRole("button", { name: "Promote now", exact: true }).click();
        await page.getByRole("button", { name: "Starting...", exact: true }).waitFor();
        await page.evaluate(() => globalThis.__finish("/commands/vault.promote_now", { notes: 0 }));
        await page
          .getByRole("status")
          .filter({ hasText: "No inbox notes are waiting to be promoted." })
          .waitFor();
        await page.getByRole("button", { name: "Promote now", exact: true }).click();
        await page.evaluate(() =>
          globalThis.__finish("/commands/vault.promote_now", { notes: 2, turnId: "upkeep" }),
        );
        await page
          .getByRole("status")
          .filter({
            hasText:
              "Promotion started for 2 inbox notes. Follow its progress in the Vault upkeep conversation.",
          })
          .waitFor();

        await reindex.click();
        await page.evaluate(() => globalThis.__fail("/commands/vault.reindex"));
        await page.getByRole("alert").filter({ hasText: "Connection lost" }).waitFor();
        assert.equal(await reindex.isEnabled(), true);
        await reindex.click();
        await page.evaluate(() =>
          globalThis.__finish(
            "/commands/vault.reindex",
            { error: { message: "Vault is offline" } },
            503,
          ),
        );
        await page.getByRole("alert").filter({ hasText: "Vault is offline" }).waitFor();

        for (const [label, busy, command] of [
          ["Undo", "Undoing...", "undo_edit"],
          ["Apply", "Applying...", "apply_revision"],
          ["Decline", "Declining...", "decline_revision"],
        ]) {
          await page.getByRole("button", { name: label, exact: true }).click();
          const working = page.getByRole("button", { name: busy, exact: true });
          await working.waitFor();
          assert.equal(await working.isDisabled(), true);
          await page.evaluate((name) => globalThis.__finish(`/commands/vault.${name}`), command);
          await page.getByRole("button", { name: label, exact: true }).waitFor();
        }

        await page.getByRole("textbox", { name: "Recall", exact: true }).fill("Istanbul");
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await page.getByRole("button", { name: "Searching...", exact: true }).waitFor();
        await page.evaluate(() => globalThis.__fail("/vault/recall?query=Istanbul&limit=10"));
        await page.getByRole("alert").filter({ hasText: "Connection lost" }).waitFor();
        assert.equal(
          await page.getByRole("button", { name: "Search", exact: true }).isEnabled(),
          true,
        );
        await page.getByRole("button", { name: "Search", exact: true }).click();
        await page.evaluate(() =>
          globalThis.__finish("/vault/recall?query=Istanbul&limit=10", {
            entityIds: [],
            evidence: [],
            freshness: "unknown",
          }),
        );
        await page.getByRole("button", { name: "Search", exact: true }).waitFor();

        await page.getByRole("textbox", { name: "Passcode", exact: true }).fill("1234");
        await page.getByRole("button", { name: "Show sensitive", exact: true }).click();
        const unlocking = page.getByRole("button", { name: "Unlocking...", exact: true });
        await unlocking.waitFor();
        assert.equal(await unlocking.isDisabled(), true);
        await page.evaluate(() =>
          globalThis.__finish("/passcode/unlock", {
            configured: true,
            unlocked: true,
            timeoutMinutes: 10,
            lockoutSeconds: 0,
          }),
        );
        await page.getByText("Sensitive notes are shown.", { exact: true }).waitFor();
        await page.getByRole("button", { name: "Lock", exact: true }).click();
        await page.getByRole("button", { name: "Locking...", exact: true }).waitFor();
        await page.evaluate(() => globalThis.__fail("/passcode/lock"));
        await page.getByRole("alert").filter({ hasText: "Connection lost" }).waitFor();
        assert.equal(
          await page.getByRole("button", { name: "Lock", exact: true }).isEnabled(),
          true,
        );

        const places = page.getByRole("button", { name: "Save places", exact: true });
        await places.click();
        await page.getByRole("button", { name: "Saving...", exact: true }).waitFor();
        await page.evaluate(() => globalThis.__fail("/settings"));
        await page.getByRole("alert").filter({ hasText: "Connection lost" }).last().waitFor();
        assert.equal(await places.isEnabled(), true);
        await places.click();
        await page.evaluate(() => globalThis.__finish("/settings"));
        await places.waitFor();
        await page.getByRole("button", { name: "Reset", exact: true }).click();
        await page.getByRole("button", { name: "Resetting...", exact: true }).waitFor();
        await page.evaluate(() => globalThis.__finish("/reset"));

        const add = page.getByRole("button", { name: "Add a place", exact: true });
        await add.focus();
        await page.keyboard.down("Space");
        await waitFor(
          () => add.evaluate((element) => getComputedStyle(element).scale),
          (scale) => scale === "0.97",
          "button press feedback appeared",
        );
        await page.keyboard.up("Space");
        await page.emulateMedia({ reducedMotion: "reduce" });
        const button = page.getByRole("button", { name: "Promote now", exact: true });
        await button.focus();
        await page.keyboard.down("Space");
        assert.equal(await button.evaluate((element) => getComputedStyle(element).scale), "none");
        await page.keyboard.up("Space");
        await waitFor(
          () => page.evaluate(() => globalThis.__requests.at(-1)?.path),
          (path) => path === "/commands/vault.promote_now",
          "keyboard action registered",
        );
        await page.evaluate(() => globalThis.__finish("/commands/vault.promote_now", { notes: 0 }));
        assert.deepEqual(errors, []);
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > globalThis.innerWidth),
          false,
        );
        await page.close();
      }
    } finally {
      await browser?.close();
      await stopProcess(web);
    }
  },
);

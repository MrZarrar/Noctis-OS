import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { launchOptions, startProcess, stopProcess, waitForHttp } from "./harness.mjs";

test("each box in a reply copies its own text with one click", { timeout: 90000 }, async () => {
  const url = "http://127.0.0.1:4297/e2e/copy.html";
  const web = startProcess(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "apps/web",
      "--host",
      "127.0.0.1",
      "--port",
      "4297",
      "--strictPort",
    ],
    { cwd: process.cwd(), env: process.env },
  );
  let browser;
  try {
    await waitForHttp(url, "copy fixture", web);
    browser = await chromium.launch(launchOptions());
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(url);

    const buttons = page.getByRole("button", { name: "Copy", exact: true });
    await buttons.first().waitFor();
    assert.equal(await buttons.count(), 2);

    await buttons.nth(1).click();
    await page.getByRole("button", { name: "Copied", exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => globalThis.navigator.clipboard.readText()),
      "dream pop, 92 bpm, airy female vocal",
    );

    await page.getByRole("button", { name: "Copy", exact: true }).first().click();
    await page.waitForFunction(async () =>
      (await globalThis.navigator.clipboard.readText()).startsWith("[Verse 1]"),
    );
    assert.equal(
      // Windows hands text back with CRLF line ends.
      (await page.evaluate(() => globalThis.navigator.clipboard.readText())).replace(/\r\n/g, "\n"),
      "[Verse 1]\nI dreamed of a city made of glass",
    );

    // Back to Copy on its own, so a second copy is as obvious as the first.
    await page.waitForFunction(
      () => [...document.querySelectorAll("button")].every((b) => b.textContent === "Copy"),
      undefined,
      { timeout: 5000 },
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stopProcess(web);
  }
});

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright";
import { launchOptions, startProcess, stopProcess, waitForHttp, waitFor } from "./harness.mjs";

test(
  "options cards: desktop and phone, inspectable links, file images and owning conversation actions",
  { timeout: 90000 },
  async () => {
    const url = "http://127.0.0.1:4291/e2e/options.html";
    const web = startProcess(
      process.execPath,
      [
        "node_modules/vite/bin/vite.js",
        "apps/web",
        "--host",
        "127.0.0.1",
        "--port",
        "4291",
        "--strictPort",
      ],
      { cwd: process.cwd(), env: process.env },
    );
    let browser;
    try {
      await waitForHttp(url, "options fixture", web);
      browser = await chromium.launch(launchOptions());
      for (const viewport of [
        { width: 1280, height: 900 },
        { width: 390, height: 844 },
        { width: 700, height: 900 },
      ]) {
        const page = await browser.newPage({ viewport });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        const cards = page.getByRole("article");
        await page.getByRole("heading", { name: "Anker USB-C cable", exact: true }).waitFor();
        assert.equal(await cards.count(), 3);
        await waitFor(
          () =>
            page
              .getByRole("img", { name: "Anker USB-C cable" })
              .evaluate((img) => img.complete && img.naturalWidth > 0),
          Boolean,
          "file screenshot decoded",
        );
        await waitFor(
          () => page.getByText("Screenshot unavailable", { exact: true }).count(),
          (count) => count === 2,
          "missing and failed screenshots show placeholders",
        );
        assert.equal(
          await page
            .getByRole("img", { name: "Anker USB-C cable" })
            .evaluate((img) => getComputedStyle(img).objectFit),
          "contain",
        );
        const boxes = await cards.evaluateAll((nodes) =>
          nodes.map((node) => {
            const { x, y, width } = node.getBoundingClientRect();
            return { x, y, width };
          }),
        );
        assert.equal(
          viewport.width > 719 ? boxes[0].y === boxes[1].y : boxes[1].y > boxes[0].y,
          true,
        );
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > globalThis.innerWidth),
          false,
        );
        const link = page.getByRole("link", {
          name: "Open listing: https://amazon.co.uk/cable?colour=black",
          exact: true,
        });
        assert.equal(await link.textContent(), "amazon.co.uk");
        assert.equal(await link.getAttribute("title"), "https://amazon.co.uk/cable?colour=black");
        assert.equal(await link.getAttribute("target"), "_blank");
        assert.equal(await link.getAttribute("rel"), "noopener noreferrer");
        await page.getByText("View address", { exact: true }).focus();
        await page.keyboard.press("Enter");
        assert.equal(
          await page
            .getByText("https://amazon.co.uk/cable?colour=black", { exact: true })
            .isVisible(),
          true,
        );
        mkdirSync("apps/web/e2e/evidence/options", { recursive: true });
        await page.screenshot({
          path: `apps/web/e2e/evidence/options/${viewport.width}.png`,
          fullPage: true,
        });
        await page.getByRole("button", { name: "Toggle busy" }).click();
        for (const name of ["Add Anker", "Add Belkin", "Add UGREEN", "Find more"])
          assert.equal(await page.getByRole("button", { name, exact: true }).isDisabled(), true);
        await page.getByRole("button", { name: "Toggle busy" }).click();
        const add = page.getByRole("button", { name: "Add Anker", exact: true });
        await add.click();
        assert.equal(await add.isDisabled(), true);
        assert.deepEqual(await page.evaluate(() => globalThis.__choices), [
          { message: "Add option anker to my basket", owner: { threadId: "owning-thread" } },
        ]);
        await page.evaluate(() => globalThis.__finishChoice());
        await page.getByRole("button", { name: "Add Belkin", exact: true }).click();
        await page.evaluate(() => globalThis.__finishChoice());
        await page.getByRole("alert").filter({ hasText: "Choice failed. Try again." }).waitFor();
        await page.getByRole("button", { name: "Find more", exact: true }).click();
        await page.evaluate(() => globalThis.__finishChoice());
        assert.equal(
          (await page.evaluate(() => globalThis.__choices)).at(-1).message,
          "Find more cables",
        );
        await page.getByRole("button", { name: "Show conversation error" }).click();
        await page
          .getByRole("alert")
          .filter({ hasText: "Conversation is unavailable" })
          .first()
          .waitFor();
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally {
      await browser?.close();
      await stopProcess(web);
    }
  },
);

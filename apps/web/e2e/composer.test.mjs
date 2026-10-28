import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdirSync } from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright";
import { launchOptions, startProcess, stopProcess, waitForHttp } from "./harness.mjs";

test(
  "mobile replies fit and the composer expands in place without losing a draft",
  { timeout: 90000 },
  async () => {
    const url = "http://127.0.0.1:4295/e2e/composer.html";
    const web = startProcess(
      process.execPath,
      [
        "node_modules/vite/bin/vite.js",
        "apps/web",
        "--host",
        "127.0.0.1",
        "--port",
        "4295",
        "--strictPort",
      ],
      { cwd: process.cwd(), env: process.env },
    );
    let browser;
    try {
      await waitForHttp(url, "composer fixture", web);
      browser = await chromium.launch(launchOptions());
      for (const [width, height] of [
        [320, 600],
        [393, 852],
      ]) {
        const page = await browser.newPage({
          viewport: { width, height },
          reducedMotion: "reduce",
        });
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(url);
        const composer = page.locator("[data-panel-composer]");
        await page.getByLabel("Message Vesper").waitFor();
        const header = page.locator('section[aria-label="Threads"] > div > header');
        assert.ok(
          (await header.boundingBox()).height <= 64,
          "phone Threads header should fit in one compact row",
        );
        for (const name of ["Conversations", "Add panel", "Agents · 37"]) {
          const control = await header.getByRole("button", { name, exact: true }).boundingBox();
          assert.ok(control.height >= 44 && control.x >= 0 && control.x + control.width <= width);
        }
        const bounds = await page.evaluate(() => {
          const page = document.querySelector('section[aria-label="Threads"]');
          const list = document.querySelector('[aria-label="Conversation"]');
          return {
            pageOverflow: page.scrollWidth - page.clientWidth,
            list: list.getBoundingClientRect().toJSON(),
            replies: [
              ...document.querySelectorAll('li[data-entry="message"], li[data-entry="streaming"]'),
            ].map((node) => node.getBoundingClientRect().toJSON()),
          };
        });
        assert.ok(
          bounds.pageOverflow <= 1,
          `page has ${bounds.pageOverflow}px horizontal overflow at ${width}px`,
        );
        for (const reply of bounds.replies) {
          assert.ok(
            reply.left >= bounds.list.left && reply.right <= bounds.list.right + 1,
            `reply extends past the transcript at ${width}px`,
          );
        }
        assert.ok(
          (await composer.boundingBox()).height <= 140,
          "collapsed composer should leave room to read",
        );
        const expand = composer.getByRole("button", { name: "Show composer details", exact: true });
        assert.equal(await expand.getAttribute("aria-expanded"), "false");
        assert.equal(await composer.getByRole("button", { name: /^Agent:/ }).isVisible(), false);
        assert.equal(
          await composer.getByRole("region", { name: "Usage limits" }).isVisible(),
          false,
        );
        await composer.getByRole("button", { name: "Stop", exact: true }).waitFor();
        await page.getByLabel("Message Vesper").fill("Keep my draft");
        await expand.click();
        assert.equal(
          await composer
            .getByRole("button", { name: "Hide composer details" })
            .getAttribute("aria-expanded"),
          "true",
        );
        await composer.locator("[data-thread-status]").waitFor();
        await composer.getByRole("meter", { name: /^Codex 5-hour limit/ }).waitFor();
        const usage = await composer.getByRole("region", { name: "Usage limits" }).boundingBox();
        assert.ok(usage.x >= 0 && usage.x + usage.width <= width);
        mkdirSync(".noctis/composer", { recursive: true });
        await page.screenshot({ path: `.noctis/composer/expanded-${width}.png` });
        await composer.getByRole("button", { name: /^Agent:/ }).click();
        await page.getByRole("option", { name: "Other (codex)", exact: true }).click();
        await composer.locator('input[type="file"]').setInputFiles({
          name: "draft.txt",
          mimeType: "text/plain",
          buffer: Buffer.from("attachment"),
        });
        await composer.getByRole("button", { name: "Hide composer details" }).click();
        assert.equal(
          await composer.getByRole("region", { name: "Usage limits" }).isVisible(),
          false,
        );
        assert.equal(await page.getByLabel("Message Vesper").inputValue(), "Keep my draft");
        await composer.getByRole("button", { name: "Preview draft.txt", exact: true }).waitFor();
        await composer.getByRole("button", { name: "Stop", exact: true }).click();
        assert.equal(await page.getByLabel("Message Vesper").inputValue(), "Keep my draft");
        mkdirSync(".noctis/composer", { recursive: true });
        await page.screenshot({ path: `.noctis/composer/mobile-${width}.png` });
        await composer.getByRole("button", { name: "Send", exact: true }).click();
        const sent = await page.evaluate(() => globalThis.__sent);
        assert.equal(sent.text, "Keep my draft");
        assert.equal(sent.options.model.model, "other-model");
        assert.equal(sent.options.files.length, 1);
        await page.setViewportSize({ width, height: 450 });
        assert.ok((await composer.boundingBox()).height <= 140);
        const message = await page.getByLabel("Message Vesper").boundingBox();
        assert.ok(message.y >= 0 && message.y + message.height <= 450);
        await page.setViewportSize({ width: 1280, height: 900 });
        await composer.getByRole("button", { name: /^Agent:/ }).waitFor();
        assert.equal(
          await composer.getByRole("button", { name: "Show composer details" }).isVisible(),
          false,
        );
        await page.screenshot({ path: `.noctis/composer/desktop-${width}.png` });
        assert.deepEqual(errors, []);
        await page.close();
      }
    } finally {
      await browser?.close();
      await stopProcess(web);
    }
  },
);

import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { startProcess, stopProcess, waitForHttp, launchOptions } from "./harness.mjs";

const PORT = 4287;
const URL = `http://127.0.0.1:${String(PORT)}/e2e/health.html`;

test("THE GATE (Health): the report as an instrument on desktop and phone, reduced motion, stale", async () => {
  const web = startProcess(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "apps/web", "--host", "127.0.0.1", "--port", String(PORT)],
    { cwd: process.cwd(), env: process.env },
  );
  let browser;
  try {
    await waitForHttp(URL, "fixture", web);
    browser = await chromium.launch(launchOptions());

    for (const [viewport, reducedMotion] of [
      [{ width: 1280, height: 900 }, "no-preference"],
      [{ width: 390, height: 844 }, "no-preference"],
      [{ width: 390, height: 844 }, "reduce"],
    ]) {
      const page = await browser.newPage({ viewport, reducedMotion });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(URL);

      await page.getByRole("heading", { name: "Health", exact: true }).waitFor();
      await page
        .getByRole("img", { name: /time in range|in range:/i })
        .first()
        .waitFor();
      await page.getByRole("img", { name: /Your glucose day/ }).waitFor();
      const charts = await page.getByRole("img", { name: /events, aligned at the start/ }).count();
      const strips = await page.getByRole("table", { name: /Basal against programmed/ }).count();
      assert.ok(
        charts + strips >= 3,
        `expected three finding charts, saw ${String(charts + strips)}`,
      );
      await page.getByText("Not medical advice", { exact: false }).waitFor();

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - globalThis.innerWidth,
      );
      assert.equal(overflow, 0, `no horizontal scroll at ${String(viewport.width)} px`);

      // The clock is the other view of the same day.
      await page.getByRole("radio", { name: "Clock" }).click();
      await page
        .getByRole("button", { name: /breakfast: see findings/i })
        .first()
        .waitFor();
      await page.getByRole("radio", { name: "Ribbon" }).click();

      // Applied takes two presses; the first only explains.
      await page.getByRole("button", { name: "Applied", exact: true }).click();
      await page.getByRole("button", { name: /I already changed the pump/ }).click();
      await page.getByRole("button", { name: "Undo" }).waitFor();
      assert.deepEqual(await page.evaluate(() => globalThis.__decided), [
        ["2026-W41-breakfast-carb_ratio", "mark-applied"],
      ]);

      assert.deepEqual(errors, []);
      await page.close();
    }

    const stale = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await stale.goto(`${URL}?stale`);
    await stale.getByText(/Data stale since/).waitFor();
    assert.equal(await stale.locator("[data-stale=true]").count(), 1);
    await stale.close();

    const unreadable = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await unreadable.goto(`${URL}?state=unreadable`);
    await unreadable.getByText("Report unreadable").waitFor();
    await unreadable.close();
  } finally {
    await browser?.close();
    await stopProcess(web);
  }
});

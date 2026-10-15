import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { startProcess, stopProcess, waitForHttp, launchOptions } from "./harness.mjs";
test("productivity desktop and phone workflows with strict contract fake core", async () => {
  const web = startProcess(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "apps/web", "--host", "127.0.0.1", "--port", "4283"],
    { cwd: process.cwd(), env: process.env },
  );
  let browser;
  try {
    await waitForHttp("http://127.0.0.1:4283/e2e/productivity.html", "fixture", web);
    browser = await chromium.launch(launchOptions());
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto("http://127.0.0.1:4283/e2e/productivity.html");
      await page.getByLabel("Reminder", { exact: true }).fill("Renew passport");
      await page.getByLabel("When", { exact: true }).selectOption("interval");
      await page.getByRole("button", { name: "Add reminder", exact: true }).click();
      await page.getByText("Renew passport", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Snooze 1 hour" }).click();
      await page.getByText(/snoozed/).waitFor();
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.getByText(/^done /).waitFor();
      await page.getByRole("button", { name: "Notes", exact: true }).click();
      await page.getByLabel("Title", { exact: true }).fill("Travel");
      await page.getByLabel("Note", { exact: true }).fill("Bring passport");
      await page.getByRole("button", { name: "Toggle panel" }).click();
      assert.equal(await page.getByLabel("Title", { exact: true }).inputValue(), "Travel");
      await page.getByRole("button", { name: "Save note" }).click();
      await page.getByRole("heading", { name: "Travel" }).waitFor();
      await page.getByLabel("Search notes").fill("passport");
      assert.equal(await page.getByRole("heading", { name: "Travel" }).count(), 1);
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await page.getByLabel("Note", { exact: true }).fill("Passport and tickets");
      await page.getByRole("button", { name: "Save changes" }).click();
      await page.getByText("Passport and tickets", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Reminders", exact: true }).click();
      await page.getByRole("tab", { name: "Scheduled tasks" }).click();
      await page.getByLabel("Task name").fill("Daily review");
      await page.getByLabel("Prompt", { exact: true }).fill("Summarise recent work");
      await page.getByLabel("When", { exact: true }).selectOption("weekly");
      await page.getByRole("button", { name: "Create paused task" }).click();
      await page.getByRole("button", { name: "Turn on", exact: true }).waitFor();
      await page.getByRole("button", { name: "Turn on", exact: true }).click();
      await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Run now" }).isEnabled(), true);
      await page.getByText("Standing permissions (0)", { exact: true }).click();
      await page.getByRole("button", { name: "Add permission", exact: true }).click();
      await page.getByLabel("Capability", { exact: true }).fill("git.push");
      await page.getByLabel("Target type", { exact: true }).fill("repository");
      await page.getByLabel("Exact target ID", { exact: true }).fill("owner/repo");
      await page.getByRole("button", { name: "Grant for this task", exact: true }).click();
      await page.getByText("git.push: owner/repo", { exact: false }).waitFor();
      await page.getByRole("button", { name: "Revoke", exact: true }).click();
      await page
        .getByRole("button", { name: "Revoke", exact: true })
        .waitFor({ state: "detached" });
      await page.getByRole("button", { name: "Suggest task change", exact: true }).click();
      await page.getByRole("tab", { name: "Scheduled tasks" }).click();
      await page.getByRole("button", { name: "Review suggested changes", exact: true }).click();
      assert.equal(
        await page.getByLabel("Prompt", { exact: true }).inputValue(),
        "Suggested new work",
      );
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await page.getByText("Suggested new work", { exact: true }).waitFor();
      await page
        .getByRole("button", { name: "Review suggested changes", exact: true })
        .waitFor({ state: "detached" });
      await page.getByText("Run history (0)").click();
      await page.getByText("No runs yet.").waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
        false,
      );
      mkdirSync(".noctis/productivity", { recursive: true });
      await page.screenshot({ path: `.noctis/productivity/${viewport.width}.png`, fullPage: true });
      await page.getByRole("button", { name: "To-dos", exact: true }).click();
      await page.getByLabel("To-do", { exact: true }).fill("Book appointment");
      await page.getByRole("button", { name: "Add to-do", exact: true }).click();
      await page.getByText("Book appointment", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      assert.equal(await page.getByText("Book appointment", { exact: true }).count(), 0);
      await page.getByRole("button", { name: "Seed due reminders" }).click();
      await page.getByRole("button", { name: "and 1 more" }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Done", exact: true }).count(), 3);
      await page.getByRole("button", { name: "Done", exact: true }).first().click();
      await page.getByText("Due 3", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Snooze 1 hour" }).first().click();
      await page.getByText("Due 1", { exact: true }).waitFor({ state: "detached" });
      await page
        .getByLabel("Other snooze times")
        .first()
        .selectOption("pc:00000000-0000-7000-8000-000000000001");
      await page.getByText("Due 2", { exact: true }).waitFor({ state: "detached" });
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser?.close();
    await stopProcess(web);
  }
});

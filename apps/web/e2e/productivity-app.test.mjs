import { URL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import {
  TOKEN,
  startProcess,
  stopProcess,
  waitForHttp,
  launchOptions,
  coreCommand,
} from "./harness.mjs";
test("actual app productivity navigation, adaptive panels and notification thread link", async () => {
  const repo = process.cwd(),
    scratch = mkdtempSync(join(tmpdir(), "noctis-productivity-"));
  const coreUrl = "http://127.0.0.1:8898",
    webUrl = "http://localhost:4284";
  let core, web, browser;
  try {
    mkdirSync(join(scratch, "vault"));
    core = startProcess(process.execPath, [join(repo, "apps/core/dist/main.js")], {
      cwd: repo,
      env: {
        ...process.env,
        NOCTIS_CORE_TOKEN: TOKEN,
        NOCTIS_CORE_PORT: "8898",
        NOCTIS_DATABASE_PATH: join(scratch, "core.db"),
        NOCTIS_ALLOWED_ORIGINS: webUrl,
        NOCTIS_LOG_LEVEL: "error",
        NOCTIS_VAULT_ROOT: join(scratch, "vault"),
        NOCTIS_TASKS_ENABLED: "0",
      },
    });
    await waitForHttp(coreUrl + "/health", "isolated core", core);
    web = startProcess(
      process.execPath,
      [join(repo, "node_modules/vite/bin/vite.js"), "--port", "4284", "--strictPort"],
      {
        cwd: join(repo, "apps/web"),
        env: {
          ...process.env,
          VITE_CORE_TOKEN: "",
          VITE_CORE_URL: webUrl,
          NOCTIS_CORE_PROXY_TARGET: coreUrl,
        },
      },
    );
    await waitForHttp(webUrl, "app", web);
    browser = await chromium.launch(launchOptions());
    const thread = await coreCommand(coreUrl, "conversation.create_thread", {
      idempotencyKey: "notification-thread",
      identityId: "jester",
    });
    assert.equal(thread.status, 200);
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(webUrl + "/?thread=" + thread.body.id + "&keep=1");
      await page.getByLabel("Core token").fill(TOKEN);
      await page.getByLabel("Core token").press("Enter");
      await page.getByRole("heading", { name: "Threads", exact: true }).waitFor();
      await page.getByLabel("Message Jester").waitFor();
      assert.equal(new URL(page.url()).searchParams.has("thread"), false);
      assert.equal(new URL(page.url()).searchParams.get("keep"), "1");
      async function select(name) {
        if (viewport.width < 700 && ["Reminders", "To-dos", "Notes"].includes(name))
          await page.getByRole("button", { name: "More", exact: true }).click();
        await page.getByRole("button", { name, exact: true }).click();
      }
      await select("Notes");
      await page.getByLabel("Title", { exact: true }).fill("App note " + viewport.width);
      await page.getByLabel("Note", { exact: true }).fill("Preserved across navigation");
      await select("To-dos");
      await page.getByLabel("To-do", { exact: true }).fill("Task " + viewport.width);
      await page.getByRole("button", { name: "Add to-do", exact: true }).click();
      await page.getByText("Task " + viewport.width, { exact: true }).waitFor();
      await select("Notes");
      assert.equal(
        await page.getByLabel("Title", { exact: true }).inputValue(),
        "App note " + viewport.width,
      );
      await page.getByRole("button", { name: "Save note", exact: true }).click();
      await page
        .getByRole("heading", { name: "App note " + viewport.width, exact: true })
        .waitFor();
      const taskId = "00000000-0000-7000-8000-000000000002";
      const now = new Date().toISOString();
      await page.route("**/tasks", (route) =>
        route.fulfill({
          json: {
            tasks: [
              {
                id: taskId,
                identityId: "jester",
                name: "Jester result",
                prompt: "Review work",
                model: { providerId: "codex", model: "gpt-6-sol" },
                nodeId: "00000000-0000-7000-8000-000000000003",
                rootGrantId: "test",
                trigger: { kind: "repeat", rule: { kind: "interval", hours: 24 } },
                threadMode: "new",
                maxRunMinutes: 30,
                paused: true,
                consecutiveFailures: 0,
                revision: 1,
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
        }),
      );
      await page.route("**/tasks/" + taskId + "/runs", (route) =>
        route.fulfill({
          json: {
            runs: [
              {
                id: "00000000-0000-7000-8000-000000000004",
                taskId,
                status: "completed",
                threadId: thread.body.id,
                startedAt: now,
                result: "Task finished",
              },
            ],
          },
        }),
      );
      await select("Presence");
      await page
        .getByRole("group", { name: "Who to talk to" })
        .getByRole("button", { name: /Vesper/ })
        .click();
      await page.getByLabel("Message Vesper").waitFor();
      await page.getByRole("button", { name: "Open task thread", exact: true }).click();
      await page.getByLabel("Message Jester").waitFor();
      await select("Presence");
      await page.getByRole("button", { name: "Add panel", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Add panel" })
        .getByRole("button", { name: "Open Notes panel", exact: true })
        .click();
      if (viewport.width < 700)
        await page.getByRole("button", { name: "Open panel Notes", exact: true }).click();
      await page
        .getByRole("heading", { name: "App note " + viewport.width, exact: true })
        .waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
        false,
      );
      if(viewport.width<700)assert.equal(await page.locator("[data-core-dock]").isVisible(),false,"focused phone panel must not be covered by the hero core");
      mkdirSync(".noctis/productivity", { recursive: true });
      await page.screenshot({ path: ".noctis/productivity/app-" + viewport.width + ".png" });
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser?.close();
    await stopProcess(web);
    await stopProcess(core);
    rmSync(scratch, { recursive: true, force: true });
  }
});

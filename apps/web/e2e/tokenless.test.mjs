import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { Buffer } from "node:buffer";
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
  runOnce,
  startProcess,
  stopProcess,
  tabTo,
  waitFor,
  waitForHttp,
} from "./harness.mjs";

/**
 * The tokenless path, end to end, for the first time.
 *
 * Every other E2E suite sets `VITE_CORE_TOKEN` and drives `BrowserTransport`,
 * and every piece of the session path is otherwise proven only against fakes —
 * a `FakeEventSource`, a scripted `fetch`, a synthetic `ServerResponse`. Three
 * things had no proof at all, and all three are load-bearing:
 *
 *   1. that a real browser attaches the `SameSite=Strict` session cookie to a
 *      real `EventSource`, which cannot carry an `Authorization` header and is
 *      therefore the only reason the cookie realm exists;
 *   2. that the origin gate lets a real same-origin page through;
 *   3. that the built `dist` layout serves correctly through the new static
 *      handler.
 *
 * So there is no Vite here. The page is opened at the core's own origin,
 * because that is the only arrangement in which a `SameSite=Strict` cookie is
 * ever sent — a dev server on another port would never receive it, which would
 * make a green suite prove the opposite of what it claims.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const WEB_ROOT = join(REPO_ROOT, "apps/web");
const DIST = resolve(process.env.NOCTIS_E2E_DIST ?? join(WEB_ROOT, "dist"));

const CORE_PORT = 8803;
/** 127.0.0.1, not localhost: this exact string is also the origin allowlist. */
const CORE_URL = `http://127.0.0.1:${CORE_PORT}`;

const WRONG_TOKEN = "ffffffffffffffffffffffffffffffff";
const SEEDED = "the first client typed this";
const LIVE = "a second client typed this";
/** No node is paired, so the turn fails to route — the message still commits. */
const MODEL = { providerId: "codex", model: "fake-model" };

let core;
let browser;
let context;
let page;
let databaseDirectory;
let seededThreadId;

function seed(name, body) {
  return coreCommand(CORE_URL, name, body);
}

/** The session cookie as the browser holds it, or `undefined`. */
async function sessionCookie() {
  return (await context.cookies()).find((cookie) => cookie.name === "__Host-noctis_session");
}

function readPage() {
  return page.evaluate(() => ({
    heading: document.querySelector("h1")?.textContent ?? "",
    body: document.body.textContent ?? "",
    hasNav: document.querySelector('nav[aria-label="Primary"]') !== null,
    hasTokenField: document.querySelector('input[type="password"]') !== null,
    // Read from script, which is the whole point of HttpOnly.
    scriptVisibleCookies: document.cookie,
    messages: [...document.querySelectorAll('li[data-entry="message"]')].map(
      (item) => item.textContent?.trim() ?? "",
    ),
    approvals: [
      ...(document.querySelector('ul[aria-label="Approvals waiting"]')?.children ?? []),
    ].map((item) => item.textContent?.trim() ?? ""),
  }));
}

async function signIn(token) {
  await tabTo(page, "Core token");
  await page.keyboard.type(token);
  await page.keyboard.press("Enter");
}

describe("the tokenless front door: a page the core serves, a cookie it cannot read", () => {
  before(async () => {
    assert.ok(
      existsSync(join(REPO_ROOT, "packages/ui/dist/index.js")),
      "run `npm run build` before the E2E suite",
    );

    // A production bundle, built in a shell with no `VITE_CORE_TOKEN` — which
    // `vite.config.ts` refuses to build with, because the core serves this
    // directory unauthenticated.
    //
    // Built every run, and the skip is opt-in rather than automatic. Skipping
    // by default would mean anyone who had run `build:web` once — for Tauri, or
    // for `test:desktop` — and then edited `Login.tsx` or `SessionTransport.ts`
    // would have this suite serve the *old* bundle and pass. That is a suite
    // that cannot fail, on the only proof the tokenless path has.
    //
    // ponytail: the ceiling on `NOCTIS_E2E_SKIP_BUILD` is exactly that stale
    // bundle, so it is for someone who just built and knows it. The upgrade
    // path is hashing the sources into the decision, which is a build system,
    // which Vite already is — so the honest default is simply to run it.
    const fresh =
      process.env.NOCTIS_E2E_SKIP_BUILD !== undefined && existsSync(join(DIST, "index.html"));

    if (!fresh) {
      const env = { ...process.env };

      delete env.VITE_CORE_TOKEN;
      // Absent means `window.location.origin`, which is the deployed shape and
      // the only one the cookie survives.
      delete env.VITE_CORE_URL;

      await runOnce(process.execPath, [join(REPO_ROOT, "node_modules/vite/bin/vite.js"), "build"], {
        cwd: WEB_ROOT,
        env,
      });
    }

    databaseDirectory = mkdtempSync(join(tmpdir(), "noctis-e2e-tokenless-"));

    core = startProcess(process.execPath, [join(REPO_ROOT, "apps/core/dist/main.js")], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NOCTIS_CORE_TOKEN: TOKEN,
        NOCTIS_CORE_PORT: String(CORE_PORT),
        NOCTIS_DATABASE_PATH: join(databaseDirectory, "core.db"),
        // Both, together: the core refuses to start serving a page with no
        // origin allowlist, because the page would load and then do nothing.
        NOCTIS_WEB_ROOT: DIST,
        NOCTIS_ALLOWED_ORIGINS: CORE_URL,
        NOCTIS_LOG_LEVEL: "error",
      },
    });

    await waitForHttp(`${CORE_URL}/health`, "the core", core);

    // The page subscribes against the thread it finds on load, so there has to
    // be one before it loads for the live message below to have a home.
    const seeded = await seed("conversation.send", {
      idempotencyKey: "e2e-tokenless-seed",
      identityId: "vesper",
      text: SEEDED,
      model: MODEL,
    });

    assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
    seededThreadId = seeded.body.threadId;

    browser = await chromium.launch(launchOptions());
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
  });

  after(async () => {
    await page?.close();
    await context?.close();
    await browser?.close();
    await stopProcess(core);

    if (databaseDirectory !== undefined) {
      rmSync(databaseDirectory, { recursive: true, force: true });
    }
  });

  it(
    "THE GATE: logs in once at the core's own origin, then streams and commands over the cookie",
    { timeout: 180_000 },
    async () => {
      await page.goto(CORE_URL);

      // 1. The login screen, which is the only screen a page with no token can
      //    draw. Its presence is also the proof that the bundle carries no
      //    token: `needsLogin()` would be false if it did.
      const front = await waitFor(
        readPage,
        (state) => state.hasTokenField,
        "the core did not serve a login screen at its own origin",
      );

      assert.equal(front.heading, "Noctis");
      assert.ok(!front.hasNav, "the workbench rendered before anyone logged in");

      // 2. A wrong token is refused, and leaves nothing behind.
      await signIn(WRONG_TOKEN);

      const refused = await waitFor(
        readPage,
        (state) => state.body.includes("That token is not valid"),
        "a wrong token was not refused",
      );

      assert.ok(refused.hasTokenField, "the login screen went away on a refusal");
      assert.equal(await sessionCookie(), undefined, "a refused login still set a session cookie");

      const originalViewport = page.viewportSize();
      await page.setViewportSize({ width: 400, height: 200 });
      const tokenField = page.getByLabel("Core token");
      await tokenField.scrollIntoViewIfNeeded();
      const fieldBox = await tokenField.boundingBox();
      assert.ok(fieldBox.y >= 0 && fieldBox.y + fieldBox.height <= 200);
      await page.getByRole("heading", { name: "Noctis", exact: true }).scrollIntoViewIfNeeded();
      const headingBox = await page
        .getByRole("heading", { name: "Noctis", exact: true })
        .boundingBox();
      assert.ok(headingBox.y >= 0, "the top of the short login form cannot be scrolled into view");
      await page.setViewportSize(originalViewport);

      // 3. The right one yields the workbench.
      await signIn(TOKEN);

      const workbench = await waitFor(
        readPage,
        (state) => state.hasNav,
        "the right token did not produce the workbench",
      );

      assert.ok(!workbench.hasTokenField, "the login screen is still showing after a login");

      // The idle core's breathing is a keyframes rule. This page is served
      // under the core's own policy, which refuses an inline <style>, so the
      // rule has to arrive in the bundled stylesheet.
      assert.ok(
        await page.evaluate(() =>
          [...document.styleSheets].some((sheet) =>
            [...sheet.cssRules].some((rule) => rule.name === "noctis-core-breathe"),
          ),
        ),
        "the core's breathing keyframes never loaded under the core's CSP",
      );

      // A pasted screenshot previews from a blob: URL, which the policy has to
      // allow for the thumbnail to be anything but a blank square.
      const box = page.getByRole("textbox", { name: "Message Vesper" });

      await box.evaluate((textarea) => {
        const png = Uint8Array.from(
          globalThis.atob(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
          ),
          (character) => character.charCodeAt(0),
        );
        const clipboard = new globalThis.DataTransfer();

        clipboard.items.add(new globalThis.File([png], "image.png", { type: "image/png" }));
        textarea.dispatchEvent(
          new globalThis.ClipboardEvent("paste", {
            clipboardData: clipboard,
            bubbles: true,
            cancelable: true,
          }),
        );
      });

      const thumbnail = page.getByRole("list", { name: "Attached files" }).locator("img");

      await thumbnail.waitFor();
      await page.waitForFunction(
        () => document.querySelector('ul[aria-label="Attached files"] img')?.naturalWidth > 0,
        undefined,
        { timeout: 5000 },
      );

      await page.getByRole("button", { name: /^Preview screenshot-/ }).click();
      await page.waitForFunction(
        () => document.querySelector("dialog[open] img")?.naturalWidth > 0,
        undefined,
        { timeout: 5000 },
      );
      await page
        .getByRole("dialog", { name: /^screenshot-/ })
        .getByRole("button", { name: "Close", exact: true })
        .click();

      // 4. The credential is a cookie script cannot touch. This is the whole
      //    argument for the session realm: an XSS that reads every variable in
      //    the page still cannot exfiltrate anything a browser would present.
      const cookie = await sessionCookie();

      assert.ok(cookie !== undefined, "logging in set no session cookie");
      assert.equal(cookie.httpOnly, true, "the session cookie is readable by script");
      assert.equal(cookie.sameSite, "Strict");
      assert.ok(
        !workbench.scriptVisibleCookies.includes("noctis_session"),
        `document.cookie exposed the session: ${workbench.scriptVisibleCookies}`,
      );

      // 5. A live event, committed by a separate bearer-authenticated client,
      //    reaching this page over SSE. The browser attaches the cookie to the
      //    `EventSource` on its own — nothing in the page can, because
      //    `EventSource` takes no headers.
      // Loading the page was a visit to Presence, which may have moved the
      // seeded chat onto the list; it is carried on from there either way.
      await tabTo(page, "Threads");
      await page.keyboard.press("Enter");

      const listed = (await coreRead(CORE_URL, "/conversations?identityId=vesper")).body;
      const seededChat = listed.conversations.find((c) => c.id === seededThreadId);
      const seededLabel =
        seededChat.kind === "free"
          ? "Current chat"
          : seededChat.preview?.split("\n")[0]?.trim() || "New conversation";

      await page
        .getByRole("region", { name: "Conversations" })
        .getByRole("button", { name: seededLabel, exact: true })
        .click();

      const history = await waitFor(
        readPage,
        (state) => state.heading === "Threads" && state.messages.length >= 1,
        "Chat never loaded the seeded thread",
      );

      assert.ok(history.messages[0].includes(SEEDED), history.messages[0]);

      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      );
      const uploaded = await fetch(`${CORE_URL}/attachments`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "image/png",
          "x-noctis-filename": "sent-shot.png",
        },
        body: png,
      });
      assert.equal(uploaded.status, 200);
      const sentShot = await uploaded.json();

      const live = await seed("conversation.send", {
        idempotencyKey: "e2e-tokenless-live",
        identityId: "vesper",
        threadId: seededThreadId,
        text: LIVE,
        model: MODEL,
        attachmentIds: [sentShot.id],
      });

      assert.equal(live.status, 200, JSON.stringify(live.body));

      // No reload anywhere below this line: if the stream is not working, this
      // is where the suite stops.
      const streamed = await waitFor(
        readPage,
        (state) => state.messages.some((message) => message.includes(LIVE)),
        "an event committed by another client never arrived over SSE",
        30_000,
      );

      assert.equal(streamed.messages.length, 2);

      // The screenshot sent with it shows under the message, loaded through the cookie.
      await page.waitForFunction(
        () =>
          document.querySelector(
            '[data-entry="message"][data-role="user"] img[alt="sent-shot.png"]',
          )?.naturalWidth > 0,
        undefined,
        { timeout: 10_000 },
      );

      // 6. And a mutation in the other direction: a command the page sends,
      //    authenticated by the cookie and the CSRF header, from a real
      //    browser at a real origin.
      const requested = await seed("authority.request", {
        idempotencyKey: "e2e-tokenless-approval",
        actorId: "vesper",
        operationClass: "external_write",
        capability: "shell.run",
        target: { type: "command", id: "curl" },
        consequenceSummary: "Post to an external hook",
        reversibility: "irreversible",
      });

      assert.equal(requested.status, 200, JSON.stringify(requested.body));
      assert.equal(requested.body.outcome, "require_confirmation");

      await tabTo(page, "Approvals");
      await page.keyboard.press("Enter");
      await waitFor(
        readPage,
        (state) => state.heading === "Approvals" && state.approvals.length === 1,
        "the seeded approval never reached the page",
      );

      await tabTo(page, "Confirm");
      await page.keyboard.press("Enter");

      const confirmed = await waitFor(
        readPage,
        (state) => state.approvals.some((approval) => approval.includes("Confirmed at")),
        "the page's confirm command did not take effect",
      );

      assert.ok(
        !confirmed.body.includes("csrf_required") && !confirmed.body.includes("unauthorized"),
        "the page's command was refused by the credential gate",
      );

      // And the core agrees, not just the page: read it back through the other
      // realm, so the assertion does not rest on what the page rendered.
      const stored = await coreRead(CORE_URL, `/approvals/${requested.body.requestId}`);

      assert.equal(stored.status, 200, JSON.stringify(stored.body));
      assert.ok(
        stored.body.confirmedAt !== undefined,
        `the core has no record of the page's confirmation: ${JSON.stringify(stored.body)}`,
      );
    },
  );

  it(
    "THE GATE: a reload keeps the session, and signing out ends it",
    { timeout: 120_000 },
    async () => {
      const before = await sessionCookie();

      assert.ok(before !== undefined, "the suite reached the reload with no session");

      // The one thing the suite above deliberately never did. Every path that
      // matters on a phone is this document load: pull-to-refresh, iOS Safari
      // evicting a backgrounded tab, a Home Screen cold start — which is the
      // only context in which iOS delivers a push at all — and the service
      // worker's `client.navigate("/")` when a notification is tapped. All of
      // them destroy the in-memory CSRF value while the cookie survives.
      await page.reload();

      const resumed = await waitFor(
        readPage,
        (state) => state.hasNav,
        "a reload sent a page with a live session back to the token prompt",
      );

      assert.ok(!resumed.hasTokenField, "the login screen came back after a reload");

      // Resumed, not logged in again: the browser is still holding the cookie
      // the first login set, and no second one was issued.
      const after = await sessionCookie();

      assert.equal(after?.value, before.value, "the reload minted a new session");

      // And the way off this browser, which until now no screen offered at all.
      await tabTo(page, "Settings");
      await page.keyboard.press("Enter");
      await waitFor(readPage, (state) => state.heading === "Settings", "Settings never opened");

      await tabTo(page, "Sign out");
      await page.keyboard.press("Enter");

      const out = await waitFor(
        readPage,
        (state) => state.hasTokenField,
        "signing out did not return the page to the login screen",
      );

      assert.ok(!out.hasNav, "the workbench is still showing after a sign-out");
      assert.equal(await sessionCookie(), undefined, "signing out left the session cookie behind");

      // And the core agrees the session is gone, so a reload cannot resume it.
      await page.reload();
      await waitFor(
        readPage,
        (state) => state.hasTokenField,
        "a signed-out browser resumed a session the core should have deleted",
      );
    },
  );

  it("serves the built dist layout, and nothing outside it", { timeout: 60_000 }, async () => {
    const indexResponse = await fetch(CORE_URL);

    assert.equal(indexResponse.status, 200);
    assert.equal(indexResponse.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(indexResponse.headers.get("x-content-type-options"), "nosniff");
    assert.equal(indexResponse.headers.get("cache-control"), "no-cache");
    assert.match(indexResponse.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(indexResponse.headers.get("x-frame-options"), "DENY");
    assert.equal(indexResponse.headers.get("referrer-policy"), "no-referrer");

    // The hashed bundle, by the name the served index.html actually references.
    const html = await indexResponse.text();
    const asset = /\/assets\/[A-Za-z0-9._-]+\.js/.exec(html)?.[0];

    assert.ok(asset !== undefined, `index.html references no hashed script: ${html}`);

    const assetResponse = await fetch(`${CORE_URL}${asset}`);

    assert.equal(assetResponse.status, 200);
    assert.equal(assetResponse.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(assetResponse.headers.get("cache-control"), "public, max-age=31536000, immutable");

    // The guard in `vite.config.ts`, proven rather than trusted: the bytes the
    // core serves unauthenticated must not contain the core token.
    const bundles = readdirSync(join(DIST, "assets"))
      .filter((name) => name.endsWith(".js"))
      .map((name) => readFileSync(join(DIST, "assets", name), "utf8"));

    for (const bundle of bundles) {
      assert.ok(!bundle.includes(TOKEN), "a served bundle carries the core token");
    }

    // A client route falls back to the shell; a missing file does not, because
    // answering a script request with HTML breaks module loading as a syntax
    // error in nobody's source.
    assert.equal((await fetch(`${CORE_URL}/somewhere-the-app-routes`)).status, 200);

    // But only outside `API_SEGMENTS`. `/missions` is an API collection, so it
    // is claimed by the credential gate and answers 401 rather than the shell.
    // Harmless today — the app has no client-side router and every URL but
    // `/` is unused — and a trap the day one is added, because four of the
    // eight rail destinations (Missions, Artifacts, Vault, Nodes) share a name
    // with a top-level collection. Recorded in `static.ts` beside the list.
    assert.equal((await fetch(`${CORE_URL}/missions`)).status, 401);
    assert.equal((await fetch(`${CORE_URL}/assets/not-here.js`)).status, 404);

    // Escaped, not spelled: `fetch` normalises a literal `/../` away before the
    // request leaves, so only the encoded form actually asks the core to
    // resolve a traversal. (The exhaustive cases live in `static.test.ts`.)
    assert.equal((await fetch(`${CORE_URL}/%2e%2e%2fpackage.json`)).status, 404);

    // The service worker, at the web root and unauthenticated like the rest of
    // the shell. Scope is the whole point: a worker served from a subdirectory
    // cannot control the pages above it, so a push would reach nothing. Served
    // as a script, and revalidated rather than cached forever — a stale worker
    // outlives every deploy.
    const worker = await fetch(`${CORE_URL}/sw.js`);

    assert.equal(worker.status, 200);
    assert.equal(worker.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(worker.headers.get("cache-control"), "no-cache");
    assert.ok((await worker.text()).includes(`addEventListener("push"`));

    // The manifest, without which iOS's Add to Home Screen produces a bookmark
    // rather than an installed app — and an installed app is the only context
    // in which iOS delivers a web push at all. `.webmanifest` was already in
    // the content-type allowlist, serving a file that did not exist, while the
    // Settings card told the owner to add Noctis to the Home Screen.
    const manifest = await fetch(`${CORE_URL}/manifest.webmanifest`);

    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get("content-type"), "application/manifest+json");

    const declared = JSON.parse(await manifest.text());

    assert.equal(declared.display, "standalone");
    assert.equal(declared.start_url, "/");
    assert.ok(declared.icons.length > 0, "the manifest declares no icon");
    assert.ok(html.includes('rel="manifest"'), `index.html links no manifest: ${html}`);
    assert.ok(html.includes("apple-mobile-web-app-capable"), "index.html has no Apple meta tags");
    assert.equal((await fetch(`${CORE_URL}${declared.icons[0].src}`)).status, 200);

    // And the push paths are the API's, not static's: without `push` in
    // `API_SEGMENTS` this would answer 200 with the app shell, and the page
    // would parse HTML looking for a VAPID key.
    assert.equal((await fetch(`${CORE_URL}/push/key`)).status, 401);

    // Static must not have swallowed the API: these still answer as routes,
    // and still require a credential.
    assert.equal((await fetch(`${CORE_URL}/objectives`)).status, 401);
  });
});

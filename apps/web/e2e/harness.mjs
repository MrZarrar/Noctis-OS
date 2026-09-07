import { spawn } from "node:child_process";

/**
 * Shared E2E plumbing: starting the core and the dev server, waiting for them,
 * and the Tab-key assertion. Extracted when the Vault suite needed the same
 * four helpers the workbench suite already had — two copies of a process
 * teardown that is this fiddly on Windows is one copy too many.
 */

export const TOKEN = "0123456789abcdef0123456789abcdef";

/**
 * Bundled Chromium by default, which is what CI installs and therefore what the
 * gate is actually proven against. `NOCTIS_E2E_BROWSER_CHANNEL` selects an
 * already-installed browser instead (`msedge`, `chrome`) for a machine that
 * cannot reach Playwright's download host — an explicit opt-in, never a silent
 * fallback, so a run always says which browser it used.
 */
export const CHANNEL = process.env.NOCTIS_E2E_BROWSER_CHANNEL;

export function launchOptions() {
  return CHANNEL === undefined ? {} : { channel: CHANNEL };
}

/**
 * Spawns a server without a shell.
 *
 * `shell: true` on Windows makes the direct child `cmd.exe`, so `kill()` stops
 * the shell and leaves the real server running — which keeps its stdio pipes
 * attached and stops the test process from ever exiting. Spawning the binary
 * directly means the handle we hold is the process we need to stop.
 *
 * The output listeners also matter: an unread pipe fills and blocks the child
 * once it has written enough, and the tail is what a startup failure gets to
 * report instead of a bare timeout.
 */
export function startProcess(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];

  const record = (chunk) => {
    output.push(chunk.toString());

    if (output.length > 40) {
      output.shift();
    }
  };

  child.stdout.on("data", record);
  child.stderr.on("data", record);
  child.output = output;

  return child;
}

export function stopProcess(child) {
  if (child === undefined || child.exitCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolveExit) => {
    child.once("exit", resolveExit);
    child.kill();
    setTimeout(() => {
      child.kill("SIGKILL");
      resolveExit();
    }, 5_000).unref();
  });
}

export async function waitForHttp(url, label, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const response = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });

      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }

    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${label} at ${url}; it last said: ${child.output.join("")}`,
      );
    }

    await new Promise((resolveTimer) => setTimeout(resolveTimer, 150));
  }
}

/**
 * Presses Tab until the focused element is the named control, and fails if it
 * never is.
 *
 * This is the assertion, not a way of reaching the element: a control that
 * cannot be reached by Tab fails the gate here rather than being clicked into
 * focus and silently passing.
 */
export async function tabTo(page, label, limit = 40) {
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press("Tab");

    const focused = await page.evaluate(() => {
      const active = document.activeElement;

      if (active === null) {
        return "";
      }

      // The accessible name, in the order a screen reader would resolve it.
      // `labels` covers a wrapping `<label>` as well as a `for`/`id` pair, which
      // is how a form field with no `aria-label` is named.
      const aria = active.getAttribute("aria-label");

      if (aria !== null && aria !== "") {
        return aria;
      }

      const labelled = active.labels?.[0]?.textContent?.trim();

      return labelled !== undefined && labelled !== ""
        ? labelled
        : (active.textContent?.trim() ?? "");
    });

    if (focused === label) {
      return;
    }
  }

  throw new Error(`"${label}" is not reachable with the Tab key`);
}

/**
 * Polls from Node rather than inside the page, so the predicate stays an
 * ordinary closure and a failure can report the state it actually saw.
 */
export async function waitFor(read, predicate, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const state = await read();

    if (predicate(state)) {
      return state;
    }

    if (Date.now() > deadline) {
      throw new Error(`${label}; the page was ${JSON.stringify(state)}`);
    }

    await new Promise((resolveTimer) => setTimeout(resolveTimer, 100));
  }
}

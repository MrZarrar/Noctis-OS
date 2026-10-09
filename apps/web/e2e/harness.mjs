import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Shared E2E plumbing: starting the core and the dev server, waiting for them,
 * the Tab-key assertion, and the paired fake node. Extracted when the Vault
 * suite needed the same four helpers the workbench suite already had — two
 * copies of a process teardown that is this fiddly on Windows is one copy too
 * many, and the same went for the node pairing once the phone suite needed a
 * node that answers.
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

/** Runs a one-shot command to completion and returns what it printed. */
export function runOnce(command, args, options) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";

    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolveRun(output);
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited ${String(code)}: ${output}`));
      }
    });
  });
}

/** A bearer-authenticated command against a core, for seeding a suite's fixtures. */
export async function coreCommand(coreUrl, name, body) {
  const response = await fetch(`${coreUrl}/commands/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return { status: response.status, body: await response.json() };
}

/** A bearer-authenticated read, the mirror of `coreCommand`. */
export async function coreRead(coreUrl, path) {
  const response = await fetch(`${coreUrl}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });

  return { status: response.status, body: await response.json() };
}

/**
 * Pairs a node the way an operator does — code from the core, `pair` on the
 * agent's CLI — then grants it the runtime with one writable root and starts it
 * with the scripted runtime behind the codex slot.
 *
 * Shared rather than copied: two suites now need a node that answers, and the
 * hello/probe assertion below is the one that caught `main.js` sending the
 * machine's real providers instead of the fake probe.
 */
export async function startFakeNode({
  coreUrl,
  repoRoot,
  agentMain,
  nodeHome,
  scratch,
  keyPrefix,
  env = {},
}) {
  const issued = await coreCommand(coreUrl, "node.issue_pairing_code", {
    idempotencyKey: `${keyPrefix}-pairing`,
    hostId: "e2e",
  });

  assert.equal(issued.status, 200, JSON.stringify(issued.body));

  const agentEnv = { ...process.env, ...env, NOCTIS_NODE_HOME: nodeHome, NOCTIS_RUNTIME: "fake" };

  await runOnce(
    process.execPath,
    [agentMain, "pair", "--core", coreUrl, "--code", issued.body.code, "--host", "e2e"],
    { cwd: repoRoot, env: agentEnv },
  );

  const credential = JSON.parse(readFileSync(join(nodeHome, "node.json"), "utf8"));

  const granted = await coreCommand(coreUrl, "node.grant_capability", {
    idempotencyKey: `${keyPrefix}-grant`,
    nodeId: credential.nodeId,
    capability: "runtime.turn",
    constraints: {
      providers: ["codex"],
      roots: [{ grantId: "scratch", path: scratch, mode: "write" }],
    },
  });

  assert.equal(granted.status, 200, JSON.stringify(granted.body));

  const agent = startProcess(process.execPath, [agentMain], { cwd: repoRoot, env: agentEnv });

  const online = await waitFor(
    () => coreRead(coreUrl, `/nodes/${credential.nodeId}`),
    (node) => node.status === 200 && node.body.status === "online" && node.body.connected,
    `the fake node never came online; it last said: ${agent.output.join("")}`,
    30_000,
  );

  // The router only sends a turn to a node whose `hello` offered the model
  // (ADR-0023), so the fake runtime's probe has to have travelled with it.
  const codex = online.body.providers.find((probe) => probe.providerId === "codex");

  assert.ok(
    codex?.available === true && codex.models.some((model) => model.model === "fake-model"),
    `the node agent did not report the fake runtime's probe in hello; with NOCTIS_RUNTIME=fake ` +
      `main.js must send FAKE_PROBE, not the machine's installed providers. It reported: ` +
      JSON.stringify(online.body.providers),
  );

  // 0.3: the default is Settings data. Set through the API here; the Settings
  // control that writes it is the same command.
  const defaulted = await coreCommand(coreUrl, "identity.set_default_model", {
    idempotencyKey: `${keyPrefix}-default-model`,
    identityId: "vesper",
    model: { providerId: "codex", model: "fake-model" },
  });

  assert.equal(defaulted.status, 200, JSON.stringify(defaulted.body));

  return { agent, nodeId: credential.nodeId };
}

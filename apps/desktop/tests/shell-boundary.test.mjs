import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function read(relativePath) {
  return readFileSync(resolve(here, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

/**
 * The Phase 4 gate says the WebView cannot invoke ungranted plugins. In Tauri 2
 * that is decided by this file and nothing else, so this is the gate: an
 * exact list, not a "does not contain" check that a new grant would slip past.
 */
test("the WebView is granted exactly two permissions", () => {
  const capability = readJson("../src-tauri/capabilities/main.json");

  assert.deepEqual(capability.permissions, ["core:default", "notification:default"]);
  assert.deepEqual(capability.windows, ["main"]);
});

test("no filesystem, shell, http, or process plugin is reachable from the page", () => {
  const capability = readJson("../src-tauri/capabilities/main.json");
  const forbidden = ["fs:", "shell:", "http:", "process:", "dialog:", "opener:", "updater:"];

  for (const permission of capability.permissions) {
    for (const prefix of forbidden) {
      assert.ok(
        !permission.startsWith(prefix),
        `${permission} would give the WebView ${prefix} access`,
      );
    }
  }
});

test("the shell is Noctis-only and shares no identity with the donor", () => {
  const config = readJson("../src-tauri/tauri.conf.json");
  const manifest = read("../src-tauri/Cargo.toml");

  assert.equal(config.identifier, "uk.co.noctis.os");
  assert.equal(config.productName, "Noctis OS");
  assert.deepEqual(config.plugins["deep-link"].desktop.schemes, ["noctis"]);
  assert.ok(!/jarvis/i.test(JSON.stringify(config)));
  assert.ok(!/jarvis/i.test(manifest));
});

test("the canary neither installs nor autostarts", () => {
  const config = readJson("../src-tauri/tauri.conf.json");
  const manifest = read("../src-tauri/Cargo.toml");

  assert.equal(config.bundle.active, false);
  // Autostart is a production capability and stays unbuilt until it is asked
  // for explicitly; the plugin is not a dependency at all.
  assert.ok(!manifest.includes("tauri-plugin-autostart"));
});

test("a content security policy is set and does not open the page to the network", () => {
  const { csp } = readJson("../src-tauri/tauri.conf.json").app.security;

  assert.ok(csp.startsWith("default-src 'self'"));
  assert.ok(!csp.includes("unsafe-inline"));
  assert.ok(!csp.includes("unsafe-eval"));
  // The page reaches the core through Rust, so its own connect-src needs
  // nothing beyond the IPC endpoints.
  assert.ok(!/connect-src[^;]*https?:\/\/(?!ipc\.localhost)/.test(csp));
});

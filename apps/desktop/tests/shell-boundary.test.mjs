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

/** `{ directive: [sources] }`, so each widening is asserted exactly rather than by substring. */
function directives(csp) {
  return Object.fromEntries(
    csp
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter(([name]) => name !== "")
      .map(([name, ...sources]) => [name, sources]),
  );
}

test("a content security policy is set and opens the page only as far as the remote desktop needs", () => {
  const { csp, dangerousDisableAssetCspModification } = readJson("../src-tauri/tauri.conf.json").app
    .security;
  const policy = directives(csp);

  assert.ok(csp.startsWith("default-src 'self'"));
  assert.deepEqual(policy["default-src"], ["'self'"]);
  // WASM compilation, and nothing that evaluates a string: 'unsafe-eval' stays out.
  assert.deepEqual(policy["script-src"], ["'self'", "'wasm-unsafe-eval'"]);
  assert.ok(!/(^|[\s;])'unsafe-eval'/.test(csp));
  // The IronRDP element injects a <style> and sets style attributes at runtime
  // (remote-access.md §9.1). Inline style is allowed; inline script never is.
  assert.deepEqual(policy["style-src"], ["'self'", "'unsafe-inline'"]);
  assert.equal(csp.split("'unsafe-inline'").length - 1, 1);
  // A nonce Tauri added to style-src would silently cancel 'unsafe-inline'.
  assert.deepEqual(dangerousDisableAssetCspModification, ["style-src"]);
  // The page reaches the core through Rust. Beyond IPC it may fetch the
  // component's inlined data: WASM and open one socket: the Gateway, over TLS.
  assert.deepEqual(policy["connect-src"], [
    "'self'",
    "ipc:",
    "http://ipc.localhost",
    "data:",
    "wss://zarrarpc.tail9594ed.ts.net",
  ]);
  assert.equal(policy["frame-src"], undefined);
});

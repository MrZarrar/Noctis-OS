import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(testDirectory, "../src-tauri/Cargo.toml");

test("the pinned desktop Rust crate compiles", () => {
  const result = spawnSync(
    process.platform === "win32" ? "cargo.exe" : "cargo",
    ["check", "--manifest-path", manifestPath, "--locked"],
    { encoding: "utf8" },
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.trim());
});

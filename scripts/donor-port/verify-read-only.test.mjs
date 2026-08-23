import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as boundary from "./verify-read-only.mjs";

const donor = "C:\\Users\\mmush\\Documents\\Jarvis\\Jarvis-Sub-Agent-Dashboard";

test("rejects using the donor repository as the Noctis target", () => {
  assert.throws(
    () => boundary.assertSafeRepositoryBoundary?.(donor, donor),
    /Noctis target must be a sibling of the donor/,
  );
});

test("rejects creating Noctis inside the donor repository", () => {
  assert.throws(
    () => boundary.assertSafeRepositoryBoundary?.(`${donor}\\Noctis-OS`, donor),
    /Noctis target must be a sibling of the donor/,
  );
});

test("accepts a Noctis repository beside the donor", () => {
  const target = "C:\\Users\\mmush\\Documents\\Jarvis\\Noctis-OS";

  assert.deepEqual(boundary.assertSafeRepositoryBoundary?.(target, donor), {
    target,
    donor,
  });
});

test("rejects a target that is outside the donor parent directory", () => {
  const target = "C:\\Users\\mmush\\Documents\\Noctis-OS";

  assert.throws(
    () => boundary.assertSafeRepositoryBoundary?.(target, donor),
    /same parent directory/,
  );
});

test("treats Windows paths as case insensitive", () => {
  assert.throws(
    () =>
      boundary.assertSafeRepositoryBoundary?.(
        "c:\\users\\MMUSH\\documents\\jarvis\\jarvis-sub-agent-dashboard\\Noctis-OS",
        donor,
      ),
    /Noctis target must be a sibling of the donor/,
  );
});

test("captures donor HEAD, branch, and dirty status without changing it", (t) => {
  const repository = mkdtempSync(path.join(os.tmpdir(), "noctis-donor-test-"));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();

  git("init", "-b", "main");
  git("config", "user.name", "Noctis Test");
  git("config", "user.email", "noctis@example.invalid");
  git("config", "core.autocrlf", "false");
  writeFileSync(path.join(repository, "tracked.txt"), "tracked\n");
  git("add", "tracked.txt");
  git("commit", "-m", "test fixture");
  writeFileSync(path.join(repository, "untracked.txt"), "leave me alone\n");

  const beforeStatus = git("status", "--short");
  const snapshot = boundary.captureGitSnapshot?.(repository);
  const afterStatus = git("status", "--short");

  assert.match(snapshot?.head ?? "", /^[0-9a-f]{40}$/);
  assert.equal(snapshot?.branch, "main");
  assert.equal(snapshot?.status, "?? untracked.txt");
  assert.equal(afterStatus, beforeStatus);
});

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const deploy = join(here, "work-pc.ps1");
const keygen = join(here, "gateway-key.mjs");
const startHidden = join(here, "start-hidden.ps1");

function runDeploy(...args) {
  return spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", deploy, ...args],
    { encoding: "utf8" },
  );
}

function gitRepo() {
  const root = mkdtempSync(join(tmpdir(), "noctis-deploy-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });

  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");

  return root;
}

test("refuses to deploy anywhere but the work PC", () => {
  const result = runDeploy("-DryRun");

  assert.notEqual(
    hostname().toLowerCase(),
    "mushafzarrar",
    "this test must not run on the work PC",
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr + result.stdout, /mushafzarrar/);
});

test("refuses a working tree with changes in it, rather than building them", () => {
  const root = gitRepo();
  writeFileSync(join(root, "stray.txt"), "uncommitted");

  const result = runDeploy("-ExpectedHost", hostname(), "-RepoRoot", root, "-DryRun");

  assert.equal(result.status, 1);
  assert.match(result.stderr + result.stdout, /uncommitted changes/);
});

test("plans pull, stop, install, build, page, start and health check, in that order", () => {
  const result = runDeploy("-ExpectedHost", hostname(), "-RepoRoot", gitRepo(), "-DryRun");

  assert.equal(result.status, 0, result.stderr);

  const steps = [
    "git pull --ff-only",
    "stop the running core and node",
    "npm ci",
    "npm run build",
    "npm run build:web",
    "start the core",
    "/health",
    "start the node",
  ];
  const positions = steps.map((step) => result.stdout.indexOf(step));

  assert.ok(
    positions.every((position) => position >= 0),
    `missing a step:\n${result.stdout}`,
  );
  assert.deepEqual(
    [...positions].sort((a, b) => a - b),
    positions,
    `steps out of order:\n${result.stdout}`,
  );
  assert.match(result.stdout, /dry run: nothing was changed/);
});

test("at logon it only starts what is already built, even with work in progress", () => {
  const root = gitRepo();
  writeFileSync(join(root, "stray.txt"), "uncommitted");

  const result = runDeploy("-ExpectedHost", hostname(), "-RepoRoot", root, "-StartOnly", "-DryRun");

  assert.equal(result.status, 0, result.stderr);
  for (const step of [
    "stop the running core and node",
    "start the core",
    "/health",
    "start the node",
  ]) {
    assert.ok(result.stdout.includes(step), `missing ${step}:\n${result.stdout}`);
  }
  for (const step of ["git pull", "npm ci", "npm run build"]) {
    assert.ok(!result.stdout.includes(step), `should not ${step}:\n${result.stdout}`);
  }
});

test("the Gateway key pair is RSA-2048, and the private half is never overwritten", () => {
  const directory = mkdtempSync(join(tmpdir(), "noctis-gwkey-"));
  const first = spawnSync(process.execPath, [keygen, directory], { encoding: "utf8" });

  assert.equal(first.status, 0, first.stderr);

  const privatePem = readFileSync(join(directory, "gateway-provisioner.key"), "utf8");
  const publicPem = readFileSync(join(directory, "gateway-provisioner.pem"), "utf8");
  const key = createPrivateKey(privatePem);

  assert.equal(key.asymmetricKeyDetails?.modulusLength, 2048);
  assert.equal(createPublicKey(key).export({ type: "spki", format: "pem" }).toString(), publicPem);
  // The public half is printed for pasting into the Gateway; the private half never is.
  assert.ok(first.stdout.includes(publicPem.trim()));
  assert.ok(!first.stdout.includes(privatePem.split("\n")[1]));

  const second = spawnSync(process.execPath, [keygen, directory], { encoding: "utf8" });

  assert.equal(second.status, 1);
  assert.equal(readFileSync(join(directory, "gateway-provisioner.key"), "utf8"), privatePem);
});

test("a process it starts does not hold the caller's output open, so the caller can finish", () => {
  const directory = mkdtempSync(join(tmpdir(), "noctis-hidden-"));
  const script = [
    `. '${startHidden}'`,
    `$started = Start-Hidden -File '${process.execPath}' -Arguments @('-e', 'setTimeout(()=>{},20000)') -WorkingDirectory '${directory}' -Out '${join(directory, "out.log")}' -Err '${join(directory, "err.log")}'`,
    'Write-Output "started $($started.Id)"',
  ].join("; ");
  const begun = Date.now();
  // Piped, as a tool or CI runs it: an inherited pipe kept this open until the child exited.
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", timeout: 15_000 },
  );
  const pid = Number(/started (\d+)/.exec(result.stdout)?.[1]);

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Date.now() - begun < 10_000, "the caller waited for the child");
    assert.ok(process.kill(pid, 0), "the child is still running");
  } finally {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"]);
  }
});

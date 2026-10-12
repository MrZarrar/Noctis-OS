import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CapabilityGrant } from "@noctis/contracts";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { AdapterRefused } from "./Runtime.js";
import { resolveRoots } from "./roots.js";

const scratches: string[] = [];

afterEach(() => {
  while (scratches.length > 0) {
    const directory = scratches.pop();

    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "noctis-roots-"));

  scratches.push(directory);

  return directory;
}

function turnGrant(roots: unknown[], overrides: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return {
    id: "0199a000-0000-7000-8000-00000000000a",
    nodeId: "0199a000-0000-7000-8000-00000000000b",
    capability: "runtime.turn",
    operationClass: "read_inspect",
    constraintsVersion: 1,
    constraints: { providers: ["codex"], roots },
    grantedAt: "2026-09-01T12:00:00.000Z",
    ...overrides,
  };
}

/** `mklink /J` needs no privilege on Windows; anywhere else there is no junction to test. */
function junction(link: string, target: string): boolean {
  if (process.platform !== "win32") {
    return false;
  }

  return spawnSync("cmd.exe", ["/d", "/c", "mklink", "/J", link, target]).status === 0;
}

describe("resolveRoots", () => {
  it("splits granted roots by mode, with the primary as cwd, all as real paths", async () => {
    const base = scratch();
    const write = join(base, "write");
    const read = join(base, "read");

    mkdirSync(write);
    mkdirSync(read);

    const roots = await resolveRoots(
      [
        turnGrant([
          { grantId: "w", path: write, mode: "write" },
          { grantId: "r", path: read, mode: "read", localOnly: true },
        ]),
      ],
      "w",
    );

    expect(roots).toEqual({
      cwd: realpathSync.native(write),
      writable: [realpathSync.native(write)],
      readable: [realpathSync.native(read)],
      localOnly: true,
    });
  });

  it("reports localOnly false when no root asks for it", async () => {
    const base = scratch();

    const roots = await resolveRoots(
      [turnGrant([{ grantId: "w", path: base, mode: "write" }])],
      "w",
    );

    expect(roots.localOnly).toBe(false);
  });

  it("refuses a primary the grant does not name", async () => {
    const base = scratch();

    await expect(
      resolveRoots([turnGrant([{ grantId: "w", path: base, mode: "write" }])], "elsewhere"),
    ).rejects.toBeInstanceOf(AdapterRefused);
  });

  it("ignores revoked grants and grants for other capabilities", async () => {
    const base = scratch();
    const root = [{ grantId: "w", path: base, mode: "write" }];

    await expect(
      resolveRoots(
        [
          turnGrant(root, { revokedAt: "2026-09-01T12:00:00.000Z" }),
          turnGrant(root, { capability: "file.search" }),
        ],
        "w",
      ),
    ).rejects.toBeInstanceOf(AdapterRefused);
  });

  it("refuses a granted root that is not on this machine", async () => {
    await expect(
      resolveRoots(
        [turnGrant([{ grantId: "w", path: join(scratch(), "missing"), mode: "write" }])],
        "w",
      ),
    ).rejects.toBeInstanceOf(AdapterRefused);
  });

  it("leaves out another granted root that is missing, so one mistyped folder stops no other turn", async () => {
    const write = join(scratch(), "write");

    mkdirSync(write);

    const roots = await resolveRoots(
      [
        turnGrant([{ grantId: "w", path: write, mode: "write" }]),
        turnGrant([{ grantId: "typo", path: join(scratch(), "missing"), mode: "write" }]),
      ],
      "w",
    );

    expect(roots.writable).toEqual([realpathSync.native(write)]);
  });

  it("uses paths a runtime can be told to rely on: no trailing separator, no relative segments", async () => {
    const base = scratch();
    const nested = join(base, "nested");

    mkdirSync(nested);

    const roots = await resolveRoots(
      [turnGrant([{ grantId: "w", path: `${join(nested, "..", "nested")}${"/"}`, mode: "write" }])],
      "w",
    );

    expect(roots.cwd).toBe(realpathSync.native(nested));
  });

  // Built at collection time so skipIf can see it; cleaned in afterAll, not
  // afterEach, or the first test's teardown would remove it before it runs.
  const junctionBase = mkdtempSync(join(tmpdir(), "noctis-junction-"));
  const target = join(junctionBase, "target");
  const link = join(junctionBase, "link");

  mkdirSync(target);

  afterAll(() => {
    rmSync(junctionBase, { recursive: true, force: true });
  });

  it.skipIf(!junction(link, target))(
    "resolves a junction to the directory it points at",
    async () => {
      const roots = await resolveRoots(
        [turnGrant([{ grantId: "j", path: link, mode: "write" }])],
        "j",
      );

      // THE GATE: a grant over the junction is a grant over its target, and the
      // runtime is told the target, not the alias.
      expect(roots.cwd).toBe(realpathSync.native(target));
      expect(roots.cwd.toLowerCase()).not.toContain("link");
    },
  );
});

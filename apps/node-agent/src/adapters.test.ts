import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import type { CapabilityGrant, RuntimeAsk, RuntimeItem } from "@noctis/contracts";
import {
  EnvironmentInspectEvidenceSchema,
  FileSearchEvidenceSchema,
  RuntimeTurnEvidenceSchema,
  VerificationNoopEvidenceSchema,
} from "@noctis/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { AdapterContext } from "./adapters.js";
import { ADAPTERS, AdapterRefused, isInside } from "./adapters.js";
import { createFakeRuntime } from "./runtimes/fake.js";

const GRANT_ID = "root-a";

let scratch: string | undefined;

afterEach(() => {
  if (scratch !== undefined) {
    rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});

function fileSearchGrant(path: string, overrides: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return {
    id: "0199a000-0000-7000-8000-00000000000a",
    nodeId: "0199a000-0000-7000-8000-00000000000b",
    capability: "file.search",
    operationClass: "read_inspect",
    constraintsVersion: 1,
    constraints: { roots: [{ grantId: GRANT_ID, path }] },
    grantedAt: "2026-09-01T12:00:00.000Z",
    ...overrides,
  };
}

function context(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    grants: [],
    signal: new AbortController().signal,
    progress: () => undefined,
    stream: () => undefined,
    delta: () => undefined,
    ask: () => Promise.reject(new Error("no ask expected")),
    env: {},
    runtimes: {},
    fetchAttachment: () => Promise.reject(new Error("no attachment expected")),
    ...overrides,
  };
}

/**
 * A granted `root/` beside an ungranted `outside/`, with `root/escape` pointing
 * at the scratch directory that contains both — so the link leads not just out
 * of the root but back over it, which is the shape that makes a naive recursive
 * walk loop rather than merely over-report.
 */
function treeWithEscape(): { root: string; escapeKind: "symlink" | "junction" } {
  scratch = mkdtempSync(join(tmpdir(), "noctis-adapter-"));

  const root = join(scratch, "root");

  mkdirSync(root);
  mkdirSync(join(root, "nested"));
  mkdirSync(join(scratch, "outside"));
  writeFileSync(join(root, "report-one.txt"), "one");
  writeFileSync(join(root, "nested", "report-two.txt"), "two");
  writeFileSync(join(scratch, "outside", "report-secret.txt"), "secret");

  // Windows refuses file symlinks without Developer Mode but allows junctions,
  // so the test takes whichever the machine will give it. Both are reparse
  // points, and the adapter must decline to follow either.
  try {
    symlinkSync(scratch, join(root, "escape"), "dir");
    return { root, escapeKind: "symlink" };
  } catch {
    symlinkSync(scratch, join(root, "escape"), "junction");
    return { root, escapeKind: "junction" };
  }
}

describe("environment.inspect", () => {
  it("returns evidence matching the capability's schema", async () => {
    const evidence = await ADAPTERS["environment.inspect"]({}, context());

    expect(EnvironmentInspectEvidenceSchema.parse(evidence)).toMatchObject({
      platform: process.platform,
      nodeVersion: process.version,
    });
  });

  it("refuses a payload the capability does not describe", async () => {
    await expect(ADAPTERS["environment.inspect"]({ path: "C:\\" }, context())).rejects.toThrow();
  });
});

describe("verification.noop", () => {
  it("verifies", async () => {
    const evidence = await ADAPTERS["verification.noop"]({}, context());

    expect(VerificationNoopEvidenceSchema.parse(evidence)).toEqual({ verified: true });
  });

  it("refuses once the job has been cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      ADAPTERS["verification.noop"]({}, context({ signal: controller.signal })),
    ).rejects.toBeInstanceOf(AdapterRefused);
  });
});

describe("file.search", () => {
  it("finds files under the granted root, at any depth", async () => {
    const { root } = treeWithEscape();
    const evidence = FileSearchEvidenceSchema.parse(
      await ADAPTERS["file.search"](
        { rootGrantId: GRANT_ID, nameContains: "report", maxResults: 50 },
        context({ grants: [fileSearchGrant(root)] }),
      ),
    );

    expect(evidence.matches.map((match) => match.relativePath).sort()).toEqual([
      join("nested", "report-two.txt"),
      "report-one.txt",
    ]);
    expect(evidence.truncated).toBe(false);
  });

  /**
   * THE GATE: symlink escape. `report-secret.txt` is reachable through
   * `root/escape` and matches the search term, and it must not appear. The same
   * link points back over the root, so a walk that followed it would also never
   * finish — this asserts both.
   *
   * What closes it on a machine without file-symlink privileges is the walk
   * never queueing a reparse point, because lstat reports it as neither file nor
   * directory. The realpath containment guard is the one that matters for a
   * symlinked *file*, which Windows will not let this test create; it is covered
   * directly by the isInside cases below.
   */
  it("neither follows nor reports anything through a link out of the root", async () => {
    const { root, escapeKind } = treeWithEscape();
    const evidence = FileSearchEvidenceSchema.parse(
      await ADAPTERS["file.search"](
        { rootGrantId: GRANT_ID, nameContains: "report", maxResults: 500 },
        context({ grants: [fileSearchGrant(root)] }),
      ),
    );

    expect(["symlink", "junction"]).toContain(escapeKind);
    expect(evidence.matches.map((match) => match.relativePath)).not.toContain(
      join("escape", "outside", "report-secret.txt"),
    );
    expect(
      evidence.matches.some((match) => match.relativePath.includes("secret")),
      "a file outside the granted root was reported",
    ).toBe(false);
    // Nothing under the link at all, so the walk did not descend it either.
    expect(evidence.matches.some((match) => match.relativePath.startsWith("escape"))).toBe(false);
  });

  it("refuses a root grant id it was never given", async () => {
    const { root } = treeWithEscape();

    await expect(
      ADAPTERS["file.search"](
        { rootGrantId: "some-other-root", nameContains: "report", maxResults: 50 },
        context({ grants: [fileSearchGrant(root)] }),
      ),
    ).rejects.toBeInstanceOf(AdapterRefused);
  });

  it("refuses a revoked grant", async () => {
    const { root } = treeWithEscape();

    await expect(
      ADAPTERS["file.search"](
        { rootGrantId: GRANT_ID, nameContains: "report", maxResults: 50 },
        context({
          grants: [fileSearchGrant(root, { revokedAt: "2026-09-01T12:00:00.000Z" })],
        }),
      ),
    ).rejects.toBeInstanceOf(AdapterRefused);
  });

  it("refuses when it holds no file.search grant at all", async () => {
    const { root } = treeWithEscape();

    await expect(
      ADAPTERS["file.search"](
        { rootGrantId: GRANT_ID, nameContains: "report", maxResults: 50 },
        context({ grants: [fileSearchGrant(root, { capability: "environment.inspect" })] }),
      ),
    ).rejects.toBeInstanceOf(AdapterRefused);
  });

  it("caps the result count and says that it did", async () => {
    const { root } = treeWithEscape();
    const evidence = FileSearchEvidenceSchema.parse(
      await ADAPTERS["file.search"](
        { rootGrantId: GRANT_ID, nameContains: "report", maxResults: 1 },
        context({ grants: [fileSearchGrant(root)] }),
      ),
    );

    expect(evidence.matches).toHaveLength(1);
    expect(evidence.truncated).toBe(true);
  });

  it("stops when the job is cancelled", async () => {
    const { root } = treeWithEscape();
    const controller = new AbortController();
    controller.abort();

    await expect(
      ADAPTERS["file.search"](
        { rootGrantId: GRANT_ID, nameContains: "report", maxResults: 50 },
        context({ grants: [fileSearchGrant(root)], signal: controller.signal }),
      ),
    ).rejects.toBeInstanceOf(AdapterRefused);
  });

  it("rejects a payload that names no search term", async () => {
    const { root } = treeWithEscape();

    await expect(
      ADAPTERS["file.search"](
        { rootGrantId: GRANT_ID, nameContains: "" },
        context({ grants: [fileSearchGrant(root)] }),
      ),
    ).rejects.toThrow();
  });
});

describe("isInside", () => {
  const root = join(sep, "granted", "root");

  it("accepts the root itself and anything below it", () => {
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, join(root, "file.txt"))).toBe(true);
    expect(isInside(root, join(root, "deep", "file.txt"))).toBe(true);
  });

  it("rejects a sibling whose name merely starts the same way", () => {
    expect(isInside(root, `${root}-elsewhere`)).toBe(false);
  });

  it("rejects a parent and an unrelated path", () => {
    expect(isInside(root, join(sep, "granted"))).toBe(false);
    expect(isInside(root, join(sep, "somewhere", "else"))).toBe(false);
  });
});

describe("runtime.turn", () => {
  const PAYLOAD = {
    threadId: "0199a000-0000-7000-8000-0000000000e1",
    identityId: "vesper",
    model: { providerId: "codex", model: "fake-model" },
    userMessageId: "0199a000-0000-7000-8000-0000000000e2",
    prompt: "ASK: please",
    primaryRootGrantId: "w",
    objectiveActive: false,
  };

  function turnGrant(path: string): CapabilityGrant {
    return {
      id: "0199a000-0000-7000-8000-00000000000a",
      nodeId: "0199a000-0000-7000-8000-00000000000b",
      capability: "runtime.turn",
      operationClass: "read_inspect",
      constraintsVersion: 1,
      constraints: { providers: ["codex"], roots: [{ grantId: "w", path, mode: "write" }] },
      grantedAt: "2026-09-01T12:00:00.000Z",
    };
  }

  it("runs the fake runtime, forwarding items, deltas and the ask, and returns its evidence", async () => {
    const { root } = treeWithEscape();
    const items: RuntimeItem[] = [];
    const deltas: string[] = [];
    const asks: Array<Omit<RuntimeAsk, "askId">> = [];
    const fake = createFakeRuntime();
    let seenEnv: NodeJS.ProcessEnv | undefined;

    const evidence = await ADAPTERS["runtime.turn"](
      PAYLOAD,
      context({
        grants: [turnGrant(root)],
        runtimes: {
          codex: {
            ...fake,
            turn(input, sink) {
              seenEnv = input.env;
              return fake.turn(input, sink);
            },
          },
        },
        env: { PATH: "x", OPENAI_API_KEY: "sk-leak" },
        stream: (item) => items.push(item),
        delta: (_itemId, text) => deltas.push(text),
        ask: (ask) => {
          asks.push(ask);

          return Promise.resolve({
            askId: "0199a000-0000-7000-8000-0000000000a5",
            decision: "allow",
            approvalId: "0199a000-0000-7000-8000-0000000000a6",
          });
        },
      }),
    );

    expect(deltas).toEqual(["Hel", "lo"]);
    expect(items.map((item) => item.itemId)).toEqual(["m1", "c1", "c1"]);
    // The ask carries the real root as cwd: the runtime saw resolved roots.
    expect(asks[0]?.detail?.cwd).toBe(realpathSync.native(root));
    // THE GATE: the runtime's environment is the agent's minus the billing keys.
    expect(seenEnv).toEqual({ PATH: "x" });
    expect(RuntimeTurnEvidenceSchema.parse(evidence)).toMatchObject({
      itemCount: 3,
      stoppedReason: "completed",
    });
  });

  it("refuses when no runtime answers for the requested provider", async () => {
    const { root } = treeWithEscape();

    await expect(
      ADAPTERS["runtime.turn"](PAYLOAD, context({ grants: [turnGrant(root)] })),
    ).rejects.toThrow(/no runtime for codex/);
  });

  it("refuses a primary root the grant does not name, before touching a runtime", async () => {
    const { root } = treeWithEscape();

    await expect(
      ADAPTERS["runtime.turn"](
        { ...PAYLOAD, primaryRootGrantId: "elsewhere" },
        context({ grants: [turnGrant(root)], runtimes: { codex: createFakeRuntime() } }),
      ),
    ).rejects.toBeInstanceOf(AdapterRefused);
  });

  it("rejects a payload the capability does not describe", async () => {
    await expect(ADAPTERS["runtime.turn"]({ prompt: "hi" }, context())).rejects.toThrow();
  });
});

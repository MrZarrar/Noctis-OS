import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";

import type { CapabilityGrant } from "@noctis/contracts";
import {
  FileListEvidenceSchema,
  FileReadEvidenceSchema,
  SessionHistoryEvidenceSchema,
  SessionListEvidenceSchema,
} from "@noctis/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { AdapterContext, StreamedFile } from "./adapters.js";
import { ADAPTERS, AdapterRefused, MAX_HISTORY_BYTES } from "./adapters.js";
import type { Runtime } from "./runtimes/Runtime.js";

let scratch: string | undefined;

afterEach(() => {
  if (scratch !== undefined) {
    rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});

/** The owner's shared folder is the agents' folder: a `runtime.turn` grant. */
function runtimeGrant(path: string, overrides: Partial<CapabilityGrant> = {}): CapabilityGrant {
  return {
    id: "0199a000-0000-7000-8000-00000000000a",
    nodeId: "0199a000-0000-7000-8000-00000000000b",
    capability: "runtime.turn",
    operationClass: "read_inspect",
    constraintsVersion: 1,
    constraints: {
      providers: ["claude"],
      roots: [{ grantId: "tu", path, mode: "write", localOnly: false }],
    },
    grantedAt: "2026-09-01T12:00:00.000Z",
    ...overrides,
  };
}

/** `root/` holds a script, a folder of frames and a link back out over itself. */
function channel(): string {
  scratch = mkdtempSync(join(tmpdir(), "noctis-files-"));

  const root = join(scratch, "root");

  mkdirSync(join(root, "frames"), { recursive: true });
  mkdirSync(join(scratch, "outside"));
  writeFileSync(join(root, "script.md"), "# Episode one\n");
  writeFileSync(join(root, "frames", "frame-01.png"), "0123456789");
  writeFileSync(join(scratch, "outside", "secret.txt"), "secret");

  try {
    symlinkSync(scratch, join(root, "escape"), "dir");
  } catch {
    symlinkSync(scratch, join(root, "escape"), "junction");
  }

  return root;
}

function context(root: string, overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    grants: [runtimeGrant(root)],
    signal: new AbortController().signal,
    progress: () => undefined,
    stream: () => undefined,
    delta: () => undefined,
    ask: () => Promise.reject(new Error("no ask expected")),
    env: {},
    runtimes: {},
    fetchAttachment: () => Promise.reject(new Error("no attachment expected")),
    delegate: () => Promise.reject(new Error("no delegation expected")),
    uploadOutput: () => Promise.reject(new Error("no output expected")),
    streamFile: () => Promise.reject(new Error("no file expected")),
    streamScreen: () => Promise.reject(new Error("no screen expected")),
    ...overrides,
  };
}

/** A `streamFile` that keeps what the adapter handed it. */
function capture(): {
  files: Array<StreamedFile & { content: string }>;
  context: Partial<AdapterContext>;
} {
  const files: Array<StreamedFile & { content: string }> = [];

  return {
    files,
    context: {
      async streamFile(file) {
        files.push({ ...file, content: await text(file.body) });
      },
    },
  };
}

describe("file.list", () => {
  it("lists a shared folder, folders first, and nothing behind a link", async () => {
    const root = channel();
    const evidence = FileListEvidenceSchema.parse(
      await ADAPTERS["file.list"]({ rootGrantId: "tu", relativePath: "" }, context(root)),
    );

    expect(evidence.truncated).toBe(false);
    expect(
      evidence.entries.map(({ name, kind, sizeBytes }) => ({ name, kind, sizeBytes })),
    ).toEqual([
      { name: "frames", kind: "directory", sizeBytes: 0 },
      { name: "script.md", kind: "file", sizeBytes: 14 },
    ]);
  });

  it("lists a folder inside the root", async () => {
    const root = channel();
    const evidence = FileListEvidenceSchema.parse(
      await ADAPTERS["file.list"]({ rootGrantId: "tu", relativePath: "frames" }, context(root)),
    );

    expect(evidence.entries.map((entry) => entry.name)).toEqual(["frame-01.png"]);
  });

  it("refuses to list through a link out of the root", async () => {
    const root = channel();

    await expect(
      ADAPTERS["file.list"]({ rootGrantId: "tu", relativePath: "escape/outside" }, context(root)),
    ).rejects.toBeInstanceOf(AdapterRefused);
  });

  it("refuses a root no runtime.turn grant names", async () => {
    const root = channel();

    await expect(
      ADAPTERS["file.list"]({ rootGrantId: "other", relativePath: "" }, context(root)),
    ).rejects.toBeInstanceOf(AdapterRefused);
    await expect(
      ADAPTERS["file.list"](
        { rootGrantId: "tu", relativePath: "" },
        context(root, { grants: [runtimeGrant(root, { revokedAt: "2026-09-02T00:00:00.000Z" })] }),
      ),
    ).rejects.toBeInstanceOf(AdapterRefused);
  });

  it("refuses a path that climbs out, before touching the disk", async () => {
    const root = channel();

    await expect(
      ADAPTERS["file.list"]({ rootGrantId: "tu", relativePath: "../outside" }, context(root)),
    ).rejects.toThrow();
  });
});

describe("session.list", () => {
  function agentsGrant(root: string): CapabilityGrant {
    return runtimeGrant(root, {
      constraints: {
        providers: ["claude", "codex"],
        roots: [{ grantId: "tu", path: root, mode: "write", localOnly: false }],
      },
    });
  }

  function listing(providerId: "claude" | "codex", at: string, fails = false): Runtime {
    return {
      providerId,
      probe: () => Promise.reject(new Error("not probed here")),
      turn: () => Promise.reject(new Error("no turn here")),
      listSessions: (cwd) =>
        fails
          ? Promise.reject(new Error(`${providerId} store unreadable`))
          : Promise.resolve([
              {
                providerId,
                sessionRef: `${providerId}-1`,
                title: `${providerId} in ${cwd}`,
                lastActiveAt: at,
              },
            ]),
    };
  }

  it("lists every agent's sessions for the shared folder, newest first", async () => {
    const root = channel();
    const evidence = SessionListEvidenceSchema.parse(
      await ADAPTERS["session.list"](
        { rootGrantId: "tu" },
        context(root, {
          grants: [agentsGrant(root)],
          runtimes: {
            claude: listing("claude", "2026-10-08T10:00:00.000Z"),
            codex: listing("codex", "2026-10-08T12:00:00.000Z"),
          },
        }),
      ),
    );

    expect(evidence.sessions.map((session) => session.sessionRef)).toEqual(["codex-1", "claude-1"]);
    // Asked about the real folder, the one the agents' own stores are keyed by.
    expect(evidence.sessions[0]?.title).toBe(`codex in ${realpathSync(root)}`);
  });

  it("still lists one agent's sessions when the other's store cannot be read", async () => {
    const root = channel();
    const evidence = SessionListEvidenceSchema.parse(
      await ADAPTERS["session.list"](
        { rootGrantId: "tu" },
        context(root, {
          grants: [agentsGrant(root)],
          runtimes: {
            claude: listing("claude", "2026-10-08T10:00:00.000Z"),
            codex: listing("codex", "2026-10-08T12:00:00.000Z", true),
          },
        }),
      ),
    );

    expect(evidence.sessions.map((session) => session.sessionRef)).toEqual(["claude-1"]);
  });

  it("asks only the agents the folder is shared with", async () => {
    const root = channel();
    const evidence = SessionListEvidenceSchema.parse(
      await ADAPTERS["session.list"](
        { rootGrantId: "tu" },
        context(root, {
          // runtimeGrant shares the folder with Claude alone.
          runtimes: {
            claude: listing("claude", "2026-10-08T10:00:00.000Z"),
            codex: listing("codex", "2026-10-08T12:00:00.000Z"),
          },
        }),
      ),
    );

    expect(evidence.sessions.map((session) => session.providerId)).toEqual(["claude"]);
  });

  it("refuses a folder nobody shared", async () => {
    const root = channel();

    await expect(
      ADAPTERS["session.list"]({ rootGrantId: "other" }, context(root)),
    ).rejects.toBeInstanceOf(AdapterRefused);
  });
});

describe("session.history", () => {
  function reading(exchanges: Array<{ prompt: string; reply: string }>, asked: unknown[]): Runtime {
    return {
      providerId: "claude",
      probe: () => Promise.reject(new Error("not probed here")),
      turn: () => Promise.reject(new Error("no turn here")),
      readHistory: (cwd, sessionRef) => {
        asked.push({ cwd, sessionRef });

        return Promise.resolve(exchanges);
      },
    };
  }

  it("reads the session from the real folder, newest exchanges kept within one frame", async () => {
    const root = channel();
    const asked: unknown[] = [];
    // Ten exchanges far past every limit, in characters that take three bytes each.
    const long = Array.from({ length: 10 }, (_, index) => ({
      prompt: `${String(index)}${"—".repeat(5_000)}`,
      reply: "—".repeat(9_000),
    }));
    const evidence = SessionHistoryEvidenceSchema.parse(
      await ADAPTERS["session.history"](
        { rootGrantId: "tu", providerId: "claude", sessionRef: "abc-1" },
        context(root, { runtimes: { claude: reading(long, asked) } }),
      ),
    );

    expect(asked).toEqual([{ cwd: realpathSync(root), sessionRef: "abc-1" }]);
    expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThan(MAX_HISTORY_BYTES);
    expect(evidence.exchanges.length).toBeGreaterThan(0);
    expect(evidence.exchanges.at(-1)?.prompt.startsWith("9")).toBe(true);
  });

  it("refuses an agent the folder is not shared with", async () => {
    const root = channel();

    await expect(
      ADAPTERS["session.history"](
        { rootGrantId: "tu", providerId: "codex", sessionRef: "abc-1" },
        context(root, { runtimes: { codex: { ...reading([], []), providerId: "codex" } } }),
      ),
    ).rejects.toBeInstanceOf(AdapterRefused);
  });
});

describe("file.read", () => {
  it("streams a whole file to the core and reports its size", async () => {
    const root = channel();
    const { files, context: sink } = capture();
    const evidence = FileReadEvidenceSchema.parse(
      await ADAPTERS["file.read"](
        { rootGrantId: "tu", relativePath: "script.md", offset: 0 },
        context(root, sink),
      ),
    );

    expect(evidence).toEqual({ sizeBytes: 14, sentBytes: 14 });
    expect(files).toEqual([
      expect.objectContaining({ sizeBytes: 14, offset: 0, length: 14, content: "# Episode one\n" }),
    ]);
  });

  it("streams only the range asked for, which is how a video seeks", async () => {
    const root = channel();
    const { files, context: sink } = capture();
    const evidence = await ADAPTERS["file.read"](
      { rootGrantId: "tu", relativePath: "frames/frame-01.png", offset: 2, length: 3 },
      context(root, sink),
    );

    expect(evidence).toEqual({ sizeBytes: 10, sentBytes: 3 });
    expect(files[0]?.content).toBe("234");
  });

  it("sends nothing for a range past the end, but still says how big the file is", async () => {
    const root = channel();
    const { files, context: sink } = capture();
    const evidence = await ADAPTERS["file.read"](
      { rootGrantId: "tu", relativePath: "script.md", offset: 99 },
      context(root, sink),
    );

    expect(evidence).toEqual({ sizeBytes: 14, sentBytes: 0 });
    expect(files[0]).toEqual(expect.objectContaining({ sizeBytes: 14, length: 0, content: "" }));
  });

  it("refuses a file reached through a link out of the root", async () => {
    const root = channel();

    await expect(
      ADAPTERS["file.read"](
        { rootGrantId: "tu", relativePath: "escape/outside/secret.txt", offset: 0 },
        context(root, capture().context),
      ),
    ).rejects.toBeInstanceOf(AdapterRefused);
  });

  it("refuses a folder", async () => {
    const root = channel();

    await expect(
      ADAPTERS["file.read"](
        { rootGrantId: "tu", relativePath: "frames", offset: 0 },
        context(root, capture().context),
      ),
    ).rejects.toBeInstanceOf(AdapterRefused);
  });
});

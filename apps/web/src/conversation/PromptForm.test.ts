import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PromptForm, offeredModels, pastedFiles, rootOption } from "./PromptForm.js";

const CLAUDE = { providerId: "claude" as const, model: "opus" };
const LOCAL = { providerId: "local" as const, model: "qwen/qwen3.5-9b" };
const HERMES = { providerId: "hermes" as const, model: "qwen/qwen3.5-9b" };

describe("offeredModels", () => {
  it("offers Jester Hermes alone, since Jester is Hermes (ADR-0030)", () => {
    expect(offeredModels("jester", [CLAUDE, LOCAL, HERMES])).toEqual([HERMES]);
    expect(offeredModels("jester", [CLAUDE])).toEqual([]);
  });

  it("offers Vesper every agent", () => {
    expect(offeredModels("vesper", [CLAUDE, LOCAL, HERMES])).toEqual([CLAUDE, LOCAL, HERMES]);
  });
});

describe("rootOption", () => {
  const ROOT = {
    grantId: "grant-1",
    path: "C:\\Users\\owner\\Documents",
    mode: "write" as const,
    localOnly: false,
    nodeId: "node-1",
    hostId: "home",
    connected: true,
  };

  it("names a folder by its machine and last segment, with nothing to add when it is awake", () => {
    expect(rootOption(ROOT)).toEqual({ value: "grant-1", label: "Documents on home" });
  });

  it("says offline and read only beside the name rather than inside it", () => {
    expect(rootOption({ ...ROOT, connected: false })).toMatchObject({
      label: "Documents on home",
      detail: "offline",
    });
    expect(rootOption({ ...ROOT, mode: "read" })).toMatchObject({ detail: "read only" });
    expect(rootOption({ ...ROOT, connected: false, mode: "read" })).toMatchObject({
      detail: "offline · read only",
    });
  });
});

describe("pastedFiles", () => {
  const item = (kind: string, type: string, file: File | null) => ({
    kind,
    type,
    getAsFile: () => file,
  });
  const now = new Date(2026, 9, 9, 7, 5, 3);

  it("names every pasted image for when it was taken, since the clipboard calls them all image.png", () => {
    const files = pastedFiles(
      [
        item("file", "image/png", new File(["a"], "image.png", { type: "image/png" })),
        item("string", "text/plain", null),
        item("file", "image/jpeg", new File(["b"], "image.jpg", { type: "image/jpeg" })),
      ],
      now,
    );

    expect(files.map((file) => file.name)).toEqual([
      "screenshot-20261009-070503.png",
      "screenshot-20261009-070503-2.jpg",
    ]);
    expect(files.map((file) => file.type)).toEqual(["image/png", "image/jpeg"]);
  });

  it("keeps counting across pastes, so two in one second still get different names", () => {
    const first = pastedFiles(
      [item("file", "image/png", new File(["a"], "image.png", { type: "image/png" }))],
      now,
    );
    const second = pastedFiles(
      [item("file", "image/png", new File(["a"], "image.png", { type: "image/png" }))],
      now,
      2,
    );

    expect(first[0]?.name).toBe("screenshot-20261009-070503.png");
    expect(second[0]?.name).toBe("screenshot-20261009-070503-2.png");
  });

  it("ignores a file that is not an image the core takes, and an empty clipboard", () => {
    expect(
      pastedFiles(
        [
          item("file", "application/pdf", new File(["a"], "a.pdf", { type: "application/pdf" })),
          item("file", "image/svg+xml", new File(["a"], "a.svg", { type: "image/svg+xml" })),
          item("file", "image/png", null),
        ],
        now,
      ),
    ).toEqual([]);
    expect(pastedFiles([], now)).toEqual([]);
  });
});

describe("waking from the composer", () => {
  const render = (extra: Record<string, unknown>): string =>
    renderToStaticMarkup(
      createElement(PromptForm, {
        identityId: "jester",
        models: [],
        defaultModel: undefined,
        disabled: false,
        onSend: () => undefined,
        ...extra,
      }),
    );

  it("offers Wake while the agent is asleep", () => {
    expect(render({ asleep: true, onWake: () => undefined })).toMatch(
      /<button[^>]*>Wake<\/button>/,
    );
  });

  it("offers nothing to wake once it is awake", () => {
    expect(render({ asleep: false, onWake: () => undefined })).not.toContain(">Wake<");
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  PromptForm,
  lastRun,
  modelChoice,
  offeredModels,
  pastedFiles,
  rootChoice,
  rootOption,
} from "./PromptForm.js";

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

describe("while a turn is working", () => {
  it("says a message joins the running turn", () => {
    const markup = (steering: boolean): string =>
      renderToStaticMarkup(
        createElement(PromptForm, {
          identityId: "vesper",
          models: [],
          defaultModel: undefined,
          disabled: false,
          onSend: () => undefined,
          steering,
        }),
      );

    expect(markup(true)).toContain('placeholder="Add to what Vesper is doing..."');
    expect(markup(false)).toContain('placeholder="Ask Vesper..."');
  });
});

describe("modelChoice", () => {
  const SONNET = { providerId: "claude" as const, model: "sonnet" };
  const HAIKU = { providerId: "claude" as const, model: "claude-haiku-5-5" };
  const CODEX = { providerId: "codex" as const, model: "gpt-6.1-sol" };
  const models = [HAIKU, CLAUDE, SONNET, CODEX];

  it("a new conversation starts on the Settings default", () => {
    expect(modelChoice({ identityId: "vesper", models, defaultModel: SONNET }).selected).toEqual(
      SONNET,
    );
  });

  it("an ongoing conversation shows the model it last ran on, not the default", () => {
    expect(
      modelChoice({ identityId: "vesper", models, defaultModel: SONNET, current: CLAUDE }).selected,
    ).toEqual(CLAUDE);
  });

  it("the owner's pick wins over both, and picking the default again is a real pick", () => {
    const base = { identityId: "vesper" as const, models, defaultModel: SONNET, current: CLAUDE };

    expect(modelChoice({ ...base, chosenKey: "codex:gpt-6.1-sol" }).selected).toEqual(CODEX);
    expect(modelChoice({ ...base, chosenKey: "claude:sonnet" }).selected).toEqual(SONNET);
  });

  it("a continued session offers its own agent's models only", () => {
    const pinned = modelChoice({
      identityId: "vesper",
      models,
      defaultModel: CODEX,
      pinnedProvider: "claude",
    });

    expect(pinned.options).toEqual([HAIKU, CLAUDE, SONNET]);
    // The core's own rule when nothing was chosen: the first that agent offers.
    expect(pinned.selected).toEqual(HAIKU);
    expect(
      modelChoice({ identityId: "vesper", models, defaultModel: SONNET, pinnedProvider: "claude" })
        .selected,
    ).toEqual(SONNET);
  });
});

describe("rootChoice", () => {
  it("a new conversation leaves the folder to Noctis until one is picked", () => {
    expect(rootChoice({})).toEqual({ selected: "", offerAnywhere: true });
    expect(rootChoice({ chosen: "g-2" })).toEqual({ selected: "g-2", offerAnywhere: true });
  });

  it("an ongoing conversation stays in the folder it last ran in until another is picked", () => {
    expect(rootChoice({ current: "g-1" })).toEqual({ selected: "g-1", offerAnywhere: false });
    expect(rootChoice({ current: "g-1", chosen: "g-2" })).toEqual({
      selected: "g-2",
      offerAnywhere: false,
    });
  });
});

describe("lastRun", () => {
  it("is the latest turn's model and folder, and nothing before the first turn", () => {
    expect(lastRun([])).toBe(undefined);
    expect(
      lastRun([
        { model: LOCAL, rootGrantId: "g-1" },
        { model: CLAUDE, rootGrantId: "g-2" },
      ]),
    ).toEqual({ model: CLAUDE, rootGrantId: "g-2" });
  });
});

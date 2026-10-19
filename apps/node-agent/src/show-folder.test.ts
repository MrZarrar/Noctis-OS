import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuntimeItemSchema } from "@noctis/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SHOTS_FOLDER,
  SHOW_FOLDER,
  showItem,
  watchShowFolder,
  withdrawItem,
} from "./show-folder.js";

let dir: string;
let stop: () => void = () => undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noctis-show-"));
});

afterEach(() => {
  stop();
  rmSync(dir, { recursive: true, force: true });
});

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the show folder", () => {
  it("reports each file saved in it once, however many writes it took, and nothing outside it", async () => {
    const seen: string[] = [];
    stop = watchShowFolder(dir, (path) => seen.push(path));

    mkdirSync(join(dir, SHOW_FOLDER, "figures"), { recursive: true });
    await settle(100);
    const page = join(dir, SHOW_FOLDER, "figures", "limiter.html");
    writeFileSync(page, "<p>one");
    writeFileSync(page, "<p>two");
    writeFileSync(join(dir, "README.md"), "# not shown");
    await settle(1000);

    expect(seen).toEqual([page]);
  });

  it("reports a shown file that is deleted, so its panel closes, and ignores ones it never showed", async () => {
    const removed: string[] = [];
    stop = watchShowFolder(
      dir,
      () => undefined,
      (path) => removed.push(path),
    );

    mkdirSync(join(dir, SHOW_FOLDER), { recursive: true });
    await settle(100);
    const shot = join(dir, SHOW_FOLDER, "check.png");
    writeFileSync(shot, "png");
    await settle(800);
    unlinkSync(shot);
    writeFileSync(join(dir, SHOW_FOLDER, "never.png"), "png");
    unlinkSync(join(dir, SHOW_FOLDER, "never.png"));
    await settle(800);

    expect(removed).toEqual([shot]);
  });

  it("leaves files in a hidden folder inside it alone, where an options panel's screenshots go", async () => {
    const seen: string[] = [];
    stop = watchShowFolder(dir, (path) => seen.push(path));

    mkdirSync(join(dir, SHOW_FOLDER, SHOTS_FOLDER), { recursive: true });
    await settle(100);
    writeFileSync(join(dir, SHOW_FOLDER, SHOTS_FOLDER, "anker.png"), "png");
    const page = join(dir, SHOW_FOLDER, "options.md");
    writeFileSync(page, "# shown");
    await settle(1000);

    expect(seen).toEqual([page]);
  });

  it("does nothing for a folder that does not exist", () => {
    stop = watchShowFolder(join(dir, "missing"), () => undefined);
  });

  it("opens each kind of file as the panel that shows it, by its path", () => {
    const kinds = [
      "fig.html",
      "plot.svg",
      "notes.md",
      "shot.png",
      "clip.mp4",
      "data.bin",
      "build.mjs",
      "style.css",
      "data.json",
    ].map((name) => {
      const item = showItem(join(dir, SHOW_FOLDER, name), 1);
      return item?.kind === "proposal" && item.proposal.kind === "surface"
        ? item.proposal.surfaceKind
        : undefined;
    });

    // Code is how a figure was made, not something to look at.
    expect(kinds).toEqual([
      "visual",
      "visual",
      "document",
      "media",
      "media",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(withdrawItem(join(dir, SHOW_FOLDER, "shot.png"), 4)).toMatchObject({
      itemId: "show-4",
      proposal: { surfaceKind: "media", withdrawn: true, payload: { title: "shot.png" } },
    });
    expect(RuntimeItemSchema.parse(showItem(join(dir, SHOW_FOLDER, "fig.html"), 3))).toMatchObject({
      itemId: "show-3",
      status: "completed",
      proposal: { payload: { title: "fig.html", path: join(dir, SHOW_FOLDER, "fig.html") } },
    });
  });
});

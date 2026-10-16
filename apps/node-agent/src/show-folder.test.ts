import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuntimeItemSchema } from "@noctis/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SHOW_FOLDER, showItem, watchShowFolder } from "./show-folder.js";

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

  it("does nothing for a folder that does not exist", () => {
    stop = watchShowFolder(join(dir, "missing"), () => undefined);
  });

  it("opens each kind of file as the panel that shows it, by its path", () => {
    const kinds = ["fig.html", "plot.svg", "notes.md", "shot.png", "clip.mp4", "data.bin"].map(
      (name) => {
        const item = showItem(join(dir, SHOW_FOLDER, name), 1);
        return item?.kind === "proposal" && item.proposal.kind === "surface"
          ? item.proposal.surfaceKind
          : undefined;
      },
    );

    expect(kinds).toEqual(["visual", "visual", "document", "media", "media", undefined]);
    expect(RuntimeItemSchema.parse(showItem(join(dir, SHOW_FOLDER, "fig.html"), 3))).toMatchObject({
      itemId: "show-3",
      status: "completed",
      proposal: { payload: { title: "fig.html", path: join(dir, SHOW_FOLDER, "fig.html") } },
    });
  });
});

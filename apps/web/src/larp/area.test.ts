import { describe, expect, it } from "vitest";

import { LARP_ANCHOR_DAY, parsePath, rebase } from "./area.js";

describe("rebase", () => {
  it("moves every timestamp by whole days so the anchor day becomes today", () => {
    const today = new Date("2026-11-05T15:30:00Z");
    const moved = rebase(
      { at: `${LARP_ANCHOR_DAY}T08:15:00.000Z`, list: [{ due: "2026-10-21T22:00:00.000Z" }], n: 3 },
      today,
    );

    expect(moved).toEqual({
      at: "2026-11-05T08:15:00.000Z",
      list: [{ due: "2026-11-04T22:00:00.000Z" }],
      n: 3,
    });
  });

  it("leaves plain strings alone", () => {
    expect(rebase({ title: "Fix the 2026 build" }, new Date())).toEqual({
      title: "Fix the 2026 build",
    });
  });
});

describe("parsePath", () => {
  it("splits segments and query", () => {
    const { segments, query } = parsePath("/vault/notes/projects%2Fa?x=1");

    expect(segments).toEqual(["vault", "notes", "projects/a"]);
    expect(query.get("x")).toBe("1");
  });
});

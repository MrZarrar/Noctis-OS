import { describe, expect, it } from "vitest";

import { childPath, filesQuery, parentPath } from "./files-view.js";

describe("paths in a shared folder", () => {
  it("steps down and back up", () => {
    expect(childPath("", "frames")).toBe("frames");
    expect(childPath("frames", "ep 1")).toBe("frames/ep 1");
    expect(parentPath("frames/ep 1")).toBe("frames");
    expect(parentPath("frames")).toBe("");
  });

  it("names the place for the core, encoded", () => {
    expect(filesQuery({ nodeId: "n-1", grantId: "tu" }, "frames/ep 1&2.png")).toBe(
      "node=n-1&root=tu&path=frames%2Fep+1%262.png",
    );
  });
});

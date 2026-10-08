import { describe, expect, it } from "vitest";

import { childPath, filesQuery, parentPath, viewerKind } from "./files-view.js";

describe("viewerKind", () => {
  it("shows what a browser can draw, and offers the rest as a download", () => {
    expect(viewerKind("frame-01.PNG", 10)).toBe("image");
    expect(viewerKind("render.mp4", 10)).toBe("video");
    expect(viewerKind("take.mov", 10)).toBe("video");
    expect(viewerKind("voice.m4a", 10)).toBe("audio");
    expect(viewerKind("script.md", 10)).toBe("text");
    expect(viewerKind("build.py", 10)).toBe("text");
    expect(viewerKind("archive.zip", 10)).toBe("download");
    expect(viewerKind("README", 10)).toBe("download");
  });

  it("does not pull a huge text file into the page", () => {
    expect(viewerKind("server.log", 3 * 1024 * 1024)).toBe("download");
  });
});

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

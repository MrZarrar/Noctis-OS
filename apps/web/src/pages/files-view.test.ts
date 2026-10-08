import { describe, expect, it } from "vitest";

import { childPath, filesQuery, locateInRoots, parentPath, viewerKind } from "./files-view.js";

describe("locateInRoots", () => {
  const roots = [
    { nodeId: "home", grantId: "channel", path: "C:\\Users\\mmush\\Downloads\\channel" },
    { nodeId: "home", grantId: "docs", path: "C:\\Users\\mmush\\Documents" },
    { nodeId: "work", grantId: "channel", path: "C:\\Users\\mmush\\Downloads\\channel" },
  ];

  it("finds the shared folder a file an agent wrote is in, on the PC that wrote it", () => {
    expect(
      locateInRoots("C:\\Users\\mmush\\Downloads\\channel\\scripts\\ep1.md", "home", roots),
    ).toEqual({ root: roots[0], relativePath: "scripts/ep1.md" });
    expect(locateInRoots("C:\\Users\\mmush\\Downloads\\channel\\ep1.md", "work", roots)?.root).toBe(
      roots[2],
    );
  });

  it("matches Windows paths however the runtime spelled them", () => {
    expect(locateInRoots("c:/users/MMUSH/downloads/channel/frame.png", "home", roots)).toEqual({
      root: roots[0],
      relativePath: "frame.png",
    });
  });

  it("finds nothing outside a shared folder, or on another PC", () => {
    expect(locateInRoots("C:\\Users\\mmush\\Downloads\\channel-old\\x.md", "home", roots)).toBe(
      undefined,
    );
    expect(locateInRoots("C:\\Users\\mmush\\Downloads\\channel", "home", roots)).toBe(undefined);
    expect(locateInRoots("scripts/ep1.md", "home", roots)).toBe(undefined);
    expect(locateInRoots("C:\\Users\\mmush\\Documents\\a.md", "work", roots)).toBe(undefined);
  });
});

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

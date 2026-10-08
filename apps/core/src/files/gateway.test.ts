import { describe, expect, it } from "vitest";

import { fileMediaType, parseRange } from "./gateway.js";

describe("parseRange", () => {
  it("reads the two forms a video element sends", () => {
    expect(parseRange("bytes=0-")).toEqual({ offset: 0 });
    expect(parseRange("bytes=1000-1999")).toEqual({ offset: 1000, length: 1000 });
  });

  it("treats anything else as a request for the whole file", () => {
    // Suffix and multi-range are legal but no player needs them here; the
    // whole file with a 200 is a correct answer to both.
    for (const header of [undefined, "", "bytes=-500", "bytes=0-1,5-9", "items=0-1", "bytes=9-3"]) {
      expect(parseRange(header), String(header)).toBeUndefined();
    }
  });
});

describe("fileMediaType", () => {
  it("names what the viewer can show", () => {
    expect(fileMediaType("Script.MD")).toBe("text/markdown; charset=utf-8");
    expect(fileMediaType("notes.txt")).toBe("text/plain; charset=utf-8");
    expect(fileMediaType("frame.png")).toBe("image/png");
    expect(fileMediaType("render.mp4")).toBe("video/mp4");
    expect(fileMediaType("take.mov")).toBe("video/quicktime");
  });

  it("serves code and markup as text, never as something a browser runs", () => {
    expect(fileMediaType("build.py")).toBe("text/plain; charset=utf-8");
    expect(fileMediaType("page.html")).toBe("text/plain; charset=utf-8");
    expect(fileMediaType("unknown.bin")).toBe("application/octet-stream");
    expect(fileMediaType("no-extension")).toBe("application/octet-stream");
  });
});

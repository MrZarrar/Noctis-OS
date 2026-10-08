import { describe, expect, it } from "vitest";

import {
  CAPABILITY_CONTRACTS,
  CAPABILITY_OPERATION_CLASS,
  FileRelativePathSchema,
  grantCovers,
} from "./node.js";

describe("file browsing contracts (v1 S4)", () => {
  it("takes a path inside a root, written one way", () => {
    for (const path of ["", "script.md", "Episodes/ep 1/frame-01.png", ".config/x"]) {
      expect(FileRelativePathSchema.safeParse(path).success, path).toBe(true);
    }
  });

  it("refuses a path that could name anything outside its root", () => {
    for (const path of [
      "..",
      "../secrets",
      "a/../../b",
      "a/./b",
      "/etc/passwd",
      "C:/Users",
      "C:\\Users",
      "a\\b",
      "a//b",
      "a/",
      "a\0b",
    ]) {
      expect(FileRelativePathSchema.safeParse(path).success, JSON.stringify(path)).toBe(false);
    }
  });

  it("lets a runtime.turn grant cover reading its roots, and nothing else", () => {
    expect(grantCovers("runtime.turn", "file.list")).toBe(true);
    expect(grantCovers("runtime.turn", "file.read")).toBe(true);
    expect(grantCovers("file.read", "file.read")).toBe(true);
    expect(grantCovers("runtime.turn", "file.search")).toBe(false);
    expect(grantCovers("file.search", "file.read")).toBe(false);
  });

  it("classes both as reads", () => {
    expect(CAPABILITY_OPERATION_CLASS["file.list"]).toBe("read_inspect");
    expect(CAPABILITY_OPERATION_CLASS["file.read"]).toBe("read_inspect");
  });

  it("reads a range by offset, to the end unless a length is given", () => {
    const payload = CAPABILITY_CONTRACTS["file.read"].payload;

    expect(payload.safeParse({ rootGrantId: "tu", relativePath: "a.mp4", offset: 0 }).success).toBe(
      true,
    );
    expect(
      payload.safeParse({ rootGrantId: "tu", relativePath: "a.mp4", offset: 10, length: 5 })
        .success,
    ).toBe(true);
    // A file is never the root itself.
    expect(payload.safeParse({ rootGrantId: "tu", relativePath: "", offset: 0 }).success).toBe(
      false,
    );
    expect(payload.safeParse({ rootGrantId: "tu", relativePath: "a", offset: -1 }).success).toBe(
      false,
    );
    expect(
      payload.safeParse({ rootGrantId: "tu", relativePath: "a", offset: 0, length: 0 }).success,
    ).toBe(false);
  });
});

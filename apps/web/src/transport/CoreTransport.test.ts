import { describe, expect, it } from "vitest";

import { CorePathRefused, assertCorePath, resolveCoreUrl } from "./CoreTransport.js";

describe("assertCorePath", () => {
  it.each(["/", "/objectives", "/events?after=12&limit=500", "/commands/objective.create"])(
    "accepts the rooted core path %s",
    (path) => {
      expect(assertCorePath(path)).toBe(path);
    },
  );

  it.each([
    ["an absolute URL", "http://evil.example/steal"],
    ["a protocol-relative host", "//evil.example/steal"],
    ["a backslash-escaped host", "/\\evil.example/steal"],
    ["a bare relative path", "objectives"],
    ["an empty path", ""],
  ])("refuses %s", (_label, path) => {
    expect(() => assertCorePath(path)).toThrow(CorePathRefused);
  });
});

describe("resolveCoreUrl", () => {
  it("resolves a rooted path against the core base URL", () => {
    expect(resolveCoreUrl("http://127.0.0.1:7717", "/objectives").href).toBe(
      "http://127.0.0.1:7717/objectives",
    );
  });

  it("refuses a traversal that escapes the base origin", () => {
    // Belt and braces: `assertCorePath` already refuses this shape. The origin
    // comparison is what makes the guard true rather than merely plausible.
    expect(() => resolveCoreUrl("http://127.0.0.1:7717", "//evil.example/x")).toThrow(
      CorePathRefused,
    );
  });
});

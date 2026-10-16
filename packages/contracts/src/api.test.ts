import { describe, expect, it } from "vitest";

import { API_SEGMENTS, CORE_PATH_PATTERN } from "./api.js";

describe("the core's own paths", () => {
  // A path missing here is answered by the page's index.html with a 200 when the
  // core serves the app, which is how the digest went quietly blank.
  it.each([
    "/digest?from=a&to=b",
    "/live-sessions",
    "/live-sessions/x/entries",
    "/visuals/content?node=n&root=r&path=a.html",
  ])("claims %s for the core, not the page", (path) => {
    expect(CORE_PATH_PATTERN.test(path)).toBe(true);
    expect(API_SEGMENTS).toContain(path.split(/[/?]/)[1]);
  });
});

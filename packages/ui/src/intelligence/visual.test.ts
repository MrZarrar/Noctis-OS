import { describe, expect, it } from "vitest";

import { identityAccent } from "../tokens/index.js";
import { visualForIdentity } from "./visual.js";

describe("visualForIdentity", () => {
  it("returns the Vesper accent with no overlay when NOIR is not active", () => {
    expect(visualForIdentity("vesper")).toEqual({
      primary: identityAccent.vesper.primary,
      secondary: identityAccent.vesper.secondary,
    });
  });

  it("returns the Jester accent unchanged when protocolIds is empty", () => {
    expect(visualForIdentity("jester", [])).toEqual({
      primary: identityAccent.jester.primary,
      secondary: identityAccent.jester.secondary,
    });
  });

  it("layers the NOIR overlay on top of whichever identity is active", () => {
    expect(visualForIdentity("vesper", ["noir"]).noirOverlay).toEqual(identityAccent.noir);
    expect(visualForIdentity("jester", ["noir"]).noirOverlay).toEqual(identityAccent.noir);
  });

  it("never changes the base identity accent when NOIR is layered on", () => {
    const withNoir = visualForIdentity("vesper", ["noir"]);

    expect(withNoir.primary).toBe(identityAccent.vesper.primary);
    expect(withNoir.secondary).toBe(identityAccent.vesper.secondary);
  });
});

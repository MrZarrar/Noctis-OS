import { describe, expect, it } from "vitest";
import { controlsFor } from "./PanelControls.js";

describe("panel controls", () => {
  it("keeps place off compact panels", () => {
    expect(controlsFor("compact")).toEqual(["focus", "pin", "size", "close"]);
    expect(controlsFor("standard")).toEqual(["focus", "pin", "place", "size", "close"]);
    expect(controlsFor("wide")).toEqual(controlsFor("standard"));
  });
});

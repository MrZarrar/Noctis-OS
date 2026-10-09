import { describe, expect, it } from "vitest";

import { carriesFiles, guardStrayFileDrops } from "./file-drops.js";

const drag = (type: string, types: string[]): Event =>
  Object.assign(new Event(type, { cancelable: true }), { dataTransfer: { types } });

describe("file drops", () => {
  it("knows a drag that carries files from one that carries text", () => {
    expect(carriesFiles({ types: ["Files"] })).toBe(true);
    expect(carriesFiles({ types: ["text/plain"] })).toBe(false);
    expect(carriesFiles(null)).toBe(false);
  });

  it("stops a file dropped anywhere from navigating the tab to it, and leaves text alone", () => {
    const target = new EventTarget();
    const stop = guardStrayFileDrops(target);

    for (const type of ["dragover", "drop"]) {
      const file = drag(type, ["Files"]);
      const text = drag(type, ["text/plain"]);

      target.dispatchEvent(file);
      target.dispatchEvent(text);
      expect(file.defaultPrevented, type).toBe(true);
      expect(text.defaultPrevented, type).toBe(false);
    }

    stop();

    const after = drag("drop", ["Files"]);

    target.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});

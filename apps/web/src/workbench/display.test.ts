import { describe, expect, it } from "vitest";

import { clientId, displayFingerprint, displayFor } from "./display.js";

const DESK = {
  screenWidth: 3440,
  screenHeight: 1440,
  devicePixelRatio: 1,
  viewportWidth: 3440,
};

describe("display facts", () => {
  it("keeps the fingerprint stable when only the window is resized", () => {
    expect(displayFingerprint({ ...DESK, viewportWidth: 900 })).toBe(displayFingerprint(DESK));
  });

  it("changes the fingerprint on a physically different display", () => {
    const laptop = { ...DESK, screenWidth: 1920, screenHeight: 1080, devicePixelRatio: 2 };

    expect(displayFingerprint(laptop)).not.toBe(displayFingerprint(DESK));
  });

  it("reports the viewport width, not the screen width", () => {
    expect(displayFor({ ...DESK, viewportWidth: 1200 }).widthPx).toBe(1200);
  });

  it("never reports a width the contract would reject", () => {
    expect(displayFor({ ...DESK, viewportWidth: 0 }).widthPx).toBe(1);
    expect(displayFor({ ...DESK, viewportWidth: 1199.6 }).widthPx).toBe(1200);
  });
});

describe("client id", () => {
  it("reuses the stored id across sessions", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };

    const first = clientId(storage, () => "minted-1");

    expect(clientId(storage, () => "minted-2")).toBe(first);
  });

  it("degrades to a fresh id when storage refuses", () => {
    const storage = {
      getItem: () => {
        throw new Error("storage is not available");
      },
      setItem: () => undefined,
    };

    expect(clientId(storage, () => "minted-1")).toBe("minted-1");
  });
});

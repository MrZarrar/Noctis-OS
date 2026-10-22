import { describe, expect, it } from "vitest";

import { larpEnabled, setLarpEnabled } from "./mode.js";

function memory(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  } as Storage;
}

describe("LARP mode switch", () => {
  it("is off until this device turns it on, and off again after", () => {
    const storage = memory();

    expect(larpEnabled(storage)).toBe(false);
    setLarpEnabled(true, storage);
    expect(larpEnabled(storage)).toBe(true);
    setLarpEnabled(false, storage);
    expect(larpEnabled(storage)).toBe(false);
  });

  it("stays off when storage throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
    };

    expect(larpEnabled(broken)).toBe(false);
  });
});

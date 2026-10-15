import { describe, it, expect } from "vitest";
import { linkedThread } from "./thread-link.js";
describe("notification thread link", () => {
  it("accepts only a Noctis thread UUID", () => {
    expect(linkedThread("https://local/?thread=00000000-0000-7000-8000-000000000001")).toBe(
      "00000000-0000-7000-8000-000000000001",
    );
    expect(linkedThread("https://local/?thread=../../secrets")).toBeUndefined();
  });
});

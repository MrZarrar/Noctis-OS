import { describe, it, expect } from "vitest";
import { linkedScreen, linkedThread } from "./thread-link.js";
describe("notification thread link", () => {
  it("accepts only a Noctis thread UUID", () => {
    expect(linkedThread("https://local/?thread=00000000-0000-7000-8000-000000000001")).toBe(
      "00000000-0000-7000-8000-000000000001",
    );
    expect(linkedThread("https://local/?thread=../../secrets")).toBeUndefined();
  });
});
describe("screen link", () => {
  it("opens on a page Noctis has, and nothing else", () => {
    expect(linkedScreen("https://local/?screen=Vault")).toBe("Vault");
    expect(linkedScreen("https://local/?screen=Presence")).toBe("Presence");
    expect(linkedScreen("https://local/?screen=../../secrets")).toBeUndefined();
    expect(linkedScreen("https://local/")).toBeUndefined();
  });
});

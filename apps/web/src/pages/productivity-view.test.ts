import { describe, expect, it } from "vitest";
import { localToInstant, triggerLabel, searchNotes } from "./productivity-view.js";
describe("productivity owner time and search", () => {
  it("resolves London summer time independently of the browser zone", () => {
    expect(localToInstant("2027-07-01T09:00")).toBe("2027-07-01T08:00:00.000Z");
  });
  it("rejects a nonexistent spring clock time", () => {
    expect(() => localToInstant("2027-03-28T01:30")).toThrow();
  });
  it("searches both note title and body case insensitively", () => {
    expect(searchNotes([{ title: "Trip", body: "Bring PASSPORT" }], "passport")).toHaveLength(1);
  });
  it("labels owner presence rather than connectivity", () => {
    expect(triggerLabel({ kind: "at_pc", nodeId: "home", repeat: true })).toContain("unlocked");
  });
});
import { snoozeUntil } from "./productivity-view.js";
it("snoozes tomorrow at nine in the owner zone across clock changes", () => {
  expect(snoozeUntil("tomorrow", new Date("2027-03-27T15:00:00Z"))).toBe(
    "2027-03-28T08:00:00.000Z",
  );
});

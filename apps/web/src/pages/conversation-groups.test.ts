import { describe, it, expect } from "vitest";
import { conversationGroups } from "./conversations-view.js";
describe("scheduled conversations", () => {
  it("keeps runs under their task without losing ordinary conversations", () => {
    const free = { id: "free" },
      a = { id: "a", taskId: "task-a", taskName: "Morning review" },
      b = { id: "b", taskId: "task-a", taskName: "Morning review" },
      other = { id: "c", taskId: "task-b", taskName: "Backup" };
    const groups = conversationGroups([free, a, other, b]);
    expect(groups.map((g) => g.label)).toEqual(["Conversations", "Morning review", "Backup"]);
    expect(groups[1]?.conversations).toEqual([a, b]);
    expect(groups[0]?.conversations).toEqual([free]);
  });
});

import { describe, expect, it } from "vitest";

import { ago, conversationLabel, pinnedTo } from "./conversations-view.js";

const NOW = Date.parse("2026-10-08T18:00:00.000Z");

describe("ago", () => {
  it("says how long ago, in the unit a person would", () => {
    expect(ago("2026-10-08T17:59:40.000Z", NOW)).toBe("just now");
    expect(ago("2026-10-08T17:45:00.000Z", NOW)).toBe("15 min ago");
    expect(ago("2026-10-08T15:00:00.000Z", NOW)).toBe("3 h ago");
    expect(ago("2026-10-06T18:00:00.000Z", NOW)).toBe("2 days ago");
    expect(ago("2026-10-07T17:00:00.000Z", NOW)).toBe("1 day ago");
  });
});

describe("conversationLabel", () => {
  it("names a conversation by its title, else by what was said, else by what it is", () => {
    expect(conversationLabel({ kind: "named", title: "Storyboard pass" })).toBe("Storyboard pass");
    expect(conversationLabel({ kind: "free", preview: "hi" })).toBe("Free chat");
    expect(
      conversationLabel({ kind: "named", preview: "Draft the cold open\nthen the hook" }),
    ).toBe("Draft the cold open");
    expect(conversationLabel({ kind: "named" })).toBe("New conversation");
  });
});

describe("pinnedTo", () => {
  const roots = [
    {
      grantId: "tu",
      path: "C:\\Users\\mmush\\Downloads\\hyperframes",
      mode: "write" as const,
      localOnly: false,
      nodeId: "home-node",
      hostId: "home",
      connected: true,
    },
  ];

  it("says which agent, folder and PC a pinned thread runs on", () => {
    expect(pinnedTo({ providerId: "claude", rootGrantId: "tu", nodeId: "home-node" }, roots)).toBe(
      "Claude · hyperframes on home",
    );
  });

  it("is nothing for a thread that runs wherever the message says", () => {
    expect(pinnedTo({}, roots)).toBe(undefined);
  });
});

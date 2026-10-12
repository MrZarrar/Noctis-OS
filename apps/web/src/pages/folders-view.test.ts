import { describe, expect, it } from "vitest";

import { folderGrant, sharedFolders } from "./folders-view.js";

const NOW = Date.parse("2026-10-12T12:00:00.000Z");

function grant(roots: unknown[], extra: Record<string, unknown> = {}) {
  return {
    capability: "runtime.turn",
    constraints: { providers: ["claude", "codex"], roots },
    ...extra,
  };
}

describe("sharedFolders", () => {
  it("lists every live runtime.turn folder once, and nothing else", () => {
    expect(
      sharedFolders(
        [
          grant([
            { grantId: "noctis", path: "C:\\Noctis-OS", mode: "write" },
            { grantId: "donor", path: "C:\\Donor", mode: "read" },
          ]),
          grant([{ grantId: "noctis", path: "C:\\Noctis-OS", mode: "write" }]),
          grant([{ grantId: "old", path: "C:\\Old", mode: "write" }], {
            revokedAt: "2026-10-01T00:00:00.000Z",
          }),
          grant([{ grantId: "lapsed", path: "C:\\Lapsed", mode: "write" }], {
            expiresAt: "2026-10-11T00:00:00.000Z",
          }),
          { capability: "screen.view", constraints: {} },
          grant(["not a root"]),
        ],
        NOW,
      ),
    ).toEqual([
      { grantId: "noctis", path: "C:\\Noctis-OS", mode: "write" },
      { grantId: "donor", path: "C:\\Donor", mode: "read" },
    ]);
  });
});

describe("folderGrant", () => {
  it("names the folder after its last segment, kept apart from ids already used", () => {
    expect(
      folderGrant({
        path: '  "C:\\Users\\me\\Documents\\neckermann-mobile\\"  ',
        mode: "write",
        providers: ["claude", "codex"],
        taken: ["neckermann-mobile"],
      }),
    ).toEqual({
      providers: ["claude", "codex"],
      roots: [
        {
          grantId: "neckermann-mobile-2",
          path: "C:\\Users\\me\\Documents\\neckermann-mobile",
          mode: "write",
          localOnly: false,
        },
      ],
    });
  });

  it("refuses a path that is not absolute, and offers every agent when the PC lists none", () => {
    expect(
      folderGrant({ path: "Documents\\x", mode: "write", providers: [], taken: [] }),
    ).toBeUndefined();
    expect(
      folderGrant({ path: "D:\\My Music", mode: "read", providers: [], taken: [] })?.roots[0],
    ).toMatchObject({ grantId: "my-music", mode: "read" });
    expect(
      folderGrant({ path: "D:\\", mode: "read", providers: [], taken: [] })?.providers,
    ).toEqual(["codex", "claude", "hermes", "local"]);
  });
});

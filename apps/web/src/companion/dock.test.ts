import type { IntelligenceState } from "@noctis/ui";
import { describe, expect, it } from "vitest";

import { dockFor } from "./dock.js";

const STATES: IntelligenceState[] = [
  "idle",
  "listening",
  "thinking",
  "speaking",
  "waiting_for_approval",
];

describe("where the one core sits", () => {
  it("fills Presence's hero slot and Threads' composer slot", () => {
    for (const mobile of [false, true]) {
      expect(dockFor("Presence", "idle", mobile)).toEqual({
        anchor: "slot",
        slot: "hero",
        size: 0,
      });
      expect(dockFor("Threads", "thinking", mobile)).toEqual({
        anchor: "slot",
        slot: "composer",
        size: 76,
      });
    }
  });

  it("stays out of the Vault's way unless an approval waits", () => {
    expect(dockFor("Vault", "idle", false)).toEqual({ anchor: "hidden", size: 0 });
    expect(dockFor("Vault", "thinking", true)).toEqual({ anchor: "hidden", size: 0 });
    expect(dockFor("Vault", "waiting_for_approval", false)).toEqual({
      anchor: "corner",
      size: 96,
    });
  });

  it("fills Command's hero slot on desktop and phone", () => {
    for (const mobile of [false, true]) {
      for (const state of STATES) {
        expect(dockFor("Command", state, mobile)).toEqual({
          anchor: "slot",
          slot: "hero",
          size: 0,
        });
      }
    }
  });

  it("docks in the corner everywhere else, smaller on a phone", () => {
    for (const page of ["Files", "Nodes", "Approvals", "Settings"] as const) {
      expect(dockFor(page, "idle", false)).toEqual({ anchor: "corner", size: 96 });
      expect(dockFor(page, "speaking", true)).toEqual({ anchor: "corner", size: 72 });
    }
  });

  it("never hides an approval", () => {
    for (const page of ["Presence", "Threads", "Files", "Vault", "Settings"] as const) {
      for (const mobile of [false, true]) {
        expect(dockFor(page, "waiting_for_approval", mobile).anchor).not.toBe("hidden");
      }
    }
    for (const state of STATES) {
      if (state !== "waiting_for_approval") {
        expect(dockFor("Vault", state, false).anchor).toBe("hidden");
      }
    }
  });
});

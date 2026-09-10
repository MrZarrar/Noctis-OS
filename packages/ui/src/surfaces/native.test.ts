import type { NativeApplicationState } from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import { PLACE_LABEL } from "./native.js";

const EVERY_STATE: ReadonlyArray<NativeApplicationState["kind"]> = [
  "notRunning",
  "discovered",
  "placed",
  "restored",
  "ambiguous",
  "needsApproval",
  "refused",
];

/**
 * These tests exist because of a defect the qualification run found, and they
 * are written against the *action table* rather than the rendered markup for
 * that reason.
 *
 * The Surface offered no place action in the `placed` state. Nothing was broken
 * in the placement layer, the shell, or the authority boundary — but "arrange
 * again after dragging it yourself" was the only route to the user override, so
 * the override could not be reached from the interface at all. It was the third
 * defect of that shape in one session: a mechanism built, tested in isolation,
 * and left with no path a person could take to it.
 */
describe("the place action", () => {
  it("has a decision for every state, so a new one cannot be forgotten", () => {
    for (const kind of EVERY_STATE) {
      expect(Object.hasOwn(PLACE_LABEL, kind), kind).toBe(true);
    }

    expect(Object.keys(PLACE_LABEL).sort()).toEqual([...EVERY_STATE].sort());
  });

  /**
   * THE GATE: Phase 9's gate says user overrides are respected, and the only
   * gesture that expresses one is arranging a window you have already moved by
   * hand. Without an action in this state the clause is unreachable.
   */
  it("is offered on a window that is already arranged", () => {
    expect(PLACE_LABEL.placed).toBeDefined();
  });

  it("is offered on a window that is open, put back, or was refused", () => {
    expect(PLACE_LABEL.discovered).toBeDefined();
    expect(PLACE_LABEL.restored).toBeDefined();
    expect(PLACE_LABEL.refused).toBeDefined();
  });

  /**
   * A button that cannot do what it says is worse than no button. There is
   * nothing to place when nothing is running, and both of the other two need a
   * different answer from a person first.
   */
  it("is not offered where it could not work", () => {
    expect(PLACE_LABEL.notRunning).toBeUndefined();
    expect(PLACE_LABEL.ambiguous).toBeUndefined();
    expect(PLACE_LABEL.needsApproval).toBeUndefined();
  });

  /** "Arrange this window" on something already arranged reads as a no-op. */
  it("says something different once the window is already arranged", () => {
    expect(PLACE_LABEL.placed).not.toBe(PLACE_LABEL.discovered);
  });

  it("labels every offered action in words rather than an identifier", () => {
    for (const label of Object.values(PLACE_LABEL)) {
      if (label === undefined) {
        continue;
      }

      expect(label).toMatch(/^[A-Z]/);
      expect(label).not.toContain("_");
    }
  });
});

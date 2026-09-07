import { describe, expect, it } from "vitest";

import { OperationClassSchema } from "./enums.js";
import {
  MonitorRoleSchema,
  RegionNameSchema,
  ResolutionNoteSchema,
  WINDOW_CAPABILITIES,
  WINDOW_CAPABILITY_OPERATION_CLASS,
  WINDOW_TARGET_TYPE,
  WindowPlacementRequestSchema,
  WindowRefusalSchema,
} from "./window.js";

describe("window capabilities", () => {
  it("gives every capability an operation class", () => {
    for (const capability of WINDOW_CAPABILITIES) {
      const operationClass = WINDOW_CAPABILITY_OPERATION_CLASS[capability];

      expect(OperationClassSchema.safeParse(operationClass).success).toBe(true);
    }

    expect(Object.keys(WINDOW_CAPABILITY_OPERATION_CLASS).sort()).toEqual(
      [...WINDOW_CAPABILITIES].sort(),
    );
  });

  /**
   * THE GATE: moving another application's window is a consequence, so only the
   * capability that reads may be classed as a read. If `window.place` ever
   * becomes `read_inspect` the baseline policy allows it outright, and focus
   * mode starts rearranging a desk nobody agreed to.
   */
  it("classes only discovery as a read", () => {
    expect(WINDOW_CAPABILITY_OPERATION_CLASS["window.discover"]).toBe("read_inspect");

    for (const capability of ["window.place", "window.restore"] as const) {
      expect(WINDOW_CAPABILITY_OPERATION_CLASS[capability]).not.toBe("read_inspect");
    }
  });

  /**
   * The classes standing permissions can never cover. Placement has to stay off
   * this list or focus mode would demand a typed confirmation per window, and a
   * confirmation that appears that often is one nobody reads.
   */
  it("keeps placement out of the classes a standing permission cannot cover", () => {
    const undelegable = ["spend", "destructive", "production_deploy", "credential_security"];

    for (const capability of WINDOW_CAPABILITIES) {
      expect(undelegable).not.toContain(WINDOW_CAPABILITY_OPERATION_CLASS[capability]);
    }
  });

  it("names a target type a permission can bind to", () => {
    expect(WINDOW_TARGET_TYPE).toBe("window");
  });
});

describe("placement requests", () => {
  const request = {
    applicationId: "vscode",
    monitor: "primary",
    region: "left_two_thirds",
  };

  it("accepts a named region on a named display role", () => {
    expect(WindowPlacementRequestSchema.safeParse(request).success).toBe(true);
  });

  /**
   * THE GATE: Section 11.2 — the placement layer "works with semantic placement
   * requests, not model-provided coordinates". The schema being strict is what
   * enforces that; a request that could smuggle an `x` past it would let a model
   * put a window anywhere, including somewhere it cannot be seen or dismissed.
   */
  it("refuses a request that tries to carry coordinates", () => {
    expect(
      WindowPlacementRequestSchema.safeParse({ ...request, x: 0, y: 0, width: 100, height: 100 })
        .success,
    ).toBe(false);
  });

  it("refuses a region it does not have a name for", () => {
    expect(
      WindowPlacementRequestSchema.safeParse({ ...request, region: "bottom_left_ish" }).success,
    ).toBe(false);
  });

  it("refuses a display named by index rather than by role", () => {
    expect(WindowPlacementRequestSchema.safeParse({ ...request, monitor: 1 }).success).toBe(false);
  });
});

/**
 * These spellings are the wire contract with `crates/noctis-windows`, whose
 * serde attributes produce exactly these strings. Both sides parse strictly, so
 * a name added on one side and forgotten on the other fails to deserialize
 * rather than being silently treated as some default.
 */
describe("wire spellings shared with the Rust crate", () => {
  it("spells the region names the way serde does", () => {
    expect(RegionNameSchema.options).toEqual([
      "full",
      "left_half",
      "right_half",
      "left_two_thirds",
      "right_third",
    ]);
  });

  it("spells the display roles the way serde does", () => {
    expect(MonitorRoleSchema.options).toEqual(["primary", "secondary"]);
  });

  it("spells the resolution notes the way serde does", () => {
    expect(ResolutionNoteSchema.options).toEqual([
      "degraded_to_primary",
      "honoured_user_override",
      "clamped_to_work_area",
      "raised_to_minimum_size",
    ]);
  });

  it("reads both refusals the Rust guard can produce", () => {
    expect(
      WindowRefusalSchema.safeParse({ reason: "protected", detail: "system window class Progman" })
        .success,
    ).toBe(true);
    expect(WindowRefusalSchema.safeParse({ reason: "not_granted" }).success).toBe(true);
  });

  /** A refusal without its reason is a refusal that reads as an approval. */
  it("refuses a refusal with no reason", () => {
    expect(WindowRefusalSchema.safeParse({ detail: "because" }).success).toBe(false);
  });
});

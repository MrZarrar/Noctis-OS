import { describe, expect, it } from "vitest";

import {
  MissionStatusSchema,
  NodeJobStatusSchema,
  NoirCaseStatusSchema,
  ObjectiveStatusSchema,
  SurfaceLifecycleSchema,
} from "./enums.js";

describe("status enums fail closed on unknown members", () => {
  it.each([
    ["objective", ObjectiveStatusSchema, "active", "archived"],
    ["mission", MissionStatusSchema, "running", "paused"],
    ["surface", SurfaceLifecycleSchema, "active", "hidden"],
    ["node job", NodeJobStatusSchema, "leased", "retrying"],
    ["noir case", NoirCaseStatusSchema, "investigating", "closed"],
  ] as const)(
    "%s accepts a known member and rejects an unknown one",
    (_name, schema, good, bad) => {
      expect(schema.safeParse(good).success).toBe(true);
      expect(schema.safeParse(bad).success).toBe(false);
    },
  );
});

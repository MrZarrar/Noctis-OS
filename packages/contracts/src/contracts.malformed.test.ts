import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import { ArtifactRecordSchema } from "./artifact.js";
import { AuthorityRequestSchema } from "./authority.js";
import { ConversationThreadSchema } from "./identity.js";
import { MissionRecordSchema } from "./mission.js";
import { NodeJobSchema } from "./node.js";
import { NoirCaseSchema } from "./noir.js";
import { ObjectiveRecordSchema } from "./objective.js";
import { SourceObservationSchema } from "./source.js";
import { SurfaceIntentSchema } from "./surface.js";

const SCHEMAS: ReadonlyArray<readonly [string, ZodType]> = [
  ["ArtifactRecord", ArtifactRecordSchema],
  ["AuthorityRequest", AuthorityRequestSchema],
  ["ConversationThread", ConversationThreadSchema],
  ["MissionRecord", MissionRecordSchema],
  ["NodeJob", NodeJobSchema],
  ["NoirCase", NoirCaseSchema],
  ["ObjectiveRecord", ObjectiveRecordSchema],
  ["SourceObservation", SourceObservationSchema],
  ["SurfaceIntent", SurfaceIntentSchema],
];

const HOSTILE_INPUTS: ReadonlyArray<readonly [string, unknown]> = [
  ["null", null],
  ["undefined", undefined],
  ["a string", "not an object"],
  ["a number", 7],
  ["an array", []],
  ["an empty object", {}],
  ["a prototype-polluting payload", JSON.parse('{"__proto__":{"polluted":true}}')],
];

describe("every schema rejects hostile input", () => {
  for (const [schemaName, schema] of SCHEMAS) {
    it.each(HOSTILE_INPUTS)(`${schemaName} rejects %s`, (_label, input) => {
      expect(schema.safeParse(input).success).toBe(false);
    });
  }
});

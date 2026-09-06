import { IdentityProfileSchema } from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import { IDENTITY_PROFILES, promptPlaceholder } from "./profiles.js";

describe("IDENTITY_PROFILES", () => {
  it("has exactly the two conversational identities, each a valid profile", () => {
    expect(IDENTITY_PROFILES.map((profile) => profile.id)).toEqual(["vesper", "jester"]);

    for (const profile of IDENTITY_PROFILES) {
      expect(IdentityProfileSchema.safeParse(profile).success).toBe(true);
    }
  });

  it("uses the exact activation commands the master plan locks", () => {
    expect(IDENTITY_PROFILES.find((profile) => profile.id === "vesper")?.activationCommand).toBe(
      "VESPER",
    );
    expect(IDENTITY_PROFILES.find((profile) => profile.id === "jester")?.activationCommand).toBe(
      "JESTER",
    );
  });
});

describe("promptPlaceholder", () => {
  it.each([
    ["vesper", "Ask Vesper..."],
    ["jester", "Ask Jester..."],
  ] as const)("renders %s as %s", (identityId, expected) => {
    expect(promptPlaceholder(identityId)).toBe(expected);
  });
});

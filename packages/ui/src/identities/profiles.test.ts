import { IdentityProfileSchema } from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import { IDENTITY_PROFILES, activationFor, promptPlaceholder } from "./profiles.js";

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

describe("activationFor", () => {
  it("switches on exactly the activation command, alone in the box", () => {
    expect(activationFor("JESTER")).toBe("jester");
    expect(activationFor("  VESPER\n")).toBe("vesper");
  });

  it("sends anything else as a message, a lowercase name or a sentence included", () => {
    for (const text of ["jester", "Jester", "JESTER, what do you think?", "ask JESTER", ""]) {
      expect(activationFor(text)).toBeUndefined();
    }
  });
});

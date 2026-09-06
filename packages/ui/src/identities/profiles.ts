import type { IdentityProfile } from "@noctis/contracts";

/**
 * The exact activation commands from the master plan's locked product
 * decisions: "`JESTER` activates Jester; `VESPER` activates Vesper." There is
 * no third row for NOIR — it is a protocol overlay on whichever identity is
 * active, not a command that activates it (Section 6).
 */
export const IDENTITY_PROFILES: readonly IdentityProfile[] = [
  { id: "vesper", displayName: "Vesper", activationCommand: "VESPER" },
  { id: "jester", displayName: "Jester", activationCommand: "JESTER" },
];

export function promptPlaceholder(identityId: IdentityProfile["id"]): string {
  const profile = IDENTITY_PROFILES.find((candidate) => candidate.id === identityId);

  return `Ask ${profile?.displayName ?? identityId}...`;
}

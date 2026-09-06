import type { ConversationalIdentityId, ProtocolId } from "@noctis/contracts";

import { identityAccent } from "../tokens/index.js";

export interface IdentityVisual {
  primary: string;
  secondary: string;
  /** Present only while NOIR is layered on top of the active identity. */
  noirOverlay?: { structure: string; amber: string; red: string };
}

/**
 * Pure and swappable: this is the seam the real Three.js renderer will sit
 * behind later (see the Phase 5 fidelity decision). NOIR never changes which
 * identity is active — it only adds `noirOverlay` — so this function cannot
 * express "NOIR" as an identity, only as a layer on one.
 */
export function visualForIdentity(
  identityId: ConversationalIdentityId,
  protocolIds: readonly ProtocolId[] = [],
): IdentityVisual {
  const base = identityAccent[identityId];

  return protocolIds.includes("noir") ? { ...base, noirOverlay: identityAccent.noir } : { ...base };
}

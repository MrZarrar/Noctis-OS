import type { ConversationalIdentityId, ProtocolId } from "@noctis/contracts";
import type { CSSProperties } from "react";

import { visualForIdentity } from "./visual.js";

export interface IntelligenceRendererProps {
  identityId: ConversationalIdentityId;
  protocolIds?: readonly ProtocolId[];
}

/**
 * Inlined rather than a separate .css file: a workspace-package stylesheet
 * would need its own copy step into `dist/` for a bundler to resolve it, and
 * this placeholder is getting replaced by the real Three.js renderer anyway
 * (see the Phase 5 fidelity decision) — not worth building that pipeline for.
 *
 * The animation is CSS, not a JS `requestAnimationFrame` loop, so there is no
 * per-frame budget to police and nothing to cancel on unmount: the browser's
 * compositor stops paying for it the instant the element leaves the DOM.
 * Section 5.2's idle-RAF requirement applies to the real renderer this stands
 * in for. `prefers-reduced-motion` is honoured natively by the media query.
 */
const STYLE = `
.noctis-intelligence {
  position: relative;
  width: 220px;
  height: 220px;
  border-radius: 50%;
  filter: blur(1px);
  animation: noctis-intelligence-pulse 4s ease-in-out infinite;
}
.noctis-intelligence__overlay {
  position: absolute;
  inset: -12px;
  border-radius: 50%;
  border: 1px solid var(--noctis-noir-structure, #f5f5f7);
  box-shadow:
    0 0 24px var(--noctis-noir-amber, #ffb020),
    inset 0 0 24px var(--noctis-noir-red, #ff4d4d);
  opacity: 0.5;
}
@media (prefers-reduced-motion: reduce) {
  .noctis-intelligence {
    animation: none;
  }
}
@keyframes noctis-intelligence-pulse {
  0%, 100% { transform: scale(1); opacity: 0.85; }
  50% { transform: scale(1.04); opacity: 1; }
}
`;

export function IntelligenceRenderer({
  identityId,
  protocolIds = [],
}: IntelligenceRendererProps): JSX.Element {
  const visual = visualForIdentity(identityId, protocolIds);

  return (
    <>
      <style>{STYLE}</style>
      <div
        role="img"
        aria-label={`${identityId} intelligence, ${protocolIds.includes("noir") ? "NOIR active" : "idle"}`}
        className="noctis-intelligence"
        style={{
          background: `radial-gradient(circle at 35% 30%, ${visual.primary}, ${visual.secondary} 70%)`,
        }}
      >
        {visual.noirOverlay !== undefined && (
          <div
            className="noctis-intelligence__overlay"
            style={
              {
                "--noctis-noir-structure": visual.noirOverlay.structure,
                "--noctis-noir-amber": visual.noirOverlay.amber,
                "--noctis-noir-red": visual.noirOverlay.red,
              } as CSSProperties
            }
          />
        )}
      </div>
    </>
  );
}

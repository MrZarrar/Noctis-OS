import {
  AttentionSurface,
  ConversationSurface,
  DetailSurface,
  EvidenceSurface,
  FallbackSurface,
  ListSurface,
  RecallSurface,
} from "@noctis/ui";
import type { RecallEvidenceView } from "@noctis/ui";
import type { ReactNode } from "react";

import type { Resolved, SurfaceKind } from "./registry.js";

/**
 * What a renderer may reach outside its own payload.
 *
 * Only handoffs live here — a Surface still cannot decide where it sits or
 * what it may do. "Open in Vault" is the one Section 7 asks for.
 */
export interface SurfaceContext {
  onOpenInVault?: (evidence: RecallEvidenceView) => void;
}

/**
 * The renderer half of the registry (Section 5.3), keyed by the same union the
 * schema half is. `Record<SurfaceKind, ...>` is the enforcement: registering a
 * kind without a renderer, or a renderer without a kind, does not compile.
 *
 * Every renderer receives an already-validated payload, so the casts here are
 * safe in exactly one direction — `resolveSurface` refuses anything its schema
 * rejected, and this table is unreachable for those.
 */
const RENDERERS: Record<SurfaceKind, (payload: never, context: SurfaceContext) => ReactNode> = {
  conversation: (payload: Parameters<typeof ConversationSurface>[0]) => (
    <ConversationSurface {...payload} />
  ),
  list: (payload: Parameters<typeof ListSurface>[0]) => <ListSurface {...payload} />,
  detail: (payload: Parameters<typeof DetailSurface>[0]) => <DetailSurface {...payload} />,
  evidence: (payload: Parameters<typeof EvidenceSurface>[0]) => <EvidenceSurface {...payload} />,
  attention: (payload: Parameters<typeof AttentionSurface>[0]) => <AttentionSurface {...payload} />,
  vault_recall: (payload: Parameters<typeof RecallSurface>[0], context: SurfaceContext) => (
    <RecallSurface
      {...payload}
      {...(context.onOpenInVault === undefined ? {} : { onOpenInVault: context.onOpenInVault })}
    />
  ),
};

export function renderSurface(resolved: Resolved, context: SurfaceContext = {}): ReactNode {
  if (resolved.status === "fallback") {
    return <FallbackSurface kind={resolved.kind} reason={resolved.reason} />;
  }

  return RENDERERS[resolved.kind](resolved.payload as never, context);
}

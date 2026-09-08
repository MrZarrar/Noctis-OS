import {
  ApprovalSurface,
  ArtifactSurface,
  AttentionSurface,
  ConversationSurface,
  DetailSurface,
  EvidenceSurface,
  FallbackSurface,
  ListSurface,
  NativeApplicationSurface,
  RecallSurface,
  SourceStateSurface,
} from "@noctis/ui";
import type { NativeFocusPayload } from "@noctis/contracts";
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
  /** Phase 8 handoffs. Each one crosses a boundary the Surface may not cross itself. */
  onConfirm?: (approvalId: string, typedConfirmation?: string) => void;
  onExecute?: (approvalId: string) => void;
  onImport?: (artifactId: string) => void;
  onRefreshSource?: (sourceId: string) => void;
  /**
   * Phase 9 handoffs. Placement crosses into another application's window, which
   * is the furthest thing from something a renderer may do for itself: these go
   * to the desktop shell, which asks the core before it moves anything.
   */
  onPlaceWindow?: (applicationId: string) => void;
  onRestoreWindow?: (applicationId: string) => void;
  onChooseWindow?: (applicationId: string, handle: number) => void;
  onReviewApproval?: (requestId: string) => void;
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
  approval: (payload: Parameters<typeof ApprovalSurface>[0], context: SurfaceContext) => (
    <ApprovalSurface
      {...payload}
      {...(context.onConfirm === undefined
        ? {}
        : {
            onConfirm: (typedConfirmation?: string) => {
              context.onConfirm?.(payload.id, typedConfirmation);
            },
          })}
      {...(context.onExecute === undefined
        ? {}
        : {
            onExecute: () => {
              context.onExecute?.(payload.id);
            },
          })}
    />
  ),
  artifact: (payload: Parameters<typeof ArtifactSurface>[0]) => <ArtifactSurface {...payload} />,
  // One Surface, several applications — see `NativeFocusPayloadSchema` for why
  // it cannot be one Surface each.
  native_application: (payload: NativeFocusPayload, context: SurfaceContext) => (
    <>
      {payload.applications.map((application) => (
        <NativeApplicationSurface
          key={application.applicationId}
          {...application}
          {...(context.onPlaceWindow === undefined
            ? {}
            : {
                onPlace: () => {
                  context.onPlaceWindow?.(application.applicationId);
                },
              })}
          {...(context.onRestoreWindow === undefined
            ? {}
            : {
                onRestore: () => {
                  context.onRestoreWindow?.(application.applicationId);
                },
              })}
          {...(context.onChooseWindow === undefined
            ? {}
            : {
                onChoose: (handle: number) => {
                  context.onChooseWindow?.(application.applicationId, handle);
                },
              })}
          {...(context.onReviewApproval === undefined
            ? {}
            : { onReview: context.onReviewApproval })}
        />
      ))}
    </>
  ),
  source_state: (
    payload: Parameters<typeof SourceStateSurface>[0] & { sourceId: string },
    context: SurfaceContext,
  ) => {
    const { sourceId, ...rest } = payload;

    return (
      <SourceStateSurface
        {...rest}
        {...(context.onRefreshSource === undefined
          ? {}
          : {
              onRefresh: () => {
                context.onRefreshSource?.(sourceId);
              },
            })}
      />
    );
  },
};

export function renderSurface(resolved: Resolved, context: SurfaceContext = {}): ReactNode {
  if (resolved.status === "fallback") {
    return <FallbackSurface kind={resolved.kind} reason={resolved.reason} />;
  }

  return RENDERERS[resolved.kind](resolved.payload as never, context);
}

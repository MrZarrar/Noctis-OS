import {
  ApprovalSurface,
  ArtifactSurface,
  AttentionSurface,
  ConversationSurface,
  DetailSurface,
  DocumentSurface,
  EvidenceSurface,
  ExternalToolSurface,
  FallbackSurface,
  ListSurface,
  MediaSurface,
  PanelActions,
  TimelineSurface,
  VerificationSurface,
  NativeApplicationSurface,
  RecallSurface,
  SourceStateSurface,
} from "@noctis/ui";
import type {
  ExternalToolFocusPayload,
  LiveBriefPayload,
  NativeFocusPayload,
  MediaPayload,
  MediaSource,
  SurfaceSize,
  DocumentPayload,
  PanelAction,
  SurfaceOwner,
  PagePanelPayload,
  VisualPayload,
} from "@noctis/contracts";
import { corner, depth, typography } from "@noctis/ui";
import { PANEL_PROPOSABLE_KINDS } from "@noctis/contracts";
import type { RecallEvidenceView } from "@noctis/ui";
import type { ReactNode } from "react";

import { LiveBriefSurface } from "./LiveBrief.js";
import { OptionsPanel } from "./OptionsPanel.js";
import { FileDocument } from "./FileDocument.js";
import { FileMedia, type FileImageCache } from "./FileMedia.js";
import type { FileTextCache } from "../pages/useFileText.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { Markdown } from "../conversation/Markdown.js";
import type { Resolved, SurfaceKind } from "./registry.js";

/**
 * What a renderer may reach outside its own payload.
 *
 * Only handoffs live here — a Surface still cannot decide where it sits or
 * what it may do. "Open in Vault" is the one Section 7 asks for.
 */
export interface SurfaceContext {
  fileText?: { cache: FileTextCache; surfaceId: string };
  fileMedia?: { cache: FileImageCache; surfaceId: string };
  renderPage?: (payload: PagePanelPayload) => ReactNode;
  fileTransport?: CoreTransport;
  contentRevision?: string;
  onOpenFile?: (source: Extract<MediaSource, { from: "file" }>) => void;
  panelOwner?: SurfaceOwner;
  onPanelAction?: (message: string, owner: SurfaceOwner) => void | Promise<void>;
  panelActionsDisabled?: boolean;
  panelActionsError?: string;
  mediaUrl?: (source: MediaSource, revision?: string) => string | undefined;
  /** Where a visual panel's page is served to run, sandboxed. */
  visualUrl?: (source: VisualPayload["source"], revision?: string) => string | undefined;
  onOpenInVault?: (evidence: RecallEvidenceView) => void;
  /** Phase 8 handoffs. Each one crosses a boundary the Surface may not cross itself. */
  onConfirm?: (approvalId: string, typedConfirmation?: string) => void;
  onDecline?: (approvalId: string) => void;
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
  onChooseWindow?: (applicationId: string, windowTitle: string) => void;
  onClearWindowOverride?: (applicationId: string) => void;
  onSurveyWindows?: () => void;
  /**
   * Phase 10 handoffs. Taking a tool route starts a program or opens somebody's
   * own browser, which is the same kind of thing placement is: it goes to the
   * shell, which asks the core before it reaches anything.
   */
  onActOnTool?: (toolId: string, verbId: string) => void;
  onSurveyTools?: () => void;
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
const RENDERERS: Record<
  SurfaceKind,
  (payload: never, context: SurfaceContext, size: SurfaceSize) => ReactNode
> = {
  page: (payload: PagePanelPayload, context: SurfaceContext) => (
    <div
      className="page-panel"
      style={{
        display: "flex",
        minWidth: 0,
        height: "min(680px, 65dvh)",
        overflow: "auto",
        containerType: "inline-size",
      }}
    >
      {context.renderPage?.(payload) ?? <p>Open {payload.page} from the navigation.</p>}
    </div>
  ),
  document: (payload: DocumentPayload, context: SurfaceContext) => (
    <div className="document-panel">
      <DocumentSurface
        {...payload}
        {...(payload.content.from === "file"
          ? { body: <FileDocument payload={payload} context={context} /> }
          : payload.format === "markdown"
            ? { body: <Markdown text={payload.content.text} readOnlyTasks /> }
            : {})}
      />
    </div>
  ),
  visual: (payload: VisualPayload, context: SurfaceContext) => {
    const url = context.visualUrl?.(payload.source, context.contentRevision);

    // `allow-scripts` alone: without `allow-same-origin` the page gets an
    // opaque origin, so it cannot read the session cookie or call the core.
    return url === undefined ? (
      <p style={{ margin: 0, color: typography.color.muted }}>
        {payload.source.relativePath} can be opened from Files.
      </p>
    ) : (
      <iframe
        title={payload.title}
        src={url}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        loading="lazy"
        style={{
          display: "block",
          width: "100%",
          height: "min(640px, 65dvh)",
          border: 0,
          borderRadius: corner.sm,
          background: depth.layers[0],
        }}
      />
    );
  },
  timeline: (payload: Parameters<typeof TimelineSurface>[0]) => <TimelineSurface {...payload} />,
  verification: (payload: Parameters<typeof VerificationSurface>[0]) => (
    <VerificationSurface {...payload} />
  ),
  media: (payload: MediaPayload, context: SurfaceContext, size: SurfaceSize) => {
    const url = context.mediaUrl?.(payload.source, context.contentRevision);
    return payload.source.from === "file" &&
      payload.mediaType.startsWith("image/") &&
      context.fileMedia !== undefined ? (
      <FileMedia payload={payload} url={url} size={size} retained={context.fileMedia} />
    ) : (
      <MediaSurface title={payload.title} mediaType={payload.mediaType} url={url} size={size} />
    );
  },
  live_brief: (payload: LiveBriefPayload) => <LiveBriefSurface {...payload} />,
  conversation: (payload: Parameters<typeof ConversationSurface>[0]) => (
    <ConversationSurface {...payload} />
  ),
  list: (payload: Parameters<typeof ListSurface>[0]) => <ListSurface {...payload} />,
  options: (payload: Parameters<typeof OptionsPanel>[0]["payload"], context: SurfaceContext) => (
    <OptionsPanel payload={payload} context={context} />
  ),
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
      {...(context.onDecline === undefined
        ? {}
        : {
            onDecline: () => {
              context.onDecline?.(payload.id);
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
                onChoose: (windowTitle: string) => {
                  context.onChooseWindow?.(application.applicationId, windowTitle);
                },
              })}
          {...(context.onReviewApproval === undefined
            ? {}
            : { onReview: context.onReviewApproval })}
          {...(context.onSurveyWindows === undefined ? {} : { onRefresh: context.onSurveyWindows })}
          {...(context.onClearWindowOverride === undefined
            ? {}
            : {
                onClearOverride: () => {
                  context.onClearWindowOverride?.(application.applicationId);
                },
              })}
        />
      ))}
    </>
  ),
  // One Surface, several tools — the same reason `native_application` carries
  // all its applications: a surface intent's identity is
  // `(objectiveId, kind, sourceIds)`, so a second intent of the same kind would
  // overwrite the first rather than sit beside it.
  external_tool: (payload: ExternalToolFocusPayload, context: SurfaceContext) => (
    <>
      {payload.tools.map((tool) => (
        <ExternalToolSurface
          key={tool.toolId}
          {...tool}
          {...(context.onActOnTool === undefined
            ? {}
            : {
                onAct: (verbId: string) => {
                  context.onActOnTool?.(tool.toolId, verbId);
                },
              })}
          {...(context.onReviewApproval === undefined
            ? {}
            : { onReview: context.onReviewApproval })}
          {...(context.onSurveyTools === undefined ? {} : { onRefresh: context.onSurveyTools })}
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

export function renderSurface(
  resolved: Resolved,
  context: SurfaceContext = {},
  size: SurfaceSize = "standard",
): ReactNode {
  if (resolved.status === "fallback") {
    return <FallbackSurface kind={resolved.kind} reason={resolved.reason} />;
  }

  const payload = resolved.payload as { actions?: PanelAction[] };
  if (!PANEL_PROPOSABLE_KINDS.has(resolved.kind))
    return RENDERERS[resolved.kind](resolved.payload as never, context, size);
  const { actions, ...body } = payload;
  return (
    <>
      {RENDERERS[resolved.kind](body as never, context, size)}
      {actions !== undefined && actions.length > 0 && (
        <PanelActions
          actions={actions}
          {...(context.onPanelAction === undefined || context.panelOwner === undefined
            ? {}
            : {
                onAction: (message: string) =>
                  context.onPanelAction?.(message, context.panelOwner!),
              })}
          {...(context.panelActionsDisabled === undefined
            ? {}
            : { disabled: context.panelActionsDisabled })}
          {...(context.panelActionsError === undefined ? {} : { error: context.panelActionsError })}
        />
      )}
    </>
  );
}

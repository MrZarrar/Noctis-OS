import type {
  ExternalToolPayload,
  ModelRef,
  MonitorRole,
  NativeApplicationPayload,
  ObjectiveRecord,
  RegionName,
  ToolCapability,
  WindowCapability,
} from "@noctis/contracts";
import { ObjectiveRecordSchema } from "@noctis/contracts";
import { chooseRoute } from "@noctis/domain";
import { IDENTITY_PROFILES, corner, material, semantic, spacing, typography } from "@noctis/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import type { ConversationState } from "../conversation/useConversation.js";
import type { IdentityRuntimeState } from "../identities/useIdentityRuntime.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import type { ExternalToolBridge, SurveyedTool } from "../transport/ExternalToolBridge.js";
import { externalToolBridgeFrom } from "../transport/ExternalToolBridge.js";
import type { NativeWindowBridge, SurveyedApplication } from "../transport/NativeWindowBridge.js";
import { nativeWindowBridgeFrom } from "../transport/NativeWindowBridge.js";
import { Workbench } from "../workbench/Workbench.js";
import { useComposition } from "../workbench/useComposition.js";
import { Presence } from "./Presence.js";

/**
 * A 200 does not prove the body came from the core. `parseCoreBody` says as
 * much — a proxy or captive portal can answer anything — so the shape is
 * checked rather than asserted. This exists because it was not: an unmatched
 * dev-proxy path returned the SPA's own HTML with a 200, and reading
 * `.objectives` off it took the whole page down.
 */
const ObjectiveListSchema = z.object({ objectives: z.array(ObjectiveRecordSchema) });

let keySequence = 0;

function nextKey(scope: string): string {
  keySequence += 1;

  return `web-${scope}-${String(keySequence)}-${String(Date.now())}`;
}

/**
 * The Surfaces an Objective is born with.
 *
 * Every field here comes from the Objective record itself — nothing is invented
 * to fill a frame. When Phase 8 gives the identities a provider, they propose
 * Surfaces through the same `surface.upsert_intent` command and this function
 * goes away; the upsert is keyed by Surface identity, so proposing the same
 * three twice updates them rather than duplicating them.
 */
function seedIntents(objective: ObjectiveRecord): Array<Record<string, unknown>> {
  const author =
    IDENTITY_PROFILES.find((profile) => profile.id === objective.identityId)?.displayName ??
    objective.identityId;

  return [
    {
      kind: "conversation",
      role: "primary",
      persistence: "objective",
      priority: 100,
      minSize: "standard",
      payloadVersion: 1,
      payload: { messages: [{ id: objective.id, author, text: objective.intent }] },
    },
    {
      kind: "detail",
      role: "supporting",
      // Pinned: the Objective's own facts should survive a recomposition that
      // pushes other Surfaces into overflow.
      persistence: "pinned",
      priority: 50,
      minSize: "compact",
      payloadVersion: 1,
      payload: {
        fields: [
          { label: "Title", value: objective.title },
          { label: "Status", value: objective.status },
          { label: "Identity", value: objective.identityId },
          { label: "Activated", value: objective.activatedAt ?? "not yet" },
        ],
      },
    },
    {
      kind: "list",
      role: "context",
      persistence: "objective",
      priority: 10,
      minSize: "compact",
      payloadVersion: 1,
      payload: {
        items: [
          { id: "paused", label: "Pause", detail: "keeps the Objective and its Surfaces" },
          { id: "completed", label: "Complete", detail: "closes it and clears the canvas" },
          { id: "abandoned", label: "Abandon", detail: "closes it without completing" },
        ],
      },
    },
  ];
}

export interface CommandProps {
  transport: CoreTransport | undefined;
  /**
   * Owned by App, because Chat needs the same identity and the same Objective.
   * Two `useIdentityRuntime` calls would be two copies of "which identity is
   * active" that could disagree.
   */
  identity: IdentityRuntimeState;
  /** The identity's conversation, for Presence's model selector. */
  conversation: Pick<ConversationState, "models" | "defaultModel" | "canAttach">;
  /** Presence's prompt: sends on the thread and takes the rail to Chat. */
  onSend: (text: string, model?: ModelRef) => void;
  /** Handoff to the dedicated Vault view, from a recall Surface. */
  onOpenInVault?: (entityId: string) => void;
}

/**
 * Runs one recall for the Objective and, only if it found something, proposes
 * the Surface that shows it.
 *
 * Failing quietly is deliberate: no configured Vault, or a Vault with nothing
 * to say, should leave the canvas exactly as it was rather than adding an empty
 * frame explaining its own absence.
 */
async function recallForObjective(
  transport: CoreTransport,
  objective: ObjectiveRecord,
): Promise<void> {
  const response = await transport.request("POST", "/commands/vault.recall", {
    idempotencyKey: nextKey("vault.recall"),
    query: objective.title,
    objectiveId: objective.id,
  });

  const parsed = RecallResultSchema.safeParse(response.body);

  if (response.status !== 200 || !parsed.success || parsed.data.evidence.length === 0) {
    return;
  }

  await transport.request("POST", "/commands/surface.upsert_intent", {
    idempotencyKey: nextKey("surface.upsert_intent"),
    objectiveId: objective.id,
    kind: "vault_recall",
    role: "context",
    persistence: "objective",
    priority: 30,
    minSize: "compact",
    payloadVersion: 1,
    payload: {
      query: objective.title,
      freshness: parsed.data.freshness,
      evidence: parsed.data.evidence,
    },
  });
}

/**
 * The regions focus mode puts the development tools in.
 *
 * Written here rather than chosen by a model: Section 11.2 says the placement
 * layer takes semantic requests, and this is the semantics. The editor gets the
 * larger share because that is where the work happens, and the emulator sits
 * beside it rather than behind it because a blocker you cannot see is a blocker
 * you diagnose by guessing.
 */
const FOCUS_LAYOUT: Readonly<Record<string, { monitor: MonitorRole; region: RegionName }>> = {
  vscode: { monitor: "primary", region: "left_two_thirds" },
  emulator: { monitor: "primary", region: "right_third" },
};

/**
 * Surveys the native applications focus mode arranges and proposes a Surface
 * for each one it has something to say about.
 *
 * Mirrors `recallForObjective` deliberately, including the quiet failure. No
 * desktop shell means no bridge and no Surfaces at all — a page served in a
 * browser has no Win32 behind it, and a frame explaining that would be a frame
 * about Noctis rather than about the work.
 *
 * A Surface is proposed even for an application that is not running, because
 * "the emulator is not open" is a fact about the state of the work. It is not
 * proposed for an application focus mode has no layout for.
 */
async function focusForObjective(
  transport: CoreTransport,
  bridge: NativeWindowBridge,
  objective: ObjectiveRecord,
): Promise<void> {
  let surveyed: SurveyedApplication[];

  try {
    surveyed = await bridge.survey();
  } catch {
    // The shell is there but refused or drifted. Leave the canvas alone.
    return;
  }

  const applications = surveyed
    .filter((application) => Object.hasOwn(FOCUS_LAYOUT, application.applicationId))
    .map((application) => {
      const layout = FOCUS_LAYOUT[application.applicationId];

      return {
        applicationId: application.applicationId,
        displayName: application.displayName,
        intendedMonitor: layout?.monitor ?? "primary",
        intendedRegion: layout?.region ?? "full",
        state: application.state,
      };
    });

  if (applications.length === 0) {
    return;
  }

  await upsertFocusSurface(transport, objective.id, applications);
}

/**
 * The single `native_application` intent for an Objective.
 *
 * Extracted because it is called twice: once on activation from the survey, and
 * again after every placement, so that what the Surface shows is what actually
 * happened rather than what was asked for. The upsert is keyed by
 * `(objectiveId, kind, sourceIds)`, so calling it again updates the same
 * Surface instead of adding another.
 */
async function upsertFocusSurface(
  transport: CoreTransport,
  objectiveId: string,
  applications: readonly NativeApplicationPayload[],
): Promise<void> {
  await transport.request("POST", "/commands/surface.upsert_intent", {
    idempotencyKey: nextKey("surface.upsert_intent"),
    objectiveId,
    kind: "native_application",
    role: "supporting",
    persistence: "objective",
    priority: 40,
    minSize: "standard",
    payloadVersion: 1,
    payload: { applications },
  });
}

/**
 * Surveys the specialist tools and proposes one Surface carrying all of them.
 *
 * The route is chosen here, by `chooseRoute`, from three declared facts: what
 * the tool offers, what the shell says it can reach, and which capabilities a
 * desktop shell makes available at all. Nothing about Suno or Vinted appears in
 * this function, and nothing should — a tool is a row in the shell's registry,
 * and if adding one ever needs a change here, the router is not general.
 */
async function toolsForObjective(
  transport: CoreTransport,
  bridge: ExternalToolBridge,
  objective: ObjectiveRecord,
): Promise<void> {
  let surveyed: SurveyedTool[];

  try {
    surveyed = await bridge.survey();
  } catch {
    // The shell is there but refused or drifted. Leave the canvas alone.
    return;
  }

  const tools = surveyed.map((tool) => {
    const chosen = chooseRoute({
      summary: {
        toolId: tool.toolId,
        declaredRoutes: tool.declaredRoutes,
        verbs: tool.verbs,
      },
      granted: SHELL_TOOL_CAPABILITIES,
      availability: tool.availability,
    });

    return {
      toolId: tool.toolId,
      displayName: tool.displayName,
      route: chosen.route,
      degradedFrom: chosen.degradedFrom,
      verbs: tool.verbs.map((verb) => ({ id: verb.id, label: verb.label })),
      // Nothing has been asked of this tool yet, which is a state rather than an
      // absence — it is what the go-ahead action is offered from.
      state: { kind: "ready" } as const,
    };
  });

  if (tools.length === 0) {
    return;
  }

  await upsertToolSurface(transport, objective.id, tools);
}

/**
 * The capabilities a desktop shell makes reachable.
 *
 * Not an authority grant, and it must not be mistaken for one: the core decides
 * every act on every request regardless of what is in this set. It is an
 * eligibility filter, answering "could this route be taken at all here", which
 * is the same question `requires` answers for a whole Surface.
 *
 * `browser.control_profile` is absent, deliberately. Section 12.3 keeps
 * existing-profile *control* separately granted from everything else, and no
 * executor for it exists — so the router degrades past it rather than routing to
 * something that cannot run.
 */
const SHELL_TOOL_CAPABILITIES: ReadonlySet<ToolCapability> = new Set<ToolCapability>([
  "tool.inspect",
  "tool.launch",
  "tool.run_command",
  "browser.open_visible",
]);

/**
 * The single `external_tool` intent for an Objective.
 *
 * One Surface carrying every tool, for the reason the native one is: a surface
 * intent's identity is `(objectiveId, kind, sourceIds)`, so a second intent of
 * the same kind and sources is the same intent and the upsert would overwrite
 * rather than add.
 */
async function upsertToolSurface(
  transport: CoreTransport,
  objectiveId: string,
  tools: readonly ExternalToolPayload[],
): Promise<void> {
  await transport.request("POST", "/commands/surface.upsert_intent", {
    idempotencyKey: nextKey("surface.upsert_intent"),
    objectiveId,
    kind: "external_tool",
    role: "supporting",
    persistence: "objective",
    priority: 45,
    minSize: "standard",
    payloadVersion: 1,
    payload: { tools },
  });
}

/**
 * What the Vault already knows about a freshly activated Objective.
 *
 * Section 7: "Command receives only a focused recall Surface". The recall runs
 * once, on activation, and becomes one Surface among the others — Command never
 * shows a graph, and a Surface is only created when there is something to show.
 */
/**
 * An approval record, as much of it as the Approval Surface renders.
 *
 * Parsed rather than asserted, for the reason `ObjectiveListSchema` exists: a
 * 200 does not prove the body came from the core.
 */
const ApprovalRecordSchema = z.object({
  id: z.string().min(1),
  capability: z.string().min(1),
  target: z.object({ type: z.string().min(1), id: z.string().min(1) }),
  consequenceSummary: z.string().min(1),
  operationClass: z.string().min(1),
  reversibility: z.enum(["reversible", "partially_reversible", "irreversible"]),
  outcome: z.enum(["allow", "deny", "require_confirmation", "require_typed_confirmation"]),
  reasonCodes: z.array(z.string()),
  estimatedCostGbp: z.number().nonnegative().optional(),
  confirmationPhrase: z.string().min(1).optional(),
  confirmedAt: z.string().min(1).optional(),
  executedAt: z.string().min(1).optional(),
  declinedAt: z.string().min(1).optional(),
});

type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

/**
 * Puts a pending decision on the canvas.
 *
 * Until this existed, nothing in Noctis proposed an `approval` intent — so
 * `ApprovalSurface`, the registry entry, and `authority.confirm` were all
 * reachable only from a test. Phase 9 shipped over it because placement under an
 * active Objective is allowed outright and never asks; the first route that
 * actually needed a human answer had nowhere to put the question.
 *
 * The whole record is fetched rather than built from the shell's four-field
 * `needsApproval`, because the Surface renders the operation class, the target,
 * the reversibility and the reason codes — and a boundary screen assembled from
 * a summary would be a boundary screen that cannot show what it is agreeing to.
 */
async function showApproval(
  transport: CoreTransport,
  objectiveId: string,
  requestId: string,
): Promise<void> {
  const response = await transport.request("GET", `/approvals/${requestId}`);
  const parsed = ApprovalRecordSchema.safeParse(response.body);

  if (response.status !== 200 || !parsed.success) {
    return;
  }

  const approval = parsed.data;

  await transport.request("POST", "/commands/surface.upsert_intent", {
    idempotencyKey: nextKey("surface.upsert_intent"),
    objectiveId,
    kind: "approval",
    // Section 5.5's attention state. A decision Noctis is blocked on is the one
    // thing on the canvas that is not about the work but about Noctis waiting.
    role: "attention",
    persistence: "objective",
    // Above every other Surface. A consequence boundary that composed into
    // overflow would be a boundary nobody was asked at.
    priority: 90,
    minSize: "standard",
    payloadVersion: 1,
    payload: {
      id: approval.id,
      consequenceSummary: approval.consequenceSummary,
      operationClass: approval.operationClass,
      capability: approval.capability,
      targetType: approval.target.type,
      targetId: approval.target.id,
      reversibility: approval.reversibility,
      outcome: approval.outcome,
      reasonCodes: approval.reasonCodes,
      ...(approval.estimatedCostGbp === undefined
        ? {}
        : { estimatedCostGbp: approval.estimatedCostGbp }),
      ...(approval.confirmationPhrase === undefined
        ? {}
        : { confirmationPhrase: approval.confirmationPhrase }),
      ...(approval.confirmedAt === undefined ? {} : { confirmedAt: approval.confirmedAt }),
      ...(approval.executedAt === undefined ? {} : { executedAt: approval.executedAt }),
      ...(approval.declinedAt === undefined ? {} : { declinedAt: approval.declinedAt }),
    },
  });
}

/**
 * What carrying out a confirmed approval means, per capability.
 *
 * A total table over both capability lists, and `satisfies` is the enforcement:
 * a capability added to either list without a decision here does not compile.
 * That is the only reason this is a table rather than two `if`s — three of Phase
 * 9's seven defects were a mechanism with no path a person could take to it, and
 * a condition chain is how a path goes missing without anything failing.
 *
 * `none` is a real answer, not a gap. `window.discover` and `tool.inspect` are
 * allowed by policy and never produce an approval to confirm; `window.restore`
 * is authorised by membership of the moved-window map rather than by a record;
 * and `tool.register_descriptor` has no command yet, so a confirmation for one
 * could not exist.
 */
const RETRY_AFTER_CONFIRM = {
  "window.discover": "none",
  "window.place": "window",
  "window.restore": "none",
  "tool.inspect": "none",
  "tool.launch": "tool",
  "tool.run_command": "tool",
  "browser.open_visible": "tool",
  "browser.automate_isolated": "tool",
  "browser.control_profile": "tool",
  "tool.register_descriptor": "none",
} as const satisfies Record<WindowCapability | ToolCapability, "window" | "tool" | "none">;

/**
 * What to do about a confirmed approval, from a capability the core spelled.
 *
 * The capability arrives as a string, because the core's approval record is the
 * authority on it and it is not narrowed to these two lists. So a capability
 * this page does not know does nothing at all: the confirmation is recorded and
 * the act is not retried, which leaves an approval visible in the audit as
 * confirmed and unexecuted. Guessing would be the alternative, and guessing at
 * the consequence boundary is the one place it is never worth it.
 */
function retryKindFor(capability: string): "window" | "tool" | "none" {
  return Object.hasOwn(RETRY_AFTER_CONFIRM, capability)
    ? RETRY_AFTER_CONFIRM[capability as keyof typeof RETRY_AFTER_CONFIRM]
    : "none";
}

const RecallResultSchema = z.object({
  entityIds: z.array(z.string()),
  evidence: z.array(
    z.object({
      itemId: z.string(),
      entityId: z.string(),
      path: z.string(),
      quote: z.string(),
      freshness: z.enum(["current", "stale", "unavailable", "unknown"]),
    }),
  ),
  freshness: z.enum(["current", "stale", "unavailable", "unknown"]),
});

/**
 * The Command page: Presence when there is no active Objective, Active Canvas
 * when there is.
 *
 * Objective is state, not a route (Section 5.1) — which is why activating one
 * changes what this single page renders rather than navigating anywhere.
 */
export function Command({
  transport,
  identity,
  conversation,
  onSend,
  onOpenInVault,
}: CommandProps): JSX.Element {
  const [objectives, setObjectives] = useState<readonly ObjectiveRecord[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);

  const active = objectives.find((objective) => objective.id === identity.activeObjectiveId);
  const composition = useComposition(transport, active?.id);
  const { refresh } = composition;
  /** The Objective the native windows were last surveyed for. */
  const surveyedFor = useRef<string>();
  /**
   * `undefined` in a browser, and that is the answer rather than a failure: a
   * page with no desktop shell behind it has no Win32, so focus mode does not
   * appear at all instead of appearing and refusing.
   */
  const bridge = useMemo(() => nativeWindowBridgeFrom(globalThis), []);
  /** The same fact, for tools: no desktop shell means nothing to route through. */
  const toolBridge = useMemo(() => externalToolBridgeFrom(globalThis), []);

  /**
   * Re-surveys the native windows and re-proposes the Surface.
   *
   * A Surface payload is persisted, which is what lets a Surface survive a
   * restart — and is exactly why one describing the *outside world* cannot be
   * trusted after one. Activation alone is not enough: a shell restarted against
   * an already-active Objective never activates anything, so nothing ever
   * looked, and the canvas showed a snapshot from before.
   */
  const surveyWindows = useCallback(() => {
    if (transport === undefined || bridge === undefined || active === undefined) {
      return;
    }

    void focusForObjective(transport, bridge, active).then(refresh, () => {
      // `focusForObjective` already swallows a shell that cannot answer. This
      // catches only the upsert, and a failed refresh leaves the canvas as it
      // was rather than blanking it.
    });
  }, [transport, bridge, active, refresh]);

  /**
   * Re-surveys the tools and re-proposes the Surface.
   *
   * Same shape and same reason as `surveyWindows`: a payload describing which
   * programs are installed is a snapshot, and it is wrong the moment somebody
   * installs one.
   */
  const surveyTools = useCallback(() => {
    if (transport === undefined || toolBridge === undefined || active === undefined) {
      return;
    }

    void toolsForObjective(transport, toolBridge, active).then(refresh, () => {
      // `toolsForObjective` already swallows a shell that cannot answer. This
      // catches only the upsert, and a failed refresh leaves the canvas as it
      // was rather than blanking it.
    });
  }, [transport, toolBridge, active, refresh]);

  /**
   * Surveys once per active Objective, including on a fresh page load.
   *
   * Keyed on the Objective's id rather than a boolean, so switching Objectives
   * surveys again while a re-render does not.
   */
  useEffect(() => {
    if (active === undefined || surveyedFor.current === active.id) {
      return;
    }

    surveyedFor.current = active.id;
    surveyWindows();
    surveyTools();
  }, [active, surveyWindows, surveyTools]);

  /**
   * Runs a placement and re-proposes the Surface with what actually happened.
   *
   * The second half is the point. Rendering the requested region as though it
   * had been achieved is exactly the dishonesty the resolution notes exist to
   * prevent, so the outcome the shell returns — placed, refused, ambiguous, or
   * waiting for approval — replaces the state in the payload.
   */
  const runPlacement = useCallback(
    async (
      applicationId: string,
      act: (bridge: NativeWindowBridge) => Promise<NativeApplicationPayload["state"]>,
    ) => {
      if (transport === undefined || bridge === undefined || active === undefined) {
        return;
      }

      const current = composition.intents.find((intent) => intent.kind === "native_application");
      const payload = current?.payload as { applications?: NativeApplicationPayload[] } | undefined;
      const applications = payload?.applications;

      if (applications === undefined) {
        return;
      }

      let state: NativeApplicationPayload["state"];

      try {
        state = await act(bridge);
      } catch (failure: unknown) {
        state = {
          kind: "refused",
          reason: failure instanceof Error ? failure.message : "the shell refused the request",
        };
      }

      await upsertFocusSurface(
        transport,
        active.id,
        applications.map((application) =>
          application.applicationId === applicationId ? { ...application, state } : application,
        ),
      );

      // The same gap placement had all along, and never hit: under an active
      // Objective a placement is allowed outright, so nothing ever asked.
      if (state.kind === "needsApproval") {
        await showApproval(transport, active.id, state.requestId);
      }

      composition.refresh();
    },
    [transport, bridge, active, composition],
  );

  /**
   * Takes a tool route and re-proposes the Surface with what actually happened.
   *
   * The second half is the point, exactly as it is for placement: rendering the
   * route as though it had succeeded is the dishonesty the outcome variants
   * exist to prevent, so the shell's answer — handed off, launched, waiting for
   * approval, or unavailable — replaces the state in the payload.
   */
  const actOnTool = useCallback(
    async (toolId: string, verbId: string, approvalId?: string): Promise<void> => {
      if (transport === undefined || toolBridge === undefined || active === undefined) {
        return;
      }

      const current = composition.intents.find((intent) => intent.kind === "external_tool");
      const payload = current?.payload as { tools?: ExternalToolPayload[] } | undefined;
      const tools = payload?.tools;
      const tool = tools?.find((candidate) => candidate.toolId === toolId);

      if (tools === undefined || tool === undefined) {
        return;
      }

      await (async () => {
        let state: ExternalToolPayload["state"];

        try {
          state = await toolBridge.execute({
            toolId,
            verbId,
            // The route the router already chose and the Surface already showed.
            // The shell re-checks it against its own descriptor rather than
            // taking the page's word, so this is a request and not an
            // instruction.
            route: tool.route,
            objectiveId: active.id,
            // Present only on the second attempt, after a person confirmed.
            ...(approvalId === undefined ? {} : { approvalId }),
          });
        } catch (failure: unknown) {
          state = {
            kind: "refused",
            reason: failure instanceof Error ? failure.message : "the shell refused the request",
          };
        }

        await upsertToolSurface(
          transport,
          active.id,
          tools.map((candidate) =>
            candidate.toolId === toolId ? { ...candidate, state } : candidate,
          ),
        );

        // A decision with nowhere to be made is not a decision. Without this the
        // Surface renders the consequence summary and there is no control in
        // Noctis that can answer it.
        if (state.kind === "needsApproval") {
          await showApproval(transport, active.id, state.requestId);
        }

        composition.refresh();
      })();
    },
    [transport, toolBridge, active, composition],
  );

  /**
   * Returns its promise rather than discarding it, so a confirmation can wait
   * for the placement it authorised before re-reading the approval record. The
   * handoff that reaches a Surface discards it at the call site instead.
   */
  const placeWindow = useCallback(
    async (applicationId: string, approvalId?: string): Promise<void> => {
      await runPlacement(applicationId, async (native) => {
        const layout = FOCUS_LAYOUT[applicationId];

        return native.place({
          applicationId,
          monitor: layout?.monitor ?? "primary",
          region: layout?.region ?? "full",
          ...(active === undefined ? {} : { objectiveId: active.id }),
          // The Objective's own title, so two editors on the same machine are
          // told apart by the work rather than by enumeration order.
          ...(active === undefined ? {} : { titleHint: active.title }),
          // Present only on the second attempt, after a person confirmed. The
          // shell re-checks that this approval covers this application before
          // it moves anything.
          ...(approvalId === undefined ? {} : { approvalId }),
        });
      });
    },
    [runPlacement, active],
  );

  const restoreWindow = useCallback(
    (applicationId: string) => {
      void runPlacement(applicationId, (native) => native.restore(applicationId));
    },
    [runPlacement],
  );

  /**
   * Answers "which of these windows did you mean" by placing the one chosen.
   *
   * The window's own full title becomes the hint, which narrows to exactly that
   * window and nothing else. This is the path that matters: the Objective's
   * title is a *sentence*, and `narrow_by_title` asks whether the window title
   * contains the hint — so "Qualify Phase 9 on Noctis-OS" resolves nothing,
   * however much of the workspace name it happens to include. When Noctis
   * cannot tell, the answer is a person's, and it has to be clickable.
   */
  const chooseWindow = useCallback(
    (applicationId: string, windowTitle: string) => {
      void runPlacement(applicationId, (native) => {
        const layout = FOCUS_LAYOUT[applicationId];

        return native.place({
          applicationId,
          monitor: layout?.monitor ?? "primary",
          region: layout?.region ?? "full",
          ...(active === undefined ? {} : { objectiveId: active.id }),
          titleHint: windowTitle,
        });
      });
    },
    // `active` is listed even though `runPlacement` already depends on it and
    // would invalidate this callback anyway. Leaning on that would make this
    // correct by accident, and wrong the moment `runPlacement` stops needing it.
    [runPlacement, active],
  );

  /**
   * Forgets a dragged position and places again in the same step.
   *
   * One action rather than two, because "use the intended region instead" is a
   * single thing a person wants. Clearing the override and leaving the window
   * where it is would make the button appear to do nothing.
   */
  const clearWindowOverride = useCallback(
    (applicationId: string) => {
      void runPlacement(applicationId, async (native) => {
        await native.clearOverride(applicationId);

        const layout = FOCUS_LAYOUT[applicationId];

        return native.place({
          applicationId,
          monitor: layout?.monitor ?? "primary",
          region: layout?.region ?? "full",
          ...(active === undefined ? {} : { objectiveId: active.id }),
          ...(active === undefined ? {} : { titleHint: active.title }),
        });
      });
    },
    [runPlacement, active],
  );

  /**
   * Puts a pending decision on the canvas, or back on it.
   *
   * The "Review the decision" handoff both Surfaces have offered since Phase 9,
   * which until now went nowhere because `onReviewApproval` was declared in
   * `SurfaceContext` and supplied by nobody.
   */
  const reviewApproval = useCallback(
    (requestId: string) => {
      if (transport === undefined || active === undefined) {
        return;
      }

      void showApproval(transport, active.id, requestId).then(refresh, () => {
        setError("That decision could not be read from the core");
      });
    },
    [transport, active, refresh],
  );

  /**
   * Does the thing a confirmed approval authorised.
   *
   * Derived from the approval record rather than from a closure remembered when
   * the request was made, so confirming still works after a page reload — which
   * is the ordinary case, not the exotic one: a decision can sit unanswered for
   * as long as a person takes to read it. The route and verb come from the
   * persisted Surface payload, the same place the button that started this read
   * them from.
   */
  const retryConfirmed = useCallback(
    async (approval: ApprovalRecord): Promise<void> => {
      const kind = retryKindFor(approval.capability);

      if (kind === "window") {
        await placeWindow(approval.target.id, approval.id);

        return;
      }

      if (kind !== "tool") {
        return;
      }

      const current = composition.intents.find((intent) => intent.kind === "external_tool");
      const payload = current?.payload as { tools?: ExternalToolPayload[] } | undefined;
      const tool = payload?.tools?.find((candidate) => candidate.toolId === approval.target.id);

      if (tool === undefined) {
        return;
      }

      await actOnTool(approval.target.id, tool.verbs[0]?.id ?? "", approval.id);
    },
    [placeWindow, actOnTool, composition],
  );

  /**
   * Confirms a decision, then carries out the thing it authorised.
   *
   * The second half is what makes the first half mean anything.
   * `authority.confirm` records that a person agreed; it does not perform the
   * act, because the core cannot move a window or open a browser — only the
   * shell can. So the act is retried with the approval in hand, and the shell
   * re-checks that the approval covers the thing it is about to do.
   *
   * The approval Surface is re-proposed *after* the retry, so its payload
   * carries the real `executedAt`. Proposing it first would persist a Surface
   * saying "confirmed, not executed" about something that had already happened —
   * the stale-payload failure Phase 9 found on a shell restart, here in the one
   * place where a stale claim is a claim about somebody's consent.
   */
  const confirmApproval = useCallback(
    (approvalId: string, typedConfirmation?: string) => {
      if (transport === undefined || active === undefined) {
        return;
      }

      void (async () => {
        const confirmed = await transport.request("POST", "/commands/authority.confirm", {
          idempotencyKey: nextKey("authority.confirm"),
          requestId: approvalId,
          ...(typedConfirmation === undefined ? {} : { typedConfirmation }),
        });

        if (confirmed.status !== 200) {
          // The core refused — a near-miss on the typed phrase, or an approval
          // that is not confirmable. Nothing is retried, and the Surface is
          // re-read rather than left claiming an agreement nobody recorded.
          setError("That confirmation was not accepted");
          await showApproval(transport, active.id, approvalId);
          refresh();

          return;
        }

        const record = ApprovalRecordSchema.safeParse(
          (await transport.request("GET", `/approvals/${approvalId}`)).body,
        );

        if (record.success) {
          await retryConfirmed(record.data);
        }

        await showApproval(transport, active.id, approvalId);
        refresh();
      })().catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : "could not confirm that decision");
      });
    },
    [transport, active, refresh, retryConfirmed],
  );

  /**
   * Says no to a decision, then re-reads it so the Surface shows the recorded
   * decline rather than a control that still reads as open. No retry follows —
   * a decline authorises nothing — and the runtime waiting on this ask is
   * answered by the core from the `authority.declined.v1` event.
   */
  const declineApproval = useCallback(
    (approvalId: string) => {
      if (transport === undefined || active === undefined) {
        return;
      }

      void (async () => {
        const declined = await transport.request("POST", "/commands/authority.decline", {
          idempotencyKey: nextKey("authority.decline"),
          requestId: approvalId,
        });

        if (declined.status !== 200) {
          setError("That decline was not accepted");
        }

        await showApproval(transport, active.id, approvalId);
        refresh();
      })().catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : "could not decline that decision");
      });
    },
    [transport, active, refresh],
  );

  useEffect(() => {
    if (transport === undefined) {
      return;
    }

    let cancelled = false;

    transport
      .request("GET", "/objectives?limit=25")
      .then((response) => {
        if (cancelled || response.status !== 200) {
          return;
        }

        const parsed = ObjectiveListSchema.safeParse(response.body);

        if (parsed.success) {
          setObjectives(parsed.data.objectives);
        } else {
          setError("The core returned something that is not a list of Objectives");
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled) {
          setError(failure instanceof Error ? failure.message : "could not read Objectives");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [transport, revision]);

  const propose = useCallback(async () => {
    if (transport === undefined || title.trim() === "") {
      return;
    }

    const response = await transport.request("POST", "/commands/objective.create", {
      idempotencyKey: nextKey("objective.create"),
      title: title.trim(),
      // Born suggested, exactly as Section 4.2 has it: a proposal, not work.
      status: "suggested",
      intent: title.trim(),
      identityId: identity.activeIdentityId ?? "vesper",
      protocolIds: identity.protocolIds,
    });

    if (response.status === 200) {
      setTitle("");
      setRevision((current) => current + 1);
      setError(undefined);
    } else {
      setError("The core refused that Objective");
    }
  }, [transport, title, identity.activeIdentityId, identity.protocolIds]);

  const changeStatus = useCallback(
    async (objective: ObjectiveRecord, status: string) => {
      if (transport === undefined) {
        return;
      }

      const response = await transport.request("POST", "/commands/objective.change_status", {
        idempotencyKey: nextKey("objective.change_status"),
        objectiveId: objective.id,
        expectedRevision: objective.revision,
        status,
      });

      if (response.status !== 200) {
        setError(`The core refused to move that Objective to ${status}`);
        return;
      }

      const updated = response.body as ObjectiveRecord;

      if (status === "active") {
        for (const intent of seedIntents(updated)) {
          await transport.request("POST", "/commands/surface.upsert_intent", {
            idempotencyKey: nextKey("surface.upsert_intent"),
            objectiveId: updated.id,
            ...intent,
          });
        }

        await recallForObjective(transport, updated);

        if (bridge !== undefined) {
          await focusForObjective(transport, bridge, updated);
        }
      }

      identity.setActiveObjectiveId(status === "active" ? updated.id : undefined);
      setRevision((current) => current + 1);
      setError(undefined);
    },
    [transport, identity],
  );

  if (active === undefined) {
    return (
      <section style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Presence
          identity={identity}
          transport={transport}
          conversation={conversation}
          onSend={onSend}
        />
        <ObjectiveList
          objectives={objectives}
          title={title}
          onTitleChange={setTitle}
          onPropose={() => {
            void propose();
          }}
          onChangeStatus={(objective, status) => {
            void changeStatus(objective, status);
          }}
        />
        {error !== undefined && (
          <p style={{ color: semantic.error, padding: spacing.md }}>{error}</p>
        )}
      </section>
    );
  }

  return (
    <section
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        gap: spacing.md,
        padding: spacing.lg,
        minWidth: 0,
      }}
    >
      <header style={{ display: "flex", alignItems: "baseline", gap: spacing.md }}>
        <h1 style={{ margin: 0, font: `${String(typography.scale.lg)}px ${typography.family}` }}>
          {active.title}
        </h1>
        <span style={{ color: typography.color.muted }}>{active.status}</span>
        <span style={{ flex: 1 }} />
        {(["paused", "completed", "abandoned"] as const).map((status) => (
          <button
            key={status}
            type="button"
            onClick={() => {
              void changeStatus(active, status);
            }}
            style={buttonStyle}
          >
            {status === "paused" ? "Pause" : status === "completed" ? "Complete" : "Abandon"}
          </button>
        ))}
      </header>

      <Workbench
        composition={composition}
        handoffs={{
          ...(onOpenInVault === undefined
            ? {}
            : {
                onOpenInVault: (evidence: { entityId: string }) => {
                  onOpenInVault(evidence.entityId);
                },
              }),
          // Agreeing to a consequence needs no shell, so these two are always
          // supplied. `onExecute` deliberately is not — see below.
          onConfirm: confirmApproval,
          onDecline: declineApproval,
          onReviewApproval: reviewApproval,
          ...(bridge === undefined
            ? {}
            : {
                onPlaceWindow: (applicationId: string) => {
                  void placeWindow(applicationId);
                },
                onRestoreWindow: restoreWindow,
                onChooseWindow: chooseWindow,
                onClearWindowOverride: clearWindowOverride,
                onSurveyWindows: surveyWindows,
                onActOnTool: (toolId: string, verbId: string) => {
                  void actOnTool(toolId, verbId);
                },
                onSurveyTools: surveyTools,
              }),
        }}
        /**
         * `authority.approve` unconditionally, because agreeing to a
         * consequence is a core concern and works in a plain browser — and
         * because the `approval` registry entry requires it, so without it every
         * proposed decision rendered as a fallback. That was the third instance
         * of one shape in this codebase: a Surface built, registered, and
         * unreachable.
         *
         * `window.place` and `tool.inspect` only when a shell is behind the
         * page. Both say the same thing — there is a process that could carry
         * the consequence out — and neither is an authority grant, because the
         * core still decides every act on every request.
         */
        capabilities={
          bridge === undefined
            ? ["authority.approve"]
            : ["authority.approve", "window.place", "tool.inspect"]
        }
      />

      {(error ?? composition.error) !== undefined && (
        <p style={{ color: semantic.error, margin: 0 }}>{error ?? composition.error}</p>
      )}
    </section>
  );
}

const buttonStyle = {
  background: material.fill,
  color: "inherit",
  border: `1px solid ${material.border}`,
  borderRadius: corner.sm,
  padding: `${String(spacing.xs)}px ${String(spacing.md)}px`,
  cursor: "pointer",
} as const;

interface ObjectiveListProps {
  objectives: readonly ObjectiveRecord[];
  title: string;
  onTitleChange: (title: string) => void;
  onPropose: () => void;
  onChangeStatus: (objective: ObjectiveRecord, status: string) => void;
}

/** A suggested Objective becomes draft, then active. Never a shortcut between them. */
function nextStatus(objective: ObjectiveRecord): string | undefined {
  if (objective.status === "suggested") {
    return "draft";
  }

  return objective.status === "draft" || objective.status === "paused" ? "active" : undefined;
}

function ObjectiveList({
  objectives,
  title,
  onTitleChange,
  onPropose,
  onChangeStatus,
}: ObjectiveListProps): JSX.Element {
  return (
    <div style={{ padding: spacing.xl, display: "grid", gap: spacing.md, justifyItems: "center" }}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onPropose();
        }}
        style={{ display: "flex", gap: spacing.sm }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: spacing.sm }}>
          <span>New Objective</span>
          <input
            value={title}
            onChange={(event) => {
              onTitleChange(event.target.value);
            }}
            style={{
              width: 320,
              background: material.fill,
              border: `1px solid ${material.border}`,
              borderRadius: corner.sm,
              color: "inherit",
              padding: spacing.sm,
            }}
          />
        </label>
        <button type="submit" style={buttonStyle}>
          Propose
        </button>
      </form>

      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: spacing.xs }}>
        {objectives.map((objective) => {
          const next = nextStatus(objective);

          return (
            <li
              key={objective.id}
              style={{ display: "flex", gap: spacing.sm, alignItems: "center" }}
            >
              <span style={{ minWidth: 320 }}>{objective.title}</span>
              <span style={{ color: typography.color.muted, minWidth: 80 }}>
                {objective.status}
              </span>
              {next !== undefined && (
                <button
                  type="button"
                  onClick={() => {
                    onChangeStatus(objective, next);
                  }}
                  style={buttonStyle}
                >
                  {next === "draft" ? "Accept" : "Activate"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

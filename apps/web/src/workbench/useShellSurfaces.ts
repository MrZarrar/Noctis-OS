import type {
  ExternalToolPayload,
  MonitorRole,
  NativeApplicationPayload,
  ObjectiveRecord,
  RegionName,
  ToolCapability,
  WindowCapability,
} from "@noctis/contracts";
import { chooseRoute } from "@noctis/domain";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { nextKey } from "../idempotency.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import type { ExternalToolBridge, SurveyedTool } from "../transport/ExternalToolBridge.js";
import { externalToolBridgeFrom } from "../transport/ExternalToolBridge.js";
import type { NativeWindowBridge, SurveyedApplication } from "../transport/NativeWindowBridge.js";
import { nativeWindowBridgeFrom } from "../transport/NativeWindowBridge.js";
import type { CompositionState } from "./useComposition.js";

/**
 * The half of the canvas only a desktop shell can describe.
 *
 * Task 2.7 moved Surface *policy* into the core: what an Objective is made of,
 * and what a pending decision looks like, are proposed by
 * `apps/core/src/objectives/proposed-surfaces.ts`. These two are not policy.
 * `native_application` and `external_tool` describe which windows are open and
 * which programs are installed on the machine in front of the owner, and the
 * core has no Win32 to look with — so the page surveys and reports, and what it
 * reports is validated against the same schema every other Surface is.
 *
 * In a browser there is no shell, so both bridges are undefined, nothing is
 * surveyed, and the canvas simply has two fewer Surfaces. That is the answer
 * rather than a failure.
 */
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

/** Everything the shell contributes to the Workbench, or nothing when there is no shell. */
export interface ShellSurfaces {
  /** Passed straight into `Workbench`'s handoffs. Empty in a browser. */
  handoffs: Record<string, unknown>;
  /**
   * What a desktop shell makes reachable, for `Workbench`'s eligibility filter.
   * Not an authority grant — the core still decides every act on every request.
   */
  capabilities: Array<"window.place" | "tool.inspect">;
  /**
   * Carries out what a confirmed approval authorised, when it is one of ours.
   *
   * Derived from the approval record rather than from a closure remembered when
   * the request was made, so confirming still works after a page reload — which
   * is the ordinary case, not the exotic one: a decision can sit unanswered for
   * as long as a person takes to read it.
   */
  retryConfirmed: (approval: {
    id: string;
    capability: string;
    target: { id: string };
  }) => Promise<void>;
}

export interface ShellSurfacesOptions {
  transport: CoreTransport | undefined;
  /** The active Objective, or undefined when there is no canvas. */
  active: ObjectiveRecord | undefined;
  composition: CompositionState;
}

export function useShellSurfaces({
  transport,
  active,
  composition,
}: ShellSurfacesOptions): ShellSurfaces {
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
      // Same as above: the survey already swallows a shell that cannot answer.
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
   *
   * A `needsApproval` outcome needs nothing here any more: the core proposes the
   * approval Surface from `authority.decision_recorded.v1`, so the boundary
   * appears on the canvas whether or not this page is the one watching.
   */
  const runPlacement = useCallback(
    async (
      applicationId: string,
      act: (native: NativeWindowBridge) => Promise<NativeApplicationPayload["state"]>,
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

      let state: ExternalToolPayload["state"];

      try {
        state = await toolBridge.execute({
          toolId,
          verbId,
          // The route the router already chose and the Surface already showed.
          // The shell re-checks it against its own descriptor rather than taking
          // the page's word, so this is a request and not an instruction.
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

      composition.refresh();
    },
    [transport, toolBridge, active, composition],
  );

  /**
   * The place request, with the layout focus mode intends for this application.
   *
   * `titleHint` narrows which window is meant. The Objective's title is what it
   * usually is, so two editors on the same machine are told apart by the work
   * rather than by enumeration order.
   */
  const placeRequest = useCallback(
    (applicationId: string, titleHint: string | undefined, approvalId?: string) => {
      const layout = FOCUS_LAYOUT[applicationId];

      return {
        applicationId,
        monitor: layout?.monitor ?? "primary",
        region: layout?.region ?? "full",
        ...(active === undefined ? {} : { objectiveId: active.id }),
        ...(titleHint === undefined ? {} : { titleHint }),
        // Present only on the second attempt, after a person confirmed. The
        // shell re-checks that this approval covers this application before it
        // moves anything.
        ...(approvalId === undefined ? {} : { approvalId }),
      };
    },
    [active],
  );

  /**
   * Returns its promise rather than discarding it, so a confirmation can wait
   * for the placement it authorised before re-reading the approval record. The
   * handoff that reaches a Surface discards it at the call site instead.
   */
  const placeWindow = useCallback(
    async (applicationId: string, approvalId?: string): Promise<void> => {
      await runPlacement(applicationId, (native) =>
        native.place(placeRequest(applicationId, active?.title, approvalId)),
      );
    },
    [runPlacement, placeRequest, active],
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
      void runPlacement(applicationId, (native) =>
        native.place(placeRequest(applicationId, windowTitle)),
      );
    },
    [runPlacement, placeRequest],
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

        return native.place(placeRequest(applicationId, active?.title));
      });
    },
    [runPlacement, placeRequest, active],
  );

  const retryConfirmed = useCallback(
    async (approval: { id: string; capability: string; target: { id: string } }): Promise<void> => {
      const kind = retryKindFor(approval.capability);

      if (kind === "window") {
        await placeWindow(approval.target.id, approval.id);

        return;
      }

      if (kind !== "tool") {
        return;
      }

      // The route and verb come from the persisted Surface payload, the same
      // place the button that started this read them from.
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

  return {
    handoffs:
      bridge === undefined
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
          },
    capabilities: bridge === undefined ? [] : ["window.place", "tool.inspect"],
    retryConfirmed,
  };
}

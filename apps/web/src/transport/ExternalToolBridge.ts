import type { ExternalToolState, RouteName, ToolVerb } from "@noctis/contracts";
import {
  ExternalToolStateSchema,
  RouteAvailabilitySchema,
  RouteNameSchema,
} from "@noctis/contracts";
import { z } from "zod";

import type { Invoke } from "./TauriTransport.js";

/**
 * The page's route to specialist tools.
 *
 * Separate from `CoreTransport` for the same reason `NativeWindowBridge` is:
 * these are shell commands with no core path, because the shell is the only
 * process that can start a program or open a browser, and it asks the core
 * itself rather than being told an answer by the page.
 *
 * Every response is parsed through its contract schema before it is returned. A
 * drift between the Rust enum and `ExternalToolStateSchema` then fails loudly
 * here rather than becoming a Surface that renders a fallback for reasons nobody
 * can find — which is exactly what caught the missing `previous` field and the
 * `null` confirmation phrase in Phase 9.
 */
export interface ExternalToolBridge {
  /** `tool.inspect`: what tools exist, and which of their routes work here. */
  survey(): Promise<SurveyedTool[]>;
  execute(request: ToolExecuteRequest): Promise<ExternalToolState>;
}

export interface SurveyedTool {
  toolId: string;
  displayName: string;
  declaredRoutes: RouteName[];
  verbs: ToolVerb[];
  /**
   * Keyed by route name, and deliberately partial: a route the shell said
   * nothing about is unknown, and `chooseRoute` treats unknown as unreachable.
   */
  availability: Partial<Record<RouteName, z.infer<typeof RouteAvailabilitySchema>>>;
  manualSteps: string[];
}

export interface ToolExecuteRequest {
  toolId: string;
  verbId: string;
  /** The route the router chose. The shell re-checks it against the descriptor. */
  route: RouteName;
  /**
   * The Objective this is part of. The core allows a reversible local edit
   * without asking while an Objective is active and decides that by looking the
   * Objective up, so a request naming none is one it treats as unscoped.
   */
  objectiveId?: string;
  /** An approval already confirmed. Absent on the first attempt. */
  approvalId?: string;
}

/**
 * A verb as the shell reports it. The argument list is absent, because a page
 * that knew a verb's arguments would be a page that could propose different
 * ones — so `args` is filled with an empty list to satisfy the shared type
 * rather than carried across the boundary.
 */
const SurveyedVerbSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    operationClass: z.string().min(1),
  })
  .strict();

const SurveySchema = z.array(
  z
    .object({
      toolId: z.string().min(1),
      displayName: z.string().min(1),
      declaredRoutes: z.array(RouteNameSchema),
      verbs: z.array(SurveyedVerbSchema),
      /**
       * `partialRecord`, not `record`. Zod treats a `record` with an enum key as
       * *exhaustive* — it demands an entry for all four routes — and the shell
       * reports availability only for the routes a tool declares, because a
       * route it does not offer has no availability to report. `record` here
       * rejected every real response, and it did it at runtime: the boundary
       * parse threw, the survey failed, and the Surface fell back for no reason
       * anyone reading the page could see. Precisely the Phase 9 shape.
       */
      availability: z.partialRecord(RouteNameSchema, RouteAvailabilitySchema),
      manualSteps: z.array(z.string().min(1)),
    })
    .strict(),
);

class TauriExternalToolBridge implements ExternalToolBridge {
  readonly #invoke: Invoke;

  constructor(invoke: Invoke) {
    this.#invoke = invoke;
  }

  async survey(): Promise<SurveyedTool[]> {
    const surveyed = SurveySchema.parse(await this.#invoke("tool_survey"));

    return surveyed.map((tool) => ({
      ...tool,
      verbs: tool.verbs.map((verb) => ({
        id: verb.id,
        label: verb.label,
        // Never sent by the shell. An empty list is the honest local value: the
        // page has no arguments because it is not allowed any.
        args: [],
        operationClass: verb.operationClass as ToolVerb["operationClass"],
      })),
    }));
  }

  async execute(request: ToolExecuteRequest): Promise<ExternalToolState> {
    const { toolId, verbId, route, objectiveId, approvalId } = request;

    return ExternalToolStateSchema.parse(
      await this.#invoke("tool_execute", {
        // The shell's `ToolIntent`. It has nowhere to put a URL, an executable,
        // or an argument, which is the point.
        intent: {
          toolId,
          verbId,
          ...(objectiveId === undefined ? {} : { objectiveId }),
        },
        route,
        approvalId: approvalId ?? null,
      }),
    );
  }
}

interface TauriGlobal {
  core: { invoke: Invoke };
}

/**
 * The bridge, or nothing.
 *
 * `undefined` in a browser, and that is a first-class answer: a page served
 * outside the desktop shell cannot start a program, so the honest thing is for
 * tool routing not to appear rather than to appear and refuse.
 */
export function externalToolBridgeFrom(scope: unknown): ExternalToolBridge | undefined {
  const bridge = (scope as { __TAURI__?: TauriGlobal } | undefined)?.__TAURI__;

  return bridge === undefined ? undefined : new TauriExternalToolBridge(bridge.core.invoke);
}

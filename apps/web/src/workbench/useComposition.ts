import type {
  AttentionState,
  CompositionPlan,
  SurfaceIntent,
  SurfaceOverride,
  SurfaceRegion,
  SurfaceSize,
} from "@noctis/contracts";
import {
  CompositionPlanSchema,
  SurfaceIntentSchema,
  SurfaceOverrideSchema,
} from "@noctis/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import type { CoreTransport } from "../transport/CoreTransport.js";
import { clientId, displayFor, screenFacts } from "./display.js";

/** Long enough that dragging a window edge is one recomposition, not sixty. */
const RESIZE_SETTLE_MS = 200;

/**
 * The core's answers are parsed, not asserted. A status code says the response
 * arrived, not that it came from the core — and a plan the workbench renders
 * without checking is a plan whose `slots` could be anything.
 */
const SurfaceReadSchema = z.object({
  intents: z.array(SurfaceIntentSchema),
  overrides: z.array(SurfaceOverrideSchema),
  plan: CompositionPlanSchema,
});

const ComposeResultSchema = z.object({ plan: CompositionPlanSchema, changed: z.boolean() });

let keySequence = 0;

function nextKey(scope: string): string {
  keySequence += 1;

  return `web-${scope}-${String(keySequence)}-${String(Date.now())}`;
}

export interface CompositionState {
  plan: CompositionPlan | undefined;
  intents: readonly SurfaceIntent[];
  overrides: readonly SurfaceOverride[];
  focusedSurfaceId: string | undefined;
  attentionState: AttentionState;
  error: string | undefined;
  focus: (surfaceId: string | undefined) => void;
  move: (surfaceId: string, region: SurfaceRegion, size: SurfaceSize) => Promise<void>;
  release: (surfaceId: string) => Promise<void>;
  dismiss: (surfaceId: string) => Promise<void>;
  /**
   * Re-reads the composition.
   *
   * For a caller that changed an intent through a command this hook does not
   * own — Phase 9's placement upserts its own Surface after the shell reports
   * what happened. `move`, `release` and `dismiss` already re-read for
   * themselves, so this exists for changes that arrive from outside them.
   */
  refresh: () => void;
}

/**
 * Holds one Objective's composition.
 *
 * The plan always comes from the core, never from a local compositor call. The
 * function is pure and would give the same answer here, but running it in one
 * place keeps the committed snapshot and the rendered canvas the same object by
 * construction rather than by two implementations agreeing.
 */
export function useComposition(
  transport: CoreTransport | undefined,
  objectiveId: string | undefined,
): CompositionState {
  const [plan, setPlan] = useState<CompositionPlan>();
  const [intents, setIntents] = useState<readonly SurfaceIntent[]>([]);
  const [overrides, setOverrides] = useState<readonly SurfaceOverride[]>([]);
  const [focusedSurfaceId, setFocusedSurfaceId] = useState<string>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === "undefined" ? 1440 : window.innerWidth,
  );

  const client = useRef<string>();

  client.current ??=
    typeof window === "undefined"
      ? "server"
      : clientId(window.localStorage, () => crypto.randomUUID());

  const display = useMemo(
    () =>
      typeof window === "undefined"
        ? { fingerprint: "headless", widthPx: viewportWidth }
        : displayFor({ ...screenFacts(window), viewportWidth }),
    [viewportWidth],
  );

  const attentionState: AttentionState =
    objectiveId === undefined
      ? "presence"
      : focusedSurfaceId === undefined
        ? "active_canvas"
        : "focus";

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;

    const onResize = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        setViewportWidth(window.innerWidth);
      }, RESIZE_SETTLE_MS);
    };

    window.addEventListener("resize", onResize);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    const clientIdValue = client.current;

    if (transport === undefined || objectiveId === undefined || clientIdValue === undefined) {
      setPlan(undefined);
      setIntents([]);
      setOverrides([]);
      return;
    }

    let cancelled = false;

    const query = new URLSearchParams({
      clientId: clientIdValue,
      fingerprint: display.fingerprint,
      widthPx: String(display.widthPx),
      attentionState,
      ...(focusedSurfaceId === undefined ? {} : { focusedSurfaceId }),
    });

    void (async () => {
      try {
        const read = await transport.request(
          "GET",
          `/objectives/${objectiveId}/surfaces?${query.toString()}`,
        );

        if (cancelled) {
          return;
        }

        if (read.status !== 200) {
          setError("Could not read this Objective's Surfaces");
          return;
        }

        const body = SurfaceReadSchema.safeParse(read.body);

        if (!body.success) {
          setError("The core returned a composition that does not match its contract");
          return;
        }

        setIntents(body.data.intents);
        setOverrides(body.data.overrides);
        setPlan(body.data.plan);
        setError(undefined);

        // Committing after rendering, not before: Section 5.4 step 10 persists
        // a snapshot only once the transition it describes has happened.
        const committed = await transport.request("POST", "/commands/surface.compose", {
          idempotencyKey: nextKey("compose"),
          objectiveId,
          clientId: clientIdValue,
          display,
          attentionState,
          ...(focusedSurfaceId === undefined ? {} : { focusedSurfaceId }),
        });

        const result = ComposeResultSchema.safeParse(committed.body);

        if (!cancelled && committed.status === 200 && result.success) {
          setPlan(result.data.plan);
        }
      } catch (failure: unknown) {
        if (!cancelled) {
          setError(failure instanceof Error ? failure.message : "composition failed");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [transport, objectiveId, display, attentionState, focusedSurfaceId, revision]);

  const send = useCallback(
    async (name: string, body: Record<string, unknown>) => {
      if (transport === undefined) {
        return;
      }

      const response = await transport.request("POST", `/commands/${name}`, {
        idempotencyKey: nextKey(name),
        ...body,
      });

      if (response.status === 200) {
        setRevision((current) => current + 1);
        setError(undefined);
      } else {
        setError(`${name} was refused (${String(response.status)})`);
      }
    },
    [transport],
  );

  const overrideScope = useCallback(
    (surfaceId: string) => ({
      surfaceId,
      clientId: client.current ?? "unknown",
      displayFingerprint: display.fingerprint,
    }),
    [display.fingerprint],
  );

  return {
    plan,
    intents,
    overrides,
    focusedSurfaceId,
    attentionState,
    error,
    focus: setFocusedSurfaceId,
    refresh: useCallback(() => {
      setRevision((current) => current + 1);
    }, []),
    move: useCallback(
      async (surfaceId, region, size) => {
        await send("surface.set_override", { ...overrideScope(surfaceId), region, size });
      },
      [send, overrideScope],
    ),
    release: useCallback(
      async (surfaceId) => {
        await send("surface.release_override", overrideScope(surfaceId));
      },
      [send, overrideScope],
    ),
    dismiss: useCallback(
      async (surfaceId) => {
        // The lifecycle table allows proposed -> dismissed directly, and
        // active -> exiting -> dismissed in two hops. Asking for the direct hop
        // first means a never-entered Surface is dismissed in one command
        // instead of being walked through a transition it never made.
        const intent = intents.find((candidate) => candidate.id === surfaceId);

        if (intent?.lifecycle === "active" || intent?.lifecycle === "background") {
          await send("surface.change_lifecycle", { surfaceId, lifecycle: "exiting" });
        }

        await send("surface.change_lifecycle", { surfaceId, lifecycle: "dismissed" });
      },
      [send, intents],
    ),
  };
}

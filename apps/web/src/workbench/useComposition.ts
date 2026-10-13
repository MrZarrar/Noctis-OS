import type {
  AttentionState,
  CompositionPlan,
  SurfaceIntent,
  SurfaceOwner,
  SurfaceOverride,
  SurfaceRegion,
  SurfaceSize,
} from "@noctis/contracts";
import {
  CompositionPlanSchema,
  ownerIdOf,
  SurfaceIntentSchema,
  SurfaceOverrideSchema,
} from "@noctis/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import type { CoreTransport } from "../transport/CoreTransport.js";
import type { PanelUpdateState } from "@noctis/ui";
import { reconcileIntents } from "./reconcile.js";
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
  updates?: Readonly<Record<string, PanelUpdateState>>;
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
  owner: SurfaceOwner | undefined,
): CompositionState {
  const ownerKey = owner === undefined ? undefined : ownerIdOf(owner);
  const stableOwner = useMemo<SurfaceOwner | undefined>(() => {
    if (ownerKey === undefined) return undefined;
    if (ownerKey === "presence") return { presence: true };
    return ownerKey.startsWith("thread:")
      ? { threadId: ownerKey.slice(7) }
      : { objectiveId: ownerKey.slice(10) };
  }, [ownerKey]);
  const ownerRef = useRef(ownerKey);
  const ownerGeneration = useRef(0);
  const [dataOwner, setDataOwner] = useState(ownerKey);
  const [pending, setPending] = useState<Record<string, SurfaceIntent>>({});
  const [updating, setUpdating] = useState(false);
  const intentsRef = useRef<readonly SurfaceIntent[]>([]);
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

  // shortcut: viewport width drives capacity; measure the panel area if side-by-side columns stop fitting.
  const display = useMemo(
    () =>
      typeof window === "undefined"
        ? { fingerprint: "headless", widthPx: viewportWidth }
        : displayFor({ ...screenFacts(window), viewportWidth }),
    [viewportWidth],
  );

  const attentionState: AttentionState =
    ownerKey === undefined
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

  if (ownerRef.current !== ownerKey) {
    ownerRef.current = ownerKey;
    ownerGeneration.current += 1;
    intentsRef.current = [];
    setDataOwner(ownerKey);
    setPlan(undefined);
    setIntents([]);
    setOverrides([]);
    setFocusedSurfaceId(undefined);
    setPending({});
    setError(undefined);
    setUpdating(false);
  }

  useEffect(() => {
    const clientIdValue = client.current;

    if (transport === undefined || stableOwner === undefined || clientIdValue === undefined) {
      setPlan(undefined);
      setIntents([]);
      setOverrides([]);
      return;
    }

    let cancelled = false;
    const startedGeneration = ownerGeneration.current;
    const current = (): boolean =>
      !cancelled && ownerRef.current === ownerKey && ownerGeneration.current === startedGeneration;
    setUpdating(true);

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
          `${stableOwner.objectiveId !== undefined ? `/objectives/${stableOwner.objectiveId}` : stableOwner.threadId !== undefined ? `/threads/${stableOwner.threadId}` : "/presence"}/surfaces?${query.toString()}`,
        );

        if (!current()) {
          return;
        }

        if (read.status !== 200) {
          setError("Could not read these panels");
          setUpdating(false);
          return;
        }

        const body = SurfaceReadSchema.safeParse(read.body);

        if (!body.success) {
          setError("The core returned a composition that does not match its contract");
          setUpdating(false);
          return;
        }

        if (
          focusedSurfaceId !== undefined &&
          !body.data.intents.some(
            (intent) =>
              intent.id === focusedSurfaceId &&
              intent.lifecycle !== "exiting" &&
              intent.lifecycle !== "dismissed",
          )
        ) {
          setFocusedSurfaceId(undefined);
        }
        const reconciled = reconcileIntents(intentsRef.current, body.data.intents);
        setDataOwner(ownerKey);
        intentsRef.current = reconciled.intents;
        setIntents(reconciled.intents);
        setPending(reconciled.pending);
        setUpdating(false);
        setOverrides(body.data.overrides);
        setPlan(body.data.plan);
        setError(undefined);

        const committed = await transport.request("POST", "/commands/surface.compose", {
          idempotencyKey: nextKey("compose"),
          ...stableOwner,
          clientId: clientIdValue,
          display,
          attentionState,
          ...(focusedSurfaceId === undefined ? {} : { focusedSurfaceId }),
        });

        const result = ComposeResultSchema.safeParse(committed.body);

        if (current() && committed.status === 200 && result.success) {
          setPlan(result.data.plan);
        } else if (current()) {
          setError("Could not save this composition");
        }
      } catch (failure: unknown) {
        if (current()) {
          setUpdating(false);
          setError(failure instanceof Error ? failure.message : "composition failed");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [transport, stableOwner, ownerKey, display, attentionState, focusedSurfaceId, revision]);

  const send = useCallback(
    async (name: string, body: Record<string, unknown>) => {
      if (transport === undefined || ownerRef.current !== ownerKey) {
        return false;
      }

      const sentOwner = ownerRef.current;
      const sentGeneration = ownerGeneration.current;
      const response = await transport.request("POST", `/commands/${name}`, {
        idempotencyKey: nextKey(name),
        ...body,
      });

      if (ownerRef.current !== sentOwner || ownerGeneration.current !== sentGeneration)
        return false;
      if (response.status === 200) {
        setRevision((current) => current + 1);
        setError(undefined);
        return true;
      } else {
        setError(`${name} was refused (${String(response.status)})`);
        return false;
      }
    },
    [transport, ownerKey],
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
    updates: Object.fromEntries(
      intents.map((intent) => [
        intent.id,
        {
          updating,
          failed: error !== undefined,
          onRetry: () => setRevision((value) => value + 1),
          pendingPrimary: pending[intent.id] !== undefined,
          onUseNewVersion: () => {
            const next = pending[intent.id];
            if (next === undefined || dataOwner !== ownerRef.current) return;
            intentsRef.current = intentsRef.current.map((value) =>
              value.id === next.id ? next : value,
            );
            setIntents(intentsRef.current);
            setPending((values) => {
              const copy = { ...values };
              delete copy[next.id];
              return copy;
            });
          },
        },
      ]),
    ),
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
          if (!(await send("surface.change_lifecycle", { surfaceId, lifecycle: "exiting" })))
            return;
        }

        if (await send("surface.change_lifecycle", { surfaceId, lifecycle: "dismissed" })) {
          setFocusedSurfaceId((current) => (current === surfaceId ? undefined : current));
        }
      },
      [send, intents],
    ),
  };
}

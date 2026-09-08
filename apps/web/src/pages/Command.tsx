import type {
  MonitorRole,
  NativeApplicationPayload,
  ObjectiveRecord,
  RegionName,
} from "@noctis/contracts";
import { ObjectiveRecordSchema } from "@noctis/contracts";
import { IDENTITY_PROFILES, corner, material, semantic, spacing, typography } from "@noctis/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { useIdentityRuntime } from "../identities/useIdentityRuntime.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
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
 * What the Vault already knows about a freshly activated Objective.
 *
 * Section 7: "Command receives only a focused recall Surface". The recall runs
 * once, on activation, and becomes one Surface among the others — Command never
 * shows a graph, and a Surface is only created when there is something to show.
 */
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
export function Command({ transport, onOpenInVault }: CommandProps): JSX.Element {
  const identity = useIdentityRuntime(transport);
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
  }, [active, surveyWindows]);

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

      composition.refresh();
    },
    [transport, bridge, active, composition],
  );

  const placeWindow = useCallback(
    (applicationId: string) => {
      void runPlacement(applicationId, async (native) => {
        const layout = FOCUS_LAYOUT[applicationId];

        return native.place({
          applicationId,
          monitor: layout?.monitor ?? "primary",
          region: layout?.region ?? "full",
          ...(active === undefined ? {} : { objectiveId: active.id }),
          // The Objective's own title, so two editors on the same machine are
          // told apart by the work rather than by enumeration order.
          ...(active === undefined ? {} : { titleHint: active.title }),
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
        <Presence identity={identity} transport={transport} />
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
        {...(onOpenInVault === undefined
          ? {}
          : {
              onOpenInVault: (evidence: { entityId: string }) => {
                onOpenInVault(evidence.entityId);
              },
            })}
        {...(bridge === undefined
          ? {}
          : {
              // Both the handoffs and the capability come from the same fact:
              // there is a shell that could carry a placement out. In a browser
              // neither is passed, and the native Surface falls back saying so.
              capabilities: ["window.place"],
              onPlaceWindow: placeWindow,
              onRestoreWindow: restoreWindow,
              onChooseWindow: chooseWindow,
              onClearWindowOverride: clearWindowOverride,
              onSurveyWindows: surveyWindows,
            })}
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

import type { ExternalToolPayload, ExternalToolState, RouteName } from "@noctis/contracts";

import { corner, material, semantic, spacing, typography } from "../tokens/index.js";

const listReset = { margin: 0, padding: 0, listStyle: "none" } as const;

const buttonStyle = {
  font: `${String(typography.scale.xs)}px ${typography.family}`,
  background: material.fill,
  color: "inherit",
  border: `1px solid ${material.border}`,
  borderRadius: corner.sm,
  padding: `${String(spacing.xs)}px ${String(spacing.sm)}px`,
  cursor: "pointer",
} as const;

/**
 * How Noctis intends to reach this tool, in words.
 *
 * The two browser routes must not read alike. Agreeing to an isolated session is
 * not agreeing to one carrying your sign-ins, and a person who cannot tell the
 * two apart from the Surface cannot give informed consent to either — which is
 * the whole point of Section 12.3 keeping them separately granted.
 */
const ROUTE_SENTENCE: Readonly<Record<RouteName, string>> = {
  official_cli: "through its own command line",
  isolated_browser: "in an isolated browser holding none of your sign-ins",
  visible_handoff: "in your own signed-in browser",
  manual: "by telling you how to do it yourself",
};

/** The one word each state gets, and the colour that carries it. */
const STATE_WORD: Readonly<Record<ExternalToolState["kind"], string>> = {
  ready: "ready",
  launched: "started",
  ran: "ran",
  handedOff: "open in your browser",
  instructions: "yours to do",
  needsApproval: "waiting for you",
  routeUnavailable: "route unavailable",
  refused: "cannot be reached",
};

const STATE_COLOUR: Readonly<Record<ExternalToolState["kind"], string>> = {
  ready: semantic.stale,
  launched: semantic.current,
  ran: semantic.current,
  handedOff: semantic.current,
  instructions: semantic.stale,
  needsApproval: semantic.warning,
  routeUnavailable: semantic.warning,
  refused: semantic.unavailable,
};

/**
 * What the go-ahead action is called in each state, and `undefined` where there
 * is nothing to go ahead with.
 *
 * A total table rather than a chain of conditions, and this is not a style
 * preference — Phase 9 shipped three separate defects of the shape "mechanism
 * built, tested in isolation, no path a person could take to it", one of them
 * exactly this: an action offered in three states and missing from the fourth,
 * which happened to be the only state from which the feature could be reached.
 * A table makes a missing entry visible. A condition silently covers no case.
 *
 * `needsApproval` has a decision to make first, so offering it here would be a
 * button that cannot do what it says.
 */
export const ACT_LABEL: Readonly<Record<ExternalToolState["kind"], string | undefined>> = {
  needsApproval: undefined,
  ready: "Go there",
  // Going again is meaningful: the editor may have been closed, and the browser
  // tab may have been shut.
  launched: "Go there again",
  ran: "Run it again",
  handedOff: "Open it again",
  // The fallback is the state a stronger route may still be reachable from —
  // installing the tool changes the answer, and nothing else would re-ask.
  instructions: "Try again",
  routeUnavailable: "Try again",
  refused: "Try again",
};

export interface ExternalToolSurfaceProps extends ExternalToolPayload {
  /** Take the chosen route. A handoff, not a decision. */
  onAct?: (verbId: string) => void;
  /** Take the pending decision to the Approval Surface. */
  onReview?: (requestId: string) => void;
  /**
   * Survey the tools again.
   *
   * A Surface payload is persisted, so one describing the outside world is a
   * snapshot that goes stale the moment somebody installs or uninstalls
   * something. The same handoff the registry's `sourceRefresh` gives a source
   * Surface: an external tool is a source like any other.
   */
  onRefresh?: () => void;
}

/**
 * One specialist tool under Noctis's routing (Section 12.3).
 *
 * The Surface renders state and offers handoffs. It does not choose the route,
 * decide whether the route is allowed, or reach anything — all three live behind
 * the router and the authority boundary, and a renderer that could do any of
 * them would be a renderer with consequences.
 *
 * The chosen route is always shown, and so is what it degraded from. A Surface
 * that showed only the outcome could not express the difference between "Noctis
 * used the official interface" and "Noctis is about to open your signed-in
 * browser because the official one is not installed" — and those are not the
 * same thing to agree to.
 */
export function ExternalToolSurface({
  toolId,
  displayName,
  route,
  degradedFrom,
  verbs,
  state,
  onAct,
  onReview,
  onRefresh,
}: ExternalToolSurfaceProps): JSX.Element {
  const actLabel = ACT_LABEL[state.kind];
  const verbId = verbs[0]?.id ?? "";

  return (
    <div style={{ display: "grid", gap: spacing.sm }}>
      <p style={{ margin: 0, color: typography.color.muted }}>
        {displayName} · {toolId}
      </p>

      <p style={{ margin: 0, display: "flex", alignItems: "center", gap: spacing.xs }}>
        {/* The dot is decoration; the word beside it carries the meaning. */}
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: STATE_COLOUR[state.kind],
            flex: "0 0 auto",
          }}
        />
        <span>{STATE_WORD[state.kind]}</span>
      </p>

      <p style={{ margin: 0, color: typography.color.muted }}>
        Noctis will go {ROUTE_SENTENCE[route]}
      </p>

      {degradedFrom.length > 0 && (
        <ul style={{ ...listReset, display: "grid", gap: spacing.xs }}>
          {degradedFrom.map((passed) => (
            <li key={passed} style={{ color: semantic.warning }}>
              not {ROUTE_SENTENCE[passed]} — that route was not available
            </li>
          ))}
        </ul>
      )}

      <StateDetail state={state} onReview={onReview} />

      <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap" }}>
        {actLabel !== undefined && onAct !== undefined && (
          <button
            type="button"
            onClick={() => {
              onAct(verbId);
            }}
            style={buttonStyle}
          >
            {actLabel}
          </button>
        )}

        {/* Where staleness actually bites: a persisted payload saying a tool is
            not installed, long after somebody installed it. */}
        {(state.kind === "routeUnavailable" ||
          state.kind === "instructions" ||
          state.kind === "refused") &&
          onRefresh !== undefined && (
            <button type="button" onClick={onRefresh} style={buttonStyle}>
              Look again
            </button>
          )}
      </div>
    </div>
  );
}

/**
 * `| undefined` spelled out rather than left to `?`, because
 * `exactOptionalPropertyTypes` distinguishes "absent" from "present and
 * undefined" and this component is handed the latter.
 */
interface StateDetailProps {
  state: ExternalToolState;
  onReview?: ((requestId: string) => void) | undefined;
}

function StateDetail({ state, onReview }: StateDetailProps): JSX.Element | null {
  switch (state.kind) {
    case "ready":
      return (
        <p style={{ margin: 0 }}>Nothing has been asked of this tool for this piece of work yet.</p>
      );

    case "launched":
      return (
        <p style={{ margin: 0, color: typography.color.muted }}>
          Started as process{" "}
          <code style={{ fontFamily: typography.monoFamily }}>{state.processId}</code>. Noctis can
          recognise its windows now, because it opened them.
        </p>
      );

    case "ran":
      return (
        <div style={{ display: "grid", gap: spacing.xs }}>
          <p
            style={{
              margin: 0,
              color: state.exitCode === 0 ? typography.color.muted : semantic.unavailable,
            }}
          >
            {state.exitCode === 0 ? "Finished" : `Failed with exit code ${state.exitCode}`}
          </p>
          {state.output.length > 0 && (
            <pre
              style={{
                margin: 0,
                fontFamily: typography.monoFamily,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                maxHeight: 200,
                overflowY: "auto",
              }}
            >
              {state.output}
            </pre>
          )}
        </div>
      );

    case "handedOff":
      return (
        <div style={{ display: "grid", gap: spacing.xs }}>
          <p style={{ margin: 0 }}>
            Open at <code style={{ fontFamily: typography.monoFamily }}>{state.url}</code>
          </p>
          {/* Section 9.1's preparation boundary, said out loud. The screen is
              open and nothing has been sent — a Surface that stayed quiet here
              would let somebody assume Noctis had finished the job. */}
          <p style={{ margin: 0, color: typography.color.muted }}>
            Noctis stopped here. Anything that sends, publishes, or spends is yours to do.
          </p>
        </div>
      );

    case "instructions":
      return (
        <ol style={{ margin: 0, paddingLeft: spacing.md, display: "grid", gap: spacing.xs }}>
          {state.steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      );

    case "needsApproval":
      return (
        <div style={{ display: "grid", gap: spacing.xs }}>
          <p style={{ margin: 0 }}>{state.consequenceSummary}</p>
          {state.confirmationPhrase !== undefined && state.confirmationPhrase !== null && (
            <p style={{ margin: 0, color: semantic.warning }}>
              This one needs the phrase typed out to confirm.
            </p>
          )}
          {onReview !== undefined && (
            <div>
              <button
                type="button"
                onClick={() => {
                  onReview(state.requestId);
                }}
                style={buttonStyle}
              >
                Review the decision
              </button>
            </div>
          )}
        </div>
      );

    case "routeUnavailable":
      return <p style={{ margin: 0, color: semantic.warning }}>{state.reason}</p>;

    case "refused":
      return <p style={{ margin: 0, color: semantic.unavailable }}>{state.reason}</p>;

    default:
      // The union is closed and every arm above returns, so this is unreachable.
      // It exists so that adding a state without a renderer fails to compile.
      return null;
  }
}

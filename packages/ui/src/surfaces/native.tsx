import type { NativeApplicationPayload, NativeApplicationState } from "@noctis/contracts";

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

const REGION_LABEL: Readonly<Record<NativeApplicationPayload["intendedRegion"], string>> = {
  full: "the whole display",
  left_half: "the left half",
  right_half: "the right half",
  left_two_thirds: "the left two thirds",
  right_third: "the right third",
};

const MONITOR_LABEL: Readonly<Record<NativeApplicationPayload["intendedMonitor"], string>> = {
  primary: "primary display",
  secondary: "secondary display",
};

/**
 * Why a resolved rectangle is not the region that was asked for, in words.
 *
 * These are the reason the notes are carried at all. A window that ended up
 * somewhere unexpected with no stated reason is what makes somebody stop
 * trusting focus mode and go back to arranging windows by hand.
 */
const NOTE_SENTENCE: Readonly<Record<string, string>> = {
  degraded_to_primary: "there is no second display, so it went to the primary one",
  honoured_user_override: "you had placed this window yourself, so that was kept",
  clamped_to_work_area: "the saved position no longer fits any display, so it was moved on",
  raised_to_minimum_size: "the region was narrower than this application's minimum width",
};

/** The one word each state gets, and the colour that carries it. */
const STATE_WORD: Readonly<Record<NativeApplicationState["kind"], string>> = {
  notRunning: "not running",
  discovered: "open, not arranged",
  placed: "arranged",
  restored: "put back",
  ambiguous: "more than one window",
  needsApproval: "waiting for you",
  refused: "cannot be arranged",
};

const STATE_COLOUR: Readonly<Record<NativeApplicationState["kind"], string>> = {
  notRunning: semantic.unavailable,
  discovered: semantic.stale,
  placed: semantic.current,
  restored: semantic.current,
  ambiguous: semantic.warning,
  needsApproval: semantic.warning,
  refused: semantic.unavailable,
};

export interface NativeApplicationSurfaceProps extends NativeApplicationPayload {
  /** Ask the shell to place this application's window. A handoff, not a decision. */
  onPlace?: () => void;
  /** Put it back where it was before Noctis moved it. */
  onRestore?: () => void;
  /**
   * Resolve an ambiguous selection by naming the window. The Surface renders the
   * candidates; the shell still re-verifies identity before it moves anything,
   * so a handle from here is a hint rather than an instruction.
   */
  onChoose?: (handle: number) => void;
  /** Take the pending decision to the Approval Surface. */
  onReview?: (requestId: string) => void;
}

/**
 * One native application under Noctis's arrangement (Section 11.2).
 *
 * The Surface renders state and offers handoffs. It does not place windows,
 * decide whether placement is allowed, or choose which window is meant — all
 * three of those live behind the shell and the authority boundary, and a
 * renderer that could do any of them would be a renderer with consequences.
 *
 * The intended region is always shown, whatever the state. A Surface that showed
 * only where a window *is* could not express the gap between that and where it
 * was meant to be, and that gap is the whole content of a degraded placement.
 */
export function NativeApplicationSurface({
  applicationId,
  displayName,
  intendedMonitor,
  intendedRegion,
  state,
  onPlace,
  onRestore,
  onChoose,
  onReview,
}: NativeApplicationSurfaceProps): JSX.Element {
  return (
    <div style={{ display: "grid", gap: spacing.sm }}>
      <p style={{ margin: 0, color: typography.color.muted }}>
        {displayName} · {applicationId}
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
        Intended for {REGION_LABEL[intendedRegion]} of the {MONITOR_LABEL[intendedMonitor]}
      </p>

      <StateDetail state={state} onChoose={onChoose} onReview={onReview} />

      <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap" }}>
        {(state.kind === "discovered" || state.kind === "restored") && onPlace !== undefined && (
          <button type="button" onClick={onPlace} style={buttonStyle}>
            Arrange this window
          </button>
        )}

        {state.kind === "placed" && onRestore !== undefined && (
          <button type="button" onClick={onRestore} style={buttonStyle}>
            Put it back
          </button>
        )}

        {/* A refusal can be retried: the display arrangement, or the
            application's willingness, may both have changed since. */}
        {state.kind === "refused" && onPlace !== undefined && (
          <button type="button" onClick={onPlace} style={buttonStyle}>
            Try again
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
  state: NativeApplicationState;
  onChoose?: ((handle: number) => void) | undefined;
  onReview?: ((requestId: string) => void) | undefined;
}

function StateDetail({ state, onChoose, onReview }: StateDetailProps): JSX.Element | null {
  switch (state.kind) {
    case "notRunning":
      // Section 11.2's open-only handoff: Noctis says what is missing and does
      // not offer to start something it has not been granted the right to start.
      return (
        <p style={{ margin: 0 }}>
          Nothing matching this application is open. Start it yourself and Noctis will find it.
        </p>
      );

    case "discovered":
      return <WindowTitle title={state.windowTitle} />;

    case "placed":
      return (
        <div style={{ display: "grid", gap: spacing.xs }}>
          <p style={{ margin: 0, color: typography.color.muted }}>
            <code style={{ fontFamily: typography.monoFamily }}>
              {state.placement.width}×{state.placement.height} at {state.placement.x},
              {state.placement.y}
            </code>{" "}
            on {state.monitorId} · took {state.elapsedMs}ms
          </p>
          {/* Where it came from, so "Put it back" names somewhere real. */}
          <p style={{ margin: 0, color: typography.color.muted }}>
            was at{" "}
            <code style={{ fontFamily: typography.monoFamily }}>
              {state.previous.x},{state.previous.y}
            </code>
          </p>
          {state.notes.length > 0 && (
            <ul style={{ ...listReset, display: "grid", gap: spacing.xs }}>
              {state.notes.map((note) => (
                <li key={note} style={{ color: semantic.warning }}>
                  {NOTE_SENTENCE[note] ?? note}
                </li>
              ))}
            </ul>
          )}
        </div>
      );

    case "restored":
      return (
        <p style={{ margin: 0, color: typography.color.muted }}>
          Back at{" "}
          <code style={{ fontFamily: typography.monoFamily }}>
            {state.placement.x},{state.placement.y}
          </code>
          , where it was before Noctis moved it.
        </p>
      );

    case "ambiguous":
      return (
        <div style={{ display: "grid", gap: spacing.xs }}>
          <p style={{ margin: 0 }}>
            {state.candidates.length} windows match this application. Noctis will not guess which
            one you meant.
          </p>
          <ul style={{ ...listReset, display: "grid", gap: spacing.xs }}>
            {state.candidates.map((candidate) => (
              <li key={candidate.handle}>
                {onChoose === undefined ? (
                  candidate.title
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      onChoose(candidate.handle);
                    }}
                    style={{ ...buttonStyle, textAlign: "left", width: "100%" }}
                  >
                    {candidate.title}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      );

    case "needsApproval":
      return (
        <div style={{ display: "grid", gap: spacing.xs }}>
          <p style={{ margin: 0 }}>{state.consequenceSummary}</p>
          {state.confirmationPhrase !== undefined && (
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

    case "refused":
      return <p style={{ margin: 0, color: semantic.unavailable }}>{state.reason}</p>;

    default:
      // The union is closed and every arm above returns, so this is unreachable.
      // It exists so that adding a state without a renderer fails to compile.
      return null;
  }
}

function WindowTitle({ title }: { title: string }): JSX.Element {
  return (
    <p style={{ margin: 0 }}>
      {title.length === 0 ? (
        <span style={{ color: typography.color.muted }}>an untitled window</span>
      ) : (
        title
      )}
    </p>
  );
}

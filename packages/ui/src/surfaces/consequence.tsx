import { useState } from "react";

import { corner, material, semantic, spacing, typography } from "../tokens/index.js";

/**
 * The three Surfaces Phase 8 registers: Approval, Artifact, and Source State.
 *
 * They share one rule and it is the reason they share a file. Each of them is
 * the place a user reads what is actually true before something irreversible
 * happens, so none of them is allowed to round a fact off in the user's favour:
 * an unimported reference says it is not local, an unobserved source says
 * nobody looked, and an approval that has not been executed does not say it has.
 */

const listReset = { listStyle: "none", margin: 0, padding: 0 } as const;

const buttonStyle = {
  // A 25px target for the one control that agrees to an irreversible
  // consequence is the wrong place to be short of the touch floor. Shared by
  // Confirm, Decline, and Execute now, because they are equally answers.
  minHeight: 44,
  font: "inherit",
  fontWeight: 500,
  background: material.fillElevated,
  color: "inherit",
  border: `1px solid ${material.border}`,
  borderRadius: corner.sm,
  padding: `${String(spacing.xs)}px ${String(spacing.md)}px`,
  cursor: "pointer",
} as const;

function Field({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={{ display: "contents" }}>
      <dt style={{ color: typography.color.muted }}>{label}</dt>
      <dd style={{ margin: 0 }}>{value}</dd>
    </div>
  );
}

export type ApprovalOutcome =
  "allow" | "deny" | "require_confirmation" | "require_typed_confirmation";

export interface ApprovalSurfaceProps {
  id: string;
  consequenceSummary: string;
  operationClass: string;
  capability: string;
  targetType: string;
  targetId: string;
  reversibility: "reversible" | "partially_reversible" | "irreversible";
  outcome: ApprovalOutcome;
  reasonCodes: readonly string[];
  estimatedCostGbp?: number;
  /** Present exactly when the outcome demands typing it. Derived by the core. */
  confirmationPhrase?: string;
  confirmedAt?: string;
  executedAt?: string;
  /** Set when a person said no. A decline is a recorded fact, not an absence. */
  declinedAt?: string;
  onConfirm?: (typedConfirmation?: string) => void;
  onExecute?: () => void;
  onDecline?: () => void;
}

const OUTCOME_WORDS: Readonly<Record<ApprovalOutcome, string>> = {
  allow: "allowed by policy",
  deny: "denied by policy",
  require_confirmation: "needs your confirmation",
  require_typed_confirmation: "needs a typed confirmation",
};

/**
 * The consequence boundary, rendered.
 *
 * Three things here are deliberate and none of them is decoration:
 *
 * - the confirm control is disabled until the typed phrase matches exactly, so
 *   the friction cannot be clicked past;
 * - the execute control does not exist until the approval is confirmed, so a
 *   preparation screen never has a commit button on it;
 * - "executed" is rendered from `executedAt` and nothing else. A Surface that
 *   inferred it from having pressed the button would claim a consequence
 *   happened when a network call may have failed.
 */
export function ApprovalSurface({
  consequenceSummary,
  operationClass,
  capability,
  targetType,
  targetId,
  reversibility,
  outcome,
  reasonCodes,
  estimatedCostGbp,
  confirmationPhrase,
  confirmedAt,
  executedAt,
  declinedAt,
  onConfirm,
  onExecute,
  onDecline,
}: ApprovalSurfaceProps): JSX.Element {
  const [typed, setTyped] = useState("");

  const needsTyping = outcome === "require_typed_confirmation";
  const phraseMatches = confirmationPhrase !== undefined && typed.trim() === confirmationPhrase;
  const canConfirm =
    confirmedAt === undefined &&
    executedAt === undefined &&
    declinedAt === undefined &&
    outcome !== "deny" &&
    outcome !== "allow" &&
    (!needsTyping || phraseMatches);

  return (
    <div style={{ display: "grid", gap: spacing.md }}>
      <p style={{ margin: 0, maxWidth: typography.measurePx }}>{consequenceSummary}</p>

      <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: spacing.sm }}>
        <Field label="Operation" value={operationClass} />
        <Field label="Capability" value={capability} />
        <Field label="Target" value={`${targetType}: ${targetId}`} />
        <Field label="Reversibility" value={reversibility.replace(/_/g, " ")} />
        {estimatedCostGbp !== undefined && (
          <Field label="Estimated cost" value={`GBP ${estimatedCostGbp.toFixed(2)}`} />
        )}
        <Field label="Policy" value={`${OUTCOME_WORDS[outcome]} — ${reasonCodes.join(", ")}`} />
      </dl>

      {executedAt !== undefined ? (
        <p style={{ margin: 0, color: semantic.current }}>
          Executed at {executedAt}. This cannot happen again.
        </p>
      ) : declinedAt !== undefined ? (
        <p style={{ margin: 0, color: semantic.stale }}>Declined at {declinedAt}.</p>
      ) : confirmedAt !== undefined ? (
        <div style={{ display: "grid", gap: spacing.sm }}>
          <p style={{ margin: 0, color: semantic.approval }}>
            Confirmed at {confirmedAt}. Not yet executed.
          </p>
          {onExecute !== undefined && (
            <div>
              <button type="button" onClick={onExecute} style={buttonStyle}>
                Execute now
              </button>
            </div>
          )}
        </div>
      ) : outcome === "deny" ? (
        <p style={{ margin: 0, color: semantic.error }}>
          Policy denied this. There is no control here, because there is nothing to approve.
        </p>
      ) : outcome === "allow" ? (
        <p style={{ margin: 0, color: typography.color.muted }}>
          Allowed without confirmation. Recorded for audit either way.
        </p>
      ) : onConfirm === undefined ? (
        /*
         * No handoff, so no control — the same courtesy `onExecute` two branches
         * up already gets, and the rule the rest of the Surfaces follow. A
         * Confirm button rendered without a handler is a button that reads as
         * consent and does nothing, which is the worst possible place in Noctis
         * for a silent no-op. Said in words instead, so the state is still legible.
         */
        <p style={{ margin: 0, color: semantic.approval }}>
          This needs your confirmation. There is no control here, because this view was not given
          one.
        </p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm?.(needsTyping ? typed.trim() : undefined);
          }}
          style={{ display: "grid", gap: spacing.sm }}
        >
          {needsTyping && confirmationPhrase !== undefined && (
            <div style={{ display: "grid", gap: spacing.xs }}>
              {/* The state sentence sits outside the label rather than inside
                  it. Nested in the label it would become part of the input's
                  accessible name, so the field would announce as "Type SPEND
                  GBP 8.00 ON provider:suno to confirm The phrase must match
                  exactly" — a name that changes as you type. */}
              <label htmlFor="typed-confirmation">
                Type{" "}
                <strong style={{ fontFamily: typography.monoFamily }}>{confirmationPhrase}</strong>{" "}
                to confirm
              </label>
              <input
                id="typed-confirmation"
                value={typed}
                onChange={(event) => {
                  setTyped(event.target.value);
                }}
                // Described, not just greyed out: a disabled control with no
                // reason attached is a dead end for anyone not looking at it.
                aria-describedby="typed-confirmation-state"
                autoComplete="off"
                spellCheck={false}
                style={{
                  background: material.fill,
                  border: `1px solid ${phraseMatches ? semantic.current : material.border}`,
                  borderRadius: corner.sm,
                  color: "inherit",
                  fontFamily: typography.monoFamily,
                  padding: spacing.sm,
                }}
              />
              <span
                id="typed-confirmation-state"
                // Polite rather than assertive: it should reach a screen reader
                // as the phrase becomes correct, without interrupting typing.
                aria-live="polite"
                style={{
                  color: phraseMatches ? semantic.current : typography.color.muted,
                  font: `${String(typography.scale.xs)}px ${typography.family}`,
                }}
              >
                {phraseMatches
                  ? "The phrase matches."
                  : "The phrase must match exactly, including capitals."}
              </span>
            </div>
          )}

          <div style={{ display: "flex", gap: spacing.sm }}>
            <button
              type="submit"
              disabled={!canConfirm}
              style={{ ...buttonStyle, opacity: canConfirm ? 1 : 0.5 }}
            >
              Confirm
            </button>
            {/* Never gated on the phrase: saying no must always be one step. */}
            {onDecline !== undefined && (
              <button type="button" onClick={onDecline} style={buttonStyle}>
                Decline
              </button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

export interface ArtifactSurfaceProps {
  kind: "local_artifact" | "external_reference";
  title: string;
  uri: string;
  mediaType?: string;
  hostId?: string;
  checksum?: string;
  /** The external reference this was imported from, when it is an import. */
  derivedFromArtifactId?: string;
  /** The local artifact this reference was imported into, when one exists. */
  importedAs?: string;
  onImport?: () => void;
}

/**
 * Section 12.2, in the one sentence a user needs: whether these bytes are here.
 *
 * The kind is written out rather than shown as a badge colour, and an external
 * reference that has never been imported says so — the state where a user most
 * easily believes they have a file when they have a link.
 */
export function ArtifactSurface({
  kind,
  title,
  uri,
  mediaType,
  hostId,
  checksum,
  derivedFromArtifactId,
  importedAs,
  onImport,
}: ArtifactSurfaceProps): JSX.Element {
  const isLocal = kind === "local_artifact";

  return (
    <div style={{ display: "grid", gap: spacing.sm }}>
      <p style={{ margin: 0 }}>{title}</p>

      <p
        style={{
          margin: 0,
          color: isLocal ? semantic.current : semantic.stale,
          font: `${String(typography.scale.xs)}px ${typography.family}`,
        }}
      >
        {isLocal
          ? `Local artifact on ${hostId ?? "an unnamed host"}`
          : "External reference — the bytes are not here"}
      </p>

      <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "auto 1fr", gap: spacing.sm }}>
        <Field label="URI" value={uri} />
        {mediaType !== undefined && <Field label="Type" value={mediaType} />}
        {checksum !== undefined && <Field label="Checksum" value={checksum} />}
        {derivedFromArtifactId !== undefined && (
          <Field label="Imported from" value={derivedFromArtifactId} />
        )}
        {importedAs !== undefined && <Field label="Imported as" value={importedAs} />}
      </dl>

      {!isLocal && importedAs === undefined && onImport !== undefined && (
        <div>
          <button type="button" onClick={onImport} style={buttonStyle}>
            Import a local copy
          </button>
        </div>
      )}
    </div>
  );
}

export type SourceStatusWord = "current" | "stale" | "unavailable" | "unknown";

const STATUS_COLOUR: Readonly<Record<SourceStatusWord, string>> = {
  current: semantic.current,
  stale: semantic.stale,
  unavailable: semantic.unavailable,
  unknown: semantic.unavailable,
};

const STATUS_SENTENCE: Readonly<Record<SourceStatusWord, string>> = {
  current: "verified just now",
  stale: "last verified a while ago",
  unavailable: "could not be reached; the last known value stands",
  unknown: "nobody has looked",
};

export interface SourceStateSurfaceProps {
  sourceType: string;
  externalId: string;
  status: SourceStatusWord;
  ageSeconds?: number;
  conflicted: boolean;
  /** Rendered as text, so a payload of any shape is readable rather than assumed. */
  observed?: string;
  remembered?: string;
  onRefresh?: () => void;
}

/**
 * Section 12.1's five words, as a Surface.
 *
 * `unknown` and `unavailable` share a colour and are separated only by their
 * sentence, exactly as the evidence primitive does it — because they are both
 * "no answer" to the eye and completely different to a decision.
 */
export function SourceStateSurface({
  sourceType,
  externalId,
  status,
  ageSeconds,
  conflicted,
  observed,
  remembered,
  onRefresh,
}: SourceStateSurfaceProps): JSX.Element {
  return (
    <div style={{ display: "grid", gap: spacing.sm }}>
      <p style={{ margin: 0, color: typography.color.muted }}>
        {sourceType} · {externalId}
      </p>

      <p style={{ margin: 0, display: "flex", alignItems: "center", gap: spacing.xs }}>
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: STATUS_COLOUR[status],
            flex: "0 0 auto",
          }}
        />
        <span>{status}</span>
        <span style={{ color: typography.color.muted }}>
          — {STATUS_SENTENCE[status]}
          {ageSeconds === undefined ? "" : ` (${String(Math.round(ageSeconds))}s ago)`}
        </span>
      </p>

      {conflicted && (
        <p style={{ margin: 0, color: semantic.warning }}>
          What Noctis remembered and what it just observed disagree. Both are below.
        </p>
      )}

      <ul style={{ ...listReset, display: "grid", gap: spacing.xs }}>
        {observed !== undefined && (
          <li>
            <span style={{ color: typography.color.muted }}>Current: </span>
            <code style={{ fontFamily: typography.monoFamily }}>{observed}</code>
          </li>
        )}
        {remembered !== undefined && (
          <li>
            <span style={{ color: typography.color.muted }}>Remembered: </span>
            <code style={{ fontFamily: typography.monoFamily }}>{remembered}</code>
          </li>
        )}
      </ul>

      {onRefresh !== undefined && (
        <div>
          <button type="button" onClick={onRefresh} style={buttonStyle}>
            Check the source now
          </button>
        </div>
      )}
    </div>
  );
}

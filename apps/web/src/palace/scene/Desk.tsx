import { motion, useReducedMotion } from "motion/react";
import type { ChangeEvent, KeyboardEvent, ReactNode } from "react";
import { useEffect, useRef } from "react";

export type SaveState =
  | { kind: "idle" }
  | { kind: "draft" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "message"; text: string }
  | { kind: "conflict" }
  | { kind: "failed"; reason: string };

function statusLine(state: SaveState): string {
  switch (state.kind) {
    case "idle":
      return "";
    case "draft":
      return "Draft saved on this device";
    case "saving":
      return "Saving";
    case "saved":
      return "Saved";
    case "message":
      return state.text;
    case "conflict":
      return "This entry changed elsewhere. Your writing is kept.";
    case "failed":
      return state.reason;
  }
}

export interface DeskProps {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  state: SaveState;
  dimmed: boolean;
  placeholder?: string;
  details?: ReactNode;
  actions?: ReactNode;
  disabled?: boolean;
  allowEmptyBody?: boolean;
}

export function Desk({
  value,
  onChange,
  onSave,
  state,
  dimmed,
  placeholder = "What is on your mind?",
  details,
  actions,
  disabled = false,
  allowEmptyBody = false,
}: DeskProps): JSX.Element {
  const reduced = useReducedMotion() ?? false;
  const field = useRef<HTMLTextAreaElement>(null);
  const canSave = !disabled && state.kind !== "saving" && (allowEmptyBody || value.trim() !== "");

  useEffect(() => {
    if (!dimmed) field.current?.focus({ preventScroll: true });
  }, [dimmed]);

  const submit = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (canSave) onSave();
    }
  };

  return (
    <motion.div
      className="palace-desk"
      animate={{ opacity: dimmed ? 0 : 1, y: dimmed ? 24 : 0 }}
      transition={{ duration: reduced ? 0 : 0.5, ease: [0.2, 0, 0, 1] }}
      style={{ pointerEvents: dimmed ? "none" : "auto" }}
      {...(dimmed ? { inert: "" } : {})}
    >
      <label htmlFor="palace-desk">{placeholder}</label>
      <textarea
        id="palace-desk"
        ref={field}
        value={value}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value)}
        onKeyDown={submit}
        disabled={disabled}
        rows={2}
        spellCheck
      />
      <div className="palace-desk-footer">
        <button type="button" className="palace-save" onClick={onSave} disabled={!canSave}>
          Save
        </button>
        {actions}
        <span
          className="palace-save-state"
          data-problem={state.kind === "failed" || state.kind === "conflict"}
          aria-live="polite"
        >
          {statusLine(state)}
        </span>
        {details !== undefined && (
          <details className="palace-details">
            <summary>Details</summary>
            <div className="palace-details-fields">{details}</div>
          </details>
        )}
      </div>
    </motion.div>
  );
}

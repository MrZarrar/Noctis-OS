import { motion, useReducedMotion } from "motion/react";
import type { ChangeEvent, KeyboardEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function resizedDeskHeight(start: number, startY: number, y: number, max: number): number {
  return Math.min(max, Math.max(Math.min(180, max), start + startY - y));
}

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
  entryId?: string;
  openRequest?: number;
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
  entryId,
  openRequest = 0,
}: DeskProps): JSX.Element {
  const reduced = useReducedMotion() ?? false;
  const field = useRef<HTMLTextAreaElement>(null);
  const desk = useRef<HTMLDivElement>(null);
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);
  const [scene, setScene] = useState<Element | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [height, setHeight] = useState<number>();
  const canSave = !disabled && state.kind !== "saving" && (allowEmptyBody || value.trim() !== "");

  useEffect(() => {
    setScene(desk.current?.closest(".palace-scene") ?? null);
  }, []);
  useEffect(() => {
    if (entryId !== undefined) {
      setHeight(undefined);
      setExpanded(true);
    }
  }, [entryId]);
  useEffect(() => {
    if (openRequest > 0) {
      setHeight(undefined);
      setExpanded(true);
    }
  }, [openRequest]);
  useEffect(() => {
    if (!dimmed) field.current?.focus({ preventScroll: true });
  }, [dimmed, expanded]);

  const submit = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (canSave) onSave();
    }
  };

  const content = (
    <motion.div
      ref={desk}
      className="palace-desk"
      animate={{ opacity: dimmed ? 0 : 1, y: dimmed ? 24 : 0 }}
      transition={{ duration: reduced ? 0 : 0.5, ease: [0.2, 0, 0, 1] }}
      style={{
        pointerEvents: dimmed ? "none" : "auto",
        ...(expanded && height !== undefined ? { height } : {}),
      }}
      {...(dimmed ? { inert: "" } : {})}
    >
      {expanded ? (
        <>
          <button type="button" className="palace-full-close" onClick={() => setExpanded(false)}>
            Back to room
          </button>
          <button
            type="button"
            className="palace-resize"
            aria-label="Resize writing view"
            title="Drag to resize"
            onPointerDown={(event) => {
              if (desk.current === null) return;
              drag.current = {
                startY: event.clientY,
                startHeight: desk.current.getBoundingClientRect().height,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (drag.current === null || scene === null) return;
              setHeight(
                resizedDeskHeight(
                  drag.current.startHeight,
                  drag.current.startY,
                  event.clientY,
                  scene.clientHeight - 24,
                ),
              );
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            onKeyDown={(event) => {
              if (
                scene === null ||
                desk.current === null ||
                !["ArrowUp", "ArrowDown"].includes(event.key)
              )
                return;
              event.preventDefault();
              setHeight(
                resizedDeskHeight(
                  desk.current.getBoundingClientRect().height,
                  0,
                  event.key === "ArrowUp" ? -40 : 40,
                  scene.clientHeight - 24,
                ),
              );
            }}
          >
            <span />
          </button>
        </>
      ) : (
        <button
          type="button"
          className="palace-full-open"
          aria-label="Open full writing view"
          onClick={() => {
            setHeight(undefined);
            setExpanded(true);
          }}
        >
          Expand
        </button>
      )}
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
  return expanded && scene !== null
    ? createPortal(<div className="palace-writing-focus">{content}</div>, scene)
    : content;
}

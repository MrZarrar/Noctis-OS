import { motion, useReducedMotion } from "motion/react";
import type { ChangeEvent, KeyboardEvent } from "react";
import { useEffect, useRef } from "react";

export type SaveState =
  | { kind: "idle" }
  | { kind: "draft" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "conflict" }
  | { kind: "failed"; reason: string };

/**
 * "Draft saved on this device" and "Saved" are different promises and the words
 * are not interchangeable: the first is a local recovery copy, the second is a
 * confirmed write to the file on disk.
 */
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
  /** Dimmed and lifted away while the owner is looking around the room. */
  dimmed: boolean;
  placeholder?: string;
}

const PAPER = "#f6efdf";
const INK = "#3a2f21";

/**
 * The writing surface. It is the first thing mounted and it never waits on the
 * scene: the textarea is live before a plate has loaded, which is the whole
 * point of opening at the desk.
 */
export function Desk({
  value,
  onChange,
  onSave,
  state,
  dimmed,
  placeholder = "What is on your mind?",
}: DeskProps): JSX.Element {
  const reduced = useReducedMotion() ?? false;
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!dimmed) field.current?.focus({ preventScroll: true });
  }, [dimmed]);

  const submit = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      onSave();
    }
  };

  const status = statusLine(state);

  return (
    <motion.div
      animate={{ opacity: dimmed ? 0.25 : 1, y: dimmed ? 48 : 0 }}
      transition={{ duration: reduced ? 0 : 0.5, ease: [0.2, 0, 0, 1] }}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: dimmed ? "none" : "auto",
      }}
    >
      <div
        style={{
          background: PAPER,
          // Full bleed on purpose. The painted paper on the plate is wider than
          // the frame at the desk stop, so a narrower panel would leave its
          // edges showing either side and read as two sheets.
          margin: "0 auto",
          // Paper, not a card: a hairline of its own thickness along the top,
          // and the desk's shadow pooling underneath it.
          borderRadius: "3px 3px 0 0",
          boxShadow:
            "0 -1px 0 rgba(255,255,255,0.65) inset, 0 -28px 70px rgba(28,16,4,0.42), 0 -2px 14px rgba(28,16,4,0.3)",
          // The side padding grows to whatever keeps the line length readable,
          // so the sheet can span the frame without the writing spanning it too.
          padding: `clamp(22px, 3vw, 44px) max(clamp(24px, 3.6vw, 56px), calc((100% - 60rem) / 2)) clamp(20px, 2.4vw, 32px)`,
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        <label
          htmlFor="palace-desk"
          style={{
            font: "600 clamp(19px, 1.7vw, 27px)/1.2 Georgia, 'Times New Roman', serif",
            color: INK,
          }}
        >
          {placeholder}
        </label>

        <textarea
          id="palace-desk"
          ref={field}
          value={value}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
            onChange(event.target.value);
          }}
          onKeyDown={submit}
          rows={4}
          spellCheck
          style={{
            font: "400 clamp(15px, 1.25vw, 19px)/1.65 Georgia, 'Times New Roman', serif",
            color: INK,
            background: "transparent",
            border: 0,
            outline: "none",
            resize: "none",
            minHeight: "6.5em",
            padding: 0,
            caretColor: "#8a6b2f",
          }}
        />

        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <button
            type="button"
            onClick={onSave}
            disabled={value.trim() === "" || state.kind === "saving"}
            style={{
              font: "500 15px/1 Georgia, 'Times New Roman', serif",
              letterSpacing: "0.02em",
              color: "#f3ead6",
              background: value.trim() === "" ? "#6f7a68" : "#39503a",
              border: 0,
              borderRadius: 999,
              padding: "13px 30px",
              cursor: value.trim() === "" ? "default" : "pointer",
              transition: "background 180ms cubic-bezier(0.2,0,0,1)",
            }}
          >
            Save thought
          </button>

          <span
            aria-live="polite"
            style={{
              font: "400 13px/1.4 Georgia, 'Times New Roman', serif",
              color: state.kind === "failed" || state.kind === "conflict" ? "#8c3b2a" : "#7b6d57",
            }}
          >
            {status}
          </span>
        </div>
      </div>
    </motion.div>
  );
}

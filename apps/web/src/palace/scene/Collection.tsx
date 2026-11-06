import type { PalaceEntry } from "@noctis/contracts";
import { motion, useReducedMotion } from "motion/react";

/** A line of context under an entry's name: what it is, and its book or status. */
function describe(entry: PalaceEntry): string {
  const parts = [entry.kind === "art" ? "art idea" : entry.kind];
  if (entry.readingStatus !== undefined) parts.push(entry.readingStatus);
  if (entry.location !== undefined) parts.push(entry.location);
  if (entry.archived) parts.push("archived");
  return parts.join(" · ");
}

function label(entry: PalaceEntry): string {
  const title = entry.title?.trim();
  if (title !== undefined && title !== "") return title;
  // A jot has no title, so a short preview stands in for one. It is presentation
  // only: nothing invented here is ever written back into the owner's text.
  const preview = entry.body.trim().split("\n")[0] ?? "";
  return preview === "" ? "Untitled" : `${preview.slice(0, 72)}${preview.length > 72 ? "…" : ""}`;
}

export interface CollectionProps {
  title: string;
  entries: readonly PalaceEntry[];
  openId?: string;
  onOpen: (id: string) => void;
  onMore?: () => void;
  /** Lifted out of the way while the owner is looking around the room. */
  dimmed: boolean;
  empty: string;
}

/**
 * What the room holds, as a readable panel over the artwork. The shelves and
 * frames in the plate are scenery; this is the part that is actually navigable,
 * so every entry is a real button and the list is reachable by keyboard.
 */
export function Collection({
  title,
  entries,
  openId,
  onOpen,
  onMore,
  dimmed,
  empty,
}: CollectionProps): JSX.Element {
  const reduced = useReducedMotion() ?? false;

  return (
    <motion.section
      aria-label={title}
      animate={{ opacity: dimmed ? 0 : 1, x: dimmed ? 40 : 0 }}
      transition={{ duration: reduced ? 0 : 0.45, ease: [0.2, 0, 0, 1] }}
      style={{
        position: "absolute",
        top: "clamp(150px, 22vh, 260px)",
        right: "clamp(18px, 3vw, 54px)",
        bottom: "clamp(18px, 4vh, 48px)",
        width: "min(26rem, 40%)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "20px 8px 16px 20px",
        borderRadius: 14,
        background: "rgba(38,27,14,0.52)",
        backdropFilter: "blur(14px)",
        boxShadow: "0 18px 60px rgba(20,12,4,0.42)",
        pointerEvents: dimmed ? "none" : "auto",
      }}
    >
      <h2
        style={{
          margin: 0,
          paddingRight: 12,
          font: "400 19px/1.2 Georgia, 'Times New Roman', serif",
          color: "#f3e3c2",
        }}
      >
        {title}
      </h2>

      <div style={{ overflowY: "auto", paddingRight: 12, display: "grid", gap: 4 }}>
        {entries.length === 0 && (
          <p style={{ font: "400 14px/1.5 Georgia, serif", color: "#cdbb9a", margin: 0 }}>
            {empty}
          </p>
        )}

        {entries.map((entry) => {
          const open = entry.id === openId;
          return (
            <button
              key={entry.id}
              type="button"
              aria-current={open ? "true" : undefined}
              onClick={() => {
                onOpen(entry.id);
              }}
              style={{
                textAlign: "left",
                display: "grid",
                gap: 3,
                padding: "11px 13px",
                border: 0,
                borderRadius: 9,
                cursor: "pointer",
                background: open ? "rgba(255,230,180,0.17)" : "transparent",
                boxShadow: open ? "inset 0 0 0 1px rgba(255,226,170,0.4)" : "none",
                transition: "background 160ms",
              }}
            >
              <span style={{ font: "400 15px/1.35 Georgia, serif", color: "#f6ead3" }}>
                {label(entry)}
              </span>
              <span
                style={{
                  font: "400 12px/1.3 Georgia, serif",
                  color: "#c3ad88",
                  letterSpacing: "0.02em",
                }}
              >
                {describe(entry)}
              </span>
            </button>
          );
        })}

        {onMore !== undefined && (
          <button
            type="button"
            onClick={onMore}
            style={{
              justifySelf: "start",
              marginTop: 6,
              font: "400 13px/1 Georgia, serif",
              color: "#e8d3a4",
              background: "transparent",
              border: 0,
              padding: "8px 4px",
              cursor: "pointer",
              textDecoration: "underline",
            }}
          >
            Show more
          </button>
        )}
      </div>
    </motion.section>
  );
}

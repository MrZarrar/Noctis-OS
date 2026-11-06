import { motion, useReducedMotion } from "motion/react";

export type SearchScope = "palace" | "room";

export interface ChromeProps {
  /** The room's own name, used as the this-room scope label. */
  roomName: string;
  query: string;
  onQuery: (query: string) => void;
  scope: SearchScope;
  onScope: (scope: SearchScope) => void;
  exploring: boolean;
  onExplore: (exploring: boolean) => void;
  /** Absent in a panel, which already has the shell's own way out. */
  onLeave?: () => void;
  /** Absent in the atrium, which is where the doors already are. */
  onReturnToAtrium?: () => void;
}

const GOLD = "#e8d3a4";

/**
 * Everything floating over the scene that is not the desk: the title, search,
 * and the control that pulls the camera back to look around.
 */
export function Chrome({
  roomName,
  query,
  onQuery,
  scope,
  onScope,
  exploring,
  onExplore,
  onLeave,
  onReturnToAtrium,
}: ChromeProps): JSX.Element {
  const reduced = useReducedMotion() ?? false;

  return (
    <>
      {onReturnToAtrium !== undefined && (
        <button
          type="button"
          onClick={onReturnToAtrium}
          style={{
            position: "absolute",
            top: 22,
            left: 26,
            font: "400 14px/1 Georgia, 'Times New Roman', serif",
            color: "#4a3a26",
            background: "rgba(255,250,240,0.6)",
            border: 0,
            borderRadius: 999,
            padding: "9px 16px",
            cursor: "pointer",
            backdropFilter: "blur(6px)",
          }}
        >
          Back to the atrium
        </button>
      )}

      {onLeave !== undefined && (
        <button
          type="button"
          onClick={onLeave}
          style={{
            position: "absolute",
            top: 22,
            right: 26,
            font: "400 14px/1 Georgia, 'Times New Roman', serif",
            color: "#4a3a26",
            background: "rgba(255,250,240,0.6)",
            border: 0,
            borderRadius: 999,
            padding: "9px 16px",
            cursor: "pointer",
            backdropFilter: "blur(6px)",
          }}
        >
          Back to Noctis
        </button>
      )}

      <motion.div
        animate={{ y: exploring ? -14 : 0, opacity: 1 }}
        transition={{ duration: reduced ? 0 : 0.6, ease: [0.2, 0, 0, 1] }}
        style={{
          position: "absolute",
          top: "clamp(28px, 5vh, 68px)",
          left: "50%",
          transform: "translateX(-50%)",
          width: "min(34rem, 72%)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 18,
        }}
      >
        <h1
          style={{
            margin: 0,
            font: "400 clamp(30px, 4.2vw, 62px)/1 Georgia, 'Times New Roman', serif",
            color: "#2f2518",
            letterSpacing: "0.01em",
            textShadow: "0 2px 26px rgba(255,246,225,0.75)",
          }}
        >
          Thought Palace
        </h1>

        <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
          <input
            type="search"
            value={query}
            onChange={(event) => {
              onQuery(event.target.value);
            }}
            placeholder={scope === "room" ? `Search ${roomName.toLowerCase()}` : "Search"}
            aria-label={scope === "room" ? `Search ${roomName}` : "Search the whole palace"}
            style={{
              width: "100%",
              boxSizing: "border-box",
              font: "400 15px/1 Georgia, 'Times New Roman', serif",
              color: "#3a2f21",
              background: "rgba(255,251,243,0.72)",
              border: "1px solid rgba(120,96,56,0.22)",
              borderRadius: 999,
              padding: "14px 22px",
              outlineColor: GOLD,
              backdropFilter: "blur(8px)",
            }}
          />

          {/* Searching the whole palace is the default; narrowing to the room
              you are standing in is the option, not the other way round. */}
          <div
            role="radiogroup"
            aria-label="Where to search"
            style={{ display: "flex", justifyContent: "center", gap: 4 }}
          >
            {(
              [
                ["palace", "All of the palace"],
                ["room", roomName],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={scope === value}
                onClick={() => {
                  onScope(value);
                }}
                style={{
                  font: "400 12px/1 Georgia, 'Times New Roman', serif",
                  letterSpacing: "0.03em",
                  color: scope === value ? "#2f2518" : "#6b5b43",
                  background: scope === value ? "rgba(255,249,236,0.78)" : "transparent",
                  border: 0,
                  borderRadius: 999,
                  padding: "7px 14px",
                  cursor: "pointer",
                  transition: "background 180ms, color 180ms",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </motion.div>

      <button
        type="button"
        onClick={() => {
          onExplore(!exploring);
        }}
        aria-pressed={exploring}
        style={{
          position: "absolute",
          left: "50%",
          bottom: exploring ? "9%" : "32%",
          transform: "translateX(-50%)",
          display: "flex",
          alignItems: "center",
          gap: 9,
          font: "400 13px/1 Georgia, 'Times New Roman', serif",
          color: "#3f3222",
          background: "rgba(255,250,240,0.68)",
          border: 0,
          borderRadius: 999,
          padding: "11px 20px",
          cursor: "pointer",
          backdropFilter: "blur(6px)",
          boxShadow: "0 6px 24px rgba(30,18,6,0.22)",
          transition: reduced ? "none" : "bottom 900ms cubic-bezier(0.2,0,0,1)",
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-block",
            transform: exploring ? "rotate(180deg)" : "none",
            transition: "transform 320ms cubic-bezier(0.2,0,0,1)",
          }}
        >
          ⌃
        </span>
        {exploring ? "Return to the desk" : "Explore the palace"}
      </button>
    </>
  );
}

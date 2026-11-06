import type { TransformTemplate } from "motion/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { useCallback, useRef, useState } from "react";

import type { CameraStop } from "./camera.js";
import { OVERSCAN } from "./camera.js";
import type { Hotspot, RoomId } from "./rooms.js";
import { ROOMS } from "./rooms.js";

/**
 * Motion's own transform order is translate then scale, which would measure the
 * translate against an already-scaled box and let the focal point slide as the
 * zoom changes. The camera needs the opposite order, so the template writes it
 * rather than animating one opaque transform string.
 */
const transformTemplate: TransformTemplate = ({ x, y, scale }) =>
  `scale(${String(scale ?? 1)}) translate(${String(x ?? "0%")}, ${String(y ?? "0%")})`;

function target(stop: CameraStop): { x: string; y: string; scale: number } {
  return {
    x: `${((0.5 - stop.focus.x) * 100).toFixed(4)}%`,
    y: `${((0.5 - stop.focus.y) * 100).toFixed(4)}%`,
    scale: stop.zoom,
  };
}

/** Arriving already moving forward, so the room settles towards you. */
function arrival(stop: CameraStop): CameraStop {
  return { focus: stop.focus, zoom: stop.zoom * 1.12 };
}

const EASE_IN = [0.4, 0, 1, 1] as const;
const EASE_OUT = [0, 0, 0.2, 1] as const;
const EASE_STANDARD = [0.2, 0, 0, 1] as const;

export interface PalaceSceneProps {
  room: RoomId;
  onRoomChange: (room: RoomId) => void;
  /** True while the owner is looking around rather than writing. */
  exploring: boolean;
  /** The fixed layer: desk, editor, search. Never transformed, never scaled. */
  children?: ReactNode;
}

/**
 * The palace itself: one plate per room with the camera on it, the doors as real
 * buttons anchored to the artwork, and the writing surface held still above it.
 */
export function PalaceScene({
  room,
  onRoomChange,
  exploring,
  children,
}: PalaceSceneProps): JSX.Element {
  const reduced = useReducedMotion() ?? false;
  const current = ROOMS[room];
  const [loaded, setLoaded] = useState<Partial<Record<RoomId, boolean>>>({});
  // Read by the plate on its way out, so the room it leaves accelerates towards
  // the door that was actually clicked rather than a fixed direction.
  const leaving = useRef<CameraStop>(current.wide);

  const resting = exploring ? current.wide : current.desk;

  const travel = useCallback(
    (hotspot: Hotspot) => {
      leaving.current = hotspot.enter;
      onRoomChange(hotspot.to);
    },
    [onRoomChange],
  );

  const seconds = (ms: number): number => (reduced ? 0 : ms / 1000);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        // The plates are warm stone; an unloaded one should not flash white.
        background: "#2b2119",
      }}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={room}
          aria-hidden
          transformTemplate={transformTemplate}
          initial={{ opacity: 0, ...target(arrival(resting)) }}
          animate={{ opacity: 1, ...target(resting) }}
          // Leaving accelerates and arriving decelerates, so a door reads as
          // walking through it rather than as a crossfade between two pictures.
          exit={{
            opacity: 0,
            ...target(leaving.current),
            transition: { duration: seconds(620), ease: EASE_IN },
          }}
          transition={{
            opacity: { duration: seconds(420), ease: EASE_STANDARD },
            default: {
              duration: seconds(exploring ? 2200 : 900),
              ease: exploring ? EASE_STANDARD : EASE_OUT,
            },
          }}
          style={{
            position: "absolute",
            // Overscanned and recentred, so every camera stop has picture to
            // pan into instead of dragging an edge into frame.
            left: `${String((100 - OVERSCAN * 100) / 2)}%`,
            top: `${String((100 - OVERSCAN * 100) / 2)}%`,
            width: `${String(OVERSCAN * 100)}%`,
            height: `${String(OVERSCAN * 100)}%`,
            willChange: "transform, opacity",
          }}
        >
          <img
            src={current.plate}
            alt=""
            onLoad={() => {
              setLoaded((was) => ({ ...was, [room]: true }));
            }}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
              // The scene fades up once it has something to show. Writing is
              // already available underneath either way.
              opacity: loaded[room] === true ? 1 : 0,
              transition: `opacity ${String(seconds(600))}s ${"cubic-bezier(0, 0, 0.2, 1)"}`,
            }}
          />

          {current.hotspots.map((hotspot) => (
            <DoorButton
              key={hotspot.id}
              hotspot={hotspot}
              onEnter={() => {
                travel(hotspot);
              }}
            />
          ))}
        </motion.div>
      </AnimatePresence>

      {/* Depth, and a floor dark enough for the desk controls to read against. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          background:
            "radial-gradient(120% 90% at 50% 28%, rgba(0,0,0,0) 38%, rgba(26,18,10,0.42) 100%)",
        }}
      />

      <div style={{ position: "absolute", inset: 0 }}>{children}</div>
    </div>
  );
}

/**
 * A doorway. The art carries no lettering, so the name lives here as real text
 * that a screen reader can read and a keyboard can reach, revealed on hover or
 * focus rather than painted permanently over the scene.
 */
function DoorButton({ hotspot, onEnter }: { hotspot: Hotspot; onEnter: () => void }): JSX.Element {
  const [lit, setLit] = useState(false);

  return (
    <button
      type="button"
      onClick={onEnter}
      onPointerEnter={() => {
        setLit(true);
      }}
      onPointerLeave={() => {
        setLit(false);
      }}
      onFocus={() => {
        setLit(true);
      }}
      onBlur={() => {
        setLit(false);
      }}
      style={{
        position: "absolute",
        left: `${String(hotspot.rect.x * 100)}%`,
        top: `${String(hotspot.rect.y * 100)}%`,
        width: `${String(hotspot.rect.width * 100)}%`,
        height: `${String(hotspot.rect.height * 100)}%`,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "6%",
        border: 0,
        borderRadius: "48% 48% 6% 6%",
        cursor: "pointer",
        background: lit
          ? "linear-gradient(180deg, rgba(255,232,186,0.26), rgba(255,210,140,0.05))"
          : "transparent",
        boxShadow: lit
          ? "0 0 0 1px rgba(255,226,170,0.45), 0 0 60px rgba(255,205,130,0.3)"
          : "none",
        transition: "background 220ms cubic-bezier(0.2,0,0,1), box-shadow 220ms",
      }}
    >
      <span
        style={{
          font: "500 clamp(13px, 1.1vw, 17px)/1.2 Georgia, 'Times New Roman', serif",
          letterSpacing: "0.04em",
          color: "#f6e4c0",
          textShadow: "0 1px 10px rgba(40,24,8,0.85)",
          opacity: lit ? 1 : 0,
          transform: lit ? "translateY(0)" : "translateY(-4px)",
          transition: "opacity 220ms, transform 220ms cubic-bezier(0.2,0,0,1)",
        }}
      >
        {hotspot.label}
      </span>
    </button>
  );
}

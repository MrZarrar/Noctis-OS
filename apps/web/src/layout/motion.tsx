import { motion as tokens } from "@noctis/ui";
import { MotionConfig, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef } from "react";

/** The tokens' standard curve, as the numbers Motion takes. */
export const EASE = [0.2, 0, 0, 1] as const;

export const seconds = (ms: number): number => ms / 1000;

/**
 * The one place the app's animated DOM takes its timing from. Motion's own
 * "user" setting only drops movement and keeps fades; the tokens say a reduced
 * duration is zero, so with reduced motion every default transition is instant.
 * Anything that passes its own `transition` opts out of this and must check
 * `useReducedMotion` itself.
 */
export function MotionPolicy({ children }: { children: ReactNode }): JSX.Element {
  const reduced = useReducedMotion() ?? false;

  return (
    <MotionConfig
      reducedMotion="user"
      transition={
        reduced ? { duration: 0 } : { duration: seconds(tokens.durationMs.base), ease: EASE }
      }
    >
      {children}
    </MotionConfig>
  );
}

/** How a row that has just arrived comes in: a short rise into place. */
export const ARRIVE = { opacity: 0, y: 8 } as const;
export const SETTLED = { opacity: 1, y: 0 } as const;

/** More new rows than this at once is a list loading, not things arriving. */
const BATCH = 4;

export interface ArrivalMemory {
  seen: ReadonlySet<string>;
  present: ReadonlySet<string>;
  /** Streams that ended and whose committed rows have not shown up yet. */
  owed: number;
}

export interface Handoff {
  /** A key whose row is replaced by another when it ends, like a streamed reply. */
  from: (key: string) => boolean;
  /** A key that may be that replacement. */
  to: (key: string) => boolean;
}

/**
 * Which keys have just arrived and should play their entrance. The first sight
 * of a list is its history, and so is a batch bigger than a few rows, so
 * neither replays as if new. A key seen once never plays again, and a row that
 * takes over from a stream that just ended came in already.
 */
export function arrivals(
  memory: ArrivalMemory | undefined,
  keys: readonly string[],
  handoff?: Handoff,
): { memory: ArrivalMemory; fresh: ReadonlySet<string> } {
  const present = new Set(keys);
  if (memory === undefined) {
    return { memory: { seen: present, present, owed: 0 }, fresh: new Set() };
  }

  let owed = memory.owed;
  if (handoff !== undefined) {
    for (const key of memory.present) if (!present.has(key) && handoff.from(key)) owed += 1;
  }

  const added = keys.filter((key) => !memory.seen.has(key));
  const fresh = new Set<string>();
  if (added.length <= BATCH) {
    for (const key of added) {
      if (owed > 0 && handoff?.to(key) === true) owed -= 1;
      else fresh.add(key);
    }
  }

  return { memory: { seen: new Set([...memory.seen, ...keys]), present, owed }, fresh };
}

/**
 * `arrivals` across renders. The render only reads what was committed, so a
 * render React throws away (or Strict Mode repeats) cannot use up an entrance.
 * A new `reset` (another thread, another list) starts from history again.
 */
export function useArrivals(
  keys: readonly string[],
  reset?: unknown,
  handoff?: Handoff,
): ReadonlySet<string> {
  const committed = useRef<{ reset: unknown; memory?: ArrivalMemory }>({ reset });
  const prior = committed.current.reset === reset ? committed.current.memory : undefined;
  const result = arrivals(prior, keys, handoff);

  useLayoutEffect(() => {
    committed.current = { reset, memory: result.memory };
  });

  return result.fresh;
}

/** `initial` for a keyed row: its entrance when it has just arrived, nothing when it was already here. */
export const entrance = (fresh: ReadonlySet<string>, key: string): typeof ARRIVE | false =>
  fresh.has(key) ? ARRIVE : false;

type Box = Pick<DOMRect, "left" | "top" | "width" | "height">;

/** The transform that puts a box at `to` back where it was at `from`. */
export function moveFrom(from: Box, to: Box): string | undefined {
  if (to.width === 0 || to.height === 0) return undefined;
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  const sx = from.width / to.width;
  const sy = from.height / to.height;
  if (dx === 0 && dy === 0 && sx === 1 && sy === 1) return undefined;
  return `translate(${String(dx)}px, ${String(dy)}px) scale(${String(sx)}, ${String(sy)})`;
}

/**
 * Glides an element that has just been drawn somewhere new from where it was
 * drawn before. A Web Animation rather than state, so nothing re-renders while
 * it runs and the element's real place is never in doubt.
 */
export function playMove(element: HTMLElement, from: Box): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const transform = moveFrom(from, element.getBoundingClientRect());
  if (transform === undefined) return;
  // Its arrival would play on top of the move: the panel is not new, it moved.
  element.getAnimations().forEach((animation) => animation.cancel());
  element.animate(
    [
      { transformOrigin: "top left", transform },
      { transformOrigin: "top left", transform: "none" },
    ],
    { duration: tokens.durationMs.slow, easing: tokens.easing.standard },
  );
}

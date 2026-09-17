import { useEffect, useState } from "react";

/**
 * Ported from the donor's `client/src/hooks/useIsMobile.ts` (commit `724d331`,
 * MIT, "Copyright (c) 2026 - Now, Son Nguyen"). See
 * `docs/architecture/DONOR-PORT-LEDGER.md`.
 *
 * The breakpoint is Noctis's own: the rail is 72 px of fixed chrome, and below
 * 720 px that is more of the screen than navigation has earned. The donor's
 * 767 px is Tailwind's `md` tier, which is a fact about Tailwind.
 */
export const MOBILE_QUERY = "(max-width: 719px)";

/** Just enough of `matchMedia` to answer the question, so a test can supply one. */
type MatchMedia = (query: string) => { matches: boolean };

/**
 * The decision, as a plain function: there is no React renderer in this repo's
 * unit tests, and extracting the one branch worth testing is cheaper than
 * adding one. `undefined` is the server and every other place with no
 * `matchMedia` — a desktop-width answer, never a throw.
 */
export function isMobile(matchMedia: MatchMedia | undefined): boolean {
  return matchMedia === undefined ? false : matchMedia(MOBILE_QUERY).matches;
}

function currentMatchMedia(): MatchMedia | undefined {
  return typeof window === "undefined" || typeof window.matchMedia !== "function"
    ? undefined
    : window.matchMedia.bind(window);
}

export function useIsMobile(): boolean {
  // Read synchronously, so the first paint is already the right shell rather
  // than a desktop rail that flashes away on the next frame.
  const [mobile, setMobile] = useState(() => isMobile(currentMatchMedia()));

  useEffect(() => {
    const matchMedia = currentMatchMedia();

    if (matchMedia === undefined) {
      return;
    }

    const query = window.matchMedia(MOBILE_QUERY);
    const onChange = (): void => {
      setMobile(query.matches);
    };

    // Once on mount too: the viewport can have changed between the synchronous
    // read above and the effect running.
    onChange();
    query.addEventListener("change", onChange);

    return () => {
      query.removeEventListener("change", onChange);
    };
  }, []);

  return mobile;
}

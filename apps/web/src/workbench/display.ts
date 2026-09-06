import type { SurfaceDisplay } from "@noctis/contracts";

const CLIENT_ID_KEY = "noctis.clientId";

export interface ScreenFacts {
  screenWidth: number;
  screenHeight: number;
  devicePixelRatio: number;
  viewportWidth: number;
}

/**
 * Identifies the display arrangement, not the window.
 *
 * An override is remembered against this string, so it must change when the
 * user moves to a physically different setup and must *not* change when they
 * merely resize a window. Screen geometry and pixel ratio do that; viewport
 * width, which changes on every drag of a window edge, deliberately does not
 * appear here.
 */
export function displayFingerprint(facts: ScreenFacts): string {
  return `${String(facts.screenWidth)}x${String(facts.screenHeight)}@${String(facts.devicePixelRatio)}`;
}

export function displayFor(facts: ScreenFacts): SurfaceDisplay {
  return {
    fingerprint: displayFingerprint(facts),
    // Composition reacts to how much room there is right now, which is the
    // viewport — the one number the compositor is given, and never a rectangle.
    widthPx: Math.max(1, Math.round(facts.viewportWidth)),
  };
}

export function screenFacts(source: Window): ScreenFacts {
  return {
    screenWidth: source.screen.width,
    screenHeight: source.screen.height,
    devicePixelRatio: source.devicePixelRatio,
    viewportWidth: source.innerWidth,
  };
}

/**
 * A stable id for this browser profile, so overrides made here are not
 * attributed to the desktop shell or to another window. Storage that refuses to
 * persist (a private window, a locked-down WebView) degrades to a per-session
 * id rather than to a crash — the cost is one forgotten arrangement.
 */
export function clientId(
  storage: Pick<Storage, "getItem" | "setItem">,
  mint: () => string,
): string {
  try {
    const existing = storage.getItem(CLIENT_ID_KEY);

    if (existing !== null && existing !== "") {
      return existing;
    }

    const minted = mint();

    storage.setItem(CLIENT_ID_KEY, minted);

    return minted;
  } catch {
    return mint();
  }
}

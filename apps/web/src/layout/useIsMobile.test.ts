import { describe, expect, it } from "vitest";

import { MOBILE_QUERY, isMobile } from "./useIsMobile.js";

/**
 * The hook's decision, without a hook.
 *
 * The brief's version of this file drove `useIsMobile` through
 * `@testing-library/react`. That is not a dependency of this repo, and its own
 * fallback applies: the viewport read is a plain function, and what is left of
 * the hook is a `useState`/`useEffect` wrapper whose subscription and teardown
 * the rendered components cover in `apps/web/e2e/phone.test.mjs`.
 */

/** A `matchMedia` that answers only the query it was told matches. */
function stubMatchMedia(matching: string) {
  return (query: string) => ({ matches: query === matching });
}

describe("isMobile", () => {
  it("is true when the viewport is under the breakpoint", () => {
    expect(isMobile(stubMatchMedia(MOBILE_QUERY))).toBe(true);
  });

  it("is false when it is not", () => {
    expect(isMobile(stubMatchMedia("(max-width: 1px)"))).toBe(false);
  });

  it("is false where matchMedia does not exist, rather than throwing", () => {
    expect(() => isMobile(undefined)).not.toThrow();
    expect(isMobile(undefined)).toBe(false);
  });

  it("asks about the width at which the 72px rail stops being worth its space", () => {
    // Asserted literally, because this number is the whole port: the donor's
    // 767px is a Tailwind tier, and 719px is the rail's own geometry.
    expect(MOBILE_QUERY).toBe("(max-width: 719px)");
  });
});

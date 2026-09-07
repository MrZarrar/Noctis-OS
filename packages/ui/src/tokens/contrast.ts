/**
 * WCAG 2.2 relative luminance and contrast ratio.
 *
 * Here so the design system's own claims are checkable. Section 5.2 asks for
 * "legible white typography" and says colour is never the sole carrier of
 * meaning; the second half is a code review, but the first half is arithmetic,
 * and arithmetic belongs in a test rather than in a comment asserting itself.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** `#rgb` or `#rrggbb`. Throws rather than guessing: a token is never a near-miss. */
export function parseHex(colour: string): Rgb {
  const hex = colour.trim().replace(/^#/, "");
  const full = hex.length === 3 ? [...hex].map((character) => character + character).join("") : hex;

  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`not an opaque hex colour: ${colour}`);
  }

  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

function channelLuminance(value: number): number {
  const scaled = value / 255;

  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(colour: string): number {
  const { r, g, b } = parseHex(colour);

  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** The WCAG ratio, always >= 1, with the lighter colour on top. */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);

  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG 2.2 AA: 4.5:1 for body text, 3:1 for large text and UI components. */
export const AA_TEXT = 4.5;
export const AA_NON_TEXT = 3;

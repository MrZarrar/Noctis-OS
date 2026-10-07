import type { RailItem } from "./rail-items.js";

/**
 * Line icons for the navigation, drawn on a 24px grid at one stroke weight so
 * they read as a set. Vectors rather than the generated raster sheet they were
 * drawn from, because a tab icon has to stay crisp at every density.
 *
 * Always paired with a visible word: the icon is never the only label, so it
 * is hidden from assistive technology rather than given a second name.
 */

const PATHS: Readonly<Record<RailItem | "More", readonly string[]>> = {
  Threads: [
    "M4 5.5h10a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H8.5L5 17.5v-3H4A1.5 1.5 0 0 1 2.5 13V7A1.5 1.5 0 0 1 4 5.5Z",
    "M18 9h2a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 20 18h-1v3l-3.5-3H11",
  ],
  Files: [
    "M9.5 6V4a1 1 0 0 1 1-1h6l3.5 3.5V15a1 1 0 0 1-1 1H18",
    "M16.5 3v3.5H20",
    "M3 9a1.5 1.5 0 0 1 1.5-1.5h3.2l1.8 2h6A1.5 1.5 0 0 1 17 11v7.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 18.5Z",
  ],
  Nodes: [
    "M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 5 4.5Z",
    "M12 16v3.5M8.5 19.5h7",
    "M13.5 13v-1.5M15.5 13v-3M17.5 13V8",
  ],
  Approvals: [
    "M12 3 4.5 6v5.5c0 4.5 3.2 8 7.5 9.5 4.3-1.5 7.5-5 7.5-9.5V6L12 3Z",
    "m8.8 12 2.2 2.2 4.4-4.4",
  ],
  Vault: [
    "M10.3 4.8a1.7 1.7 0 1 0 3.4 0 1.7 1.7 0 1 0-3.4 0",
    "M17.15 9.78a1.7 1.7 0 1 0 3.4 0 1.7 1.7 0 1 0-3.4 0",
    "M14.53 17.82a1.7 1.7 0 1 0 3.4 0 1.7 1.7 0 1 0-3.4 0",
    "M6.07 17.82a1.7 1.7 0 1 0 3.4 0 1.7 1.7 0 1 0-3.4 0",
    "M3.45 9.78a1.7 1.7 0 1 0 3.4 0 1.7 1.7 0 1 0-3.4 0",
    "M15.01 5.46A7.2 7.2 0 0 1 17.29 7.12M19.15 12.84a7.2 7.2 0 0 1-.87 2.69M13.41 19.06a7.2 7.2 0 0 1-2.82 0M5.72 15.53a7.2 7.2 0 0 1-.87-2.69M6.71 7.12A7.2 7.2 0 0 1 8.99 5.46",
  ],
  Settings: [
    "M18.3 9.19 20.94 9.81v4.38l-2.64.62-.71 1.24.77 2.6-3.79 2.18-1.86-1.97h-1.42l-1.86 1.97-3.79-2.18.77-2.6-.71-1.24-2.64-.62V9.81l2.64-.62.71-1.24-.77-2.6 3.79-2.18 1.86 1.97h1.42l1.86-1.97 3.79 2.18-.77 2.6Z",
    "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  ],
  Command: ["m5 7 5 5-5 5", "M12 17h7"],
  Missions: ["M5 21V4", "M5 4h12l-2.5 4L17 12H5"],
  Artifacts: ["M12 3 20 7.5v9L12 21l-8-4.5v-9L12 3Z", "M4 7.5 12 12l8-4.5M12 12v9"],
  Automations: ["M13 2.5 5 13.5h6l-1 8 8-11h-6l1-8Z"],
  More: ["M6 12h.01M12 12h.01M18 12h.01"],
};

export function NavIcon({
  item,
  size = 22,
}: {
  item: RailItem | "More";
  size?: number;
}): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flexShrink: 0 }}
    >
      {PATHS[item].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/**
 * The Noctis mark: an outlined N with chamfered stems, redrawn from the
 * generated mark so it stays sharp at rail and tab sizes. Drawn here rather
 * than loaded as an image so the shell never waits on a request to show whose
 * app this is.
 */
export function NoctisMark({ size = 28 }: { size?: number }): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      style={{ display: "block", filter: "drop-shadow(0 0 4px rgba(139, 124, 246, 0.65))" }}
    >
      <defs>
        <linearGradient id="noctis-mark-stroke" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#D9D3FF" />
          <stop offset="1" stopColor="#8B7CF6" />
        </linearGradient>
      </defs>
      <path
        d="M4.24 4 24.11 23.7V7.49L27.76 4.16v23.09h-3.12L8.54 11.25V24.4L4.35 28Z"
        stroke="url(#noctis-mark-stroke)"
        strokeWidth={1.1}
        strokeLinejoin="round"
      />
    </svg>
  );
}

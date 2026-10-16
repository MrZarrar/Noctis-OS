# Health panel mockups (Codex image generation)

Owner request, 2026-10-16: build the glycolens Health panel in Noctis, with the visuals designed alongside
the code, not left to the end. Claude (Opus) implements the React; Codex makes the design mockups that set
the target look.

## What to make

Four images, saved as PNG into `docs/Mockups/health/`:

1. `health-desktop-01-overview.png`: 1672x941 desktop, the Noctis rail on the left (same as
   `docs/Mockups/02-vault-trace-v7.png`), the Health page filling the rest.
2. `health-desktop-02-finding.png`: same frame, scrolled to one finding: its spaghetti chart and the
   suggestion card under it.
3. `health-phone-01-overview.png`: 390x844 phone, tab bar at the bottom, the same page stacked.
4. `health-desktop-03-stale.png`: the overview with the "Data stale since Sun 11 Oct, 20:03" banner and the
   charts dimmed.

## The page (top to bottom)

- Header "Health", a quiet "Run now" button, "Last run Sun 11 Oct 20:03" in muted text.
- **Hero: "your glucose day".** A 24-hour radial clock (or wide ribbon) from hourly percentiles:
  p5–p95 a soft haze, p25–p75 a solid band, the median a glowing line. A target corridor 3.9–10.0 mmol/L,
  and a low zone glowing red beneath 3.9. Four arcs round the clock for the pump's windows (overnight
  00–06, breakfast 06–11, lunch 11–17, dinner 17–24); breakfast and overnight carry a small marker because
  they have findings.
- **Headline:** a segmented time-in-range ring, 71.4% in range at its centre. Five segments: below 3.0
  (0.6%), 3.0–3.9 (2.5%), 3.9–10.0 (71.4%), 10.0–13.9 (21.3%), above 13.9 (4.2%), each labelled and
  patterned (hatch, dots), not colour alone. Beside it: GMI 6.9%, CV 34.5%, mean 8.4 mmol/L.
- **Findings**, one card each:
  - "Breakfast: 2 of 3 meals ended high (median +3.4 mmol/L at 4h)." with a spaghetti chart of three
    4-hour meal curves aligned at the bolus: two glowing, one faint, a bold median, a dashed "+2.0 at 4h"
    threshold and the 3.9 line.
  - "Overnight: corrections dropped 1.6x what your correction factor predicts." with correction curves
    and a dashed expected curve.
  - "Overnight: Control-IQ ran basal at 132% of programmed." with a night-by-hour heat strip (cut back
    to boosted, one hatched empty cell) and a sparkline per night. One hollow dashed marker at 03:10 for a
    possible sensor low.
- **Suggestion card:** "Breakfast carb ratio", a chip "10 → 9 g/U, 10%", buttons "Applied" and "Dismiss".
- **Past changes:** "Overnight basal 0.80 → 0.88", a small before → after ring (64% → 71.4%), a badge
  "Helped" with a check icon and a "provisional" tag.
- **Watching:** "Lunch pre-bolus: 2 of 5 meals so far; needs 3."
- Footer line: "Not medical advice. glycolens finds patterns; you and your diabetes team decide."

## Look

Match the existing Noctis mockups in `docs/Mockups/` (`02-vault-trace-v7.png`, `01-presence-v2.png`):
near-black violet floor `#050409`, layers `#0b0a12` / `#131120` / `#1c1930`, frosted glass cards
(white 4–7% fill, 10% border, 24 px blur), Inter type in `#E7E6EE` and muted `#9B98AE`, Vesper violet
`#8B7CF6` as the accent and glow. Glucose colours: in range a calm teal-green, highs amber `#FFB020`, lows
red `#FF4D4D`, each also told apart by pattern or label. Premium medical instrument, not a fitness app:
calm, precise, a little cinematic. Every number on screen is one of the numbers above; invent none.

## Report back

The absolute paths of the four PNGs and a few lines on design choices worth carrying into code (layout
grid, chart style, motion ideas).

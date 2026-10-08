# Codex brief: Jester's core profile, reference stills

Continues `docs/design/codex-brief.md` (same world, same rules). Image generation only: do not edit
any file. Generate the images and report their paths; Claude copies them into the repo.

## Who Jester is

Jester is Noctis's second conversational identity, beside Vesper. Vesper is calm and restrained.
Jester is the contrarian: it attacks the premise, finds the part the owner is pretending will solve
itself, and only ever prepares (never sends, spends or publishes). It runs on a local model on the
owner's PC. The master plan's rule for its look: "visibly distinct irregular energy with lime and
red provocation annotations, never merely a colour swap" of Vesper.

## Look

The images passed with `-i` are, in order:

1. `core-states.png`: Vesper's approved core in its five states (idle, listening, thinking,
   speaking, waiting for approval). This is the object Jester is a variant of: a sphere-like cage
   of thin mesh lines and bright nodes, wrapped in large translucent glass shards, a bright centre,
   floating over a small violet floor light. Same render style, same material, same black.
2. `presence-desktop.png`: Vesper's Presence page, for scale and room.
3. `01-jester-activation-presence-v7.png`, `02-jester-idea-provocation-v7.png`,
   `03-jester-challenge-deep-dive-v7.png`: the owner's own Jester mockups. Jester's core there is
   the same cage, broken more irregularly, with a face read into it: a red point-light eye on the
   left, a violet crystalline eye on the right, a wide acid-lime grin of lit nodes, and lime
   "drips" falling from shard edges. Lime handwritten notes ("one has teeth.") sit beside it.

Palette: floor `#050409`; Vesper violet `#8B7CF6` / `#5B4FE0`; Jester acid lime `#B6FF3B` and red
`#FF3B5C`; approval amber `#FFC16C`. Lime and red are accents on the violet-and-glass object, not a
recolour of all of it.

## What to draw

Three variants, so the owner can pick a direction. Each is ONE wide image laid out exactly like
`core-states.png`: five panels side by side on black, the core centred in each over its floor
light, and only the state name under each panel in the same plain white type: Idle, Listening,
Thinking, Speaking, Waiting for approval. No other text.

- **Variant A, "The grin" (faithful to the mockups).** The face as in the mockups: red eye,
  violet crystal eye, lime grin, lime drips. The cage is lumpier and more broken than Vesper's,
  shards jut at odd angles. States: idle is dim with the grin faint; listening, the eyes brighten;
  thinking, the grin flickers into a jagged line and the red eye pulses; speaking, the grin is wide
  and bright with more drips; waiting for approval, the grin goes flat and an amber light takes the
  centre, as Vesper's does.
- **Variant B, "Fault lines" (no face).** No eyes or mouth. Jester's irregular energy instead: the
  cage split along one or two lime fault lines, a few shards knocked out of orbit and tilted, red
  sparks at the breaks, lime drips. Same five states, carried by how wide the fault opens and how
  bright the lime runs; amber centre when waiting for approval.
- **Variant C, "Hidden grin".** At idle and listening it reads as Variant B (fault lines, no face).
  The grin and the red eye surface only while thinking and speaking, then fade again. Waiting for
  approval: face gone, amber centre.

Also one small reference sheet:

- **Jester glyph.** The small lime icon from the mockups' "JESTER · ACTIVE" label (top left), drawn
  large and alone, centred on solid `#050409`, flat front view, thin even lime strokes, built from
  a few clean shapes so Claude can redraw it as an SVG. Show three takes side by side: the
  mockup's sun/gear-like mark as it is, a jester's three-point cap reduced to strokes, and a
  lopsided grin inside a circle. No text.

## Report back

For each image: the absolute path of the generated PNG, its pixel size, and one line on anything you
could not match.

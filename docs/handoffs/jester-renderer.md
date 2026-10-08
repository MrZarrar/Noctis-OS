# Handoff to Codex: Jester's core in the renderer

Implement Jester's profile in `packages/ui/src/intelligence/IntelligenceRenderer.tsx`. That file is
yours alone; do not change `core.ts` or the tests. On this Windows PC your sandbox cannot read or
write files, so the three files are pasted below this brief: return the **complete new
`IntelligenceRenderer.tsx`** in your final message between the lines `=====BEGIN FILE=====` and
`=====END FILE=====`, then a few lines on anything you left out.

## The look (the owner's pick)

The attached image is variant C, "hidden grin", which the owner approved: Vesper's cage, cracked
along lime fault lines with lime drips. The red eye and the lime grin surface only while thinking
and speaking. Waiting for approval drops the face and turns the centre amber, as Vesper's does. The
master plan: "visibly distinct irregular energy with lime and red provocation annotations, never
merely a colour swap".

## The contract (already in `core.ts`, tested; use it, don't change it)

- `profileFor(identityId)`; `JESTER_PROFILE.jester = { lime, red }`; Vesper has no `jester`.
- `coreAppearance(state, profile)` now also returns `face` (0 to 1: how far the red eye and grin
  have surfaced) and `fault` (0 to 1: how bright the faults and drips run). Both are 0 for Vesper.
- `buildJesterMarks(core)` gives `faults` (two chains of point indices along the cage's own
  edges), `grin` (11 front-facing points, a smile below centre), `redEye`, `violetEye`, and
  `drips` (`[top, bottom]` pairs, straight down).

## What to build

1. The `profile` prop's default becomes `profileFor(identityId)`. Add `data-core-profile` with
   `profile.name` to the host div.
2. **WebGL scene.** Build Jester's objects once in `createScene` and keep them hidden for Vesper;
   `update(state, profile)` can switch profile at any time.
   - Faults: lime `LineSegments` along each chain (consecutive indices), additive, opacity scaled
     by `fault`, plus small lime `lights` at the fault points. They rotate with `network`, since
     they are its edges.
   - Drips: lime `LineSegments`, in the `shell` group, opacity scaled by `fault`.
   - A few red sparks: reuse the spark idea on fault edges, red, only while moving.
   - Red eye: a large red `lights` point at `redEye`, intensity scaled by `face`.
   - Grin: lime `lights` at the grin points plus a lime line through them, scaled by `face`.
     While thinking, the grin flickers jagged: odd points jitter in y by a small amount on a fast
     sine. While speaking, it is steady and bright.
   - The heart (centre crystal and fragments) moves toward `violetEye` by `face`: at face 0 it
     is centred, so the amber approval centre works unchanged.
   - Irregular energy: for Jester, 3 of the 14 shell shards sit knocked out of orbit (a fixed
     outward offset and tilt), and the shard drift gets a second, faster, uneven term. Vesper's
     motion must be unchanged.
   - Lerp `face` and `fault` toward their targets like `energy`, so the face surfaces smoothly.
3. **Budgets stay as they are**: no animation loop at idle (`shouldAnimateCore` unchanged), a
   single static frame under reduced motion, nothing new per frame that allocates. Dispose the
   new geometries and materials with the rest.
4. **`StaticCore` (SVG fallback, also what the tests read).** When `profile.jester` is set:
   - each fault as `<polyline data-jester-fault="true" stroke="#b6ff3b" ...>`, opacity from
     `fault`;
   - each drip as `<line data-jester-drip="true" stroke="#b6ff3b" ...>`;
   - only when `face > 0`: the grin as `<polyline data-jester-grin="true" stroke="#b6ff3b" ...>`
     and the red eye as `<circle fill="#ff3b5c" ...>` (with a soft halo circle in the same red);
   - the heart group gets `transform="translate(dx dy)"` (the violet eye's projected offset times
     `face`, numbers rounded to 1 decimal) **only when face > 0**, so its tag stays exactly
     `<g data-core-heart="true">` otherwise.
     Vesper's SVG must contain no `data-jester` attribute and neither Jester colour.
5. Keep everything else (aria label, data attributes, the idle CSS breathe, context-loss handling).

## Done when

The pasted `renderer.test.ts` passes, including the four new Jester cases. Keep the code in the
file's existing style: plain functions, comments only where the reason is not obvious.

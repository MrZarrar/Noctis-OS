# S6 core reference stills

Generate reference images only. Do not implement, install, stage, commit, or change application code.
Do not use an API key or a metered image service. Use the signed-in subscription image tool.

Read the S6 requirements and Section 8 in `docs/architecture/2026-10-07-v1-scope.md`,
Section 6 and the performance budgets in `docs/architecture/2026-08-23-noctis-os-master-implementation-plan.md`,
the palette in `packages/ui/src/tokens/`, and the previous asset brief in `docs/design/codex-brief.md`.

## Visual source

Match `docs/Mockups/01-presence-v2.png`: an irregular, vertically elongated intelligence object,
translucent angular glass shards, a delicate interconnected lit mesh, scattered violet junctions,
and a bright violet crystalline centre. Preserve the space and dark gaps between the pieces.
It should feel dimensional, calm, and intricate, with restrained light. Avoid a smooth orb,
solid ball, concentric neon rings, dashboard clutter, fake controls, and excessive bloom.

Keep the architectural room consistent with the shipped room images in
`docs/design/assets/backdrop-landscape.png` and `docs/design/assets/backdrop-portrait.png`.
This is a reference for a real-time Three.js object, not a bitmap that will replace the object.
Use a plausible geometry count for a phone. Only Vesper is in this session; do not design Jester or NOIR.

## Deliverables

Save three separate PNGs under `apps/web/public/assets/generated/s6-reference/`:

1. `presence-desktop.png`: a landscape Presence home reference with the core large and central
   in the existing dark room. A quiet greeting and an "Ask Vesper..." prompt below it.
   Existing v1 navigation, with Presence added as home; no legacy destinations or identity switches.
2. `presence-phone.png`: the same idle core and materials composed for a portrait phone.
   Keep the greeting, prompt and navigation legible without covering the core. No phone hardware frame.
3. `core-states.png`: a clearly separated five-panel landscape reference sheet of the same object,
   at the same camera angle and scale against a near-black background, labelled:
   Idle, Listening, Thinking, Speaking, Waiting for approval.

State guidance: Idle is coherent and dim, with a small bright centre. Listening opens the outer
shards slightly toward the viewer. Thinking has denser inner connections and brighter violet energy.
Speaking has an expanded luminous centre and outward energy. Waiting for approval holds a still,
composed shape with a restrained amber accent among the violet junctions. Geometry and silhouette
stay recognisably the same core in every panel. Do not turn states into five unrelated objects.
Colour is supported by text labels; it is not the only state signal.

Open and inspect every image. Report absolute file paths, dimensions, any visual limitations,
and the session ID. If image generation is unavailable, report that directly; do not simulate the
stills with SVG, browser code, or Python drawings. Do not start implementation.

# Codex brief: Noctis v1 design assets (S5)

You are generating raster design assets for Noctis, a dark, cinematic control plane for AI agents
that the owner mostly uses from a phone. Image generation only: do not edit any code or any file
outside `apps/web/public/assets/generated/`.

## Look

Read these before drawing, and match them:

- `docs/Mockups/01-presence-v2.png`, `docs/Mockups/02-vault-trace-v7.png`,
  `docs/Mockups/02-active-canvas-shell-v2.png` (passed to you as images too). Note the violet neon
  "N" mark top left, the thin line icons in the rail, the near-black floor, and the restrained
  violet light.
- `packages/ui/src/tokens/` for the palette: floor `#050409`, layers `#0b0a12` `#131120` `#1c1930`
  `#272140`, Vesper violet `#8B7CF6` and `#5B4FE0`, text `#E7E6EE`.

Rules from the design spec: cinematic dark depth, soft glass and metal, low-noise purple energy,
legible white type. No flat dashboard look, no excessive glow, no fake sci-fi controls, no text or
lettering in any image unless asked, no watermarks.

## Assets

Save each one as PNG at exactly this path (create the folder):

1. `apps/web/public/assets/generated/noctis-mark.png`, square. The Noctis "N" mark from the mockups,
   alone, centred, on solid `#050409`. Geometric, built from a few clean strokes with a faint violet
   neon edge, so it can be redrawn by hand as a vector. Flat front view, no perspective, no scene.
2. `apps/web/public/assets/generated/nav-icons.png`, landscape. A reference sheet of six line icons
   in one row, evenly spaced, white strokes on solid black, the same weight and style as the rail
   icons in the mockups (thin, rounded caps, open shapes, no fills). In order: Threads (two
   overlapping speech bubbles), Files (a folder with a page), Nodes (a monitor or PC tower with a
   small signal), Approvals (a shield with a check), Vault (a sphere of linked nodes), Settings (a
   gear). No labels.
3. `apps/web/public/assets/generated/backdrop-portrait.png`, tall portrait (phone). The ambient
   space behind every page: the dark architectural corridor and floor from `01-presence-v2.png`,
   seen from the front, with faint violet light lines at the edges and a soft violet glow low in
   the frame. The centre must be empty and very dark, because text and controls sit on top. Overall
   almost black: most pixels close to `#050409`. No sphere, no objects, no UI.
4. `apps/web/public/assets/generated/backdrop-landscape.png`, wide landscape (desktop). The same
   space as asset 3, framed for a wide screen, equally dark and empty in the centre.
5. `apps/web/public/assets/generated/files-empty.png`, square. The illustration for the empty Files
   page: a few translucent glass sheets (documents, an image frame, a film strip) floating in a
   loose arc, lit from inside by violet light, in the same material as the shards around the sphere
   in `01-presence-v2.png`. Edges fade to solid `#050409` on every side so it blends into the page.
   No text on the sheets.

## Report back

For each asset: its path, its pixel size, and one line on anything you could not match. Keep the
same session for follow-ups; the owner may ask for revisions.

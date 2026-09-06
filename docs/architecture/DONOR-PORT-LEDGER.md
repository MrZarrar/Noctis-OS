# Donor port ledger

Add one entry before each port.

Donor licence: MIT, "Copyright (c) 2026 - Now, Son Nguyen"
(`Jarvis-Sub-Agent-Dashboard/LICENSE`). MIT permits reuse with the copyright and
permission notice retained; each ported file carries an attribution comment naming the donor
path and commit.

| Donor commit | Donor path                                               | Licence          | Target path                             | Retained behaviour                                                                                                                                                                                                                                                             | Changed behaviour                                                                                                                                                                                                                                                                                                                                                                                             | Verification                                 |
| ------------ | -------------------------------------------------------- | ---------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| _none_       | _none_                                                   | _not applicable_ | _none_                                  | _none_                                                                                                                                                                                                                                                                         | Phase 0 starts from original Noctis code only                                                                                                                                                                                                                                                                                                                                                                 | Phase 0 acceptance                           |
| `ee7b4527`   | `server/lib/vault.js` — `parseWikilinks`, `normalizeKey` | MIT              | `packages/domain/src/vault/markdown.ts` | The wikilink grammar (`[[Target]]`, `[[Target\|alias]]`, `[[Target#heading]]`, and `![[embed]]` counting as a link) and the key normalization that folds case, a trailing `.md`, and whitespace/underscores to hyphens so `[[Jarvis Project]]` resolves to `jarvis-project.md` | Returns the span of every occurrence rather than a de-duplicated key set, because provenance needs the byte range and one note may cite a target more than once. Pure and synchronous: the donor read files and wrote `vault_edges` inside the function; here parsing takes a string and returns data, and persistence is the caller's job. Typed, with the alias and heading captured rather than discarded. | `packages/domain/src/vault/markdown.test.ts` |
| `ee7b4527`   | `client/src/components/VaultSphere.tsx` — `anchorFor`    | MIT              | `packages/domain/src/vault/layout.ts`   | The Fibonacci-sphere anchor that gives each note type a fixed cluster direction, including the `2.399963` golden-angle increment                                                                                                                                               | Anchors eight fixed slots by entity type as the donor does, but a node's own position is derived from a hash of its key rather than from its index in a list, so a note's coordinate does not move when unrelated notes are added or removed. Degree-based radius is dropped: it made position depend on the rest of the graph, which is exactly the instability Section 7 asks to remove.                    | `packages/domain/src/vault/layout.test.ts`   |

Not ported, and why:

- `server/lib/vault-engine.js` — the entity engine extracts named entities through
  a model router. Phase 7 derives entities deterministically from note identity and
  wikilink targets instead; model-proposed entities need the provider work in Phase 8
  and would have made indexing non-reproducible, which the "repeated indexing is
  stable" gate forbids.
- `server/lib/vault-graphify.js` — a bridge that shells out to an external
  `graphify` CLI. An external-tool integration belongs to Phase 10's routing, not to
  Vault indexing.
- `client/src/components/VaultSphere.tsx` beyond `anchorFor` — **deferred to the
  Phase 7 acceptance work, not rejected.**

  An earlier revision of this ledger recorded the component as `REPLACE` in the
  Section 13.1 matrix and reimplemented its behaviour in SVG. That citation was
  wrong. Line 765 of the master plan reads `Existing Vault sphere interactions |
KEEP + REFACTOR | Preserve pan/zoom/rotation/labels/focus and visual familiarity;
remove continuous wandering and donor component coupling`, and Phase 7 says
  "Port selectively: donor Vault indexing/entity/edge logic **and useful sphere
  interaction**". The REPLACE rows belong to the dashboard shell and the design
  tokens; attaching one of them to the sphere is what justified building a
  substitute for a finished, already-approved system.

  What the donor has: 940 lines on `three@0.170` with `OrbitControls` — a lat/long
  wireframe shell, a crystal core with light rays, a starfield, curved edges with
  travelling pulses, camera fly-to on select, double-click neighbourhood focus,
  label level-of-detail on a canvas overlay, and an existing reduced-motion path.

  What the refactor needs, and it is narrower than it looks: `tickSim(nodes, edges,
alpha, wander, t)` already takes `wander` as a parameter, and the component
  already preserves positions across data changes, so "remove continuous force
  wandering" is that flag plus seeding from `vault_layout` instead of simulating
  from scratch. `packages/domain/src/vault/layout.ts` is the other half of exactly
  that refactor: the donor has the renderer and no stable coordinates; Phase 7 built
  stable coordinates and a lesser renderer.

  What is genuinely new work: the donor component has zero `tabIndex`, `aria-*`, or
  `role` attributes. The keyboard and screen-reader layer has to be written, and is
  the one thing the interim SVG view does better.

  `packages/ui/src/vault/VaultSphere.tsx` and `packages/domain/src/vault/view.ts`
  are that interim view. They are deliberately not a port; they should be deleted
  when the real one lands rather than kept as a second way to draw the same graph.

- The donor's `notes`/`db` layer — `REMOVE from implementation dependency` in
  Section 13.1: the donor SQLite schema and runtime data are never shared.

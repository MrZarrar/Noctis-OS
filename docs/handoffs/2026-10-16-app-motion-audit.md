# App-wide libraries and motion audit (Codex, read-only)

Owner, 2026-10-16: earlier work avoided new dependencies, and the owner thinks parts of the app were
neglected because of it. The owner does not mind dependencies; looking great matters. This audit finds where
a library or animation would lift the app the most. It changes no code.

## Scope

Every page in `apps/web/src/pages/`, the shell in `apps/web/src/App.tsx` and `apps/web/src/layout/`,
`apps/web/src/workbench/`, `apps/web/src/surfaces/`, and the primitives and tokens in `packages/ui/src/`
(`tokens/motion.ts` is the current motion system). Mockups of the intended look are in `docs/Mockups/`.

## Constraints any proposal must meet

- React 18.3.1, Vite 8, TypeScript strict. Exact versions published at least two weeks before 2026-10-16.
- Nothing that phones home: no analytics, no runtime CDN fonts or assets, no remote tiles, no server.
- Honour `prefers-reduced-motion` (the tokens already have `reducedDurationMs`).
- Never meaning by colour alone. Readable on a 390 px phone.
- Do not propose touching the RDP / iron-remote-desktop code paths.

## Deliverable

Write the audit to `docs/handoffs/2026-10-16-app-motion-audit-report.md`:

1. Recommended stack (package@version, one line each on what it does here). Expect something like
   `motion` for React animation, `d3-*` or `@visx/*` for charts, maybe a toast / command palette / list
   virtualisation library if a page clearly needs one.
2. Per page or shell area, ranked by visible impact: what looks or feels flat now (cite file:line), what to
   do, which library, and a size estimate (S / M / L).
3. Shared pieces worth building once (page transitions, list enter/exit, number tickers, skeletons,
   shared-layout panel moves) and where each would be used.
4. Risks: bundle size, places where animation could fight existing layout code (the adaptive panels in
   `apps/web/src/layout/` and `workbench/` have had re-render traps; see
   `docs/acceptance/IMPLEMENTATION-STATUS.md`).

Keep it concrete. Report back the path of the report and the top five recommendations.

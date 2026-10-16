# Handoff: draw Mermaid diagrams in Noctis Markdown

## Task

Agents write ` ```mermaid ` fences in messages and document panels. Today they render as plain code
blocks. Make `apps/web/src/conversation/Markdown.tsx` draw them as diagrams. Every message bubble and every
`document` panel goes through this one component, so both get diagrams.

Done means: a `mermaid` fenced block renders as a diagram in the dark theme, any other fence still renders as
code, a diagram that fails to parse shows its source as code plus a short muted "diagram could not be drawn" line,
and the tests and checks below pass.

## Constraints

- **Package:** add `mermaid` at exactly `12.1.0` (no caret) to `apps/web/package.json`. Install it with
  `npm install` from the repo root so `package-lock.json` updates. Node is 22.x. Do not upgrade or add anything else.
- **Lazy load:** load mermaid with a dynamic `import()` only when a message actually contains a mermaid fence.
  It is large and most messages have none.
- **CSP:** the page CSP is `default-src 'self'; img-src 'self' blob:`, with no `'unsafe-inline'` and no
  `'unsafe-eval'` (see `apps/core/src/api/static.ts`). Do not widen it. Inline `<style>` in the page is blocked,
  and mermaid's SVG carries its own `<style>`. So do not inject the SVG into the DOM. Render it to an SVG string
  (`mermaid.render`), turn it into a `blob:` URL (`URL.createObjectURL(new Blob([svg], {type: "image/svg+xml"}))`)
  and show it as an `<img>`, where the SVG's own styles apply. Revoke the URL on unmount or change. Turn off HTML
  labels (`htmlLabels: false`, including the flowchart setting) so the labels are SVG text. Use
  `securityLevel: "strict"`.
- **Theme:** use mermaid's `dark` theme or `base` with `themeVariables`. Read the colours from `@noctis/ui`
  (`depth`, `material`, `typography`, `identityAccent.vesper`). The diagram must be readable on the dark panel
  background. Width up to 100% of the bubble or panel, scrolling sideways if it is wider.
- **Keep:** links, read-only checkboxes and the other behaviour in `Markdown.tsx` stay as they are. Raw HTML in
  the text still stays text (`disableParsingRawHTML`).
- **Code style:** match the surrounding code and its comment style. Comments explain a non-obvious why, never
  cite docs or files, and never sound machine-generated. No AI attribution anywhere.
- **TDD:** write a focused failing test first, then make it pass. Tests in this repo render with
  `react-dom/server` `renderToStaticMarkup` (see `apps/web/src/pages/AgentQuestions.test.ts`). Cover at least:
  a mermaid fence is not rendered as a plain code block, and a non-mermaid fence still is. Put the mermaid call
  behind a small function you can test or mock, because vitest has no real layout.
- **Files you own:** `apps/web/src/conversation/Markdown.tsx`, any new file under `apps/web/src/conversation/`,
  `apps/web/src/index.css` (`.noctis-md` rules), `apps/web/package.json` and `package-lock.json`. Another
  agent is editing other files in this repo at the same time, so touch nothing else and do not run
  `prettier --write .` or any repo-wide rewrite.
- **Do not** commit, push, stage or run destructive git commands.

## Checks to run

- `npx vitest run apps/web`
- `npm run typecheck`
- `npx eslint` on the files you changed
- `npx prettier --check` on the files you changed
- `npm run build:web`. Report the size of the mermaid chunk and confirm it is a separate chunk from the main
  bundle.
- If you can, check it in a real browser. `npm run build:web`, then serve `apps/web/dist` with a CSP header
  matching the one above, and confirm a sample diagram draws with no CSP errors in the console.

## Report back

The files changed, test and check output, the chunk size, whether the browser check ran and what it showed, and
any open questions.

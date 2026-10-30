# Video editor as a Noctis section

Written 30 October 2026. A design, not a task-by-task plan: it answers whether this fits
and how, grounded in this repo's actual code, not a guess at it. The owner should read this
before anyone picks up implementation, since it names one real blocker this repo already
guards against on purpose.

## What exists today

The HyperFrames video editor (`hyperframes-channel-starter/editor/`) is a complete,
framework-free app: vanilla JS, an HTML canvas timeline, a Node `http` server with no
external dependencies. It already has its own project picker (open an existing video,
scaffold a new one) and runs as `node editor/serve.mjs <videos-root> --port 7700` on
whichever PC holds the video assets, which today is the home PC only.

The owner wants it reachable from inside Noctis the way Threads or Vault are: a section in
the permanent rail, not a URL to remember.

## How a Noctis page actually works

Checked against this repo rather than assumed. `apps/web/src/pages/` holds one component
per page (`Threads.tsx`, `Vault.tsx`, `Nodes.tsx`, `Health.tsx`...). There is no declarative
route table: `App.tsx` imports each page directly and switches on a page-name string
(`case "Vault":`, `{active === "Vault" && <Vault .../>}`), and a couple of satellite files
key off the same string (`companion/dock.ts` decides whether the companion column shows
beside a given page). Adding a page today means a new file in `pages/`, a new case in
`App.tsx`, a rail entry, and checking whether the companion dock should hide beside it.

The video editor is not a document, a list, or a chart; it is a full interactive
application with its own drag handling and canvas rendering. Rebuilding that in React
inside `apps/web` would be throwing away a working, already-tested tool to rewrite it
somewhere else. The right shape is an `<iframe>` pointing at the editor's own server,
inside a thin `VideoEditor.tsx` page that is otherwise exactly like any other page. The
editor's existing picker becomes the in-page project switcher for free: the iframe's `src`
can just be the editor's bare root URL, and the owner opens or creates a project inside it
exactly as they do standalone today.

## The one real blocker

`apps/core/src/api/static.ts` sets `frame-ancestors 'none'` and `default-src 'self'` on
every page this app serves, on purpose: the comment there explains it closes a clickjacking
hole on the login form, and a `<iframe>` pointing at another origin is blocked by the same
`default-src` unless a `frame-src` is explicitly opened for it. **An iframe to the editor's
`host:port` will not load until this policy is deliberately widened.** This is not an
oversight to route around; it is the thing the file exists to enforce, and widening it is a
call for whoever owns that policy, not something to patch quietly from the web side.

There is already exactly this kind of widening for exactly this reason:
`pageSecurityPolicy(gatewayOrigins)` opens `connect-src` to a configured list of Gateway
origins only when the embedded remote desktop (IronRDP, ADR-0035) is actually configured,
and only to those named origins. The video editor needs the same shape: a `frame-src`
opened only to a configured editor-server origin, only when one is configured, never a
blanket `frame-src *`.

## Shape of the work

1. **Config:** a setting naming the editor server's origin (e.g.
   `http://100.70.27.11:7700`, the home PC's Tailscale address), the same way Gateway
   origins are configured for remote desktop. Empty by default; the page and the CSP
   widening both key off whether it is set.
2. **CSP:** extend `pageSecurityPolicy` (or add a sibling function next to it) to add
   `frame-src <that origin>` when the setting is present, following the existing
   Gateway-origin widening as the template, including an equivalent code comment
   explaining why that exact origin and nothing wider.
3. **Page:** `apps/web/src/pages/VideoEditor.tsx`, an iframe at the configured origin, no
   project parameter needed since the editor's own picker handles that. Register it the
   same mechanical way Vault and Threads are: a case in `App.tsx`, a rail entry, a line in
   `companion/dock.ts` if the companion column should hide beside it (it probably should;
   the editor already uses all its own screen width).
4. **Reachability:** the editor server needs to actually be running when the page opens.
   Whether Noctis starts it on demand or it runs as a standing background process is an
   `apps/node-agent` question this design does not answer; whoever picks this up should
   look at how that app manages other long-running local processes before deciding, rather
   than inventing a third pattern.
5. **Cross-PC:** the owner is sometimes on the work PC while the video assets and the
   editor server are on the home PC. The configured origin is a Tailscale address, which
   already makes this reachable; whether it is fast enough to actually edit by (scrubbing
   relies on local-disk video seeks, which a remote connection does not give for free) is
   worth checking once before calling this done, not assuming.

## What this design deliberately does not decide

- Whether the editor server runs always-on or is launched per-session: `apps/node-agent`'s
  existing patterns should decide this, not this document.
- The exact config schema and where it lives (`packages/contracts`, a settings page, or
  elsewhere): follow however Gateway origins are configured today.
- Companion dock and back-button behaviour beyond "probably hide the companion column":
  whoever implements it should look at what Threads and Vault actually do and match
  whichever is closer.

## Order of work

Config and the CSP widening first, with nothing in the browser yet: prove the origin opens
correctly and nothing else does, the same way the Gateway widening can be tested without a
real RDP session. Only then the page and its registration. Building the page before the CSP
allows it only produces a blocked iframe to debug blind.

## Acceptance

Opening the video editor from the Noctis rail on the home PC shows the same picker and the
same working editor as `http://localhost:7700` does today, with no separate URL to
remember. A second, later check: the same page from the work PC, honestly reporting
whether cross-PC editing is actually usable or just reachable.

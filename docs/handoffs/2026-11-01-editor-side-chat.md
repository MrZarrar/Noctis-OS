# Noctis Editor side chat

The standalone Editor reuses the complete Noctis frontend through the separate `editor.html` entry. Build it with `vite build --mode editor` from `apps/web`; output is `dist-editor/`, leaving the normal web bundle unchanged. The Editor's build script copies this bundle and the shared `API_SEGMENTS` contract into its local package.

The Editor serves this entry behind a loopback-only relay. A launch bootstrap sets an HttpOnly local session cookie; `window.__NOCTIS_EDITOR_CHAT__` carries only its CSRF value. The existing `SessionTransport` handles requests, uploads and streaming. The relay signs requests to the existing Noctis core using this PC's encrypted credential. The page receives no core token. Core authority, runtimes and model routing are unchanged.

Each saved project retains a named Noctis thread. The relay appends fresh native session/selection/playhead context to a chat request and enforces the granted Editor workspace. The frontend displays the owner's original text and the fixed Editor folder. A different native project opens its own retained thread. Normal page navigation, approvals and conversations remain available through the same App.

Verified 1 November 2026: the actual native WebView sent a GPT-6.1-Sol turn through the live core. It discovered the Editor skill, performed a revision-checked layer rename, and native GUI Undo restored the original name and clean state. The standalone relay's checks cover local authentication, CSRF, credential isolation, context, model preservation, thread persistence and streamed-event resume. Frontend typecheck, Editor build and affected conversation/transport tests pass. No core deployment or node-agent restart is required. Remote work-PC GUI use was outside this change.

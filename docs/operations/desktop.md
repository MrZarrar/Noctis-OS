# Operating the Noctis desktop shell

The shell is a Tauri 2 application. It owns the core credential, signs every request the page makes,
and holds the client socket. The WebView holds nothing: it names a method and a rooted path, and the
shell decides whether that is a request it is willing to sign.

Phase 4 ships this as an unsigned local canary. It is not installed, not registered, and does not
start with Windows.

## Running it

The shell needs a core to talk to. Start one first:

```powershell
$env:NOCTIS_CORE_TOKEN = "<at least 32 characters>"
$env:NOCTIS_DATABASE_PATH = "$env:LOCALAPPDATA\Noctis\core.db"
node apps/core/dist/main.js
```

Then, in a second terminal:

```powershell
npm run build:web                      # tsc, then the page assets
npm run build:desktop                  # tauri build --no-bundle
$env:NOCTIS_CORE_TOKEN = "<the same token>"
target\release\noctis-desktop.exe    # a workspace target directory since Phase 9
```

`npm --workspace @noctis/desktop run dev` does the same with a debug build and rebuilds the page
first.

## Configuration

| Variable                 | Default                 | Meaning                                              |
| ------------------------ | ----------------------- | ---------------------------------------------------- |
| `NOCTIS_CORE_TOKEN`      | _required_              | The client-realm bearer. At least 32 characters.     |
| `NOCTIS_CORE_URL`        | `http://127.0.0.1:7717` | A bare origin. A path, query, or credentials refuse. |
| `NOCTIS_REGISTER_SCHEME` | unset                   | `true` registers `noctis://` for this executable.    |

A shell started without a usable token still opens its window; the page shows the reason rather than
the process exiting somewhere nobody can read it.

## What the WebView can reach

Three commands, and one plugin:

- `core_request(method, path, body)` — `GET` or `POST` to a rooted path on the core origin. Anything
  that could name another host is refused before the token is attached.
- `core_subscribe(afterSequence)` / `core_unsubscribe()` — start and stop the client socket. Frames
  arrive on the `core:frame` event verbatim; connection changes arrive on `core:status`.
- `notification:default` — native notifications.

`apps/desktop/src-tauri/capabilities/main.json` is the whole allowlist, and
`apps/desktop/tests/shell-boundary.test.mjs` asserts it exactly, so widening it fails a test rather
than passing quietly. The filesystem, shell, HTTP, process, dialog, and updater plugins are not
reachable from the page. Deep links, the global shortcut, the tray, and the core socket are driven
from Rust and appear nowhere in that file.

## Window, tray, and shortcut

- **Close** hides the window. The tray is the way back, and the way out — its menu has
  `Show Noctis` and `Quit Noctis`. A left click on the tray icon toggles the window.
- **Ctrl+Alt+N** toggles the window from anywhere. If another application already owns that
  combination the shell logs it and starts anyway.
- **Placement** is saved to `%APPDATA%\uk.co.noctis.os\window.json` on every move and resize
  (throttled to 250 ms) and exactly on close, so a crash keeps the last position rather than the
  position from the last clean shutdown. It is written through a temporary file and renamed.

On restore, the saved rectangle is a request. The monitors that exist at that moment decide what is
honoured: a window whose monitor is gone comes back centred on the primary, one hanging off an edge
slides back on, one larger than its monitor shrinks to fit, and nothing is ever restored below
800×600.

To forget a saved position, delete that file.

## Deep links

`noctis://<route>` and `noctis://<route>/<identifier>`, where the route is one of `objective`,
`mission`, `node`, or `command`. Anything else — another scheme, an unregistered route, a target that
is not an identifier — is refused and logged, not forwarded to the page.

Links arrive three ways, all ending at the same `core:deep-link` event: on the command line of a cold
start, on the command line of a second launch (the first instance is focused and the second exits),
and from the OS once the scheme is registered.

Registering the scheme writes to `HKCU\Software\Classes\noctis`, so it is off unless you ask:

```powershell
$env:NOCTIS_REGISTER_SCHEME = "true"
```

Unregister by deleting that key.

## Duplicate launches

There is one instance. A second launch forwards its command line to the running one, focuses it, and
exits with code 0 in well under a second.

## Limits in this phase

- The core token comes from the environment, not from OS-protected storage. See ADR-0016.
- There is no autostart, no updater, and no signature verification: all three are production
  activations and none is built. `bundle.active` is `false`, so no installer is produced.
- The page is the Phase 4 canary, not the workbench. It exists to prove the shell end to end.

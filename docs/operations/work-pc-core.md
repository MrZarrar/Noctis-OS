# The core on the work PC

Owner decision 0.15 (2026-09-12): the authoritative core runs on the **work PC**, whose Windows and
tailnet hostname is `mushafzarrar` (user `mushaf.zarrar`). The **personal PC** is a worker, and its
hostname is `zarrarpc` (user `mmush`).

The two names read backwards from what you would guess, and an earlier revision of this document had
them swapped. Getting it wrong puts the authoritative core on the personal machine and grants the
work machine the personal roots, which is exactly the boundary decision 0.30 draws. Check `hostname`
before acting on either side. The home development core keeps running for tests
only. ADR-0027 records why and what it costs.

Everything below is a manual start in a terminal. **Windows service or autostart registration is a
separate approval by name** and is not part of Slice 1.

## Install (once, on the work PC)

```powershell
git clone <origin> C:\Users\mushaf.zarrar\Documents\Noctis-OS
cd C:\Users\mushaf.zarrar\Documents\Noctis-OS
node --version        # 22.23.2 (CI pin); 24.x works but CI is authoritative
npm ci
npm run build         # tsc -b. Compiles every workspace. Builds NO web bundle.
npm run build:web     # vite build -> apps/web/dist. The page the phone loads.
```

`npm run build` is `tsc -b` and nothing else, so it produces no `apps/web/dist`. The front door needs
both lines. Run `build:web` in a shell that does **not** have `VITE_CORE_TOKEN` set: Vite inlines
every `VITE_`-prefixed variable into the bundle, and the core serves that bundle unauthenticated, so
a dev token in the build environment becomes readable by anyone who can reach the port. `vite build`
refuses outright rather than warning, so this is a failed build and not a silent leak — but the
failure is easier to understand if you expect it. Re-run `build:web` after every `git pull`; a
served `dist` is a build artefact and does not update itself.

## Environment (user scope, never in the repo)

| Variable                 | Value                              | Why                                                                                         |
| ------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `NOCTIS_CORE_TOKEN`      | 32+ random characters              | Every node credential derives from it; rotating it re-pairs every node.                     |
| `NOCTIS_DATABASE_PATH`   | `%LOCALAPPDATA%\Noctis\core.db`    | The SQLite **file**, not a directory. Outside the repo, outside OneDrive.                   |
| `NOCTIS_WEB_ROOT`        | `<repo>\apps\web\dist`             | The built page the core serves. Without it the phone gets `{"error":{"code":"not_found"}}`. |
| `NOCTIS_ALLOWED_ORIGINS` | the Serve URL (see the front door) | The **page's** origin, not the core's bind address. Node agents send no Origin at all.      |
| `NOCTIS_VAULT_ROOT`      | unset                              | Slice 2 turns the live Vault on (ADR-0029).                                                 |
| `NOCTIS_CORE_BIND`       | unset (`127.0.0.1`)                | Serve proxies to loopback; the core never binds a LAN address.                              |
| `NOCTIS_VAPID_*`         | see below                          | Web push. All three or none: one or two set refuses to start.                               |

```powershell
[Environment]::SetEnvironmentVariable("NOCTIS_CORE_TOKEN", "<32+ chars>", "User")
[Environment]::SetEnvironmentVariable("NOCTIS_DATABASE_PATH", "$env:LOCALAPPDATA\Noctis\core.db", "User")
```

Open a fresh terminal after setting them. `.env.example` in the repo root lists the same names with
their defaults; it is a reference, not a file this deployment uses.

## Start, expose, check

```powershell
node apps\core\dist\main.js                      # terminal 1
tailscale serve --bg 7717                        # once; prints https://mushafzarrar.tail9594ed.ts.net
```

Serve is private to the tailnet. **Never `tailscale funnel`.** From the personal PC:

```powershell
Invoke-RestMethod https://mushafzarrar.tail9594ed.ts.net/health
```

`/health` needs no token and is the one call that proves the tunnel before credentials enter the
picture. Every other path needs the **work** core's token, which the personal PC does not hold and
does not need: pairing carries a one-time code instead.

## Deploy an update (one command)

Once the install and environment above are done, every later update is:

```powershell
cd $HOME\Documents\Noctis-OS
powershell -ExecutionPolicy Bypass -File scripts\deploy\work-pc.ps1
```

`scripts\deploy\work-pc.ps1` refuses unless the host is `mushafzarrar`, the branch is `main` and
the tree is clean. It then runs `git pull --ff-only`, stops the running core and this PC's node agent
(any `node` running `apps\core\dist\main.js` or `apps\node-agent\dist`), and runs `npm ci`,
`npm run build` and `npm run build:web` with `VITE_CORE_TOKEN` removed. It starts the core **hidden**,
with stdout/stderr in `%LOCALAPPDATA%\Noctis\core.out.log` / `core.err.log`, waits for `/health`, then
starts the node agent the same way (`node.out.log` / `node.err.log`). A node that will not start is a
warning, since the core is already up. Before starting either it re-reads every `NOCTIS_*` variable
from the registry, so a variable set after this terminal opened is not silently missing. Both are
started through `start-hidden.ps1`, which inherits none of the script's handles, so a tool or CI job
that runs the deploy gets its prompt back instead of waiting for the core to exit. It registers no
service or task: the core and node are ordinary processes, the script prints their PIDs and the
`Stop-Process` that ends each, and a reboot does not bring them back.
`-DryRun` prints the plan and changes nothing.

Stop any `vite` or `tauri dev` running from this checkout first. Their native binaries are the only
files in `node_modules` Windows locks, and `npm ci` fails on a locked file. Worker nodes reconnect by
themselves after the restart. A turn leased at that moment fails after 30 s rather than re-running.

## Remote desktop (Task 3.9, ADR-0035)

Off until both variables are set. Once, on the work PC:

```powershell
node scripts\deploy\gateway-key.mjs          # writes %LOCALAPPDATA%\Noctis\gateway-provisioner.{key,pem}, prints the public key
[Environment]::SetEnvironmentVariable('NOCTIS_GATEWAY_PROVISIONER_KEY_FILE', "$env:LOCALAPPDATA\Noctis\gateway-provisioner.key", 'User')
[Environment]::SetEnvironmentVariable('NOCTIS_REMOTE_DESKTOPS', '[{"host":"zarrarpc","gatewayUrl":"wss://zarrarpc.tail9594ed.ts.net/jet/rdp","destination":"zarrarpc.tail9594ed.ts.net:3389"}]', 'User')
```

The `.key` file is the credential: it signs the Gateway's session tokens, and it never leaves this
machine. The printed **public** key goes into `provisioner.pem` on each Gateway host
(remote-access.md §9). The key generator refuses to overwrite an existing pair, because a new private
key silently locks out every Gateway still holding the old public one. The Windows password is not
configured anywhere; the panel asks for it on every connect. Then deploy as above; the script prints
`remote desktop: configured`.

## The front door (the phone reaches the core)

The core serves the built page itself. That is not a convenience: `tailscale serve` maps the whole
tailnet hostname to one port, so the page and the core have to be one origin — and the session
cookie is `SameSite=Strict`, which a page on any other origin would never get to send back.

Do these in this order. Each step depends on the one before it, and skipping either of the first two
produces a front door that looks like it is working and is not.

**1. Learn the Serve URL before setting anything.** The origin allowlist has to name it exactly.

```powershell
tailscale serve --bg 7717       # prints https://mushafzarrar.tail9594ed.ts.net
tailscale serve status          # or read it back later
```

**2. Build the page.** `npm run build:web`, in a shell with no `VITE_CORE_TOKEN` — see Install
above. It writes `apps\web\dist`, which must end up containing `index.html` **and** `assets\`.

**3. Point the core at the build, and allow the page's origin.**

```powershell
[Environment]::SetEnvironmentVariable('NOCTIS_WEB_ROOT', "$HOME\Documents\Noctis-OS\apps\web\dist", 'User')
[Environment]::SetEnvironmentVariable('NOCTIS_ALLOWED_ORIGINS', 'https://mushafzarrar.tail9594ed.ts.net', 'User')
```

Both, together. The core refuses to start with `NOCTIS_WEB_ROOT` set and an empty allowlist,
because the page would load and then be unable to log in or stream. It cannot refuse the more likely
mistake, which is the allowlist naming the _wrong_ origin — `http://localhost:5173`, the development
value, is the one to watch for. The page then loads, the login POST answers 403, `/events/live`
answers 403, and nothing on screen says why. A browser sends no `Origin` on a top-level navigation
and does send one on the login POST and on the `EventSource`, which is exactly why the failure looks
like a working page.

If the personal PC still runs Vite against this core (see Clients), list both, comma-separated:
`https://mushafzarrar.tail9594ed.ts.net,http://localhost:5173`.

`NOCTIS_WEB_ROOT` must be the **build**, not the source tree. `apps\web` has an `index.html` of its
own — Vite's entry — so `...\apps\web` is a plausible typo that would serve `/src`,
`/vite.config.ts`, `/node_modules` and any `.env` beside them to anyone who can reach the port. The
core refuses a root with no `assets\` directory for that reason; if it says so, the path is missing
its `\dist`.

**4. Open a fresh terminal** — Windows does not give a running process a user variable set after it
started — **and start the core.** Then, on the phone, open the Serve URL. Expect the Noctis login
screen; type the core token once. The browser keeps a thirty-day `HttpOnly` cookie, and the page
re-mints its CSRF value from that cookie on every load, so a reload, a backgrounded tab and a tapped
notification all land back on the workbench rather than on the token prompt. Settings → **This
browser → Sign out** is the way back to the login screen.

If the phone gets `{"error":{"code":"not_found"}}`, `NOCTIS_WEB_ROOT` is not set in the environment
the core actually started with. If the login screen appears and signing in fails with no explanation,
check `NOCTIS_ALLOWED_ORIGINS` against the URL in the phone's address bar.

## Web push (the phone hears about it)

Push needs HTTPS, which Serve already provides, and a VAPID key pair. **The private key is a
credential.** It goes in a user-scoped environment variable and nowhere else: never in the repo,
never in SQLite, never in a log line, and never pasted into an issue.

```powershell
# One-time, on the work PC. Prints a public and a private key; use them once, here.
npx web-push generate-vapid-keys

[Environment]::SetEnvironmentVariable('NOCTIS_VAPID_PUBLIC_KEY',  '<public>',  'User')
[Environment]::SetEnvironmentVariable('NOCTIS_VAPID_PRIVATE_KEY', '<private>', 'User')
[Environment]::SetEnvironmentVariable('NOCTIS_VAPID_SUBJECT',     'mailto:mushaf.zarrar@travelvogue.co.uk', 'User')
```

All three or none. One or two set is a `ConfigurationError` at startup, because a core that
silently has no push looks exactly like one whose key was mistyped, and the symptom of both is a
phone that never rings. The core validates the keys itself as it starts — `assertVapidKey` in
`config/server.ts` checks the charset and the decoded length, 65 bytes for the public point and 32
for the private scalar — so a truncated paste is a `ConfigurationError` here rather than a delivery
failure noticed weeks later. It names the variable and never its value.

As everywhere else in this runbook, a new terminal does not inherit a just-set user variable on
Windows — restart the editor, or the core will start without push and say nothing about it.

Then, on the phone, with the front door above already working: open the Serve URL, **add it to the
Home Screen** (Share → Add to Home Screen), open it from that icon, log in, then Settings →
Notifications → **Turn on notifications**. Two events reach it — an approval waiting for a person,
and a turn that failed or was blocked — and nothing else.

**On an iPhone the Home Screen step is not optional.** Safari on iOS exposes no `Notification` API
to an ordinary tab, so the button can do nothing there, and the card says so when it finds itself in
one. The page ships a `manifest.webmanifest` declaring `display: "standalone"`, which is what makes
Add to Home Screen produce an installed app rather than a bookmark — without it the install happens
and push still does not work.

If the card says notifications **could not be turned on**, the browser is capable and something else
refused: most often the core has no VAPID keys, or it was started before they were set. That is a
different message from "this browser does not support notifications", which is the iPhone-in-a-tab
case above.

Rotating the pair: set the new values and restart the core. Every phone has to press the button
again — subscriptions encrypted to the old key are undeliverable, and the core prunes them the
first time the push service answers 404 or 410.

## Workers

Pair the work PC's own node first (`--host work`), then the personal PC (`--host home`), following
[nodes.md](nodes.md). The node agent accepts an `https://` core URL and dials `wss://` for the socket.
Grant `runtime.turn` per machine: work roots on the work node, the 0.18 roots on the home node. The
work PC never receives a home-root grant (0.30).

## Clients

- **Desktop shell on the work PC:** `NOCTIS_CORE_URL=http://127.0.0.1:7717`. The shell's Rust client
  has no TLS backend by design (see the Cargo comment), so it talks to the local core directly.
- **Personal PC in Slice 1:** run Vite locally with `NOCTIS_CORE_PROXY_TARGET` set to the Serve URL,
  so the page stays same-origin on `localhost:5173` and the proxy crosses the tailnet. The browser
  transport polls, so it sees items and messages but no token deltas until Slice 2's SSE lands.
- **Phone:** the Serve URL itself — see [the front door](#the-front-door-the-phone-reaches-the-core).
  No Vite, no proxy, no token on the device: the core serves the page and the page holds a session
  cookie.

## Stop, rotate, recover

- **Stop:** Ctrl+C in the core terminal. Leased turns lapse after 30 s and are not re-run blind
  (`runtime.turn` is never retried); their turns complete as `failed`.
- **Rotate the token:** set the new value, restart the core, re-pair every node. There is no grace
  period; that is the intended blast radius.
- **A browser session does not die with the token.** Rotating `NOCTIS_CORE_TOKEN` invalidates every
  node credential and every future login, and leaves every _existing_ browser session working: the
  session row carries no record of which token minted it. So a lost or stolen phone is an open door
  for up to `NOCTIS_SESSION_TTL_HOURS` — thirty days by default — and the only way to close it today
  is to delete rows from SQLite with the core stopped:

  ```powershell
  # Ends every browser session everywhere. Each device logs in again.
  sqlite3 "$env:LOCALAPPDATA\Noctis\core.db" "DELETE FROM sessions;"
  ```

  `push_subscriptions` cascades from `sessions`, so this also drops every device's push
  registration; each one is restored by opening Settings on that device. Signing out from the phone
  itself (Settings → This browser) is the ordinary way out and needs none of this. Tying rotation to
  session invalidation needs a stored token generation on the session row — schema and design, and
  tracked for the next slice rather than done here.

- **Database:** `%LOCALAPPDATA%\Noctis\core.db` plus `-wal`/`-shm`. Copy all three with the core
  stopped. Message bodies of turns that ran on the personal PC live here (ADR-0027).

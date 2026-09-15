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
npm run build
```

## Environment (user scope, never in the repo)

| Variable                 | Value                           | Why                                                                                                 |
| ------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `NOCTIS_CORE_TOKEN`      | 32+ random characters           | Every node credential derives from it; rotating it re-pairs every node.                             |
| `NOCTIS_DATABASE_PATH`   | `%LOCALAPPDATA%\Noctis\core.db` | Outside the repo, outside OneDrive.                                                                 |
| `NOCTIS_ALLOWED_ORIGINS` | `http://localhost:5173`         | The **page's** origin. Vite proxies the core, so both share one; node agents send no Origin at all. |
| `NOCTIS_VAULT_ROOT`      | unset                           | Slice 2 turns the live Vault on (ADR-0029).                                                         |
| `NOCTIS_CORE_BIND`       | unset (`127.0.0.1`)             | Serve proxies to loopback; the core never binds a LAN address.                                      |

```powershell
[Environment]::SetEnvironmentVariable("NOCTIS_CORE_TOKEN", "<32+ chars>", "User")
[Environment]::SetEnvironmentVariable("NOCTIS_DATABASE_PATH", "$env:LOCALAPPDATA\Noctis\core.db", "User")
```

Open a fresh terminal after setting them.

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
- **Phone:** Slice 2.

## Stop, rotate, recover

- **Stop:** Ctrl+C in the core terminal. Leased turns lapse after 30 s and are not re-run blind
  (`runtime.turn` is never retried); their turns complete as `failed`.
- **Rotate the token:** set the new value, restart the core, re-pair every node. There is no grace
  period; that is the intended blast radius.
- **Database:** `%LOCALAPPDATA%\Noctis\core.db` plus `-wal`/`-shm`. Copy all three with the core
  stopped. Message bodies of turns that ran on the personal PC live here (ADR-0027).

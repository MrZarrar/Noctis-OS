# The core on the work PC

Owner decision 0.15 (2026-09-12): the authoritative core runs on the work PC (`zarrarpc` on the
tailnet); the home PC (`mushafzarrar`) is a worker. The home development core keeps running for tests
only. ADR-0027 records why and what it costs.

Everything below is a manual start in a terminal. **Windows service or autostart registration is a
separate approval by name** and is not part of Slice 1.

## Install (once, on the work PC)

```powershell
git clone <origin> C:\Users\mushaf.zarrar\Documents\Jarvis\Noctis-OS
cd C:\Users\mushaf.zarrar\Documents\Jarvis\Noctis-OS
node --version        # 22.23.2 (CI pin); 24.x works but CI is authoritative
npm ci
npm run build
```

## Environment (user scope, never in the repo)

| Variable                 | Value                               | Why                                                                                    |
| ------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------- |
| `NOCTIS_CORE_TOKEN`      | 32+ random characters               | Every node credential derives from it; rotating it re-pairs every node.                |
| `NOCTIS_DATABASE_PATH`   | `%LOCALAPPDATA%\Noctis\core.db`     | Outside the repo, outside OneDrive.                                                    |
| `NOCTIS_ALLOWED_ORIGINS` | `https://zarrarpc.<tailnet>.ts.net` | The browser page served over Tailscale Serve sends this Origin; node agents send none. |
| `NOCTIS_VAULT_ROOT`      | unset                               | Slice 2 turns the live Vault on (ADR-0029).                                            |
| `NOCTIS_CORE_BIND`       | unset (`127.0.0.1`)                 | Serve proxies to loopback; the core never binds a LAN address.                         |

```powershell
[Environment]::SetEnvironmentVariable("NOCTIS_CORE_TOKEN", "<32+ chars>", "User")
[Environment]::SetEnvironmentVariable("NOCTIS_DATABASE_PATH", "$env:LOCALAPPDATA\Noctis\core.db", "User")
```

Open a fresh terminal after setting them.

## Start, expose, check

```powershell
node apps\core\dist\main.js                      # terminal 1
tailscale serve --bg 7717                        # once; prints https://zarrarpc.<tailnet>.ts.net
```

Serve is private to the tailnet. **Never `tailscale funnel`.** From the home PC:

```powershell
Invoke-RestMethod https://zarrarpc.<tailnet>.ts.net/health
Invoke-RestMethod https://zarrarpc.<tailnet>.ts.net/ready -Headers @{ Authorization = "Bearer $env:NOCTIS_CORE_TOKEN" }
```

## Workers

Pair the work PC's own node first (`--host work`), then the home PC (`--host home`), following
[nodes.md](nodes.md). The node agent accepts an `https://` core URL and dials `wss://` for the socket.
Grant `runtime.turn` per machine: work roots on the work node, the 0.18 roots on the home node. The
work PC never receives a home-root grant (0.30).

## Clients

- **Desktop shell on the work PC:** `NOCTIS_CORE_URL=http://127.0.0.1:7717`. The shell's Rust client
  has no TLS backend by design (see the Cargo comment), so it talks to the local core directly.
- **Home PC in Slice 1:** the web page in a browser against the Serve URL (`VITE_CORE_URL`,
  `VITE_CORE_TOKEN` for development only). The browser transport polls, so it sees items and
  messages but no token deltas until Slice 2's session realm and SSE land.
- **Phone:** Slice 2.

## Stop, rotate, recover

- **Stop:** Ctrl+C in the core terminal. Leased turns lapse after 30 s and are not re-run blind
  (`runtime.turn` is never retried); their turns complete as `failed`.
- **Rotate the token:** set the new value, restart the core, re-pair every node. There is no grace
  period; that is the intended blast radius.
- **Database:** `%LOCALAPPDATA%\Noctis\core.db` plus `-wal`/`-shm`. Copy all three with the core
  stopped. Message bodies of home turns live here (ADR-0027).

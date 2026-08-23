# Noctis OS

Noctis OS is a new local-first orchestration operating environment. It is implemented in this
independent repository and will replace the running Jarvis OS after acceptance and a controlled
production cutover.

The Jarvis Sub-Agent Dashboard is a read-only donor. No Noctis command may write inside it.

## Current implementation state

- Active branch: `feat/bootstrap-foundation`
- Active delivery slice: Phase 0 bootstrap, followed by the first Phase 1 contracts
- Node.js: 22.23.2
- Rust: 1.98.0 pinned and verified on this Windows machine
- Production activation: not authorised

The authoritative roadmap is
[`docs/architecture/2026-08-23-noctis-os-master-implementation-plan.md`](docs/architecture/2026-08-23-noctis-os-master-implementation-plan.md).

## Local commands

Use the bundled Node 22 runtime until the machine-wide PATH is qualified:

```powershell
$env:Path = "C:\Users\mmush\Documents\Jarvis\.tools\node-v22.23.2-win-x64;$env:Path"
npm.cmd ci
npm.cmd run test:boundary
npm.cmd run format:check
npm.cmd run lint
npm.cmd run typecheck
npm.cmd run test:unit
npm.cmd run build
npm.cmd run test:desktop-bootstrap
npm.cmd run rust:fmt:check
npm.cmd run rust:clippy
npm.cmd run rust:test
npm.cmd run build:desktop
```

The desktop commands execute unsigned Cargo build helpers. On this development PC, enforced Windows
Smart App Control blocks those generated executables. GitHub Actions is the trusted bootstrap build
environment until an approved local App Control development policy or another qualified Windows host
is available. Do not disable Smart App Control as an implementation shortcut.

Do not deploy, register services, enable autostart, connect the live Vault, pair real workers, or
retire Jarvis from this branch.

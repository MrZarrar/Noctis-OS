# System boundary

## Repository boundary

- Noctis target: `C:\Users\mmush\Documents\Jarvis\Noctis-OS`
- Read-only donor: `C:\Users\mmush\Documents\Jarvis\Jarvis-Sub-Agent-Dashboard`
- The repositories are siblings with independent Git histories.
- Ported behaviour must be recorded in the donor port ledger before copying code.
- No Noctis script may clean, reset, checkout, stage, commit, install, migrate, or write inside the donor.

## Runtime boundary

Development uses Noctis-only ports, configuration roots, databases, credentials, caches, deep links,
application IDs, and disposable Vault fixtures. It does not share writable runtime state with Jarvis.

Noctis will replace the running Jarvis OS at a later controlled cutover. Jarvis may remain available
during development and a bounded rollback window, but it is not a permanent parallel product. The
donor repository remains preserved after the Jarvis runtime is retired.

## Authority boundary

This branch is authorised for local repository creation, dependency installation, tests, and
implementation. It is not authorised for production deployment, external writes, live Vault writes,
worker pairing, service registration, autostart, paid APIs, or Jarvis retirement.

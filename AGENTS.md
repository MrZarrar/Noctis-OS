# Noctis OS implementation rules

- Treat `C:\Users\mmush\Documents\Jarvis\Jarvis-Sub-Agent-Dashboard` as a read-only donor.
- Never run a write, install, migration, clean, reset, checkout, stage, or commit command in the donor.
- Record every future donor port in `docs/architecture/DONOR-PORT-LEDGER.md` before copying code.
- Use Node.js 22.23.2 and the exact package lock.
- Write a focused failing test before production behavior, then verify red and green.
- Models may propose validated semantic intent; deterministic code owns authority, state transitions,
  layout, routing, restore, and physical window placement.
- Keep production capabilities default-off. Do not deploy, register services, enable autostart, pair
  real workers, connect the live Vault, make external writes, use metered APIs, or retire Jarvis
  without explicit approval.
- Preserve unrelated work. Do not use destructive Git or filesystem commands.
- Record fresh verification evidence before completion claims or commits.
- Commit and push as you go. The owner has given a standing yes for this whole repo: once a task passes
  its tests and review, commit it and push it to `origin/main` without asking first. Never force-push or
  rewrite history.

# Owner decisions and discussion: 6 November 2026

Follows `2026-10-23-owner-decisions.md`. Each item is marked **Decided**, **Built**, **Open** or **Deferred**.

## 1. Live Dexcom CGM: Health panel, Presence, and thread status

**Asked (owner):** connect Noctis to the owner's live Dexcom G7, shown on the Health panel, as a widget on Presence
(the clock/greeting screen, what the owner calls "home"), and beside the clock in Threads.

**Found:** glycolens already covers a weekly deterministic report from the home PC's paired data, not a live
current reading. Per `inbox/2026-10-15-glycolens-planned.md`, UK Tandem pump users have their G7 routed through
Tandem Source since August 2025, which has no public live API. Dexcom Share (the Follow API) is separate from that
pairing and still works for a live reading.

**Decided (owner):**

- Data source: Dexcom Share/Follow, not Tandem Source. The owner's account is UK, so the OUS server
  (`shareous1.dexcom.com`) applies, not the US one.
- Units: mmol/L (the owner's own Dexcom app shows mmol/L; Dexcom Share's raw API returns mg/dL, converted on read).
- Credentials: a new Settings field on the work PC. The username/password are encrypted at rest in the core's own
  SQLite (`runtime_kv`), with the key in a sibling file, the same precedent as the gateway provisioner key file.
  Not Windows Credential Manager, not pasted into chat.
- "A widget in home" meant Presence (`apps/web/src/pages/Presence.tsx`), not a new page — there is no page named
  Home in Noctis today.

**Built:**

- `apps/core/src/health/dexcom.ts`: the Dexcom Share HTTP client (login, latest reading, mg/dL→mmol/L, trend→arrow
  code mapping). Uses the public Dexcom Share mobile app's own `applicationId`, the same constant every third-party
  Share client uses; there is no OAuth app for this.
- `apps/core/src/health/dexcom-credentials.ts`: AES-256-GCM encrypt/store/read in `runtime_kv`, key file beside the
  database.
- `apps/core/src/health/dexcom-service.ts`: polls at most every 5 minutes (the G7's own cadence), caches the latest
  reading, reports `not_configured` / `ok` / `stale` (cache older than 15 minutes, or last poll failed) / `error`.
  Wired into the same 1-second sweep that already drives `health.pass()` in `server.ts`.
- Routes: `GET /glucose/live`, `GET /integrations/dexcom`, `POST /integrations/dexcom` (connect; validates the login
  before anything is stored, so a bad password never persists), `POST /integrations/dexcom/disconnect`.
- A `GlucoseBadge` component (value + trend arrow, colour-banded on NICE's hypo/hyper thresholds) beside the clock in
  both Presence and `ThreadStatus.tsx`, and a full-size one in the Health page's header actions. A new "Dexcom"
  section on the Settings page for the login.

**Open:** the owner has not yet entered their real Dexcom Share login, so this has not been exercised against the
live service. No core restart yet; the owner asked for commit and push without a redeploy this time.

-- apps/core/migrations/0003_surfaces.sql
-- Phase 6 makes the three Surface identities structural rather than conventional.
-- No new tables: 0001 already declared surface_intents, surface_overrides, and
-- composition_snapshots. What was missing was the uniqueness each one relies on,
-- which until now lived only in the service that happened to be the sole writer.

-- Section 5.4 step 2 collapses duplicate intents "by objective/kind/source
-- identity". That is the upsert key, so the database is the thing that enforces
-- it: two rows claiming the same Surface cannot coexist to be collapsed later.
CREATE UNIQUE INDEX idx_surface_intents_identity
  ON surface_intents (objective_id, kind, source_ids_json);

-- At most one live override per Surface per client per display. Released rows
-- are excluded from the constraint, so the history of what a user once
-- arranged survives while only one arrangement is ever in force.
CREATE UNIQUE INDEX idx_surface_overrides_live
  ON surface_overrides (surface_id, client_id, display_fingerprint)
  WHERE released_at IS NULL;

-- One restorable snapshot per objective per display, updated in place. The
-- history of compositions is not lost by this: every change also appends
-- surface.composition_changed.v1, which is the append-only record. Keeping the
-- snapshot single-row is what gives it a stable id for idempotent replay.
CREATE UNIQUE INDEX idx_composition_snapshots_display
  ON composition_snapshots (objective_id, display_fingerprint);

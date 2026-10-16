-- Arrivals at and departures from the owner's named places, as the phone's
-- Shortcuts automations report them. A name and a time, never a coordinate.
CREATE TABLE place_events (
  id          INTEGER PRIMARY KEY,
  place       TEXT NOT NULL,
  transition  TEXT NOT NULL CHECK (transition IN ('arrive', 'leave')),
  at          TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE INDEX place_events_at ON place_events (at);

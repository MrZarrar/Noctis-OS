import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { PlaceEvent, PlaceVisit } from "@noctis/contracts";

import type { NoctisDatabase } from "../db/connection.js";

/**
 * The phone's link is derived like a node credential: a pure function of the
 * core token and a generation counter, so the database holds a number and no
 * secret. It can only report arrivals, so the Shortcut holding it in plain text
 * is an acceptable home for it. Rotating the core token changes it too.
 */
const LINK_DOMAIN = "noctis.places.link.v1";
const GENERATION_KEY = "places:link-generation";
const BEARER = /^Bearer ([0-9a-f]{64})$/;

const MINUTE = 60_000;
const SHOWN_DAYS = 30;
// ponytail: an arrive with no leave for this long is a lost leave, not a stay.
// Closing it at the next arrival elsewhere would guess the length instead.
const LONGEST_STAY_MINUTES = 12 * 60;

function generation(db: NoctisDatabase): number {
  const row = db.prepare(`SELECT value_json FROM runtime_kv WHERE key = ?`).get(GENERATION_KEY) as
    { value_json: string } | undefined;

  return row === undefined ? 0 : Number(JSON.parse(row.value_json));
}

export function linkToken(db: NoctisDatabase, coreToken: string): string {
  return createHmac("sha256", coreToken)
    .update(`${LINK_DOMAIN}:${String(generation(db))}`)
    .digest("hex");
}

export function rotateLink(db: NoctisDatabase, coreToken: string): string {
  db.prepare(
    `INSERT INTO runtime_kv (key, value_version, value_json, updated_at)
       VALUES (?, 1, ?, ?)
     ON CONFLICT (key) DO UPDATE SET
       value_version = value_version + 1,
       value_json = excluded.value_json,
       updated_at = excluded.updated_at`,
  ).run(GENERATION_KEY, JSON.stringify(generation(db) + 1), new Date().toISOString());

  return linkToken(db, coreToken);
}

export function verifyLink(
  db: NoctisDatabase,
  coreToken: string,
  authorization: string | undefined,
): boolean {
  const presented = authorization === undefined ? null : BEARER.exec(authorization);

  if (presented?.[1] === undefined) {
    return false;
  }

  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

  return timingSafeEqual(digest(presented[1]), digest(linkToken(db, coreToken)));
}

export function recordPlaceEvent(db: NoctisDatabase, event: PlaceEvent, receivedAt: string): void {
  db.prepare(
    `INSERT INTO place_events (place, transition, at, received_at) VALUES (?, ?, ?, ?)`,
  ).run(event.place, event.transition, event.at, receivedAt);
}

/** Events in time order, oldest first. Visits come back in the same order. */
export function visits(
  events: readonly PlaceEvent[],
  minMinutes: number,
  now: number,
): PlaceVisit[] {
  const open = new Map<string, string>();
  const found: PlaceVisit[] = [];
  const minutesBetween = (start: string, end: number) =>
    Math.round((end - Date.parse(start)) / MINUTE);

  for (const event of events) {
    const arrived = open.get(event.place);

    if (event.transition === "arrive") {
      // A second arrive soon after is the geofence twitching; one long after means the leave was lost.
      if (
        arrived === undefined ||
        minutesBetween(arrived, Date.parse(event.at)) > LONGEST_STAY_MINUTES
      ) {
        open.set(event.place, event.at);
      }
      continue;
    }

    if (arrived === undefined) continue;

    open.delete(event.place);
    const minutes = minutesBetween(arrived, Date.parse(event.at));

    if (minutes >= minMinutes && minutes <= LONGEST_STAY_MINUTES) {
      found.push({ place: event.place, start: arrived, end: event.at, minutes });
    }
  }

  for (const [place, start] of open) {
    const minutes = minutesBetween(start, now);

    if (minutes <= LONGEST_STAY_MINUTES) {
      found.push({ place, start, end: null, minutes });
    }
  }

  return found.sort((left, right) => left.start.localeCompare(right.start));
}

export function placesView(
  db: NoctisDatabase,
  minMinutes: number,
  now: number,
): { events: PlaceEvent[]; visits: PlaceVisit[] } {
  const since = new Date(now - SHOWN_DAYS * 24 * 60 * MINUTE).toISOString();
  const events = db
    .prepare(`SELECT place, transition, at FROM place_events WHERE at >= ? ORDER BY at, id`)
    .all(since) as unknown as PlaceEvent[];

  return {
    events: events.slice(-50).reverse(),
    visits: visits(events, minMinutes, now).reverse(),
  };
}

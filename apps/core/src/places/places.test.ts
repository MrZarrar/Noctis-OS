import { describe, expect, it } from "vitest";

import { openDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import {
  linkToken,
  placesView,
  recordPlaceEvent,
  rotateLink,
  verifyLink,
  visits,
} from "./places.js";

const coreToken = "0123456789abcdef0123456789abcdef";
const at = (time: string) => `2026-10-16T${time}:00.000Z`;
const event = (place: string, transition: "arrive" | "leave", time: string) => ({
  place,
  transition,
  at: at(time),
});

describe("visits", () => {
  const now = Date.parse(at("23:00"));

  it("pair an arrive with the next leave, and drop stays shorter than the minimum", () => {
    expect(
      visits(
        [
          event("gym", "arrive", "19:10"),
          event("gym", "leave", "20:40"),
          event("home", "arrive", "20:55"),
          event("home", "leave", "21:00"),
        ],
        20,
        now,
      ),
    ).toEqual([{ place: "gym", start: at("19:10"), end: at("20:40"), minutes: 90 }]);
  });

  it("keep the first of two arrivals and ignore a leave with no arrival", () => {
    expect(
      visits(
        [
          event("gym", "leave", "18:00"),
          event("gym", "arrive", "19:00"),
          event("gym", "arrive", "19:05"),
          event("gym", "leave", "20:00"),
        ],
        20,
        now,
      ),
    ).toEqual([{ place: "gym", start: at("19:00"), end: at("20:00"), minutes: 60 }]);
  });

  it("do not let a lost leave swallow the next real visit", () => {
    expect(
      visits(
        [
          { place: "gym", transition: "arrive", at: "2026-10-15T18:00:00.000Z" },
          event("gym", "arrive", "18:00"),
          event("gym", "leave", "19:00"),
        ],
        20,
        now,
      ),
    ).toEqual([{ place: "gym", start: at("18:00"), end: at("19:00"), minutes: 60 }]);
  });

  it("show a stay still going, unless the leave was clearly lost", () => {
    expect(visits([event("gym", "arrive", "22:30")], 20, now)).toEqual([
      { place: "gym", start: at("22:30"), end: null, minutes: 30 },
    ]);
    expect(visits([event("gym", "arrive", "05:00")], 20, now)).toEqual([]);
  });
});

describe("the phone's link", () => {
  it("is derived from the core token and changes when rotated", () => {
    const db = openDatabase(":memory:");
    migrate(db, { directory: "apps/core/migrations", clock: { now: () => 0 } });
    const first = linkToken(db, coreToken);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyLink(db, coreToken, `Bearer ${first}`)).toBe(true);
    expect(verifyLink(db, coreToken, `Bearer ${coreToken}`)).toBe(false);
    expect(verifyLink(db, coreToken, undefined)).toBe(false);

    const second = rotateLink(db, coreToken);

    expect(second).not.toBe(first);
    expect(verifyLink(db, coreToken, `Bearer ${first}`)).toBe(false);
    expect(verifyLink(db, coreToken, `Bearer ${second}`)).toBe(true);
    db.close();
  });
});

describe("the places view", () => {
  it("lists recent arrivals newest first, and the visits they make", () => {
    const db = openDatabase(":memory:");
    migrate(db, { directory: "apps/core/migrations", clock: { now: () => 0 } });
    recordPlaceEvent(db, event("gym", "arrive", "19:10"), at("19:11"));
    recordPlaceEvent(db, event("gym", "leave", "20:40"), at("20:41"));

    expect(placesView(db, 20, Date.parse(at("23:00")))).toEqual({
      events: [event("gym", "leave", "20:40"), event("gym", "arrive", "19:10")],
      visits: [{ place: "gym", start: at("19:10"), end: at("20:40"), minutes: 90 }],
    });
    db.close();
  });
});

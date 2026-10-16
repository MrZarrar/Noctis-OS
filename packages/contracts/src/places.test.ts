import { describe, expect, it } from "vitest";

import { SetSettingCommandSchema } from "./command.js";
import { PlaceEventBodySchema } from "./places.js";

const set = (key: string, value: unknown) =>
  SetSettingCommandSchema.safeParse({ idempotencyKey: "places-1", key, value }).success;

describe("the owner's places", () => {
  it("are short lowercase names, each once", () => {
    expect(set("places", ["home", "work", "gym"])).toBe(true);
    expect(set("places", [])).toBe(true);
    expect(set("places", ["gym", "gym"])).toBe(false);
    expect(set("places", ["The Gym"])).toBe(false);
    expect(set("places", [""])).toBe(false);
    expect(set("placeVisitMinutes", 20)).toBe(true);
    expect(set("placeVisitMinutes", 0)).toBe(false);
  });
});

describe("what the phone sends", () => {
  it("takes the place in any case and the phone's own time with its offset", () => {
    expect(
      PlaceEventBodySchema.parse({
        place: " Gym ",
        transition: "arrive",
        at: "2026-10-16T19:12:03+01:00",
      }),
    ).toEqual({ place: "gym", transition: "arrive", at: "2026-10-16T19:12:03+01:00" });
    expect(PlaceEventBodySchema.parse({ place: "home", transition: "leave" })).toEqual({
      place: "home",
      transition: "leave",
    });
  });

  it("refuses anything else", () => {
    expect(PlaceEventBodySchema.safeParse({ place: "gym", transition: "enter" }).success).toBe(
      false,
    );
    expect(
      PlaceEventBodySchema.safeParse({ place: "gym", transition: "arrive", at: "tonight" }).success,
    ).toBe(false);
    expect(
      PlaceEventBodySchema.safeParse({ place: "gym", transition: "arrive", lat: 51.5 }).success,
    ).toBe(false);
  });
});

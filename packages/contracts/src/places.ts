import { z } from "zod";

/**
 * Places the owner names (home, work, gym) and the arrivals the phone reports.
 * The geofence lives in the phone's Shortcuts automation, so the core only ever
 * hears "arrived at gym", never a coordinate.
 */

export const PlaceNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "a short lowercase name");

export const PlacesSettingSchema = z
  .array(PlaceNameSchema)
  .max(20)
  .refine((places) => new Set(places).size === places.length, {
    message: "place names must be unique",
  });

export const PlaceTransitionSchema = z.enum(["arrive", "leave"]);

/** One Shortcuts automation firing. `at` is the phone's clock, so a late delivery keeps its time. */
export const PlaceEventBodySchema = z
  .object({
    place: z.string().trim().toLowerCase().pipe(PlaceNameSchema),
    transition: PlaceTransitionSchema,
    at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export type PlaceEventBody = z.infer<typeof PlaceEventBodySchema>;

export interface PlaceEvent {
  place: string;
  transition: z.infer<typeof PlaceTransitionSchema>;
  at: string;
}

/** An arrive and its leave. `end` is null while the owner is still there. */
export interface PlaceVisit {
  place: string;
  start: string;
  end: string | null;
  minutes: number;
}

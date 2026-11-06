import { OVERSCAN } from "./camera.js";
import type { CameraStop } from "./camera.js";

export type RoomId = "atrium" | "library" | "gallery";

/**
 * A door, shelf or exhibit the owner can actually click.
 *
 * Coordinates are a rectangle on the plate in 0..1, measured off the approved
 * mockups, so a hotspot tracks the artwork through every camera move instead of
 * being pinned to the viewport. `enter` is the camera stop the room pushes
 * towards while the transition plays, which is what makes it read as walking
 * through the doorway rather than a crossfade.
 */
export interface Hotspot {
  id: string;
  label: string;
  to: RoomId;
  rect: { x: number; y: number; width: number; height: number };
  enter: CameraStop;
}

export interface Room {
  id: RoomId;
  plate: string;
  /** Spoken aloud by a screen reader on arrival, and the page's heading. */
  name: string;
  /** Where the camera rests when writing. */
  desk: CameraStop;
  /** Where "Explore the palace" travels to. */
  wide: CameraStop;
  hotspots: readonly Hotspot[];
}

const ATRIUM_DOORWAY = { y: 0.04, height: 0.46 };

export const ROOMS: Readonly<Record<RoomId, Room>> = {
  atrium: {
    id: "atrium",
    plate: "/palace/atrium.png",
    name: "The atrium",
    desk: { focus: { x: 0.5, y: 0.5 }, zoom: 1 / OVERSCAN },
    wide: { focus: { x: 0.5, y: 0.34 }, zoom: 1.32 },
    hotspots: [
      {
        id: "door-library",
        label: "Library",
        to: "library",
        rect: { x: 0.055, width: 0.18, ...ATRIUM_DOORWAY },
        enter: { focus: { x: 0.12, y: 0.27 }, zoom: 3.3 },
      },
      {
        id: "door-gallery",
        label: "Gallery",
        to: "gallery",
        rect: { x: 0.79, width: 0.18, ...ATRIUM_DOORWAY },
        enter: { focus: { x: 0.88, y: 0.27 }, zoom: 3.3 },
      },
    ],
  },
  library: {
    id: "library",
    plate: "/palace/library.png",
    name: "The library",
    desk: { focus: { x: 0.5, y: 0.5 }, zoom: 1 / OVERSCAN },
    wide: { focus: { x: 0.5, y: 0.34 }, zoom: 1.28 },
    // Neither side room has a doorway back in its artwork, so the way out is a
    // plain control rather than a bookcase pretending to be a door.
    hotspots: [],
  },
  gallery: {
    id: "gallery",
    plate: "/palace/gallery.png",
    name: "The gallery",
    desk: { focus: { x: 0.5, y: 0.5 }, zoom: 1 / OVERSCAN },
    wide: { focus: { x: 0.5, y: 0.36 }, zoom: 1.26 },
    hotspots: [],
  },
};

/** The camera stop that centres a hotspot, for keyboard focus moving the view. */
export function hotspotCentre(hotspot: Hotspot): CameraStop["focus"] {
  return {
    x: hotspot.rect.x + hotspot.rect.width / 2,
    y: hotspot.rect.y + hotspot.rect.height / 2,
  };
}

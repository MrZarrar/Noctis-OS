/**
 * Where the camera sits in a room.
 *
 * `focus` is a point on the plate in 0..1, `zoom` is how close. The desk stop is
 * pushed in low and centre so the writing surface fills the frame; the wide stop
 * pulls back and lifts to show the colonnade and the coastline beyond it.
 */
export interface CameraStop {
  focus: { x: number; y: number };
  zoom: number;
}

/**
 * The plate is rendered larger than the viewport so there is always picture to
 * pan into. Without it the wide stop, which looks above the centre line, would
 * drag the top edge of the artwork into frame.
 */
export const OVERSCAN = 1.3;

/**
 * `scale() translate()` in that written order means the translate runs first in
 * the element's own space, putting the focal point at the centre, and the scale
 * then magnifies about that centre. Written the other way round the percentages
 * would be measured against an already-scaled box and the focal point would
 * drift as the zoom changed.
 */
export function cameraTransform(stop: CameraStop): string {
  const dx = (0.5 - stop.focus.x) * 100;
  const dy = (0.5 - stop.focus.y) * 100;
  return `scale(${String(stop.zoom)}) translate(${dx.toFixed(4)}%, ${dy.toFixed(4)}%)`;
}

/**
 * The zoom at which the plate still reaches every edge of the viewport.
 *
 * A focus `d` away from the plate's centre pushes the near edge `d` closer and
 * the far edge `d` further, so the binding constraint is the near one: the
 * remaining half-width `0.5 - d` of overscanned plate has to cover the
 * viewport's half-width. Hence `0.5 / (overscan * (0.5 - d))`, which is not the
 * `1 + 2d` it looks like at small offsets and diverges badly past a third.
 */
export function minimumZoom(focus: CameraStop["focus"], overscan = OVERSCAN): number {
  const near = 0.5 - Math.max(Math.abs(0.5 - focus.x), Math.abs(0.5 - focus.y));
  return near <= 0 ? Number.POSITIVE_INFINITY : 0.5 / (overscan * near);
}

export function coversViewport(stop: CameraStop, overscan = OVERSCAN): boolean {
  return stop.zoom >= minimumZoom(stop.focus, overscan) - 1e-9;
}

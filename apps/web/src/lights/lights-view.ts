import type { LightState } from "@noctis/contracts";

const WARM = [255, 180, 107] as const;
const COOL = [219, 232, 255] as const;

/** What the light is giving out, for its swatch; undefined when it is dark. */
export function lightColour(light: LightState): string | undefined {
  if (!light.online || light.on !== true) return undefined;
  if (light.mode === "colour" || (light.hue !== undefined && light.colorTempK === undefined)) {
    return `hsl(${String(light.hue ?? 0)} ${String(light.saturation ?? 100)}% 55%)`;
  }
  const t = Math.min(1, Math.max(0, ((light.colorTempK ?? 2700) - 2500) / 4000));
  const [r, g, b] = WARM.map((w, i) => Math.round(w + (COOL[i]! - w) * t));
  return `rgb(${String(r)} ${String(g)} ${String(b)})`;
}

export function sceneLabel(scene: string): string {
  const words = scene.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

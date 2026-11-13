import { LightChangeSchema, SceneNameSchema } from "@noctis/contracts";
import { z } from "zod";

import { lightsAgentsEnabled } from "./config.js";
import { lightsService } from "./index.js";

export const LIGHTS_TOOL_DESCRIPTION =
  "Read this PC's lights with {}, or change them with {scene} or {changes}. Read the state first to get light names and available scenes.";

export const LightsToolInputSchema = z
  .object({
    scene: SceneNameSchema.optional(),
    changes: z.array(LightChangeSchema).min(1).max(16).optional(),
  })
  .strict()
  .refine(
    (input) => input.scene === undefined || input.changes === undefined,
    "use a scene or changes",
  );

export function createLightsTool(options: { env?: NodeJS.ProcessEnv } = {}) {
  const env = options.env ?? process.env;
  if (!lightsAgentsEnabled(env)) return undefined;
  return {
    async call(
      input: unknown,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
      try {
        if (!lightsAgentsEnabled(env))
          return {
            content: [{ type: "text", text: "lights agent access is disabled on this PC" }],
            isError: true,
          };
        const parsed = LightsToolInputSchema.safeParse(input);
        if (!parsed.success)
          return {
            content: [{ type: "text", text: "expected {}, {scene} or {changes}" }],
            isError: true,
          };
        const service = lightsService(env);
        const evidence =
          parsed.data.scene !== undefined || parsed.data.changes !== undefined
            ? await service.set(parsed.data)
            : await service.state();
        return { content: [{ type: "text", text: JSON.stringify(evidence) }] };
      } catch {
        return {
          content: [
            {
              type: "text",
              text: "lights request refused; read state to check names and configuration",
            },
          ],
          isError: true,
        };
      }
    },
  };
}

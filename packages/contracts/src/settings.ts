import { z } from "zod";

import { RemoteHostNameSchema } from "./remote.js";

/**
 * The owner's settings: what the Settings page can change about how Noctis
 * runs. Each value is checked here, so a bad one is refused before it is
 * stored. Start-up settings (port, token, keys) are not here on purpose: the
 * core needs them before it can serve a page.
 */

/** A local time like "21:30", or empty for off. */
export const SettingTimeSchema = z.union([
  z.literal(""),
  z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a time like 21:30"),
]);

/** One remote desktop the Nodes page can open: its host, its Gateway and where the Gateway connects. */
export const RemoteDesktopHostSchema = z
  .object({
    host: RemoteHostNameSchema,
    gatewayUrl: z.url({ protocol: /^wss$/ }),
    destination: z.string().regex(/^[A-Za-z0-9.-]+:\d{1,5}$/),
  })
  .strict();

export const RemoteDesktopTargetsSettingSchema = z
  .array(RemoteDesktopHostSchema)
  .max(20)
  .refine((targets) => new Set(targets.map((target) => target.host)).size === targets.length, {
    message: "host names must be unique",
  });

export const SETTING_VALUE_SCHEMAS = {
  digestAt: SettingTimeSchema,
  promoterAt: SettingTimeSchema,
  vaultWrites: z.boolean(),
  sessionTtlHours: z.int().min(1).max(8760),
  logLevel: z.enum(["debug", "info", "warn", "error"]),
  showAllPages: z.boolean(),
  remoteDesktops: RemoteDesktopTargetsSettingSchema,
} as const;

export type SettingKey = keyof typeof SETTING_VALUE_SCHEMAS;

export const SETTING_KEYS = Object.keys(SETTING_VALUE_SCHEMAS) as SettingKey[];

export const SettingKeySchema = z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]);

export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTING_VALUE_SCHEMAS)[K]>;

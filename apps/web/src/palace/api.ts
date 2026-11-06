import {
  ArchivePalaceCommandSchema,
  PalaceEntrySchema,
  PalaceListQuerySchema,
  PalaceListSchema,
  PalaceReceiptSchema,
  SavePalaceCommandSchema,
} from "@noctis/contracts";
import type { ArchivePalaceCommand, SavePalaceCommand } from "@noctis/contracts";
import { z } from "zod";
import { coreBaseUrl } from "../core-client.js";
import { palaceArea } from "../larp/palace.js";
import { vaultArea } from "../larp/vault.js";
import type { CoreTransport } from "../transport/CoreTransport.js";

export class PalaceRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export const palaceDraftScope = () => ({
  ownerId: "local",
  coreOrigin: coreBaseUrl(),
  fixture: import.meta.env.VITE_NOCTIS_PALACE_LIVE !== "1",
});

export function createPalaceApi(transport: CoreTransport | undefined) {
  const fixture = import.meta.env.VITE_NOCTIS_PALACE_LIVE !== "1";
  async function request<S extends z.ZodType>(
    schema: S,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<z.infer<S>> {
    const response = fixture
      ? (palaceArea.request?.(method, path, body) ?? vaultArea.request?.(method, path, body))
      : await transport?.request(method, path, body);
    if (response === undefined)
      throw new PalaceRequestError(
        503,
        "The core is unavailable. Your draft stays on this device.",
      );
    if (response.status !== 200) {
      const error = response.body as { error?: { message?: string } };
      throw new PalaceRequestError(
        response.status,
        error.error?.message ?? "The entry could not be saved",
      );
    }
    return schema.parse(response.body);
  }
  return {
    fixture,
    list: (filters: z.input<typeof PalaceListQuerySchema> = {}) => {
      const parsed = PalaceListQuerySchema.parse(filters);
      const query = new URLSearchParams(
        Object.entries(parsed).map(([key, value]) => [key, String(value)]),
      );
      return request(PalaceListSchema, "GET", `/palace/entries?${query}`);
    },
    read: (id: string) =>
      request(PalaceEntrySchema, "GET", `/palace/entries/${encodeURIComponent(id)}`),
    save: (command: SavePalaceCommand) =>
      request(
        PalaceReceiptSchema,
        "POST",
        "/commands/palace.save",
        SavePalaceCommandSchema.parse(command),
      ),
    archive: (command: ArchivePalaceCommand) =>
      request(
        PalaceReceiptSchema,
        "POST",
        "/commands/palace.archive",
        ArchivePalaceCommandSchema.parse(command),
      ),
    restore: (command: ArchivePalaceCommand) =>
      request(
        PalaceReceiptSchema,
        "POST",
        "/commands/palace.restore",
        ArchivePalaceCommandSchema.parse(command),
      ),
    passcode: () => request(z.object({ unlocked: z.boolean() }), "GET", "/passcode"),
    lock: () => request(z.object({ unlocked: z.boolean() }), "POST", "/passcode/lock", {}),
    unlock: (passcode: string) =>
      request(z.object({ unlocked: z.boolean() }), "POST", "/passcode/unlock", { passcode }),
  };
}
export type PalaceApi = ReturnType<typeof createPalaceApi>;

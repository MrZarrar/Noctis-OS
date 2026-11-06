import {
  ArchivePalaceCommandSchema,
  PalaceEntrySchema,
  PalaceListQuerySchema,
  SavePalaceCommandSchema,
} from "@noctis/contracts";
import type { PalaceEntry } from "@noctis/contracts";
import type { CoreResponse } from "../transport/CoreTransport.js";
import type { LarpArea } from "./area.js";
import { ok, parsePath } from "./area.js";
import { vaultIsUnlocked } from "./vault.js";
import { makePalaceEntries } from "./palace-data.js";

const entries: PalaceEntry[] = makePalaceEntries();
let version = 1;
for (const entry of entries) entry.contentHash = (version++).toString(16).padStart(64, "0");
const replays = new Map<string, { request: string; response: CoreResponse }>();
const refused = (status: number, code: string, message: string): CoreResponse => ({
  status,
  body: { error: { code, message } },
});
const visible = (entry: PalaceEntry) => !entry.sensitive || vaultIsUnlocked();

export const palaceArea: LarpArea = {
  request(method, path, body) {
    const { segments, query } = parsePath(path);
    if (method === "GET" && segments[0] === "palace" && segments[1] === "entries") {
      if (segments.length === 3) {
        const entry = entries.find((entry) => entry.id === segments[2] && visible(entry));
        return entry === undefined
          ? refused(404, "not_found", "Entry not found")
          : ok(structuredClone(entry));
      }
      if (segments.length !== 2) return undefined;
      const parsed = PalaceListQuerySchema.safeParse(Object.fromEntries(query));
      if (!parsed.success) return refused(400, "invalid_request", "Check the palace filters");
      const options = parsed.data;
      const search = options.query?.toLowerCase() ?? "";
      const matching = entries
        .filter(
          (entry) =>
            visible(entry) &&
            (options.archived === "all" || entry.archived === (options.archived === "true")) &&
            (options.kind === undefined || entry.kind === options.kind) &&
            (options.bookId === undefined || entry.bookId === options.bookId) &&
            (options.cursor === undefined || entry.id > options.cursor) &&
            (options.room === undefined ||
              (options.room === "library"
                ? entry.kind === "book" || entry.bookId !== undefined
                : entry.kind !== "book" && entry.kind !== "quote")) &&
            `${entry.title ?? ""}\n${entry.body}\n${entry.tags.join(" ")}\n${entry.author ?? ""}`
              .toLowerCase()
              .includes(search),
        )
        .sort((a, b) => a.id.localeCompare(b.id));
      const page = matching.slice(0, options.limit);
      return ok(
        structuredClone({
          entries: page,
          ...(matching.length > page.length ? { nextCursor: page.at(-1)!.id } : {}),
        }),
      );
    }
    const name = segments[1];
    if (
      method !== "POST" ||
      segments[0] !== "commands" ||
      segments.length !== 2 ||
      !["palace.save", "palace.archive", "palace.restore"].includes(name ?? "")
    )
      return undefined;
    const parsed = (
      name === "palace.save" ? SavePalaceCommandSchema : ArchivePalaceCommandSchema
    ).safeParse(body);
    if (!parsed.success) return refused(400, "invalid_request", "Check the entry fields");
    const command = parsed.data;
    const current = entries.find((entry) => entry.id === command.entryId);
    if (
      (current !== undefined && !visible(current)) ||
      ("contents" in command && command.contents.sensitive && !vaultIsUnlocked())
    )
      return refused(404, "not_found", "Entry not found");
    const key = `${name}:${command.idempotencyKey}`;
    const request = JSON.stringify(command);
    const replay = replays.get(key);
    if (replay !== undefined)
      return replay.request === request
        ? structuredClone(replay.response)
        : refused(409, "idempotency_key_reused", "That key belongs to another request");
    if (current?.contentHash !== command.expectedHash)
      return refused(409, "conflict", "The entry changed since it was read");
    if (current === undefined && name !== "palace.save")
      return refused(404, "not_found", "Entry not found");
    const updatedAt = new Date().toISOString();
    const entry = PalaceEntrySchema.parse({
      ...("contents" in command
        ? command.contents
        : { ...current, archived: name === "palace.archive" }),
      id: command.entryId,
      createdAt: current?.createdAt ?? updatedAt,
      updatedAt,
      contentHash: (version++).toString(16).padStart(64, "0"),
    });
    const index = entries.findIndex((value) => value.id === entry.id);
    if (index === -1) entries.push(entry);
    else entries[index] = entry;
    const response = ok({
      entryId: entry.id,
      contentHash: entry.contentHash,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      indexStatus: "current",
    });
    replays.set(key, { request, response: structuredClone(response) });
    return response;
  },
};

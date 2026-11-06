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

const id = (number: number) => `01a05c32-8000-7000-8000-${String(number).padStart(12, "0")}`;
const at = new Date().toISOString();
const base = {
  createdAt: at,
  updatedAt: at,
  tags: [],
  sensitive: false,
  archived: false,
  connections: [],
  contentHash: "0".repeat(64),
};
const thoughts = [
  ["A useful pause", "A pause gives an unfinished idea somewhere to settle.", "attention"],
  [
    "The second sketch",
    "The second sketch remembers what the first one was trying to ask.",
    "making",
  ],
  [
    "Edges of a map",
    "A map becomes interesting at the places where its lines stop.",
    "perspective",
  ],
  ["Small revisions", "Moving one sentence can change the rhythm of the whole page.", "writing"],
  ["Room for questions", "An unanswered question can still be a useful companion.", "curiosity"],
  [
    "Windows at dusk",
    "A window carries two pictures at dusk: the view and a faint reflection.",
    "light",
  ],
  [
    "A slower route",
    "Taking a slower route makes small landmarks easier to remember.",
    "attention",
  ],
  ["Margins", "The margin is part of the page. Empty space gives the words their pace.", "writing"],
  [
    "A shelf of beginnings",
    "Keep a shelf for beginnings that have not found their ending yet.",
    "making",
  ],
  [
    "Patterns in rain",
    "The pattern in rain is easiest to see when the surface underneath stays still.",
    "patterns",
  ],
  [
    "Changing the frame",
    "The same drawing feels different when the frame leaves more sky around it.",
    "perspective",
  ],
  [
    "Returning to a page",
    "A familiar page can hold a new question each time it is opened.",
    "reading",
  ],
];
const books = [
  ["The Mapmaker's Window", "Rowan Vale", "reading"],
  ["Notes on Small Gardens", "Ellis Brook", "planned"],
  ["The Shape of a Sentence", "Avery Reed", "paused"],
  ["A Cabinet of Light", "Morgan Field", "finished"],
  ["Walking the Long Way", "Robin Marsh", "planned"],
];
const entries: PalaceEntry[] = [
  ...thoughts.map(([title, body, tag], index) =>
    PalaceEntrySchema.parse({
      ...base,
      id: id(index + 1),
      kind: "thought",
      title,
      body,
      tags: [tag],
      ...(index === 11 ? { bookId: id(101) } : {}),
      connections:
        index === 1
          ? [
              {
                relationship: "related",
                targetId: id(9),
                reason: "Two ways of keeping unfinished work",
              },
            ]
          : [],
    }),
  ),
  ...books.map(([title, author, readingStatus], index) =>
    PalaceEntrySchema.parse({
      ...base,
      id: id(index + 101),
      kind: "book",
      title,
      author,
      readingStatus,
      readingLane: index > 2 ? "Alongside" : "Main",
      edition: "Demo edition",
      body: "An invented book for exploring the library.",
    }),
  ),
  ...[
    ["Every map begins with a choice about what to leave visible.", 101, "Chapter 2"],
    ["A garden keeps time in leaves.", 102, "Page 14"],
    ["The blank space gives a sentence its next breath.", 103, "Page 38"],
  ].map(([body, book, location], index) =>
    PalaceEntrySchema.parse({
      ...base,
      id: id(index + 201),
      kind: "quote",
      body,
      bookId: id(Number(book)),
      location,
    }),
  ),
  ...[
    ["Paper observatory", "A folded paper room with a skylight that changes the drawing inside."],
    [
      "Tide marks",
      "Layer translucent sheets so their overlapping edges resemble a changing shoreline.",
    ],
    ["Moving shadows", "A mobile whose shadows make a second composition on the wall."],
  ].map(([title, body], index) =>
    PalaceEntrySchema.parse({
      ...base,
      id: id(index + 301),
      kind: "art",
      title,
      body,
      connections: [
        {
          relationship: "inspired_by",
          targetId: id(index + 3),
          reason: "A visual response to the thought",
        },
      ],
    }),
  ),
];
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
      ...(current ?? base),
      ...("contents" in command ? command.contents : { archived: name === "palace.archive" }),
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

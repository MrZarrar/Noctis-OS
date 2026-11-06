import { PalaceEntrySchema, UuidSchema } from "@noctis/contracts";
import type { PalaceConnection, PalaceEntry } from "@noctis/contracts";
import { isSensitiveNote, parseNote } from "../vault/markdown.js";

const META = "noctis:palace";
const LINKS = "noctis:palace:connections";
interface Span {
  start: number;
  end: number;
}
interface Block extends Span {
  text: string;
}
export interface ParsedPalaceEntry {
  raw: string;
  entry: PalaceEntry;
  metadata: Block;
  links: Block;
  frontmatter?: Block;
  prose: Span[];
}
export class PalaceFormatError extends Error {}

export function escapePalaceText(text: string): string {
  return text.replace(/<!--\s*\/?noctis:palace\b[^>]*-->/g, (value) => value.replace("<", "&lt;"));
}

function block(raw: string, name: string): Block {
  const start = `<!-- ${name} -->`;
  const end = `<!-- /${name} -->`;
  const at = raw.indexOf(start);
  const close = raw.indexOf(end);
  if (
    at < 0 ||
    close < at + start.length ||
    raw.indexOf(start, at + 1) !== -1 ||
    raw.indexOf(end, close + 1) !== -1
  )
    throw new PalaceFormatError(`Malformed or duplicated ${name} block`);
  const after = close + end.length;
  return {
    start: at,
    end: after + (raw.startsWith("\r\n", after) ? 2 : raw[after] === "\n" ? 1 : 0),
    text: raw.slice(at + start.length, close),
  };
}

const labelFor = {
  related: "Related",
  inspired_by: "Inspired by",
  responds_to: "Responds to",
} as const;
const relationFor = {
  Related: "related",
  "Inspired by": "inspired_by",
  "Responds to": "responds_to",
} as const;
function decode(value: string): string {
  return value.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}
function encode(value: string): string {
  return value.replace(/[&\r\n[\]|<>]/g, (char) => `&#${String(char.codePointAt(0))};`);
}

export function parsePalaceEntry(raw: string, id: string, contentHash: string): ParsedPalaceEntry {
  const delimiters = raw.match(/<!--\s*\/?noctis:palace\b[^>]*-->/g) ?? [];
  if (
    delimiters.some(
      (value) =>
        ![
          `<!-- ${META} -->`,
          `<!-- /${META} -->`,
          `<!-- ${LINKS} -->`,
          `<!-- /${LINKS} -->`,
        ].includes(value),
    )
  )
    throw new PalaceFormatError("Malformed palace delimiter");
  const metadata = block(raw, META);
  const links = block(raw, LINKS);
  const bom = raw.startsWith("\uFEFF") ? 1 : 0;
  const note = parseNote(raw.slice(bom));
  const frontmatter =
    note.frontmatter === undefined
      ? undefined
      : {
          start: 0,
          end: note.frontmatter.span.end + bom,
          text: raw.slice(0, note.frontmatter.span.end + bom),
        };
  const occupied = [metadata, links, ...(frontmatter === undefined ? [] : [frontmatter])].sort(
    (a, b) => a.start - b.start,
  );
  if (occupied.some((span, index) => index > 0 && span.start < occupied[index - 1]!.end))
    throw new PalaceFormatError("Overlapping palace sections");
  let fields: Record<string, unknown>;
  try {
    fields = JSON.parse(metadata.text) as Record<string, unknown>;
    if (
      fields === null ||
      Array.isArray(fields) ||
      typeof fields !== "object" ||
      fields.version !== 1
    )
      throw new Error();
  } catch {
    throw new PalaceFormatError("Invalid palace metadata");
  }
  const structured = { ...fields };
  delete structured.version;
  const allowed = [
    "kind",
    "createdAt",
    "updatedAt",
    "tags",
    "archived",
    "location",
    "author",
    "edition",
    "readingStatus",
    "readingLane",
  ];
  if (Object.keys(structured).some((key) => !allowed.includes(key)))
    throw new PalaceFormatError("Unknown palace metadata fields");
  const connections: PalaceConnection[] = [];
  let bookId: string | undefined;
  for (const line of links.text.split(/\r?\n/)) {
    if (line === "" || line === "## Connections") continue;
    const matched =
      /^(Related|Inspired by|Responds to|Book) \[\[([^|\]]+)\|([^\]]*)\]\](?:: (.*))?$/.exec(line);
    if (matched === null || !UuidSchema.safeParse(matched[2]).success)
      throw new PalaceFormatError("A connection needs repair");
    const targetId = matched[2]!;
    if (matched[1] === "Book") {
      if (bookId !== undefined || matched[4] !== undefined)
        throw new PalaceFormatError("Invalid book membership");
      bookId = targetId;
    } else {
      const relationship = relationFor[matched[1] as keyof typeof relationFor];
      connections.push({
        relationship,
        targetId,
        ...(matched[4] === undefined ? {} : { reason: decode(matched[4]) }),
      });
    }
  }
  const prose: Span[] = [];
  let offset = 0;
  for (const span of occupied) {
    if (span.start > offset) prose.push({ start: offset, end: span.start });
    offset = span.end;
  }
  if (offset < raw.length) prose.push({ start: offset, end: raw.length });
  const body = prose.map((span) => raw.slice(span.start, span.end)).join("");
  let title: string | undefined;
  const titleLines =
    note.frontmatter?.raw.split(/\r?\n/).filter((line) => /^title\s*:/.test(line)) ?? [];
  if (titleLines.length > 1) throw new PalaceFormatError("Duplicated title");
  const titleValue = titleLines[0]?.replace(/^title\s*:\s*/, "");
  if (titleValue?.startsWith('"')) {
    try {
      title = JSON.parse(titleValue) as string;
    } catch {
      throw new PalaceFormatError("Invalid title");
    }
  } else {
    title = note.frontmatter?.title;
  }
  const entry = PalaceEntrySchema.parse({
    ...structured,
    id,
    ...(title === undefined ? {} : { title }),
    body,
    sensitive: isSensitiveNote(note),
    connections,
    ...(bookId === undefined ? {} : { bookId }),
    contentHash,
  });
  return {
    raw,
    entry,
    metadata,
    links,
    ...(frontmatter === undefined ? {} : { frontmatter }),
    prose,
  };
}

function metadataFor(entry: PalaceEntry): string {
  const fields = {
    kind: entry.kind,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    tags: entry.tags,
    archived: entry.archived,
    location: entry.location,
    author: entry.author,
    edition: entry.edition,
    readingStatus: entry.readingStatus,
    readingLane: entry.readingLane,
  };
  return `<!-- ${META} -->\n${JSON.stringify({ version: 1, ...fields }).replaceAll("<", "\\u003c")}\n<!-- /${META} -->\n`;
}
function linksFor(entry: PalaceEntry, previous?: ParsedPalaceEntry): string {
  const labels = new Map<string, string>();
  for (const match of previous?.links.text.matchAll(/\[\[([^|\]]+)\|([^\]]*)\]\]/g) ?? [])
    labels.set(match[1]!, match[2]!);
  const link = (id: string) => `[[${id}|${labels.get(id) ?? `Entry ${id.slice(-6)}`}]]`;
  const lines = [
    ...(entry.bookId === undefined ? [] : [`Book ${link(entry.bookId)}`]),
    ...entry.connections.map(
      (connection) =>
        `${labelFor[connection.relationship]} ${link(connection.targetId)}${connection.reason === undefined ? "" : `: ${encode(connection.reason)}`}`,
    ),
  ];
  return `<!-- ${LINKS} -->\n## Connections\n${lines.length === 0 ? "" : lines.join("\n") + "\n"}<!-- /${LINKS} -->\n`;
}
function frontmatterFor(entry: PalaceEntry, previous?: ParsedPalaceEntry): string {
  const newline = previous?.frontmatter?.text.includes("\r\n") ? "\r\n" : "\n";
  const lines = previous?.frontmatter?.text.split(/\r?\n/).slice(1, -2) ?? [];
  const other = lines.filter((line) => !/^(title|sensitive)\s*:/.test(line));
  const bom = previous?.frontmatter?.text.startsWith("\uFEFF") ? "\uFEFF" : "";
  return (
    bom +
    [
      "---",
      ...(entry.title === undefined
        ? []
        : [`title: ${JSON.stringify(entry.title).replaceAll("<", "\\u003c")}`]),
      `sensitive: ${String(entry.sensitive)}`,
      ...other,
      "---",
      "",
    ].join(newline)
  );
}

export function serializePalaceEntry(value: PalaceEntry, previous?: ParsedPalaceEntry): string {
  const entry = PalaceEntrySchema.parse(value);
  if (previous === undefined) {
    const raw =
      frontmatterFor(entry) + metadataFor(entry) + linksFor(entry) + escapePalaceText(entry.body);
    parsePalaceEntry(raw, entry.id, entry.contentHash);
    return raw;
  }
  if (entry.id !== previous.entry.id)
    throw new PalaceFormatError("An entry cannot change identity");
  const edits: Array<Span & { text: string }> = [];
  if (metadataFor(entry) !== metadataFor(previous.entry))
    edits.push({ ...previous.metadata, text: metadataFor(entry) });
  if (
    JSON.stringify(entry.connections) !== JSON.stringify(previous.entry.connections) ||
    entry.bookId !== previous.entry.bookId
  )
    edits.push({ ...previous.links, text: linksFor(entry, previous) });
  if (entry.title !== previous.entry.title || entry.sensitive !== previous.entry.sensitive)
    edits.push({
      start: 0,
      end: previous.frontmatter?.end ?? 0,
      text: frontmatterFor(entry, previous),
    });
  if (entry.body !== previous.entry.body) {
    if (previous.prose.length > 1)
      throw new PalaceFormatError(
        "Prose surrounds owned sections; repair the layout before editing",
      );
    edits.push({
      ...(previous.prose[0] ?? { start: previous.raw.length, end: previous.raw.length }),
      text: escapePalaceText(entry.body),
    });
  }
  let raw = previous.raw;
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end))
    raw = raw.slice(0, edit.start) + edit.text + raw.slice(edit.end);
  parsePalaceEntry(raw, entry.id, entry.contentHash);
  return raw;
}

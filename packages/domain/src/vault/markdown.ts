/**
 * Markdown reading for the Vault index.
 *
 * Ported from `Jarvis-Sub-Agent-Dashboard` at commit `ee7b4527`,
 * `server/lib/vault.js` (`parseWikilinks`, `normalizeKey`). MIT licence,
 * Copyright (c) 2026 - Now, Son Nguyen. See `docs/architecture/DONOR-PORT-LEDGER.md`.
 *
 * Every function here reads. None of them returns modified prose, and there is
 * no serializer in this module at all — Section 7 makes Markdown the memory
 * authority, so the index is derived from the file and can never rewrite it.
 */

export interface VaultSpan {
  start: number;
  end: number;
}

export interface Wikilink {
  /** Normalized link target, the key an entity is found by. */
  key: string;
  /** The target exactly as written, before normalization. */
  target: string;
  alias?: string;
  heading?: string;
  /** Offsets into the raw note text, including the brackets. */
  span: VaultSpan;
}

export interface Frontmatter {
  /** The block verbatim, without its `---` fences. Never re-serialized. */
  raw: string;
  span: VaultSpan;
  title?: string;
  aliases: string[];
}

export interface ParsedNote {
  raw: string;
  frontmatter?: Frontmatter;
  body: string;
  /** Where `body` starts in `raw`, so a body offset can be turned into a note offset. */
  bodyOffset: number;
  wikilinks: Wikilink[];
  /** The first ATX heading, when the note has one. */
  heading?: string;
}

/**
 * Donor behaviour, preserved exactly: fold case, drop a trailing `.md`, and
 * collapse whitespace and underscores to hyphens, so `[[Jarvis Project]]`
 * resolves to a `jarvis-project.md` filename as well as a "Jarvis Project" title.
 */
export function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[\s_]+/g, "-");
}

/** Donor grammar: `[[Target]]`, `[[Target|alias]]`, `[[Target#heading]]`, `![[embed]]`. */
const WIKILINK = /!?\[\[([^\][|#]*)(?:#([^\][|]*))?(?:\|([^\][]*))?\]\]/g;

/** Fenced blocks, so a link shown as an example is not indexed as a real one. */
const FENCE = /^[ \t]*(?:```|~~~)/;

function fencedRanges(text: string): VaultSpan[] {
  const ranges: VaultSpan[] = [];
  let offset = 0;
  let openedAt: number | undefined;

  for (const line of text.split("\n")) {
    if (FENCE.test(line)) {
      if (openedAt === undefined) {
        openedAt = offset;
      } else {
        ranges.push({ start: openedAt, end: offset + line.length });
        openedAt = undefined;
      }
    }

    offset += line.length + 1;
  }

  // An unclosed fence swallows the rest of the note, which is what a Markdown
  // renderer does with it too.
  if (openedAt !== undefined) {
    ranges.push({ start: openedAt, end: text.length });
  }

  return ranges;
}

/**
 * Every wikilink occurrence, in document order.
 *
 * The donor returned a de-duplicated set of keys because it only needed to
 * write one edge row per target. Provenance needs more: a note that cites the
 * same target twice has two pieces of evidence, and each one has its own span.
 */
export function parseWikilinks(text: string, offset = 0): Wikilink[] {
  const fenced = fencedRanges(text);
  const links: Wikilink[] = [];

  WIKILINK.lastIndex = 0;

  for (let match = WIKILINK.exec(text); match !== null; match = WIKILINK.exec(text)) {
    const start = match.index;

    if (fenced.some((range) => start >= range.start && start < range.end)) {
      continue;
    }

    const target = match[1] ?? "";
    const key = normalizeKey(target);

    if (key === "") {
      continue;
    }

    const heading = match[2]?.trim();
    const alias = match[3]?.trim();

    links.push({
      key,
      target: target.trim(),
      ...(alias === undefined || alias === "" ? {} : { alias }),
      ...(heading === undefined || heading === "" ? {} : { heading }),
      span: { start: offset + start, end: offset + start + match[0].length },
    });
  }

  return links;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const INLINE_LIST = /^\[(.*)\]$/;

/**
 * Reads the handful of frontmatter fields link resolution needs.
 *
 * ponytail: a deliberate subset of YAML — `key: value`, `key: [a, b]`, and
 * block lists of scalars. Only `title` and `aliases` are consumed, and both are
 * that shape in every Obsidian vault. Reach for a YAML parser when a field with
 * real structure is actually needed; the raw block is preserved verbatim either
 * way, so nothing is lost by not understanding it.
 */
function readFrontmatterFields(raw: string): { title?: string; aliases: string[] } {
  const aliases: string[] = [];
  let title: string | undefined;
  let collecting = false;

  for (const line of raw.split(/\r?\n/)) {
    const listItem = /^\s*-\s+(.*)$/.exec(line);

    if (collecting && listItem?.[1] !== undefined) {
      aliases.push(unquote(listItem[1]));
      continue;
    }

    collecting = false;

    const field = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);

    if (field === null) {
      continue;
    }

    const [, name = "", value = ""] = field;

    if (name === "title") {
      title = unquote(value);
    }

    if (name === "aliases") {
      const inline = INLINE_LIST.exec(value.trim());

      if (inline?.[1] !== undefined) {
        aliases.push(
          ...inline[1]
            .split(",")
            .map((entry) => unquote(entry))
            .filter((entry) => entry !== ""),
        );
      } else if (value.trim() === "") {
        collecting = true;
      } else {
        aliases.push(unquote(value));
      }
    }
  }

  return { ...(title === undefined || title === "" ? {} : { title }), aliases };
}

function unquote(value: string): string {
  return value
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
}

export function parseNote(raw: string): ParsedNote {
  // Anchored at index 0: a `---` rule further down a note is a horizontal rule,
  // not a second frontmatter block.
  const matched = FRONTMATTER.exec(raw);
  const bodyOffset = matched === null ? 0 : matched[0].length;
  const body = raw.slice(bodyOffset);
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();

  const frontmatter =
    matched === null
      ? undefined
      : {
          raw: matched[1] ?? "",
          span: { start: 0, end: matched[0].length },
          ...readFrontmatterFields(matched[1] ?? ""),
        };

  return {
    raw,
    ...(frontmatter === undefined ? {} : { frontmatter }),
    body,
    bodyOffset,
    // Spans are offsets into the whole note, not into the body, so a caller
    // holding the file can quote provenance without re-deriving where it began.
    wikilinks: parseWikilinks(body, bodyOffset),
    ...(heading === undefined ? {} : { heading }),
  };
}

/** Frontmatter title, then the first heading, then the filename. */
export function titleFor(path: string, note: ParsedNote): string {
  const filename = (path.split("/").pop() ?? path).replace(/\.md$/i, "");

  return note.frontmatter?.title ?? note.heading ?? filename;
}

/** Every key a note answers to as a link target: its title, filename, and aliases. */
export function keysFor(path: string, note: ParsedNote): string[] {
  const filename = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
  const keys = new Set<string>([normalizeKey(titleFor(path, note)), normalizeKey(filename)]);

  for (const alias of note.frontmatter?.aliases ?? []) {
    const key = normalizeKey(alias);

    if (key !== "") {
      keys.add(key);
    }
  }

  keys.delete("");

  return [...keys];
}

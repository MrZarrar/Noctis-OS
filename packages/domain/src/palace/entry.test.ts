import { describe, expect, it } from "vitest";
import type { PalaceEntry } from "@noctis/contracts";
import { parsePalaceEntry, serializePalaceEntry } from "./entry.js";
import { isSensitiveNote, keysFor, parseNote } from "../vault/markdown.js";

const id = "01a05c32-8000-7000-8000-000000000001";
const bookId = "01a05c32-8000-7000-8000-000000000002";
const entry: PalaceEntry = {
  id,
  kind: "thought",
  body: "雪 🌿\r\n\r\nAgain.\r\n\r\nAgain.\r\n",
  createdAt: "2026-11-06T12:00:00.000Z",
  updatedAt: "2026-11-06T12:00:00.000Z",
  tags: [],
  sensitive: false,
  archived: false,
  connections: [],
  contentHash: "0".repeat(64),
};

describe("palace Markdown", () => {
  it("keeps prose, repetitions, unknown frontmatter and surrounding text byte for byte", () => {
    const raw =
      serializePalaceEntry(entry).replace(
        "sensitive: false",
        "sensitive: false\ncustom: untouched",
      ) + "\nUnknown footer.\n";
    const parsed = parsePalaceEntry(raw, id, entry.contentHash);
    expect(parsed.entry.body).toBe(entry.body + "\nUnknown footer.\n");
    expect(serializePalaceEntry(parsed.entry, parsed)).toBe(raw);
    const changed = serializePalaceEntry({ ...parsed.entry, archived: true, title: "雪" }, parsed);
    expect(changed).toContain("custom: untouched");
    expect(parsePalaceEntry(changed, id, entry.contentHash).entry.body).toBe(parsed.entry.body);
    expect(
      serializePalaceEntry({ ...parsed.entry, body: parsed.entry.body + "More." }, parsed),
    ).toContain(parsed.entry.body + "More.");
    expect(keysFor(`palace/entries/${id}.md`, parseNote(raw))).toEqual([id]);
    expect(keysFor(`palace/entries/${bookId}.md`, parseNote(raw))).toEqual([bookId]);
    const bom = parsePalaceEntry(
      "\uFEFF" + raw.replace("sensitive: false", "sensitive: true"),
      id,
      entry.contentHash,
    );
    expect(bom.entry.sensitive).toBe(true);
    expect(
      isSensitiveNote(parseNote("\uFEFF" + raw.replace("sensitive: false", "sensitive: true"))),
    ).toBe(true);
    expect(serializePalaceEntry({ ...bom.entry, title: "Changed" }, bom).startsWith("\uFEFF")).toBe(
      true,
    );
  });

  it("refuses damaged or duplicated owned blocks and ambiguous prose edits", () => {
    const raw = serializePalaceEntry(entry);
    for (const damaged of [
      raw + raw,
      raw.replace('"version":1', '"version":9'),
      raw.replace("<!-- /noctis:palace -->", ""),
      raw.replace('"kind":"thought"', '"kind":'),
    ])
      expect(() => parsePalaceEntry(damaged, id, entry.contentHash)).toThrow();
    const surrounded = "Before\n" + raw.slice(raw.indexOf("<!-- noctis:palace -->"));
    const parsed = parsePalaceEntry(surrounded, id, entry.contentHash);
    expect(serializePalaceEntry(parsed.entry, parsed)).toBe(surrounded);
    expect(() => serializePalaceEntry({ ...parsed.entry, body: "replacement" }, parsed)).toThrow();
  });

  it("reads typed links only in the owned section and escapes delimiter impersonation", () => {
    const linked = {
      ...entry,
      kind: "quote" as const,
      bookId,
      connections: [
        {
          relationship: "responds_to" as const,
          targetId: bookId,
          reason: "A response\nwith | brackets ]]",
        },
      ],
    };
    const raw = serializePalaceEntry(linked);
    const parsed = parsePalaceEntry(raw, id, entry.contentHash);
    expect(parsed.entry.bookId).toBe(bookId);
    expect(parsed.entry.connections).toEqual(linked.connections);
    expect(
      raw.slice(raw.indexOf("<!-- noctis:palace -->"), raw.indexOf("<!-- /noctis:palace -->")),
    ).not.toContain("targetId");
    const prose = {
      ...entry,
      title: "<!-- noctis:palace -->",
      tags: ["<!-- noctis:palace -->"],
      body: `Related [[${bookId}|Body link]]\n<!-- noctis:palace -->\n{}`,
    };
    const escaped = parsePalaceEntry(serializePalaceEntry(prose), id, entry.contentHash);
    expect(escaped.entry.connections).toEqual([]);
    expect(escaped.entry.body).toContain("&lt;!-- noctis:palace -->");
  });
});

import type { PalaceEntry, PalaceList, PalaceListQuery } from "@noctis/contracts";

export function pagePalaceEntries(entries: PalaceEntry[], options: PalaceListQuery): PalaceList {
  const query = options.query?.toLocaleLowerCase() ?? "";
  const visible = entries
    .filter(
      (entry) =>
        (options.archived === "all" || entry.archived === (options.archived === "true")) &&
        (options.kind === undefined || entry.kind === options.kind) &&
        (options.bookId === undefined || entry.bookId === options.bookId) &&
        (options.room === undefined ||
          (options.room === "library"
            ? entry.kind === "book" || entry.bookId !== undefined
            : entry.kind !== "book" && entry.kind !== "quote")) &&
        (options.cursor === undefined || entry.id > options.cursor) &&
        `${entry.title ?? ""}\n${entry.body}\n${entry.tags.join(" ")}\n${entry.author ?? ""}`
          .toLocaleLowerCase()
          .includes(query),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const page = visible.slice(0, options.limit);
  return {
    entries: page,
    ...(visible.length > page.length ? { nextCursor: page.at(-1)!.id } : {}),
  };
}

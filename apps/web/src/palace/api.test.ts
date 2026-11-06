import { afterEach, describe, expect, it, vi } from "vitest";

import { DemoTransport } from "../larp/DemoTransport.js";
import { palaceArea } from "../larp/palace.js";
import { vaultArea } from "../larp/vault.js";
import { createPalaceApi, palaceDraftScope } from "./api.js";

function mode(on: boolean): void {
  vi.stubGlobal("localStorage", { getItem: () => (on ? "1" : null) });
  vi.stubGlobal("window", { location: { origin: "https://noctis.test" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("Palace storage mode", () => {
  it("reads normal mode through the real core transport", async () => {
    mode(false);
    const request = vi.fn().mockResolvedValue({ status: 200, body: { entries: [] } });
    const api = createPalaceApi({ request, subscribe: vi.fn() });
    expect(api.fixture).toBe(false);
    expect(await api.list()).toEqual({ entries: [] });
    expect(request).toHaveBeenCalledWith(
      "GET",
      expect.stringMatching(/^\/palace\/entries\?/),
      undefined,
    );
  });

  it("uses the existing LARP transport and supplies a varied, linked sample collection", async () => {
    mode(true);
    const transport = new DemoTransport({ areas: [palaceArea, vaultArea], latencyMs: 0 });
    const request = vi.spyOn(transport, "request");
    const api = createPalaceApi(transport);
    expect(api.fixture).toBe(true);
    const page = await api.list({ limit: 200 });
    expect(request).toHaveBeenCalled();
    for (const [kind, minimum] of [
      ["book", 20],
      ["quote", 30],
      ["art", 24],
      ["thought", 15],
    ] as const)
      expect(page.entries.filter((entry) => entry.kind === kind).length).toBeGreaterThanOrEqual(
        minimum,
      );
    const ids = new Set(page.entries.map((entry) => entry.id));
    expect(ids.size).toBe(page.entries.length);
    for (const entry of page.entries) {
      expect(entry.sensitive).toBe(false);
      if (entry.bookId !== undefined) expect(ids.has(entry.bookId)).toBe(true);
      for (const link of entry.connections)
        if (link.targetId !== undefined) expect(ids.has(link.targetId)).toBe(true);
    }
    const first = await api.list({ limit: 100 });
    expect(first.nextCursor).toBeDefined();
    const next = await api.list({ limit: 100, cursor: first.nextCursor! });
    expect(new Set([...first.entries, ...next.entries].map((entry) => entry.id)).size).toBe(
      page.entries.length,
    );
  });

  it("separates recovery drafts between real and LARP mode", () => {
    mode(false);
    expect(palaceDraftScope().fixture).toBe(false);
    mode(true);
    expect(palaceDraftScope().fixture).toBe(true);
  });

  it("creates an empty book notebook in LARP and refuses a stale replacement", async () => {
    mode(true);
    const api = createPalaceApi(new DemoTransport({ areas: [palaceArea], latencyMs: 0 }));
    const command = {
      entryId: "01a05c32-8000-7000-8000-000000009999",
      idempotencyKey: "empty-book-notebook",
      contents: {
        kind: "book" as const,
        title: "A sample notebook",
        body: "",
        tags: [],
        sensitive: false,
        archived: false,
        connections: [],
        readingLane: "Alongside",
      },
    };
    const receipt = await api.save(command);
    expect(await api.save(command)).toEqual(receipt);
    const book = await api.read(command.entryId);
    expect(book.body).toBe("");
    expect(book.readingStatus).toBeUndefined();
    expect(book.readingLane).toBe("Alongside");
    await expect(api.save({ ...command, idempotencyKey: "stale-create" })).rejects.toMatchObject({
      status: 409,
    });
    expect((await api.read(command.entryId)).contentHash).toBe(receipt.contentHash);
    const updated = await api.save({
      ...command,
      idempotencyKey: "start-reading",
      expectedHash: receipt.contentHash,
      contents: { ...command.contents, readingStatus: "reading" },
    });
    const { readingLane, ...cleared } = command.contents;
    expect(readingLane).toBe("Alongside");
    await api.save({
      ...command,
      idempotencyKey: "clear-reading",
      expectedHash: updated.contentHash,
      contents: cleared,
    });
    const reopened = await api.read(command.entryId);
    expect(reopened.readingStatus).toBeUndefined();
    expect(reopened.readingLane).toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";
import { releaseUnusedFileImages, type FileImageCache } from "./FileMedia.js";

describe("file image ownership", () => {
  it("keeps a panel's option screenshots until their owner leaves", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    try {
      const cache: FileImageCache = new Map([
        ["media", { key: "media", url: "blob:media" }],
        ["card", { key: "card", url: "blob:card", ownerId: "options" }],
      ]);
      releaseUnusedFileImages(cache, new Set(["options"]));
      expect([...cache.keys()]).toEqual(["card"]);
      expect(revoke).toHaveBeenCalledWith("blob:media");
      releaseUnusedFileImages(cache, new Set());
      expect(cache.size).toBe(0);
      expect(revoke).toHaveBeenCalledWith("blob:card");
    } finally {
      revoke.mockRestore();
    }
  });
});

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AttachmentRef } from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import { AdapterRefused } from "./Runtime.js";
import { promptWithAttachments, stageAttachments } from "./attachments.js";

function ref(filename: string, bytes: Uint8Array): AttachmentRef {
  return {
    id: "0199a000-0000-7000-8000-00000000000a",
    filename,
    mediaType: "image/png",
    checksum: createHash("sha256").update(bytes).digest("hex"),
  };
}

const BYTES = new Uint8Array([1, 2, 3, 4]);
/** Mirrors the mkdtemp prefix in attachments.ts, so the cleanup check can count directories. */
const PREFIX = "noctis-attachments-";

describe("stageAttachments", () => {
  it("writes each file into a fresh directory and takes it away again", async () => {
    const staged = await stageAttachments([ref("shot.png", BYTES)], () => Promise.resolve(BYTES));

    expect(staged.files).toHaveLength(1);
    expect(staged.files[0]?.path).toBe(join(staged.directory, "shot.png"));
    expect(readFileSync(staged.files[0]?.path ?? "")).toEqual(Buffer.from(BYTES));

    await staged.discard();

    expect(existsSync(staged.directory)).toBe(false);
  });

  it("refuses bytes that do not match the checksum the core recorded", async () => {
    // A truncated image a model then describes confidently is worse than a turn
    // that never starts, which is why this is a refusal rather than a warning.
    await expect(
      stageAttachments([ref("shot.png", BYTES)], () => Promise.resolve(new Uint8Array([9, 9]))),
    ).rejects.toBeInstanceOf(AdapterRefused);
  });

  it("refuses a filename that would write outside the staging directory", async () => {
    // Re-checked here even though the core's schema already refused it: this is
    // where a name becomes a path, and a guard only at the far end of a network
    // hop holds until someone adds a second producer.
    const escaping = { ...ref("shot.png", BYTES), filename: "../escape.png" };

    await expect(stageAttachments([escaping], () => Promise.resolve(BYTES))).rejects.toBeInstanceOf(
      AdapterRefused,
    );
  });

  it("leaves no directory behind when one file of several fails", async () => {
    // A base of its own: counting the shared temp directory raced every other
    // suite staging attachments in parallel, and failed whenever one did.
    const base = mkdtempSync(join(tmpdir(), "noctis-attachments-test-"));

    try {
      // The first file lands, the second does not match its checksum. Without the
      // rollback the turn would fail *and* leave the first file on disk forever.
      await expect(
        stageAttachments(
          [ref("a.png", BYTES), ref("b.png", new Uint8Array([7]))],
          () => Promise.resolve(BYTES),
          base,
        ),
      ).rejects.toBeInstanceOf(AdapterRefused);

      expect(readdirSync(base).filter((name) => name.startsWith(PREFIX))).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("promptWithAttachments", () => {
  it("leaves a prompt with no files exactly as it was", () => {
    expect(promptWithAttachments("what is this", [])).toBe("what is this");
  });

  it("names every staged file by path and type", () => {
    const composed = promptWithAttachments("what is this", [
      { ref: ref("shot.png", BYTES), path: "C:\\tmp\\noctis\\shot.png" },
    ]);

    expect(composed).toContain("what is this");
    expect(composed).toContain("C:\\tmp\\noctis\\shot.png");
    expect(composed).toContain("image/png");
  });
});

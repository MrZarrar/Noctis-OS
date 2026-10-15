import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startHelper } from "./helper.js";
import { createOwnerPresenceReader } from "./owner.js";

describe("owner presence from the helper", () => {
  it("uses its authenticated owner-profile helper and fails closed when it disappears", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "noctis-owner-reader-"));
    const infoPath = join(scratch, "screen-helper.json");
    let report: (present: boolean) => void = () => undefined;
    const helper = await startHelper({
      infoPath,
      watchPresence: (onPresence) => {
        report = onPresence;
        return () => undefined;
      },
    });
    const read = createOwnerPresenceReader({
      infoPath,
      platform: "win32",
      interactive: () => Promise.resolve(false),
    });
    try {
      expect(await read()).toBe(false);
      report(true);
      expect(await read()).toBe(true);
      report(false);
      expect(await read()).toBe(false);
      report(true);
      expect(await createOwnerPresenceReader({ infoPath, platform: "linux" })()).toBe(false);
      await helper.close();
      expect(await read()).toBe(false);
    } finally {
      await helper.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

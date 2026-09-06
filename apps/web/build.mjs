import { cpSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * There is no bundler in Phase 4 and deliberately so: `tsc` emits ES modules the
 * WebView loads directly, which is why nothing here may import a bare specifier.
 * This script only assembles what `tsc` produced.
 */
cpSync("public", "dist", { recursive: true });

/** Test output is not part of what the shell serves. */
for (const directory of ["dist", join("dist", "transport")]) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.includes(".test.")) {
      rmSync(join(directory, entry.name));
    }
  }
}

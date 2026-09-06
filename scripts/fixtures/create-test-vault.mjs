#!/usr/bin/env node
/**
 * Writes the fixture Vault Section 7 calls for, so development and test never
 * have a reason to point at real notes.
 *
 * The content lives in `@noctis/test-kit` rather than here, because the
 * integration tests use the same fixture and a second copy would drift. Run
 * `npm run build` first: this loads the built package.
 *
 * Usage: node scripts/fixtures/create-test-vault.mjs [target directory]
 *        (default: .noctis-test-vault in the repository root)
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createTestVault } from "../../packages/test-kit/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const target = resolve(process.argv[2] ?? resolve(repoRoot, ".noctis-test-vault"));

mkdirSync(target, { recursive: true });

const { paths } = createTestVault(target);

process.stdout.write(`Wrote ${String(paths.length)} notes to ${target}\n`);
process.stdout.write(`  set NOCTIS_VAULT_ROOT=${target}\n`);

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The test Vault (Section 7: "Development and test use
 * `scripts/fixtures/create-test-vault.ts`").
 *
 * Fixed content, no randomness and no clock: two runs produce byte-identical
 * files, which is what lets the "repeated indexing is stable" gate compare
 * hashes rather than counts. It exists so that no test ever has a reason to
 * point at real notes.
 */

export interface TestVaultFile {
  /** Vault-relative, POSIX separators. */
  path: string;
  contents: string;
}

/**
 * A small PARA Vault that exercises every indexing path: each folder type, a
 * frontmatter title and aliases, a link through an alias, a link to a note that
 * does not exist, a repeated link, a link inside a code fence, and a note with
 * no links at all.
 */
export const TEST_VAULT_FILES: readonly TestVaultFile[] = [
  {
    path: "projects/jarvis-project.md",
    contents: `---
title: Jarvis Project
aliases: [Jarvis, jarvis-os]
tags:
  - project
---

# Jarvis Project

Kicked off with [[Alex Kerr]] in early 2026. The client is [[Acme Travel]].

Deployment follows [[Runbook#deploy]]. [[Alex Kerr]] owns the rollout.

An unwritten note: [[Future Retrospective]].
`,
  },
  {
    path: "people/alex-kerr.md",
    contents: `---
title: Alex Kerr
aliases: [Alex]
---

# Alex Kerr

Engineer on [[Jarvis Project]]. Prefers async updates.
`,
  },
  {
    path: "people/sam-oyelaran.md",
    contents: `# Sam Oyelaran

Works with [[Alex]] — a link through an alias, which must still resolve to
the Alex Kerr note.
`,
  },
  {
    path: "reference/acme-travel.md",
    contents: `---
title: Acme Travel
---

# Acme Travel

Travel client. Contract renews annually.
`,
  },
  {
    path: "reference/runbook.md",
    contents: `# Runbook

## deploy

Steps live here. A fenced example must not become an edge:

\`\`\`markdown
[[Not A Real Link]]
\`\`\`
`,
  },
  {
    path: "daily/2026-09-01.md",
    contents: `# 2026-09-01

Reviewed [[Jarvis Project]] with [[Acme Travel]].
`,
  },
  {
    path: "inbox/loose-thought.md",
    contents: `# Loose thought

No links here at all. It should still be indexed and still be findable.
`,
  },
  {
    path: "agent/brain.md",
    contents: `# Agent Brain

- prefers short replies
`,
  },
];

export interface CreateTestVaultResult {
  root: string;
  paths: string[];
}

/** Writes the fixture Vault into `root`, creating folders as needed. */
export function createTestVault(
  root: string,
  files: readonly TestVaultFile[] = TEST_VAULT_FILES,
): CreateTestVaultResult {
  const paths: string[] = [];

  for (const file of files) {
    const absolute = join(root, file.path);

    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.contents, "utf8");
    paths.push(file.path);
  }

  return { root, paths };
}

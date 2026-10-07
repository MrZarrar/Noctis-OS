import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What Codex itself must ask before running, however much its sandbox would
 * allow: recursive deletes, pushing or rewriting history, publishing a package.
 * Codex raises these as approval requests, which the runtime forwards to the
 * owner like any other ask Codex makes.
 *
 * They live in the owner's Codex home because that is the only place Codex
 * reads user rules from, so the owner's other Codex sessions prompt for them
 * too. Codex merges every rules file and keeps the strictest result, so this
 * file can only add prompts, never remove one.
 *
 * ponytail: prefix rules match leading tokens only, so `Remove-Item -LiteralPath
 * x -Recurse` and `git commit -m x --amend` slip past. The sandbox still bounds
 * them to the granted roots; a token-anywhere rule would need Codex support.
 */
export const NOCTIS_CODEX_RULES = `# Managed by the Noctis node agent, which puts this file back when it changes.
# Codex asks before any of these; Noctis forwards the question to the owner.

# Recursive deletes.
prefix_rule(
    pattern = ["rm", ["-r", "-R", "-rf", "-Rf", "-rF", "-fr", "-fR", "-RF", "--recursive"]],
    decision = "prompt",
    justification = "a recursive delete",
)
prefix_rule(
    pattern = [["Remove-Item", "ri", "rm", "del", "erase", "rd", "rmdir"], ["-Recurse", "-r"]],
    decision = "prompt",
    justification = "a recursive delete",
)
prefix_rule(
    pattern = [["Remove-Item", "ri", "rm", "del", "erase", "rd", "rmdir"], ["-Force", "-fo"], ["-Recurse", "-r"]],
    decision = "prompt",
    justification = "a recursive delete",
)
prefix_rule(
    pattern = [["rd", "rmdir"], ["/s", "/S"]],
    decision = "prompt",
    justification = "a recursive delete",
)

# Pushing and rewriting history.
prefix_rule(
    pattern = ["git", "push"],
    decision = "prompt",
    justification = "pushes history to a remote",
)
prefix_rule(
    pattern = ["git", ["reset", "rebase", "filter-branch", "filter-repo", "replace"]],
    decision = "prompt",
    justification = "rewrites history",
)
prefix_rule(
    pattern = ["git", "commit", "--amend"],
    decision = "prompt",
    justification = "rewrites history",
)
prefix_rule(
    pattern = ["git", "branch", ["-D", "--delete"]],
    decision = "prompt",
    justification = "deletes a branch",
)

# Publishing a package or a release.
prefix_rule(
    pattern = [["npm", "pnpm", "yarn", "bun", "cargo", "poetry", "uv"], "publish"],
    decision = "prompt",
    justification = "publishes a package",
)
prefix_rule(
    pattern = ["yarn", "npm", "publish"],
    decision = "prompt",
    justification = "publishes a package",
)
prefix_rule(
    pattern = [["twine", "gem"], ["upload", "push"]],
    decision = "prompt",
    justification = "publishes a package",
)
prefix_rule(
    pattern = [["dotnet", "nuget"], ["nuget", "push"]],
    decision = "prompt",
    justification = "publishes a package",
)
prefix_rule(
    pattern = ["gh", "release"],
    decision = "prompt",
    justification = "publishes a release",
)
`;

/** Writes `rules/noctis.rules` under `codexHome` unless it already says exactly this. Returns its path. */
export function installCodexRules(codexHome: string): string {
  const directory = join(codexHome, "rules");
  const path = join(directory, "noctis.rules");
  let current: string | undefined;

  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = undefined;
  }

  if (current !== NOCTIS_CODEX_RULES) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path, NOCTIS_CODEX_RULES);
  }

  return path;
}

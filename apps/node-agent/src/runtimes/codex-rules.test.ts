import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveCodexCommand } from "./codex-command.js";
import { NOCTIS_CODEX_RULES, installCodexRules } from "./codex-rules.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "noctis-codex-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("the Noctis Codex rules", () => {
  it("installs its own rules file and leaves the owner's rules alone", () => {
    mkdirSync(join(home, "rules"));
    writeFileSync(join(home, "rules", "default.rules"), "# the owner's\n");

    const path = installCodexRules(home);

    expect(path).toBe(join(home, "rules", "noctis.rules"));
    expect(readFileSync(path, "utf8")).toBe(NOCTIS_CODEX_RULES);
    expect(readFileSync(join(home, "rules", "default.rules"), "utf8")).toBe("# the owner's\n");
  });

  it("creates the rules folder, and puts the file back when it has been changed", () => {
    const path = installCodexRules(home);

    writeFileSync(path, "# edited\n");
    installCodexRules(home);

    expect(readFileSync(path, "utf8")).toBe(NOCTIS_CODEX_RULES);
  });

  it("does not rewrite a file that is already right", () => {
    const path = installCodexRules(home);
    const before = statSync(path).mtimeMs;

    installCodexRules(home);

    expect(statSync(path).mtimeMs).toBe(before);
  });

  const codex = resolveCodexCommand({ env: process.env });

  /** Codex's own evaluator, on the file as installed. Skipped where Codex is not installed. */
  describe.skipIf(codex === undefined)("as Codex itself reads them", () => {
    function decide(command: string): string | undefined {
      const out = execFileSync(
        codex ?? "",
        ["execpolicy", "check", "--rules", installCodexRules(home), ...command.split(" ")],
        { encoding: "utf8", windowsHide: true },
      );

      return (JSON.parse(out) as { decision?: string }).decision;
    }

    it.each([
      "rm -rf build",
      "rm -r build",
      "rm -fr build",
      "rm --recursive build",
      "Remove-Item -Recurse -Force build",
      "Remove-Item -Force -Recurse build",
      "rd /s /q build",
      "rmdir /s build",
      "git push origin main",
      "git push --force",
      "git reset --hard HEAD~1",
      "git rebase -i main",
      "git commit --amend",
      "git filter-branch --tree-filter x",
      "git filter-repo --path x",
      "git branch -D old",
      "npm publish",
      "pnpm publish",
      "yarn publish",
      "yarn npm publish",
      "cargo publish",
      "twine upload dist/x.whl",
      "poetry publish",
      "gh release create v1",
    ])("prompts before %s", (command) => {
      expect(decide(command)).toBe("prompt");
    });

    it.each([
      "git status",
      "git commit -m tidy",
      "rm notes.txt",
      "Remove-Item notes.txt",
      "npm test",
      "npm run build",
    ])("leaves %s to the sandbox", (command) => {
      expect(decide(command)).toBe(undefined);
    });
  });
});

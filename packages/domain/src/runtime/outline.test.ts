import { describe, expect, it } from "vitest";

import { outlineCommand } from "./outline.js";

describe("outlineCommand", () => {
  it.each([
    ["git status", "Runs git status"],
    ["npm test -- --run", "Runs npm test"],
    ["cd repo && git log --oneline -5", "Runs git log"],
    ["git status; git diff --stat; npm run build", "Runs git status, git diff and npm run"],
    [
      "Get-ChildItem | Sort-Object Name | Format-List",
      "Runs Get-ChildItem, Sort-Object and Format-List",
    ],
    ["ls && ls && ls", "Runs ls"],
    [`"C:\\Program Files\\Git\\bin\\git.exe" status`, "Runs git status"],
    ["FOO=1 node --version", "Runs node"],
    ["", "Runs a command"],
  ])("%s", (command, outline) => {
    expect(outlineCommand(command)).toBe(outline);
  });

  it("reads an inline script as one script, not as commands", () => {
    const command = `cd "C:/x" && git show origin/main:a.json > /tmp/a.json 2>/dev/null || git show origin/main:a.json > a.tmp.json; python -c "
import json; s = json.load(open('a.json'))
for k in s: print(k)
"`;

    expect(outlineCommand(command)).toBe("Runs git show and an inline Python script");
  });

  it("does not read a heredoc body as commands", () => {
    expect(
      outlineCommand("cat > notes.md <<'MD'\nrm everything; then push\nMD\ngit add notes.md"),
    ).toBe("Runs cat and git add");
  });

  it("unwraps the shell a runtime wraps every command in", () => {
    expect(outlineCommand(`powershell.exe -Command "Get-Content -Raw a.md"`)).toBe(
      "Runs Get-Content",
    );
  });

  it("keeps a long chain short", () => {
    expect(outlineCommand("a; b; c; d; e; f")).toBe("Runs a, b, c, d and 2 more");
  });
});

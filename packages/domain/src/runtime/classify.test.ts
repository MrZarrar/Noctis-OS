import type { OperationClass, Reversibility } from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import type { AskInput } from "./classify.js";
import { classifyAsk } from "./classify.js";

const ROOTS = { writableRoots: ["C:\\work\\repo"], readableRoots: ["C:\\docs"] };
const INSIDE = "C:\\work\\repo";
const OUTSIDE = "C:\\other";

function command(cmd: string, cwd = INSIDE): AskInput {
  return { kind: "command", command: cmd, cwd, ...ROOTS };
}

function files(...paths: string[]): AskInput {
  return { kind: "file_change", paths, ...ROOTS };
}

function tool(name: string): AskInput {
  return { kind: "tool_call", tool: name, ...ROOTS };
}

type Row = [
  label: string,
  input: AskInput,
  operationClass: OperationClass,
  reversibility: Reversibility,
  capability: string,
];

const CMD = "runtime.command";
const FILE = "runtime.file_change";
const TOOL = "runtime.tool_call";

// Rows mirror the plan's Step 1 table; the extra rows are the edges each rule has.
const ROWS: Row[] = [
  ["rm -rf", command("rm -rf ./dist"), "destructive", "irreversible", CMD],
  ["rm -r", command("rm -r build"), "destructive", "irreversible", CMD],
  [
    "Remove-Item -Recurse",
    command("Remove-Item .\\node_modules -Recurse -Force"),
    "destructive",
    "irreversible",
    CMD,
  ],
  [
    "Remove-Item -Recurse first",
    command("Remove-Item -Recurse -Force .\\dist"),
    "destructive",
    "irreversible",
    CMD,
  ],
  ["rd /s", command("rd /s /q dist"), "destructive", "irreversible", CMD],
  ["del /s", command("del /s *.tmp"), "destructive", "irreversible", CMD],
  ["git push --force", command("git push --force origin main"), "destructive", "irreversible", CMD],
  ["git push -f", command("git push -f"), "destructive", "irreversible", CMD],
  ["git reset --hard", command("git reset --hard HEAD~1"), "destructive", "irreversible", CMD],
  ["git clean -fd", command("git clean -fd"), "destructive", "irreversible", CMD],
  ["format", command("format D: /q"), "destructive", "irreversible", CMD],
  ["mkfs", command("mkfs.ext4 /dev/sdb1"), "destructive", "irreversible", CMD],
  ["Clear-Content", command("Clear-Content log.txt"), "destructive", "irreversible", CMD],
  [
    "destructive wins over read-only head",
    command("ls && rm -rf /"),
    "destructive",
    "irreversible",
    CMD,
  ],
  [
    "npm run format is not format",
    command("npm run format"),
    "local_reversible_edit",
    "reversible",
    CMD,
  ],

  ["git push", command("git push origin feature"), "external_write", "partially_reversible", CMD],
  ["gh pr create", command("gh pr create --fill"), "external_write", "partially_reversible", CMD],
  [
    "gh release",
    command("gh release create v1.0.0"),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  ["npm publish", command("npm publish"), "external_write", "partially_reversible", CMD],
  [
    "curl -X POST",
    command("curl -X POST https://api.example.com/x"),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  [
    "curl -d",
    command("curl -d '{}' https://api.example.com/x"),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  [
    "Invoke-WebRequest -Method Post",
    command("Invoke-WebRequest https://x -Method Post"),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  [
    "Invoke-RestMethod -Body",
    command("Invoke-RestMethod https://x -Body $b"),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  ["ssh", command("ssh box 'uptime'"), "external_write", "partially_reversible", CMD],
  [
    "aws deploy",
    command("aws deploy create-deployment"),
    "external_write",
    "partially_reversible",
    CMD,
  ],

  ["dir", command("dir"), "read_inspect", "reversible", CMD],
  ["git status", command("git status --short"), "read_inspect", "reversible", CMD],
  ["type", command("type README.md"), "read_inspect", "reversible", CMD],
  [
    "read-only pipeline",
    command("git log --oneline | findstr fix"),
    "read_inspect",
    "reversible",
    CMD,
  ],
  ["read-only head outside any root", command("cat x", OUTSIDE), "read_inspect", "reversible", CMD],
  [
    "redirect is a write",
    command("type a.txt > b.txt"),
    "local_reversible_edit",
    "reversible",
    CMD,
  ],
  ["curl GET", command("curl https://example.com"), "local_reversible_edit", "reversible", CMD],

  ["other command inside root", command("npm test"), "local_reversible_edit", "reversible", CMD],
  [
    "other command outside root",
    command("npm test", OUTSIDE),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  [
    "other command without cwd",
    { kind: "command", command: "npm test", ...ROOTS },
    "external_write",
    "partially_reversible",
    CMD,
  ],

  [
    "write inside root",
    files("C:\\work\\repo\\src\\a.ts"),
    "local_reversible_edit",
    "reversible",
    FILE,
  ],
  [
    "write inside root, posix separators, other case",
    files("c:/Work/Repo/src/a.ts"),
    "local_reversible_edit",
    "reversible",
    FILE,
  ],
  ["write outside root", files("C:\\other\\a.ts"), "external_write", "partially_reversible", FILE],
  [
    "write to a sibling sharing the prefix",
    files("C:\\work\\repo2\\a.ts"),
    "external_write",
    "partially_reversible",
    FILE,
  ],
  [
    "one path outside taints the set",
    files("C:\\work\\repo\\a.ts", "C:\\other\\b.ts"),
    "external_write",
    "partially_reversible",
    FILE,
  ],
  [
    "write to a readable-only root",
    files("C:\\docs\\a.md"),
    "external_write",
    "partially_reversible",
    FILE,
  ],

  [
    "permission",
    { kind: "permission", ...ROOTS },
    "external_write",
    "partially_reversible",
    "runtime.permission",
  ],

  ["tool_call browser_*", tool("browser_click"), "external_write", "partially_reversible", TOOL],
  [
    "tool_call mcp__*",
    tool("mcp__github__create_issue"),
    "external_write",
    "partially_reversible",
    TOOL,
  ],
  ["tool_call noctis_*", tool("noctis_status"), "read_inspect", "reversible", TOOL],
  ["tool_call other", tool("web_fetch"), "external_write", "partially_reversible", TOOL],
];

describe("classifyAsk", () => {
  it.each(ROWS)("%s", (_label, input, operationClass, reversibility, capability) => {
    const result = classifyAsk(input);

    expect(result).toMatchObject({ operationClass, reversibility, capability });
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.reason).not.toContain("\n");
  });

  it("is case-insensitive over the command", () => {
    expect(classifyAsk(command("GIT PUSH --FORCE")).operationClass).toBe("destructive");
  });
});

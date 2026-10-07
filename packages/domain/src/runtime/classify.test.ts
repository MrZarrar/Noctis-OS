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
  /**
   * From the first live turn: a read-only listing was classed `destructive` and
   * demanded a typed DESTROY, because `\b` sits between "format" and a hyphen.
   */
  ["Format-List is not format", command("dir | Format-List"), "read_inspect", "reversible", CMD],
  [
    "Format-Table is not format",
    command("Get-ChildItem | Format-Table"),
    "read_inspect",
    "reversible",
    CMD,
  ],
  [
    "a PowerShell read pipeline ending in Format-List",
    command(
      `powershell.exe -Command "Get-ChildItem -LiteralPath C:\\Users\\me\\Downloads -File | Sort-Object LastWriteTime -Descending | Select-Object -First 3 Name,Length | Format-List"`,
    ),
    "read_inspect",
    "reversible",
    CMD,
  ],
  /**
   * From the S1 measurement: Codex on Windows wraps every command in a quoted
   * PowerShell path, and this plain read raised an approval and hung the turn.
   */
  [
    "a plain read inside Codex's quoted PowerShell wrapper",
    command(
      `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content -Raw 'C:\\Users\\me\\.agents\\skills\\superpowers\\SKILL.md'"`,
      OUTSIDE,
    ),
    "read_inspect",
    "reversible",
    CMD,
  ],
  [
    "PowerShell switches before -Command",
    command(`pwsh -NoProfile -ExecutionPolicy Bypass -c "git status"`),
    "read_inspect",
    "reversible",
    CMD,
  ],
  ["cmd /c around a read", command(`cmd.exe /c "dir /b"`), "read_inspect", "reversible", CMD],
  [
    "the wrapper does not launder a write",
    command(`powershell.exe -Command "Set-Content notes.txt hi"`),
    "local_reversible_edit",
    "reversible",
    CMD,
  ],
  [
    "the wrapper does not launder a redirect",
    command(`powershell.exe -Command "Get-Content a.txt > b.txt"`),
    "local_reversible_edit",
    "reversible",
    CMD,
  ],
  ["bash -lc around a read", command(`bash -lc "git status"`), "read_inspect", "reversible", CMD],

  // Constructs that hide what will run: whatever they hide, the owner sees it first.
  ["iex", command("iex (Get-Content cmd.txt -Raw)"), "external_write", "partially_reversible", CMD],
  [
    "Invoke-Expression",
    command("Invoke-Expression $payload"),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  [
    "-EncodedCommand",
    command("powershell.exe -NoProfile -EncodedCommand ZwBpAHQAIABwAHUAcwBoAA=="),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  [
    "a nested PowerShell inside the wrapped one",
    command(`powershell.exe -Command "Get-Date; pwsh -File run.ps1"`),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  [
    "the call operator on a built string",
    command("& ('gi'+'t') push origin main"),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  [
    "the call operator on a variable",
    command("Get-Date; & $tool status"),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  [
    "dot-sourcing a script",
    command(". ./setup.ps1"),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  [
    "a PowerShell backtick escape",
    command("g`it pu`sh origin main"),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  [
    "a Bash backtick substitution",
    command("echo `cat secrets`"),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  ["eval", command(`eval "$CMD"`), "external_write", "partially_reversible", CMD],
  [
    "bash -c inside a command",
    command(`cd repo && bash -c "make deploy"`),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  ["sh -c", command(`make && sh -c 'printf hi'`), "external_write", "partially_reversible", CMD],
  [
    "node -e",
    command(`node -e "require('child_process').execSync('x')"`),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  ["python -c", command(`python -c "import os"`), "external_write", "partially_reversible", CMD],
  [
    "&& is not the call operator",
    command("npm test && npm run lint"),
    "local_reversible_edit",
    "reversible",
    CMD,
  ],
  ["a dot argument is not dot-sourcing", command("ls ."), "read_inspect", "reversible", CMD],
  ["node --version is not node -e", command("node --version"), "read_inspect", "reversible", CMD],
  [
    "a file named for PowerShell is not a PowerShell",
    command("Get-Content powershell-notes.md"),
    "read_inspect",
    "reversible",
    CMD,
  ],
  [
    "the wrapper does not hide a disk format",
    command(`powershell.exe -Command "format D: /q"`),
    "destructive",
    "irreversible",
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
  [
    "an MCP tool named for a read",
    tool("mcp__github__get_issue"),
    "read_inspect",
    "reversible",
    TOOL,
  ],
  [
    "an MCP lookup with a hyphenated name",
    tool("mcp__context7__query-docs"),
    "read_inspect",
    "reversible",
    TOOL,
  ],
  [
    "an MCP send is not a read",
    tool("mcp__slack__send_message"),
    "external_write",
    "partially_reversible",
    TOOL,
  ],
  [
    "a browser action behind an MCP server is not a read",
    tool("mcp__playwright__browser_navigate"),
    "external_write",
    "partially_reversible",
    TOOL,
  ],
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

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

function tool(name: string, args?: unknown): AskInput {
  return { kind: "tool_call", tool: name, ...(args === undefined ? {} : { args }), ...ROOTS };
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
  [
    "Chrome phone tests with a literal PowerShell executable",
    command(
      String.raw`$env:NOCTIS_E2E_BROWSER_CHANNEL = 'chrome'; & 'C:\Users\mushaf.zarrar\AppData\Local\Noctis\runtime\node-v22.23.2-win-x64\node.exe' --test --test-name-pattern='native status bar|anchors phone navigation' apps/web/e2e/phone.test.mjs`,
    ),
    "local_reversible_edit",
    "reversible",
    CMD,
  ],
  [
    "a Git alias with a visible push still asks",
    command('git -c "alias.ship=!git push origin main" ship'),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  [
    "a Git alias with a visible reset still asks",
    command('git -c "alias.wipe=!git reset --hard HEAD" wipe'),
    "destructive",
    "irreversible",
    CMD,
  ],
  [
    "push with a Git working-folder option",
    command('git -C "C:\\work\\repo" push origin main'),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  [
    "reset with a Git configuration option",
    command("git -c core.autocrlf=false reset --hard HEAD"),
    "destructive",
    "irreversible",
    CMD,
  ],
  [
    "read with Git global options",
    command("git --no-pager -C C:\\work\\repo status"),
    "read_inspect",
    "reversible",
    CMD,
  ],
  [
    "Windows push executable",
    command("git.exe push origin main"),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  [
    "Windows destructive executable",
    command("git.exe reset --hard HEAD"),
    "destructive",
    "irreversible",
    CMD,
  ],
  [
    "Windows publish executable",
    command("npm.cmd publish"),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  [
    "parent directory file escape",
    files("C:\\work\\repo\\..\\outside.txt"),
    "external_write",
    "partially_reversible",
    FILE,
  ],
  [
    "parent directory command escape",
    command("npm test", "C:\\work\\repo\\..\\other"),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  ["an empty command still asks", command(""), "external_write", "partially_reversible", CMD],
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
    command(`powershell.exe -Command "Get-Date; pwsh -Command run"`),
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
    "a literal Node executable starts a local preview",
    command(
      String.raw`& 'C:\Program Files\nodejs\node.exe' node_modules/vite/bin/vite.js --host 127.0.0.1`,
    ),
    "local_reversible_edit",
    "reversible",
    CMD,
  ],
  [
    "a literal executable outside the writable roots still asks",
    command(String.raw`& 'C:\tools\node.exe' preview.js`, OUTSIDE),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  [
    "a literal executable still exposes a push",
    command(String.raw`& 'C:\tools\git.exe' push origin main`),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  [
    "a literal executable still exposes a destructive command",
    command(String.raw`& 'C:\tools\git.exe' reset --hard HEAD`),
    "destructive",
    "irreversible",
    CMD,
  ],
  [
    "an interpolated executable still asks",
    command('& "$tool.exe" preview.js'),
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
  /**
   * A script handed over on the command line is in plain sight, and no more hidden than
   * `python script.py`, which was always local. Asking for every `python -c` that read a
   * JSON file was most of what the owner was asked to approve.
   */
  [
    "python -c inside a root runs like a script",
    command(`python -c "import json; print(json.load(open('a.json')))"`),
    "local_reversible_edit",
    "reversible",
    CMD,
  ],
  [
    "python -c outside every root",
    command(`python -c "print(1)"`, OUTSIDE),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  [
    "node -e inside a root",
    command(`node -e "console.log(1)"`),
    "local_reversible_edit",
    "reversible",
    CMD,
  ],
  [
    "node -e still shows a push it names",
    command(`node -e "require('child_process').execSync('git push')"`),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  [
    "a quoted heredoc's backticks are text",
    command("cat > notes.md <<'MD'\nRun `npm test` first.\nMD"),
    "local_reversible_edit",
    "reversible",
    CMD,
  ],
  [
    "python reading a quoted heredoc",
    command('cd repo && python - <<"PY"\ns = "a `b`"\nPY\necho done'),
    "local_reversible_edit",
    "reversible",
    CMD,
  ],
  [
    "an unquoted heredoc still substitutes backticks",
    command("cat > a.txt <<EOF\n`whoami`\nEOF"),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  [
    "a backtick after a quoted heredoc",
    command("cat > a <<'X'\nhi\nX\necho `whoami`"),
    "external_write",
    "partially_reversible",
    CMD,
  ],
  [
    "powershell -File runs a script like any other",
    command("powershell -ExecutionPolicy Bypass -File scripts\\deploy\\work-pc.ps1"),
    "local_reversible_edit",
    "reversible",
    CMD,
  ],
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
    "a Playwright browser action is a local step",
    tool("mcp__playwright__browser_navigate"),
    "local_reversible_edit",
    "reversible",
    TOOL,
  ],
  ["tool_call other", tool("web_fetch"), "external_write", "partially_reversible", TOOL],
  [
    "clicking around the owner's browser is a local step",
    tool("mcp__browser__browser_click", { element: "Add to Basket button", ref: "e12" }),
    "local_reversible_edit",
    "reversible",
    TOOL,
  ],
  [
    "opening a page in the owner's browser is a local step",
    tool("mcp__browser__browser_navigate", { url: "https://www.amazon.co.uk/s?k=headphones" }),
    "local_reversible_edit",
    "reversible",
    TOOL,
  ],
  [
    "a browser click that places an order asks",
    tool("mcp__browser__browser_click", { element: "Place your order", ref: "e40" }),
    "external_write",
    "partially_reversible",
    TOOL,
  ],
  [
    "a browser click that heads to checkout asks",
    tool("mcp__browser__browser_click", { element: "Proceed to Checkout button", ref: "e9" }),
    "external_write",
    "partially_reversible",
    TOOL,
  ],
  [
    "a form field named for payment asks",
    tool("mcp__browser__browser_fill_form", {
      fields: [{ name: "Card number", type: "textbox", ref: "e3", value: "4111" }],
    }),
    "external_write",
    "partially_reversible",
    TOOL,
  ],
  [
    "typed words are what the owner asked for, not what the click does",
    tool("mcp__browser__browser_type", {
      element: "Search box",
      ref: "e2",
      text: "how to send a parcel",
    }),
    "local_reversible_edit",
    "reversible",
    TOOL,
  ],
  [
    "a desktop click is a local step",
    tool("mcp__desktop__Click", { label: 14 }),
    "local_reversible_edit",
    "reversible",
    TOOL,
  ],
  [
    "launching an app on the desktop is a local step",
    tool("mcp__desktop__App", { mode: "launch", name: "Teams" }),
    "local_reversible_edit",
    "reversible",
    TOOL,
  ],
  [
    "a desktop button named Send asks",
    tool("mcp__desktop__Click", { label: "Send" }),
    "external_write",
    "partially_reversible",
    TOOL,
  ],
  [
    "opening a terminal on the desktop asks, or typing into it would go round the command checks",
    tool("mcp__desktop__App", { mode: "launch", name: "Windows PowerShell" }),
    "external_write",
    "partially_reversible",
    TOOL,
  ],
  [
    "the Run box asks for the same reason",
    tool("mcp__desktop__Shortcut", { shortcut: "win+r" }),
    "external_write",
    "partially_reversible",
    TOOL,
  ],
  [
    "a desktop server Noctis did not lend still asks",
    tool("mcp__windows-mcp__Click", { label: 14 }),
    "external_write",
    "partially_reversible",
    TOOL,
  ],
];

describe("classifyAsk", () => {
  it.each(["browser", "playwright"])(
    "handles routine %s tools and keeps consequential steps gated",
    (server) => {
      for (const [name, args] of [
        ["browser_resize", { width: 1280, height: 720 }],
        [
          "browser_evaluate",
          { function: "() => document.querySelector('main').getBoundingClientRect().width" },
        ],
        ["browser_evaluate", { function: "function () { return document.title; }" }],
      ] as const) {
        expect(classifyAsk(tool(`mcp__${server}__${name}`, args)).operationClass).toBe(
          "local_reversible_edit",
        );
      }
      expect(
        classifyAsk(tool(`mcp__${server}__browser_click`, { element: "Send message" }))
          .operationClass,
      ).toBe("external_write");
      expect(
        classifyAsk(
          tool(`mcp__${server}__browser_fill_form`, { fields: [{ name: "Card number" }] }),
        ).operationClass,
      ).toBe("external_write");
    },
  );

  it.each([
    "() => document.querySelector('button').click()",
    "() => document.forms[0].requestSubmit()",
    "() => document.forms[0].submit()",
    "() => document.body.dispatchEvent(new Event('submit'))",
    "() => fetch('/send', { method: 'POST' })",
    "() => new XMLHttpRequest()",
    "() => navigator.sendBeacon('/send', 'message')",
    "() => eval(code)",
    "() => new Function(code)()",
    "() => import('/action.js')",
    "() => localStorage.setItem('token', 'x')",
    "() => { document.cookie = 'token=x'; }",
  ])("asks before browser evaluation with visible effects: %s", (code) => {
    for (const server of ["browser", "playwright"]) {
      expect(
        classifyAsk(tool(`mcp__${server}__browser_evaluate`, { function: code })).operationClass,
      ).toBe("external_write");
    }
  });

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

import type { OperationClass, Reversibility } from "@noctis/contracts";

/**
 * The class of one runtime ask, decided before it runs.
 *
 * Deterministic and fail-closed: a command nothing recognises is a write, and a
 * write anywhere the operator did not grant is external. The model proposes;
 * this decides what it proposed.
 */

export interface AskInput {
  kind: "command" | "file_change" | "permission" | "tool_call";
  command?: string;
  cwd?: string;
  paths?: readonly string[];
  tool?: string;
  /** A tool call's own input, so a step on the owner's screen can be judged by what it presses. */
  args?: unknown;
  writableRoots: readonly string[];
  readableRoots: readonly string[];
}

export interface AskClass {
  operationClass: OperationClass;
  reversibility: Reversibility;
  capability: string;
  reason: string;
}

type Rule = [name: string, pattern: RegExp];

/** A command head: start of the string or the start of a chained segment. */
const HEAD = String.raw`(?:^|[;&|]\s*)`;

// ponytail: pattern table; a grammar if it ever misclassifies in practice
const DESTRUCTIVE: readonly Rule[] = [
  ["rm -r", /\brm\s+-[a-z]*r/],
  ["Remove-Item -Recurse", /\bremove-item\b.*-recurse\b/],
  ["rd /s", /\b(?:rd|rmdir)\b.*\/s\b/],
  ["del /s or /q", /\bdel\b.*\/[sq]\b/],
  ["git push --force", /\bgit\s+push\b.*(?:--force\b|\s-f\b)/],
  ["git reset --hard", /\bgit\s+reset\b.*--hard\b/],
  ["git clean -f", /\bgit\s+clean\b.*\s-[a-z]*f/],
  /**
   * `(?=\s|$)` rather than `\b`, because `\b` also sits between "format" and a
   * hyphen — so `Get-ChildItem | Format-List` matched the disk formatter and a
   * directory listing was classed `destructive`, demanding a typed DESTROY.
   * `Format-List`, `Format-Table` and `Format-Wide` end half the read-only
   * PowerShell pipelines there are, and an approval that cries wolf teaches
   * people to type the phrase without reading it.
   */
  ["format", new RegExp(HEAD + String.raw`format(?:\.com|\.exe)?(?=\s|$)`)],
  ["diskpart", new RegExp(HEAD + String.raw`diskpart\b`)],
  ["mkfs", new RegExp(HEAD + String.raw`mkfs\b`)],
  ["Clear-Content", /\bclear-content\b/],
];

const EXTERNAL: readonly Rule[] = [
  ["git push", /\bgit\s+push\b/],
  ["gh pr create", /\bgh\s+pr\s+create\b/],
  ["gh release", /\bgh\s+release\b/],
  ["npm publish", /\bnpm\s+publish\b/],
  ["curl write", /\bcurl\b.*(?:\s-x\s*(?:post|put|patch|delete)\b|\s(?:-d|--data(?:-\w+)?)\b)/],
  [
    "Invoke-WebRequest write",
    /\b(?:invoke-webrequest|invoke-restmethod|iwr|irm)\b.*(?:-method\s+(?:post|put|patch|delete)\b|-body\b)/,
  ],
  ["wget --post", /\bwget\b.*--post/],
  ["ssh/scp", /\b(?:ssh|scp)\b/],
  ["cloud deploy", /\b(?:az|aws|gcloud)\b.*\bdeploy\b/],
];

/**
 * Heads that only read. Applied per chained segment; a redirect disqualifies
 * the lot.
 *
 * The trailing group is PowerShell's pure pipeline stages. Without them a plain
 * `Get-ChildItem | Sort-Object | Format-List` is not a read, because one
 * unrecognised segment demotes the whole pipeline — and nearly every read
 * pipeline a model writes ends in a formatter. They are safe to name here only
 * because the destructive and external tables are scanned across the entire
 * command first, so `... | Where-Object { Remove-Item x }` is caught before
 * this is consulted. Deliberately absent: `Out-File` and `Set-Content`, which
 * write, and `ForEach-Object`, which runs whatever it is handed.
 */
const READ_ONLY_HEAD =
  /^(?:dir|ls|type|cat|get-childitem|gci|get-content|gc|echo|findstr|grep|rg|where|which|pwd|select-string|test-path|git\s+(?:status|log|diff|show)|node\s+--version|npm\s+ls|format-(?:list|table|wide)|select-object|sort-object|measure-object|out-string)\b/;

/**
 * A shell launched only to run one command: `"...\powershell.exe" -Command "..."`,
 * `pwsh -NoProfile -c "..."`, `cmd /c "..."`, `bash -lc "..."`. Codex wraps every
 * command this way (PowerShell on Windows, bash elsewhere), so without unwrapping, the head every
 * rule sees is the shell and no read is ever recognised as one. Only a wrapper at the very start
 * is unwrapped; a shell started anywhere else is an evasion construct below.
 */
const SHELL_WRAPPER = new RegExp(
  [
    String.raw`^\s*(?:"[^"]*?(?:powershell|pwsh)(?:\.exe)?"|(?:\S*[\/])?(?:powershell|pwsh)(?:\.exe)?)\s+(?:-(?:noprofile|nologo|noninteractive|executionpolicy\s+\S+)\s+)*-(?:command|c)\s+([\s\S]+)$`,
    String.raw`^\s*(?:"[^"]*?cmd(?:\.exe)?"|(?:\S*[\/])?cmd(?:\.exe)?)\s+\/[ck]\s+([\s\S]+)$`,
    String.raw`^\s*(?:"[^"]*?(?:bash|sh|zsh)(?:\.exe)?"|(?:\S*[\/])?(?:bash|sh|zsh)(?:\.exe)?)\s+-l?c\s+([\s\S]+)$`,
  ].join("|"),
  "i",
);

export function unwrap(command: string): string {
  let current = command;

  // Bounded: a wrapper inside a wrapper is plausible, a deeper one is not worth a loop.
  for (let depth = 0; depth < 3; depth += 1) {
    const match = SHELL_WRAPPER.exec(current);
    const inner = (match?.[1] ?? match?.[2] ?? match?.[3])?.trim();

    if (inner === undefined) {
      break;
    }

    const quote = inner[0];

    current =
      inner.length >= 2 && (quote === '"' || quote === "'") && inner.endsWith(quote)
        ? inner.slice(1, -1)
        : inner;
  }

  return current;
}

/**
 * Ways of running a command that hide what the command is: a string evaluated, a script
 * sourced, an encoded or nested shell, an escape that splits a word the tables would know.
 * Whatever they hide, the owner sees it before it runs. Checked after the destructive and
 * external tables, which already catch what they can see.
 *
 * `python -c` and `node -e` are absent on purpose. The script is right there in the command,
 * no more hidden than `python script.py`, and asking for every one that printed some JSON was
 * most of what the owner was being asked to approve. A PowerShell started with `-File` runs a
 * script the same way, so it is let through too.
 */
const EVASION: readonly Rule[] = [
  ["Invoke-Expression", /\b(?:iex|invoke-expression)\b/],
  [
    "a nested PowerShell",
    /(?:^|[\s;&|("'\\/])(?:powershell|pwsh)(?:\.exe)?["']?\s+(?!(?:-(?:noprofile|nologo|noninteractive|executionpolicy\s+\S+)\s+)*-file\b)-/,
  ],
  ["a nested cmd /c", /(?:^|[\s;&|("'\\/])cmd(?:\.exe)?["']?\s+\/[ck]\b/],
  ["the call operator", new RegExp(String.raw`(?:^|[;|({]\s*)&\s*["'($]`)],
  ["dot-sourcing", new RegExp(String.raw`(?:^|[;&|({]\s*)\.\s+\S`)],
  ["eval", /\beval\b/],
  ["a nested shell -c", /(?:^|[\s;&|("'\\/])(?:bash|sh|zsh|dash)(?:\.exe)?\s+(?:-\S+\s+)*-\w*c\b/],
];

/**
 * A heredoc whose delimiter is quoted (`<<'EOF'`, `<<"EOF"`) is passed through as written, so
 * a backtick in its body is a Markdown code span or a Python string, never a substitution.
 * Only the backtick check skips these bodies; the other tables still read every line.
 */
const QUOTED_HEREDOC = /<<-?\s*(['"])(\w+)\1[^\n]*\n[\s\S]*?^\s*\2\s*$/gm;

function hasLiveBacktick(command: string): boolean {
  return command.replace(QUOTED_HEREDOC, "").includes("`");
}

function literalExecutables(command: string): string {
  return command.replace(
    /(^\s*|[;|({]\s*)&\s*(?:'([^'\r\n`$]+\.exe)'|"([^"\r\n`$]+\.exe)")(?=\s|$)/g,
    (_call, head: string, single: string | undefined, double: string | undefined) =>
      head + (single ?? double ?? "").split(/[\\/]/).at(-1)!.slice(0, -4),
  );
}

function lower(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Case-insensitive, separator-agnostic containment with a trailing-slash boundary. */
function insideAny(path: string, roots: readonly string[]): boolean {
  const p = lower(path);
  if (p.split("/").some((part) => part.trimEnd() === "..")) return false;

  return roots.some((root) => {
    const r = lower(root);

    return p === r || p.startsWith(`${r}/`);
  });
}

function match(rules: readonly Rule[], command: string): string | undefined {
  return rules.find(([, pattern]) => pattern.test(command))?.[0];
}

function isReadOnly(command: string): boolean {
  return (
    !command.includes(">") &&
    command
      .split(/[;&|]+/)
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0)
      .every((segment) => READ_ONLY_HEAD.test(segment))
  );
}

const DESTRUCTIVE_CLASS = { operationClass: "destructive", reversibility: "irreversible" } as const;
const EXTERNAL_CLASS = {
  operationClass: "external_write",
  reversibility: "partially_reversible",
} as const;
const LOCAL_CLASS = {
  operationClass: "local_reversible_edit",
  reversibility: "reversible",
} as const;
const READ_CLASS = { operationClass: "read_inspect", reversibility: "reversible" } as const;

function classifyCommand(input: AskInput): AskClass {
  const capability = "runtime.command";
  const supplied = literalExecutables(unwrap((input.command ?? "").toLowerCase())).replace(
    /\b(git|gh|npm|curl|wget|ssh|scp|az|aws|gcloud|diskpart|format)(?:\.exe|\.cmd|\.bat)\b/g,
    "$1",
  );
  const command = supplied.replace(
    /\bgit\s+(?:(?:-c\s*|--(?:git-dir|work-tree|namespace|config-env)(?:\s+|=))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|]+)\s+|--(?:no-pager|paginate|bare|no-optional-locks)\s+)+/g,
    "git ",
  );
  const inspected = `${supplied}\n${command}`;

  if (command.trim() === "") {
    return { ...EXTERNAL_CLASS, capability, reason: "command was not provided" };
  }

  const destructive = match(DESTRUCTIVE, inspected);
  if (destructive !== undefined) {
    return { ...DESTRUCTIVE_CLASS, capability, reason: `destructive pattern: ${destructive}` };
  }

  const external = match(EXTERNAL, inspected);
  if (external !== undefined) {
    return { ...EXTERNAL_CLASS, capability, reason: `external-write pattern: ${external}` };
  }

  const evasion =
    match(EVASION, inspected) ?? (hasLiveBacktick(supplied) ? "a backtick" : undefined);
  if (evasion !== undefined) {
    return { ...EXTERNAL_CLASS, capability, reason: `hides what it runs: ${evasion}` };
  }

  if (isReadOnly(command)) {
    return { ...READ_CLASS, capability, reason: "read-only command head" };
  }

  if (input.cwd === undefined) {
    return { ...EXTERNAL_CLASS, capability, reason: "unrecognised command with no cwd" };
  }

  return insideAny(input.cwd, input.writableRoots)
    ? { ...LOCAL_CLASS, capability, reason: "unrecognised command inside a writable root" }
    : { ...EXTERNAL_CLASS, capability, reason: "unrecognised command outside every writable root" };
}

const MCP_READ_VERB =
  /^(?:get|list|search|read|fetch|query|find|view|describe|show|lookup|resolve)(?:[_-]|$)/;

/**
 * The servers Noctis lends for the owner's own screen: their browser and their desktop. A step
 * there is the owner's PC doing what they asked, so it runs, unless what it presses commits them.
 */
const SCREEN_SERVER = /^mcp__(?:browser|playwright|desktop)__/;

// shortcut: visible effect names only; computed calls still need the agent's judgement.
const EVALUATION_EFFECT =
  /\b(?:fetch|XMLHttpRequest|sendBeacon|eval|Function|import)\s*\(|\.\s*(?:click|submit|requestSubmit|dispatchEvent)\s*\(|\b(?:localStorage|sessionStorage)\s*\.\s*(?:setItem|removeItem|clear)\s*\(|\bdocument\s*\.\s*cookie\s*=/;

/**
 * Words on a button or field that mean money, a message or a post leaves the PC. A backstop
 * under the agent's own judgement, which is told to stop before these anyway.
 *
 * ponytail: matches only what a step names (a browser element, a desktop label). A desktop click
 * by screen id or an Enter that sends a chat names nothing; an accessibility-tree lookup of the
 * target would close that if it misses in practice.
 */
const COMMITS =
  /\b(?:buy|purchase|place (?:your |the )?order|pay(?:ment)?|pay now|checkout|check out|complete (?:order|purchase)|confirm (?:order|purchase|payment)|card number|cvv|cvc|send|submit|post|publish|tweet|delete|transfer)\b/i;

/**
 * A terminal or the Run box opened on the desktop, which the next Type step would turn into a
 * command no command check ever saw.
 *
 * ponytail: names and one shortcut; typing into a terminal that was already open is not caught.
 */
const OPENS_A_SHELL =
  /\b(?:powershell|pwsh|cmd|command prompt|terminal|wt|bash|wsl|git bash)\b|^win\+r$/i;

function opensAShell(tool: string, args: unknown): boolean {
  if (typeof args !== "object" || args === null) {
    return false;
  }

  const { name, shortcut } = args as { name?: unknown; shortcut?: unknown };
  const target =
    tool === "mcp__desktop__App" ? name : tool === "mcp__desktop__Shortcut" ? shortcut : undefined;

  return typeof target === "string" && OPENS_A_SHELL.test(target.trim());
}

/** The names a step gives what it presses: Playwright's `element`, a field's `name`, a desktop `label`. */
function namedTargets(args: unknown): string[] {
  if (Array.isArray(args)) {
    return args.flatMap(namedTargets);
  }

  if (typeof args !== "object" || args === null) {
    return [];
  }

  return Object.entries(args).flatMap(([key, value]) =>
    typeof value === "string" && (key === "element" || key === "name" || key === "label")
      ? [value]
      : typeof value === "object"
        ? namedTargets(value)
        : [],
  );
}

function classifyToolCall(tool: string, args: unknown): AskClass {
  const capability = "runtime.tool_call";

  if (tool.startsWith("noctis_")) {
    return { ...READ_CLASS, capability, reason: "noctis_* tool" };
  }

  // An MCP tool named for a read (`get_issue`, `query-docs`). Its name is the
  // server's claim, which is all Noctis has; anything else stays external.
  if (tool.startsWith("mcp__") && MCP_READ_VERB.test(tool.slice(tool.lastIndexOf("__") + 2))) {
    return { ...READ_CLASS, capability, reason: "mcp__* tool named for a read" };
  }

  if (opensAShell(tool, args)) {
    return { ...EXTERNAL_CLASS, capability, reason: "opens a shell on the desktop" };
  }

  if (SCREEN_SERVER.test(tool)) {
    if (tool.endsWith("__browser_evaluate")) {
      const code =
        typeof args === "object" && args !== null
          ? (args as { function?: unknown }).function
          : undefined;
      if (typeof code !== "string" || EVALUATION_EFFECT.test(code)) {
        return {
          ...EXTERNAL_CLASS,
          capability,
          reason: "browser evaluation with visible effects or missing code",
        };
      }
    }
    const commits = namedTargets(args).find((name) => COMMITS.test(name));

    return commits === undefined
      ? { ...LOCAL_CLASS, capability, reason: "a step on the owner's own screen" }
      : {
          ...EXTERNAL_CLASS,
          capability,
          reason: `presses something that commits: ${commits.slice(0, 80)}`,
        };
  }

  if (tool.startsWith("browser_") || tool.startsWith("mcp__")) {
    return { ...EXTERNAL_CLASS, capability, reason: "browser_* or mcp__* tool" };
  }

  return { ...EXTERNAL_CLASS, capability, reason: "tool outside the known prefixes" };
}

export function classifyAsk(input: AskInput): AskClass {
  switch (input.kind) {
    case "command":
      return classifyCommand(input);
    case "permission":
      return {
        ...EXTERNAL_CLASS,
        capability: "runtime.permission",
        reason: "permission ask",
      };
    case "tool_call":
      return classifyToolCall(input.tool ?? "", input.args);
    case "file_change": {
      const paths = input.paths ?? [];
      const capability = "runtime.file_change";

      return paths.length > 0 && paths.every((p) => insideAny(p, input.writableRoots))
        ? { ...LOCAL_CLASS, capability, reason: "every path inside a writable root" }
        : { ...EXTERNAL_CLASS, capability, reason: "a path outside every writable root" };
    }
  }
}

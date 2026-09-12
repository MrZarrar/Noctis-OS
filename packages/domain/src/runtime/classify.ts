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
  ["format", new RegExp(HEAD + String.raw`format(?:\.com|\.exe)?\b`)],
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

/** Heads that only read. Applied per chained segment; a redirect disqualifies the lot. */
const READ_ONLY_HEAD =
  /^(?:dir|ls|type|cat|get-childitem|gci|get-content|gc|echo|findstr|grep|rg|where|which|pwd|select-string|test-path|git\s+(?:status|log|diff|show)|node\s+--version|npm\s+ls)\b/;

function lower(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Case-insensitive, separator-agnostic containment with a trailing-slash boundary. */
function insideAny(path: string, roots: readonly string[]): boolean {
  const p = lower(path);

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
  const command = (input.command ?? "").toLowerCase();

  const destructive = match(DESTRUCTIVE, command);
  if (destructive !== undefined) {
    return { ...DESTRUCTIVE_CLASS, capability, reason: `destructive pattern: ${destructive}` };
  }

  const external = match(EXTERNAL, command);
  if (external !== undefined) {
    return { ...EXTERNAL_CLASS, capability, reason: `external-write pattern: ${external}` };
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

function classifyToolCall(tool: string): AskClass {
  const capability = "runtime.tool_call";

  if (tool.startsWith("noctis_")) {
    return { ...READ_CLASS, capability, reason: "noctis_* tool" };
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
      return classifyToolCall(input.tool ?? "");
    case "file_change": {
      const paths = input.paths ?? [];
      const capability = "runtime.file_change";

      return paths.length > 0 && paths.every((p) => insideAny(p, input.writableRoots))
        ? { ...LOCAL_CLASS, capability, reason: "every path inside a writable root" }
        : { ...EXTERNAL_CLASS, capability, reason: "a path outside every writable root" };
    }
  }
}

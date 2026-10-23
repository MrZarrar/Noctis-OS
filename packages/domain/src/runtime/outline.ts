import { unwrap } from "./classify.js";

/**
 * A command as one line a person can read before approving it: the programs it runs, in
 * order, without the flags, paths and inline code around them. Used when the agent gave no
 * description of its own. The command itself is always shown alongside, so this only has to
 * be a fair outline, never the whole truth.
 */

/** Tools whose first argument is the thing being done: `git show`, `npm test`. */
const SUBCOMMANDS = new Set([
  "git",
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "gh",
  "cargo",
  "docker",
  "dotnet",
  "winget",
  "pip",
  "uv",
]);

/** Moving between folders is not something the command does. */
const SKIPPED = new Set(["cd", "set-location", "sl", "pushd", "popd"]);

const INLINE: Readonly<Record<string, { flags: RegExp; name: string }>> = {
  python: { flags: /^-c$/, name: "an inline Python script" },
  python3: { flags: /^-c$/, name: "an inline Python script" },
  py: { flags: /^-c$/, name: "an inline Python script" },
  node: { flags: /^(?:-e|--eval|-p|--print)$/, name: "an inline Node script" },
};

const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?^\s*\2\s*$/gm;

/** Splits on `;`, `&&`, `||`, `|`, `&` and newlines outside quotes. `2>&1` is not a split. */
function segments(command: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | undefined;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] ?? "";

    if (quote !== undefined) {
      current += ch;
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (";|\n".includes(ch) || (ch === "&" && !"<>".includes(command[i - 1] ?? ""))) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

function words(segment: string): string[] {
  return [...segment.matchAll(/"([^"]*)"?|'([^']*)'?|(\S+)/g)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? "",
  );
}

function program(word: string): string {
  return (word.split(/[\\/]/).at(-1) ?? word).replace(/\.exe$/i, "");
}

function describe(segment: string): string | undefined {
  const all = words(segment);
  const start = all.findIndex((w) => !/^[A-Za-z_]\w*=/.test(w));
  const [head, ...rest] = start === -1 ? [] : all.slice(start);

  if (head === undefined) return undefined;

  const name = program(head);
  const key = name.toLowerCase();

  if (SKIPPED.has(key)) return undefined;

  const inline = INLINE[key];
  if (inline !== undefined && rest.some((w) => inline.flags.test(w))) return inline.name;

  const sub = rest[0];
  return SUBCOMMANDS.has(key) && sub !== undefined && !sub.startsWith("-")
    ? `${name} ${sub}`
    : name;
}

function list(names: readonly string[]): string {
  const shown =
    names.length > 5 ? [...names.slice(0, 4), `${String(names.length - 4)} more`] : names;

  return shown.length === 1
    ? (shown[0] ?? "")
    : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1) ?? ""}`;
}

export function outlineCommand(command: string): string {
  const names = [
    ...new Set(
      segments(unwrap(command).replace(HEREDOC, ""))
        .map(describe)
        .filter((name): name is string => name !== undefined),
    ),
  ];

  return names.length === 0 ? "Runs a command" : `Runs ${list(names)}`;
}

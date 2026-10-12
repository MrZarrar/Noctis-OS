/**
 * The bridge's entries in an agent's hook settings: `~/.claude/settings.json`
 * for Claude Code, `~/.codex/hooks.json` for Codex, which read the same shape.
 * Everything else in the file is the owner's and is left exactly as found.
 */

export const BRIDGE_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"] as const;

/** How a bridge entry is recognised again, whatever path the repo is at. */
const MARK = "bridge-hook.js";

/** Seconds. A core that is down costs the agent this long at most, per hook. */
const TIMEOUT_SECONDS = 5;

interface HookGroup {
  hooks?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

type Settings = Record<string, unknown> & { hooks?: Record<string, HookGroup[]> };

function isBridge(group: HookGroup): boolean {
  return (group.hooks ?? []).some(
    (hook) => typeof hook.command === "string" && hook.command.includes(MARK),
  );
}

export function removeBridgeHooks<T extends Settings>(settings: T): T {
  const hooks: Record<string, HookGroup[]> = {};

  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const kept = groups.filter((group) => !isBridge(group));

    if (kept.length > 0) {
      hooks[event] = kept;
    }
  }

  const rest: Settings = { ...settings };

  delete rest.hooks;

  return (Object.keys(hooks).length === 0 ? rest : { ...rest, hooks }) as T;
}

/** Idempotent: an entry already there is replaced, so a moved repo is picked up. */
export function addBridgeHooks<T extends Settings>(
  settings: T,
  command: string,
): T & { hooks: Record<string, HookGroup[]> } {
  const clean = removeBridgeHooks(settings);
  const hooks: Record<string, HookGroup[]> = { ...(clean.hooks ?? {}) };

  for (const event of BRIDGE_EVENTS) {
    hooks[event] = [
      ...(hooks[event] ?? []),
      { hooks: [{ type: "command", command, timeout: TIMEOUT_SECONDS }] },
    ];
  }

  return { ...clean, hooks };
}

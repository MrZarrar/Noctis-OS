import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { BridgeProviderId } from "@noctis/contracts";

import { addBridgeHooks, removeBridgeHooks } from "./hooks-config.js";

/** Where each agent keeps the hooks every session it starts loads. */
function settingsPath(provider: BridgeProviderId): string {
  return provider === "claude"
    ? join(homedir(), ".claude", "settings.json")
    : join(homedir(), ".codex", "hooks.json");
}

/** Forward slashes and no quotes unless needed: Claude runs hooks in Git Bash, Codex in PowerShell. */
function hookCommand(provider: BridgeProviderId): string {
  const word = (path: string): string => {
    const forward = path.replaceAll("\\", "/");

    return forward.includes(" ") ? `"${forward}"` : forward;
  };
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "bridge-hook.js");

  return `${word(process.execPath)} ${word(script)} ${provider}`;
}

function rewrite(
  provider: BridgeProviderId,
  change: (settings: Record<string, unknown>) => Record<string, unknown>,
): string {
  const path = settingsPath(provider);
  const before = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
    : {};

  mkdirSync(dirname(path), { recursive: true });

  // The owner's file as it was before Noctis first touched it, kept once.
  if (existsSync(path) && !existsSync(`${path}.before-noctis`)) {
    copyFileSync(path, `${path}.before-noctis`);
  }

  writeFileSync(path, `${JSON.stringify(change(before), null, 2)}\n`);

  return path;
}

const PROVIDERS: readonly BridgeProviderId[] = ["claude", "codex"];

export function installBridge(): string[] {
  return [
    ...PROVIDERS.map(
      (provider) =>
        `${provider}: hooks added to ${rewrite(provider, (settings) => addBridgeHooks(settings, hookCommand(provider)))}`,
    ),
    "codex: open Codex and run /hooks to trust them; Codex skips a hook nobody trusted.",
  ];
}

export function uninstallBridge(): string[] {
  return PROVIDERS.map(
    (provider) => `${provider}: hooks removed from ${rewrite(provider, removeBridgeHooks)}`,
  );
}

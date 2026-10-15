import type {
  ResetSettingCommand,
  SetSettingCommand,
  SettingKey,
  SettingValue,
} from "@noctis/contracts";
import { SETTING_KEYS, SETTING_VALUE_SCHEMAS } from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { ok } from "@noctis/domain";

import type { NoctisDatabase } from "../db/connection.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The owner's settings, set on the Settings page. A key the owner has not set
 * falls back to the environment variable it replaces, then to its default, so
 * a deployment configured through the environment keeps working unchanged.
 *
 * Stored in `runtime_kv` beside the default model, as `setting:<key>`.
 */

interface Entry {
  env: string;
  fromEnv: (raw: string) => unknown;
  fallback: unknown;
  kind: "time" | "boolean" | "integer" | "choice" | "list";
  label: string;
  help: string;
}

const REGISTRY: Record<SettingKey, Entry> = {
  digestAt: {
    env: "NOCTIS_DIGEST_AT",
    fromEnv: (raw) => raw.trim(),
    fallback: "",
    kind: "time",
    label: "Daily digest",
    help: "When your phones get the day's summary. Empty is off.",
  },
  promoterAt: {
    env: "NOCTIS_PROMOTER_AT",
    fromEnv: (raw) => raw.trim(),
    fallback: "",
    kind: "time",
    label: "File the inbox nightly",
    help: "When Vesper files new inbox notes into the Vault. Empty is off.",
  },
  vaultWrites: {
    env: "NOCTIS_VAULT_ALLOW_WRITES",
    fromEnv: (raw) => raw === "true",
    fallback: false,
    kind: "boolean",
    label: "Let Noctis write to the Vault",
    help: "The Agent Brain, and what the promoter files. Never your own text without asking.",
  },
  sessionTtlHours: {
    env: "NOCTIS_SESSION_TTL_HOURS",
    fromEnv: (raw) => Number(raw),
    fallback: 720,
    kind: "integer",
    label: "Stay logged in for (hours)",
    help: "Applies to the next login on each device.",
  },
  logLevel: {
    env: "NOCTIS_LOG_LEVEL",
    fromEnv: (raw) => raw.trim(),
    fallback: "info",
    kind: "choice",
    label: "Core log detail",
    help: "How much the core writes to its log.",
  },
  showAllPages: {
    env: "VITE_NOCTIS_ALL_PAGES",
    fromEnv: (raw) => raw === "1",
    fallback: false,
    kind: "boolean",
    label: "Show unfinished pages",
    help: "Missions, Artifacts and Automations in the rail.",
  },
  wakeWhileTyping: {
    env: "NOCTIS_WAKE_WHILE_TYPING",
    fromEnv: (raw) => raw !== "false",
    fallback: true,
    kind: "boolean",
    label: "Wake an agent as I start typing",
    help: "Loads Jester's model while you write, so the reply is not held up. The Wake button works either way.",
  },
  remoteDesktops: {
    env: "NOCTIS_REMOTE_DESKTOPS",
    fromEnv: (raw) => JSON.parse(raw) as unknown,
    fallback: [],
    kind: "list",
    label: "Remote desktops",
    help: "Hosts the Nodes page can open. The gateway key stays a start-up setting.",
  },
};

const storageKey = (key: SettingKey): string => `setting:${key}`;

/** One fixed stream for every settings event, so their history reads in order. */
const SETTINGS_STREAM_ID = "0199e3a0-0000-7000-8000-5e7714950000";

function stored(db: NoctisDatabase, key: SettingKey): { value: unknown } | undefined {
  const row = db.prepare(`SELECT value_json FROM runtime_kv WHERE key = ?`).get(storageKey(key)) as
    { value_json: string } | undefined;

  if (row === undefined) {
    return undefined;
  }

  const parsed = SETTING_VALUE_SCHEMAS[key].safeParse(JSON.parse(row.value_json));

  return parsed.success ? { value: parsed.data } : undefined;
}

function fromEnvironment(
  env: Env,
  key: SettingKey,
): { value: unknown } | { ignored: string } | undefined {
  const entry = REGISTRY[key];
  const raw = env[entry.env];

  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }

  try {
    const parsed = SETTING_VALUE_SCHEMAS[key].safeParse(entry.fromEnv(raw));

    return parsed.success ? { value: parsed.data } : { ignored: raw };
  } catch {
    return { ignored: raw };
  }
}

/** The value the owner set on the Settings page, or undefined when they have not. */
export function ownerSetting<K extends SettingKey>(
  db: NoctisDatabase,
  key: K,
): SettingValue<K> | undefined {
  return stored(db, key)?.value as SettingValue<K> | undefined;
}

export function readSetting<K extends SettingKey>(
  db: NoctisDatabase,
  env: Env,
  key: K,
): SettingValue<K> {
  const ui = stored(db, key);

  if (ui !== undefined) {
    return ui.value as SettingValue<K>;
  }

  const startUp = fromEnvironment(env, key);

  return (
    startUp !== undefined && "value" in startUp ? startUp.value : REGISTRY[key].fallback
  ) as SettingValue<K>;
}

export interface SettingView {
  key: SettingKey;
  label: string;
  help: string;
  kind: Entry["kind"];
  choices?: readonly string[];
  value: unknown;
  source: "ui" | "start-up" | "default";
  /** An environment value that was not a valid value for this setting. */
  ignoredStartUp?: string;
}

export function listSettings(db: NoctisDatabase, env: Env): SettingView[] {
  return SETTING_KEYS.map((key) => {
    const entry = REGISTRY[key];
    const ui = stored(db, key);
    const startUp = fromEnvironment(env, key);
    const base = {
      key,
      label: entry.label,
      help: entry.help,
      kind: entry.kind,
      ...(key === "logLevel" ? { choices: SETTING_VALUE_SCHEMAS.logLevel.options } : {}),
      ...(startUp !== undefined && "ignored" in startUp ? { ignoredStartUp: startUp.ignored } : {}),
    };

    if (ui !== undefined) {
      return { ...base, value: ui.value, source: "ui" as const };
    }

    return startUp !== undefined && "value" in startUp
      ? { ...base, value: startUp.value, source: "start-up" as const }
      : { ...base, value: entry.fallback, source: "default" as const };
  });
}

/** Read before any page can load, or secret: shown on the Settings page, never changed there. */
const START_UP = [
  "NOCTIS_CORE_PORT",
  "NOCTIS_CORE_BIND",
  "NOCTIS_ALLOW_NON_LOOPBACK",
  "NOCTIS_DATABASE_PATH",
  "NOCTIS_WEB_ROOT",
  "NOCTIS_ALLOWED_ORIGINS",
  "NOCTIS_VAULT_ROOT",
  "NOCTIS_VAULT_ALLOW_LIVE",
  "NOCTIS_CORE_TOKEN",
  "NOCTIS_VAPID_PUBLIC_KEY",
  "NOCTIS_VAPID_PRIVATE_KEY",
  "NOCTIS_VAPID_SUBJECT",
  "NOCTIS_GATEWAY_PROVISIONER_KEY_FILE",
] as const;

/**
 * Shown only as set or not set: the secrets, and the paths. GET /vault never
 * names the Vault's folder, and the page has no more use for where the
 * database or the built page live than for where the notes do.
 */
const SECRET: ReadonlySet<string> = new Set([
  "NOCTIS_CORE_TOKEN",
  "NOCTIS_VAPID_PRIVATE_KEY",
  "NOCTIS_GATEWAY_PROVISIONER_KEY_FILE",
  "NOCTIS_VAULT_ROOT",
  "NOCTIS_DATABASE_PATH",
  "NOCTIS_WEB_ROOT",
]);

export function startUpSettings(env: Env): Array<{ name: string; value: string }> {
  return START_UP.map((name) => {
    const raw = env[name]?.trim() ?? "";

    if (SECRET.has(name)) {
      return { name, value: raw === "" ? "not set" : "set" };
    }

    return { name, value: raw === "" ? "not set" : raw };
  });
}

type Listener = (key: SettingKey) => void;

const listeners = new Set<Listener>();

/** Timers and the logger re-read their setting when it changes. Returns the unsubscribe. */
export function onSettingChange(listener: Listener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

function write(
  kernel: Kernel,
  context: CommandContext,
  scope: string,
  idempotencyKey: string,
  key: SettingKey,
  value: unknown,
): Result<{ key: SettingKey }> {
  const now = new Date(kernel.clock.now()).toISOString();
  const result = runCommand<{ key: SettingKey }>(
    kernel,
    { scope, key: idempotencyKey, resultId: SETTINGS_STREAM_ID },
    (tx) => {
      if (value === undefined) {
        tx.prepare(`DELETE FROM runtime_kv WHERE key = ?`).run(storageKey(key));
      } else {
        tx.prepare(
          `INSERT INTO runtime_kv (key, value_version, value_json, updated_at)
             VALUES (?, 1, ?, ?)
           ON CONFLICT (key) DO UPDATE SET
             value_version = value_version + 1,
             value_json = excluded.value_json,
             updated_at = excluded.updated_at`,
        ).run(storageKey(key), JSON.stringify(value), now);
      }

      return ok({
        value: { key },
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "settings",
            streamId: SETTINGS_STREAM_ID,
            type: "settings.changed.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            // The key and whether it was reset, never the value: a value can be a host list.
            payload: { key, reset: value === undefined },
            correlationId: context.correlationId,
            occurredAt: now,
          },
        ],
      });
    },
  );

  if (result.ok) {
    for (const listener of listeners) {
      listener(key);
    }
  }

  return result;
}

export function setSetting(
  kernel: Kernel,
  context: CommandContext,
  command: SetSettingCommand,
): Result<{ key: SettingKey }> {
  return write(kernel, context, "settings.set", command.idempotencyKey, command.key, command.value);
}

export function resetSetting(
  kernel: Kernel,
  context: CommandContext,
  command: ResetSettingCommand,
): Result<{ key: SettingKey }> {
  return write(kernel, context, "settings.reset", command.idempotencyKey, command.key, undefined);
}

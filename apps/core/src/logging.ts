import type { Clock } from "@noctis/domain";
import { systemClock } from "@noctis/domain";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  log(level: LogLevel, message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Read for every line; overrides `level`. The core passes its `logLevel` setting. */
  levelOf?: () => LogLevel;
  /** Defaults to stdout. Tests pass a collector. */
  sink?: (line: string) => void;
  base?: LogFields;
  clock?: Clock;
}

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const REDACTED = "[redacted]";

/**
 * Section 9.2: logs contain no access tokens, recovery keys, secrets, or
 * unbounded prompt bodies. Matched on the key, case-insensitively, because the
 * value of a secret is by definition not recognisable by shape.
 */
const SENSITIVE_KEY =
  /(token|secret|password|passphrase|credential|api[-_]?key|recovery|cookie|authorization|prompt)/i;

/** Long enough for a summary, short enough that no prompt body reaches a log file. */
const MAX_STRING_LENGTH = 512;
const MAX_DEPTH = 4;

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated ${String(value.length - MAX_STRING_LENGTH)}]`
      : value;
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (depth >= MAX_DEPTH) {
    return "[truncated]";
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(key) ? REDACTED : redact(entry, depth + 1),
    ]),
  );
}

export function createLogger(options: LoggerOptions = {}): Logger {
  // The setting, when there is one, is read per line, so a change on the
  // Settings page takes effect without rebuilding every logger the core holds.
  const levelOf = options.levelOf ?? ((): LogLevel => options.level ?? "info");
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`));
  const base = options.base ?? {};
  const clock = options.clock ?? systemClock;

  return {
    log(entryLevel, message, fields = {}) {
      if (LEVEL_ORDER[entryLevel] < LEVEL_ORDER[levelOf()]) {
        return;
      }

      sink(
        JSON.stringify({
          at: new Date(clock.now()).toISOString(),
          level: entryLevel,
          message,
          ...(redact({ ...base, ...fields }) as LogFields),
        }),
      );
    },
    child(fields) {
      return createLogger({ ...options, base: { ...base, ...fields } });
    },
  };
}

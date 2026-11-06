import type { GlucoseLive } from "@noctis/contracts";

import type { NoctisDatabase } from "../db/connection.js";
import type { DexcomReading } from "./dexcom.js";
import type { DexcomCredentials } from "./dexcom-credentials.js";
import { createDexcomCredentials } from "./dexcom-credentials.js";

const CACHE_KEY = "dexcom:latest";
/** The G7 itself only has something new every 5 minutes; no point polling faster. */
const POLL_INTERVAL_MS = 5 * 60_000;
/** Past this, the phone or sensor has probably dropped; say so rather than show a quiet number. */
const STALE_MS = 15 * 60_000;

interface Cache {
  reading?: DexcomReading;
  lastPollAt?: string;
  lastPollFailed?: boolean;
}

export interface DexcomServiceDeps {
  db: NoctisDatabase;
  databasePath: string;
  clock: { now: () => number };
  fetchLatestReading: (credentials: DexcomCredentials) => Promise<DexcomReading>;
}

export interface DexcomService {
  live(): GlucoseLive;
  pass(): void;
  setCredentials(credentials: DexcomCredentials): Promise<void>;
  clearCredentials(): void;
}

export function createDexcomService(deps: DexcomServiceDeps): DexcomService {
  const credentials = createDexcomCredentials({ db: deps.db, databasePath: deps.databasePath });
  const iso = (): string => new Date(deps.clock.now()).toISOString();

  function readCache(): Cache {
    const row = deps.db
      .prepare("SELECT value_json FROM runtime_kv WHERE key = ?")
      .get(CACHE_KEY) as { value_json: string } | undefined;
    return row === undefined ? {} : (JSON.parse(row.value_json) as Cache);
  }

  function writeCache(cache: Cache): void {
    deps.db
      .prepare(
        `INSERT INTO runtime_kv (key, value_version, value_json, updated_at)
           VALUES (?, 1, ?, ?)
         ON CONFLICT (key) DO UPDATE SET
           value_version = value_version + 1,
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      )
      .run(CACHE_KEY, JSON.stringify(cache), iso());
  }

  async function attempt(): Promise<void> {
    const stored = credentials.readCredentials();
    if (stored === undefined) return;
    try {
      const reading = await deps.fetchLatestReading(stored);
      writeCache({ reading, lastPollAt: iso(), lastPollFailed: false });
    } catch {
      writeCache({ ...readCache(), lastPollFailed: true });
    }
  }

  return {
    live() {
      if (!credentials.hasCredentials()) return { state: "not_configured" };
      const cache = readCache();
      if (cache.reading === undefined) return { state: "error", reason: "no reading yet" };
      const age = deps.clock.now() - Date.parse(cache.reading.at);
      const stale = cache.lastPollFailed === true || age > STALE_MS;
      return { state: stale ? "stale" : "ok", ...cache.reading };
    },

    pass() {
      if (!credentials.hasCredentials()) return;
      const cache = readCache();
      if (
        cache.lastPollAt !== undefined &&
        deps.clock.now() - Date.parse(cache.lastPollAt) < POLL_INTERVAL_MS
      )
        return;
      writeCache({ ...cache, lastPollAt: iso() });
      void attempt();
    },

    async setCredentials(newCredentials) {
      const reading = await deps.fetchLatestReading(newCredentials);
      credentials.setCredentials(newCredentials);
      writeCache({ reading, lastPollAt: iso(), lastPollFailed: false });
    },

    clearCredentials() {
      credentials.clearCredentials();
      deps.db.prepare("DELETE FROM runtime_kv WHERE key = ?").run(CACHE_KEY);
    },
  };
}

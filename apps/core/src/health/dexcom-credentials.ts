import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { NoctisDatabase } from "../db/connection.js";

const STORAGE_KEY = "dexcom:credentials";
const ALGORITHM = "aes-256-gcm";

export interface DexcomCredentialsDeps {
  db: NoctisDatabase;
  /** Its sibling file holds the encryption key; ":memory:" gets a process-local key. */
  databasePath: string;
}

export interface DexcomCredentials {
  username: string;
  password: string;
}

export interface DexcomCredentialsStore {
  hasCredentials(): boolean;
  readCredentials(): DexcomCredentials | undefined;
  setCredentials(credentials: DexcomCredentials): void;
  clearCredentials(): void;
}

function keyFile(databasePath: string): string | undefined {
  return databasePath === ":memory:" ? undefined : join(dirname(databasePath), "dexcom.key");
}

function loadOrCreateKey(path: string | undefined): Buffer {
  if (path === undefined) return randomBytes(32);
  if (existsSync(path)) return readFileSync(path);
  const key = randomBytes(32);
  writeFileSync(path, key, { mode: 0o600 });
  return key;
}

function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

function decrypt(key: Buffer, encoded: string): string {
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function createDexcomCredentials(deps: DexcomCredentialsDeps): DexcomCredentialsStore {
  const key = loadOrCreateKey(keyFile(deps.databasePath));

  function row(): { value_json: string } | undefined {
    return deps.db
      .prepare("SELECT value_json FROM runtime_kv WHERE key = ?")
      .get(STORAGE_KEY) as { value_json: string } | undefined;
  }

  return {
    hasCredentials: () => row() !== undefined,

    readCredentials() {
      const stored = row();
      if (stored === undefined) return undefined;
      const { username, password } = JSON.parse(stored.value_json) as {
        username: string;
        password: string;
      };
      return { username: decrypt(key, username), password: decrypt(key, password) };
    },

    setCredentials(credentials) {
      const now = new Date().toISOString();
      const value = JSON.stringify({
        username: encrypt(key, credentials.username),
        password: encrypt(key, credentials.password),
      });
      deps.db
        .prepare(
          `INSERT INTO runtime_kv (key, value_version, value_json, updated_at)
             VALUES (?, 1, ?, ?)
           ON CONFLICT (key) DO UPDATE SET
             value_version = value_version + 1,
             value_json = excluded.value_json,
             updated_at = excluded.updated_at`,
        )
        .run(STORAGE_KEY, value, now);
    },

    clearCredentials() {
      deps.db.prepare("DELETE FROM runtime_kv WHERE key = ?").run(STORAGE_KEY);
    },
  };
}

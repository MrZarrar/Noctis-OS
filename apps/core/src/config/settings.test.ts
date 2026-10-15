import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createIdFactory } from "@noctis/domain";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../db/connection.js";
import type { NoctisDatabase } from "../db/connection.js";
import { migrate } from "../db/migrate.js";
import { createEventBroker } from "../events/broker.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { createLogger } from "../logging.js";
import {
  listSettings,
  onSettingChange,
  readSetting,
  resetSetting,
  setSetting,
  startUpSettings,
} from "./settings.js";

const context: CommandContext = {
  correlationId: "01941f29-7c00-7000-8000-0000000000ff",
  actorType: "user",
  actorId: "local",
};

let directories: string[] = [];
let databases: NoctisDatabase[] = [];

afterEach(() => {
  for (const db of databases) db.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  databases = [];
  directories = [];
});

function makeKernel(): Kernel {
  const directory = mkdtempSync(join(tmpdir(), "noctis-settings-"));
  directories.push(directory);
  const db = openDatabase(join(directory, "core.db"));
  databases.push(db);
  let now = Date.parse("2026-10-15T09:00:00.000Z");
  const clock = { now: () => (now += 1) };
  migrate(db, { directory: join(process.cwd(), "apps/core/migrations"), clock });

  return {
    db,
    clock,
    ids: createIdFactory(clock),
    broker: createEventBroker(),
    logger: createLogger({ sink: () => undefined, level: "error" }),
  };
}

describe("a setting", () => {
  it("answers the UI value, else the environment, else the default", () => {
    const kernel = makeKernel();
    const env = { NOCTIS_SESSION_TTL_HOURS: "48" };

    expect(readSetting(kernel.db, {}, "sessionTtlHours")).toBe(720);
    expect(readSetting(kernel.db, env, "sessionTtlHours")).toBe(48);

    expect(
      setSetting(kernel, context, { idempotencyKey: "s1", key: "sessionTtlHours", value: 12 }).ok,
    ).toBe(true);
    expect(readSetting(kernel.db, env, "sessionTtlHours")).toBe(12);

    resetSetting(kernel, context, { idempotencyKey: "s2", key: "sessionTtlHours" });
    expect(readSetting(kernel.db, env, "sessionTtlHours")).toBe(48);
  });

  it("ignores a bad environment value, and says so", () => {
    const kernel = makeKernel();
    const env = { NOCTIS_DIGEST_AT: "noon" };

    expect(readSetting(kernel.db, env, "digestAt")).toBe("");
    expect(listSettings(kernel.db, env).find((s) => s.key === "digestAt")).toMatchObject({
      value: "",
      source: "default",
      ignoredStartUp: "noon",
    });
  });

  it("reads the booleans the way their environment variables did", () => {
    const kernel = makeKernel();

    expect(readSetting(kernel.db, { NOCTIS_VAULT_ALLOW_WRITES: "true" }, "vaultWrites")).toBe(true);
    expect(readSetting(kernel.db, { NOCTIS_VAULT_ALLOW_WRITES: "1" }, "vaultWrites")).toBe(false);
    expect(readSetting(kernel.db, { VITE_NOCTIS_ALL_PAGES: "1" }, "showAllPages")).toBe(true);
  });

  it("says where each value came from", () => {
    const kernel = makeKernel();
    setSetting(kernel, context, { idempotencyKey: "s1", key: "logLevel", value: "warn" });

    const listed = listSettings(kernel.db, { NOCTIS_DIGEST_AT: "21:30" });

    expect(listed.find((s) => s.key === "logLevel")).toMatchObject({ value: "warn", source: "ui" });
    expect(listed.find((s) => s.key === "digestAt")).toMatchObject({
      value: "21:30",
      source: "start-up",
    });
    expect(listed.find((s) => s.key === "vaultWrites")).toMatchObject({
      value: false,
      source: "default",
    });
  });

  it("reports secrets as set, never their values", () => {
    const listed = JSON.stringify(
      startUpSettings({
        NOCTIS_CORE_TOKEN: "s3cret-token",
        NOCTIS_CORE_PORT: "7717",
        NOCTIS_VAPID_PRIVATE_KEY: "k3y",
      }),
    );

    expect(listed).toContain('{"name":"NOCTIS_CORE_PORT","value":"7717"}');
    expect(listed).toContain('{"name":"NOCTIS_CORE_TOKEN","value":"set"}');
    expect(listed).toContain('{"name":"NOCTIS_GATEWAY_PROVISIONER_KEY_FILE","value":"not set"}');
    expect(listed).not.toContain("s3cret");
    expect(listed).not.toContain("k3y");
  });

  it("never shows where the Vault, the database or the page live, as GET /vault never does", () => {
    const listed = JSON.stringify(
      startUpSettings({
        NOCTIS_VAULT_ROOT: "C:\\Users\\owner\\OneDrive\\MindVault",
        NOCTIS_DATABASE_PATH: "C:\\noctis\\core.db",
        NOCTIS_WEB_ROOT: "C:\\noctis\\web",
      }),
    );

    expect(listed).toContain('{"name":"NOCTIS_VAULT_ROOT","value":"set"}');
    expect(listed).toContain('{"name":"NOCTIS_DATABASE_PATH","value":"set"}');
    expect(listed).not.toContain("MindVault");
    expect(listed).not.toContain("core.db");
    expect(listed).not.toContain("noctis");
  });

  it("tells listeners which setting changed, once it is saved", () => {
    const kernel = makeKernel();
    const heard: string[] = [];
    const stop = onSettingChange((key) => heard.push(key));

    setSetting(kernel, context, { idempotencyKey: "s1", key: "digestAt", value: "21:30" });
    resetSetting(kernel, context, { idempotencyKey: "s2", key: "digestAt" });
    stop();
    setSetting(kernel, context, { idempotencyKey: "s3", key: "digestAt", value: "22:00" });

    expect(heard).toEqual(["digestAt", "digestAt"]);
  });
});

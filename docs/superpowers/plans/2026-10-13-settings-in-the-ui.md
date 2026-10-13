# Settings in the UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the owner might want to change about how Noctis behaves is changed on the Settings page, takes effect without a restart, and the settings that must stay at start-up are at least visible there.

**Architecture:** A `settings` table holds the owner's values. A typed registry in `apps/core/src/config/settings.ts` names each setting, its zod schema, the environment variable it replaces, and its default; `readSetting` answers UI value, else environment, else default, so existing deployments keep working unchanged. `GET /settings` and the `settings.set` / `settings.reset` commands back a new "How Noctis runs" section on the Settings page. Consumers read the setting when they act (a timer when it schedules, a login when it issues a cookie), and a change notifies the timers to reschedule.

**Tech Stack:** TypeScript, `node:sqlite`, zod 4, vitest 4, React 18. No new dependencies.

**Spec:** The owner, 2026-10-13: "any config should be able to be done via the ui, perhaps in the settings page, not in code — this applies to any other existing config settings that are currently in code and not ui".

## Global Constraints

- Node.js 22.23.2, exact package lock, no new packages. Failing test first.
- Precedence is always: value set in the UI, else the environment variable, else the default. Removing a UI value ("Reset") falls back.
- Secrets never leave the core: `NOCTIS_CORE_TOKEN`, the VAPID private key and the gateway key file are reported as "set" or "not set", never their values.
- Settings that the core needs before it can serve a page stay in the environment: `NOCTIS_CORE_PORT`, `NOCTIS_CORE_BIND`, `NOCTIS_ALLOW_NON_LOOPBACK`, `NOCTIS_DATABASE_PATH`, `NOCTIS_WEB_ROOT`, `NOCTIS_ALLOWED_ORIGINS`, `NOCTIS_CORE_TOKEN`, `NOCTIS_VAPID_*`, `NOCTIS_GATEWAY_PROVISIONER_KEY_FILE`.
- Changing a setting is a command like any other: idempotent, audited by its event.

## Review Focus

1. **A malformed value typed in the UI** ("25:00", "-3" hours): refused by the command with a message, the old value kept. (Task 1 test "refuses a value its schema rejects".)
2. **A malformed environment value with no UI value**: falls back to the default rather than crashing the read, and `GET /settings` says the environment value was ignored. (Task 1 test "ignores a bad environment value".)
3. **Changing the digest time while a timer is pending**: the old timer is cleared, so the digest is not sent twice. (Task 2 test "reschedules once when the time changes".)
4. **A secret's value reaching the browser**: `GET /settings` never contains the token or a key. (Task 1 test "reports secrets as set, never their values".)
5. **Turning Vault writes off mid-run**: the next write is refused; nothing cached the old value. (Task 2 test "a write after writes are turned off is refused".)

---

## The settings

| Key               | Kind                                      | Replaces                               | Default | Read by                                         |
| ----------------- | ----------------------------------------- | -------------------------------------- | ------- | ----------------------------------------------- |
| `digestAt`        | time `HH:MM` or empty (off)               | `NOCTIS_DIGEST_AT`                     | off     | digest timer, `server.ts`                       |
| `promoterAt`      | time or empty                             | `NOCTIS_PROMOTER_AT` (new)             | off     | promoter timer (Vault promoter plan, Task 4)    |
| `vaultWrites`     | boolean                                   | `NOCTIS_VAULT_ALLOW_WRITES=true`       | false   | `writesEnabled` callers via `deps.vaultEnv`     |
| `sessionTtlHours` | integer 1–8760                            | `NOCTIS_SESSION_TTL_HOURS`             | 720     | login, `http.ts:2490`                           |
| `logLevel`        | `debug` `info` `warn` `error`             | `NOCTIS_LOG_LEVEL`                     | `info`  | the core logger                                 |
| `showAllPages`    | boolean                                   | `VITE_NOCTIS_ALL_PAGES=1` (build time) | false   | the web rail                                    |
| `remoteDesktops`  | list of `{host, gatewayUrl, destination}` | `NOCTIS_REMOTE_DESKTOPS`               | empty   | remote desktop (the key file stays at start-up) |

Not in this plan, and why: the Vault location and live switch (`NOCTIS_VAULT_ROOT`, `NOCTIS_VAULT_ALLOW_LIVE`) change what is indexed and need a reindex flow of their own; identity cards and the node tool paths (`NOCTIS_IDENTITY_CARDS`, `NOCTIS_CODEX_PATH`, `NOCTIS_HERMES_PATH`, `NOCTIS_FFMPEG`, `NOCTIS_LOCAL_MODEL_URL`) are read by each node, so they belong on the Nodes page with a node-side setting channel. Both are follow-up plans.

---

### Task 1: The settings store and API

**Files:**

- Create: `apps/core/migrations/0018_settings.sql`
- Create: `apps/core/src/config/settings.ts`, `apps/core/src/config/settings.test.ts`
- Modify: `packages/contracts/src/command.ts` (`SetSettingCommandSchema`, `ResetSettingCommandSchema`, names `"settings.set"`, `"settings.reset"`)
- Modify: `apps/core/src/api/http.ts` (`GET /settings`, the two commands); `packages/contracts/src/api.ts` (`"settings"` in the API path list)
- Modify: `apps/core/src/db/migrate.test.ts`, `apps/core/src/api/headless.integration.test.ts:333` (schema version 18)

**Interfaces:**

```ts
export type SettingKey =
  | "digestAt"
  | "promoterAt"
  | "vaultWrites"
  | "sessionTtlHours"
  | "logLevel"
  | "showAllPages"
  | "remoteDesktops";
export interface SettingView {
  key: SettingKey;
  label: string;
  help: string;
  kind: "time" | "boolean" | "integer" | "choice" | "list";
  choices?: string[];
  value: unknown;
  source: "ui" | "start-up" | "default";
  ignoredStartUp?: string;
}
export function readSetting<K extends SettingKey>(
  db: NoctisDatabase,
  env: Env,
  key: K,
): SettingValue<K>;
export function listSettings(db: NoctisDatabase, env: Env): SettingView[];
export function startUpSettings(env: Env): Array<{ name: string; value: string }>;
export function setSetting(
  kernel: Kernel,
  context: CommandContext,
  command: SetSettingCommand,
): Result<SettingView>;
export function resetSetting(
  kernel: Kernel,
  context: CommandContext,
  command: ResetSettingCommand,
): Result<SettingView>;
export function onSettingChange(listener: (key: SettingKey) => void): () => void;
```

- [ ] **Step 1: Migration**

```sql
-- apps/core/migrations/0018_settings.sql
-- The owner's settings, set on the Settings page. A key with no row falls back
-- to its environment variable, then its default (config/settings.ts).
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

- [ ] **Step 2: Failing tests** (`settings.test.ts`, kernel helper copied from `vault.integration.test.ts`)

```ts
it("answers the UI value, else the environment, else the default", () => {
  const kernel = makeKernel();
  expect(readSetting(kernel.db, {}, "sessionTtlHours")).toBe(720);
  expect(readSetting(kernel.db, { NOCTIS_SESSION_TTL_HOURS: "48" }, "sessionTtlHours")).toBe(48);
  setSetting(kernel, context, { idempotencyKey: "s1", key: "sessionTtlHours", value: 12 });
  expect(readSetting(kernel.db, { NOCTIS_SESSION_TTL_HOURS: "48" }, "sessionTtlHours")).toBe(12);
  resetSetting(kernel, context, { idempotencyKey: "s2", key: "sessionTtlHours" });
  expect(readSetting(kernel.db, { NOCTIS_SESSION_TTL_HOURS: "48" }, "sessionTtlHours")).toBe(48);
});

it("refuses a value its schema rejects", () => {
  const kernel = makeKernel();
  expect(
    setSetting(kernel, context, { idempotencyKey: "s1", key: "digestAt", value: "25:00" }).ok,
  ).toBe(false);
  expect(readSetting(kernel.db, {}, "digestAt")).toBe("");
});

it("ignores a bad environment value", () => {
  const kernel = makeKernel();
  expect(readSetting(kernel.db, { NOCTIS_DIGEST_AT: "noon" }, "digestAt")).toBe("");
  expect(
    listSettings(kernel.db, { NOCTIS_DIGEST_AT: "noon" }).find((s) => s.key === "digestAt")
      ?.ignoredStartUp,
  ).toBe("noon");
});

it("reads the booleans the way their environment variables did", () => {
  const kernel = makeKernel();
  expect(readSetting(kernel.db, { NOCTIS_VAULT_ALLOW_WRITES: "true" }, "vaultWrites")).toBe(true);
  expect(readSetting(kernel.db, { NOCTIS_VAULT_ALLOW_WRITES: "1" }, "vaultWrites")).toBe(false);
});

it("reports secrets as set, never their values", () => {
  const listed = JSON.stringify(
    startUpSettings({
      NOCTIS_CORE_TOKEN: "s3cret-token",
      NOCTIS_CORE_PORT: "7717",
      NOCTIS_VAPID_PRIVATE_KEY: "k3y",
    }),
  );
  expect(listed).toContain('"NOCTIS_CORE_PORT","value":"7717"');
  expect(listed).toContain('"NOCTIS_CORE_TOKEN","value":"set"');
  expect(listed).not.toContain("s3cret");
  expect(listed).not.toContain("k3y");
});

it("tells listeners which setting changed", () => {
  const kernel = makeKernel();
  const heard: string[] = [];
  const stop = onSettingChange((key) => heard.push(key));
  setSetting(kernel, context, { idempotencyKey: "s1", key: "digestAt", value: "21:30" });
  stop();
  expect(heard).toEqual(["digestAt"]);
});
```

- [ ] **Step 3: Run, see them fail** — `npx vitest run apps/core/src/config/settings.test.ts`.

- [ ] **Step 4: Implement `settings.ts`**

```ts
const TIME = z.union([z.literal(""), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)]);
const TARGETS = RemoteDesktopTargetsSchema; // exported from config/server.ts

const REGISTRY = {
  digestAt: {
    schema: TIME,
    env: "NOCTIS_DIGEST_AT",
    fromEnv: (v: string) => v.trim(),
    fallback: "",
    kind: "time",
    label: "Daily digest",
    help: "When your phones get the day's summary. Empty is off.",
  },
  promoterAt: {
    schema: TIME,
    env: "NOCTIS_PROMOTER_AT",
    fromEnv: (v: string) => v.trim(),
    fallback: "",
    kind: "time",
    label: "File the inbox nightly",
    help: "When Vesper files new inbox notes into the Vault. Empty is off.",
  },
  vaultWrites: {
    schema: z.boolean(),
    env: "NOCTIS_VAULT_ALLOW_WRITES",
    fromEnv: (v: string) => v === "true",
    fallback: false,
    kind: "boolean",
    label: "Let Noctis write to the Vault",
    help: "The Agent Brain, and what the promoter files. Never your own text without asking.",
  },
  sessionTtlHours: {
    schema: z.int().min(1).max(8760),
    env: "NOCTIS_SESSION_TTL_HOURS",
    fromEnv: (v: string) => Number(v),
    fallback: 720,
    kind: "integer",
    label: "Stay logged in for (hours)",
    help: "Applies to the next login on each device.",
  },
  logLevel: {
    schema: z.enum(["debug", "info", "warn", "error"]),
    env: "NOCTIS_LOG_LEVEL",
    fromEnv: (v: string) => v.trim(),
    fallback: "info",
    kind: "choice",
    label: "Core log detail",
    help: "How much the core writes to its log.",
  },
  showAllPages: {
    schema: z.boolean(),
    env: "VITE_NOCTIS_ALL_PAGES",
    fromEnv: (v: string) => v === "1",
    fallback: false,
    kind: "boolean",
    label: "Show unfinished pages",
    help: "Command, Missions, Artifacts and Automations in the rail.",
  },
  remoteDesktops: {
    schema: TARGETS,
    env: "NOCTIS_REMOTE_DESKTOPS",
    fromEnv: (v: string) => JSON.parse(v) as unknown,
    fallback: [],
    kind: "list",
    label: "Remote desktops",
    help: "Hosts the Nodes page can open. The gateway key stays a start-up setting.",
  },
} as const;
```

`readSetting`: row → `schema.safeParse(JSON.parse(value_json))`; else env → `try { schema.safeParse(fromEnv(raw)) } catch {}`; else `fallback`. `setSetting` is a `runCommand` with scope `settings.set`, validates, upserts, and emits `settings.changed.v1` with `{ key }`; after commit, call each listener. `startUpSettings` lists the start-up names from Global Constraints, printing the value for non-secrets and `"set"`/`"not set"` for `NOCTIS_CORE_TOKEN`, `NOCTIS_VAPID_PRIVATE_KEY`, `NOCTIS_GATEWAY_PROVISIONER_KEY_FILE`.

`http.ts`: `GET /settings` → `{ settings: listSettings(db, env), startUp: startUpSettings(env) }` (the env is `deps.vaultEnv`'s source; read how `server.ts` passes `env` into `ApiDeps` and add `env` if absent). Commands register with `defineDepsCommand` like `vault.reindex`.

- [ ] **Step 5: Pass**; bump schema version tests to 18; `npx vitest run apps/core packages/contracts`.
- [ ] **Step 6: Commit** — `feat(core): settings the owner sets in the UI, falling back to the environment`

### Task 2: The core reads its settings live

**Files:** `apps/core/src/server.ts` (digest timer, logger, `vaultEnv` getter), `apps/core/src/logging.ts` (`levelOf` option), `apps/core/src/api/http.ts:2490-2494` (session TTL), `apps/core/src/config/server.ts` + remote desktop readers (targets from the setting; the key still from env).
**Tests:** `apps/core/src/settings.integration.test.ts` (start a core the way `headless.integration.test.ts` does).

- [ ] **Step 1: Failing tests**

```ts
it("a write after writes are turned off is refused", async () => {
  const core = await startTestCore(
    {},
    { NOCTIS_VAULT_ROOT: vault, NOCTIS_VAULT_ALLOW_WRITES: "true" },
  );
  expect((await read(core, "/vault")).body.writesEnabled).toBe(true);
  await command(core, "settings.set", { idempotencyKey: "w0", key: "vaultWrites", value: false });
  expect((await read(core, "/vault")).body.writesEnabled).toBe(false);
});

it("issues a login cookie for the hours set in the UI", async () => {
  const core = await startTestCore();
  await command(core, "settings.set", { idempotencyKey: "t1", key: "sessionTtlHours", value: 2 });
  const login = await logIn(core); // the existing login helper in headless.integration.test.ts
  expect(login.headers.get("set-cookie")).toContain("Max-Age=7200");
});

it("reschedules once when the time changes", () => {
  const timers = fakeTimers(); // vi.useFakeTimers(); count setTimeout/clearTimeout calls
  const schedule = createDailyTimer({
    clock,
    at: () => readSetting(db, {}, "digestAt"),
    run: () => sent.push(1),
  });
  setSetting(kernel, context, { idempotencyKey: "a", key: "digestAt", value: "21:30" });
  setSetting(kernel, context, { idempotencyKey: "b", key: "digestAt", value: "22:00" });
  vi.advanceTimersByTime(24 * 3_600_000);
  expect(sent).toHaveLength(1);
});
```

- [ ] **Step 2: Implement.**
  - Extract the digest's schedule-and-reschedule loop into `createDailyTimer({ clock, at, run })` in `apps/core/src/notify/daily.ts`: `start()`, `restart()`, `stop()`; it clears its pending timeout on `restart`. `server.ts` makes one for the digest (`at: () => readSetting(db, env, "digestAt")`) and subscribes `onSettingChange((key) => key === "digestAt" && digest.restart())`. The promoter plan's Task 4 makes the second one with `promoterAt`.
  - `ApiDeps.vaultEnv` becomes a getter: `get vaultEnv() { return { ...env, NOCTIS_VAULT_ALLOW_WRITES: readSetting(db, env, "vaultWrites") ? "true" : undefined }; }`, so every `writesEnabled(deps.vaultEnv)` call reads the live value with no other change.
  - Login uses `readSetting(deps.kernel.db, deps.env, "sessionTtlHours")` instead of `deps.config.sessionTtlHours`.
  - `createLogger` takes `levelOf?: () => LogLevel`; the core passes `() => readSetting(db, env, "logLevel")`.
  - Remote desktop: `listRemoteHosts` and `openRemoteDesktop` take targets from `readSetting(db, env, "remoteDesktops")`; `parseRemoteDesktop` keeps loading the key file and no longer requires the targets env var.
- [ ] **Step 3: Pass**; `npx vitest run apps/core`.
- [ ] **Step 4: Commit** — `feat(core): digest, Vault writes, login length, log level and remote hosts follow Settings live`

### Task 3: The Settings page section

**Files:** Create `apps/web/src/pages/CoreSettings.tsx`, `apps/web/src/pages/CoreSettings.test.ts`; modify `apps/web/src/pages/Settings.tsx` (render it first), `apps/web/src/App.tsx:63` (`showAllPages` from `GET /settings`, falling back to the build flag).

- [ ] **Step 1: Failing test** — render `CoreSettingsView({ settings, startUp, onSet, onReset })` (presentational) and assert: a `type="time"` input for `digestAt`; a checkbox for `vaultWrites`; a number input for `sessionTtlHours`; a `select` for `logLevel`; "Reset" shown only where `source === "ui"`; a line "from start-up: noon (ignored, not a time)" when `ignoredStartUp` is set; a read-only "Set at start-up" list with `NOCTIS_CORE_TOKEN — set`.
- [ ] **Step 2: Implement** — the container fetches `GET /settings`, sends `settings.set` on change (time and number on blur, others on change) and `settings.reset`, and re-reads after each. Remote desktops render as rows of three text fields with Add and Remove, saved as one list.
- [ ] **Step 3: Pass**; `npx vitest run apps/web/src`.
- [ ] **Step 4: Commit** — `feat(web): How Noctis runs, on the Settings page`

### Task 4: Record

- [ ] Status log entry with the clause table and commands. Note for the owner: nothing changes on deploy (no UI values yet, so the environment still answers); from then on, change things on the Settings page, and remove the matching lines from the deploy script once set in the UI.
- [ ] Commit and push — `docs: record settings in the UI`.

# Noctis OS Phase 1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the validated contract language, deterministic transition model, migration ledger, and atomic state-plus-event commit that every later Noctis phase compiles against.

**Architecture:** Zod schemas in `packages/contracts` are the single runtime authority; `packages/domain` holds pure functions that return a `Result` union instead of throwing; `apps/core/src/db` owns a `node:sqlite` connection seam, a checksummed migration ledger, and one transaction helper that commits relational state and its audit event together or not at all.

**Tech Stack:** TypeScript 6.0.3 (ESM, NodeNext), Zod 4.4.3, Vitest 4.1.11, `node:sqlite` (built-in), `uuid` 14 (UUIDv7), Node 22.x.

**Spec:** [`docs/superpowers/specs/2026-09-01-noctis-phase-1-foundation-design.md`](../specs/2026-09-01-noctis-phase-1-foundation-design.md)

## Global Constraints

Every task's requirements implicitly include this section.

- **Node:** `engines` is `22.x`; CI pins `22.23.2`. Local development runs 24.19.0, so local green does not prove the pinned runtime. CI is authoritative.
- **Module system:** ESM with `"module": "NodeNext"`. Every relative import ends in `.js`, even when importing a `.ts` file. Example: `import { ok } from "./result.js";`
- **Type imports:** ESLint enforces `@typescript-eslint/consistent-type-imports`. Import types with `import type { Foo } from "..."`. Mixing a type into a value import fails lint.
- **Strictness:** `strict`, `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess` are all on. Indexing a record returns `T | undefined` and must be narrowed before use.
- **Schemas:** Every Zod object schema ends in `.strict()` so unknown fields fail closed.
- **Timestamps:** UTC ISO 8601 only, validated with `z.iso.datetime({ offset: true })`.
- **IDs:** UUIDv7, validated with `z.uuidv7()`. This rejects a v4 UUID, which is intended.
- **Tests:** Colocated as `*.test.ts` beside the file under test. Vitest picks up `{apps,packages}/**/*.test.ts`.
- **Formatting:** Run `npm run format` before every commit. `format:check` runs in CI and a markdown table edit is enough to fail it.
- **Secrets:** Never stored in SQLite or in JSON columns.
- **Verification before commit:** `npm run format:check && npm run lint && npm run typecheck && npm run test:unit` must pass.

## File Structure

**`packages/contracts/src/`** — runtime authority for every shape crossing a boundary.

| File            | Responsibility                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `primitives.ts` | Shared scalars: `UtcTimestamp`, `Uuid`, `Revision`, `IdempotencyKey`, `SchemaVersion`                               |
| `enums.ts`      | Every closed enum: identities, protocol, attention, all five status sets, Surface role/persistence, operation class |
| `objective.ts`  | `ObjectiveRecord`, objective links (exists; refactored onto `primitives.ts`)                                        |
| `mission.ts`    | `MissionRecord`, `MissionStep`, `MissionEvidence`                                                                   |
| `surface.ts`    | `SurfaceIntent`, `SurfaceOverride`, `CompositionPlan`                                                               |
| `node.ts`       | `NodeDescriptor`, `CapabilityGrant`, `NodeJob`                                                                      |
| `noir.ts`       | `NoirCase`, `Hypothesis`, `EvidenceItem`, `Falsifier`, `Uncertainty`                                                |
| `authority.ts`  | `AuthorityRequest`, `AuthorityDecision`, `StandingPermission`                                                       |
| `identity.ts`   | `IdentityProfile`, `ConversationThread`, `IdentityMessage`                                                          |
| `artifact.ts`   | `ArtifactRecord`                                                                                                    |
| `source.ts`     | `SourceRecord`, `SourceObservation`                                                                                 |
| `events.ts`     | `OrchestrationEvent` envelope and the frozen versioned event-name registry                                          |
| `ws.ts`         | Client and server WebSocket frame schemas (shape only; no transport this phase)                                     |

**`packages/domain/src/`** — pure logic, no I/O.

| File                         | Responsibility                                                      |
| ---------------------------- | ------------------------------------------------------------------- |
| `result.ts`                  | `Result<T>`, `DomainConflict`, `ok()`, `conflict()`                 |
| `clock.ts`                   | `Clock` interface, `systemClock`, `fixedClock`                      |
| `ids.ts`                     | `IdFactory` — UUIDv7 from an injected clock plus a sequence counter |
| `revision.ts`                | Optimistic revision check                                           |
| `state/transition.ts`        | `defineTransition`                                                  |
| `state/objective-status.ts`  | Objective machine (exists; rewritten to `Result`)                   |
| `state/mission-status.ts`    | Mission machine                                                     |
| `state/surface-lifecycle.ts` | Surface machine                                                     |
| `state/node-job-status.ts`   | node-job machine                                                    |
| `state/noir-case-status.ts`  | NOIR case machine                                                   |

**`apps/core/`** — the only place that touches SQLite.

| File                             | Responsibility                                                           |
| -------------------------------- | ------------------------------------------------------------------------ |
| `migrations/0001_foundation.sql` | All 26 tables, their foreign keys, and their indexes                     |
| `src/db/connection.ts`           | Opens the database and applies pragmas. The only file naming the driver. |
| `src/db/migrate.ts`              | Checksummed migration ledger                                             |
| `src/db/events.ts`               | Appends events and assigns the global sequence                           |
| `src/db/transactions.ts`         | Atomic state-plus-event commit and the post-commit delivery seam         |
| `src/db/idempotency.ts`          | Idempotency key lookup and insert                                        |

---

### Task 1: Resolve whether Node 22 requires `--experimental-sqlite`

This is first because its answer decides whether every test and run script carries a flag. It is settled empirically in CI, not assumed.

**Files:**

- Create: `apps/core/src/db/sqlite-availability.test.ts`
- Possibly modify: `.github/workflows/verify.yml`, `package.json`

**Interfaces:**

- Consumes: nothing
- Produces: a confirmed answer recorded in the spec's Section 8; possibly a `NODE_OPTIONS` setting every later task inherits

- [ ] **Step 1: Write the availability test**

```ts
// apps/core/src/db/sqlite-availability.test.ts
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

describe("node:sqlite availability", () => {
  it("opens an in-memory database and round-trips a row", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE probe (value TEXT NOT NULL)");
    db.prepare("INSERT INTO probe (value) VALUES (?)").run("ok");
    const row = db.prepare("SELECT value FROM probe").get() as { value: string };
    db.close();

    expect(row.value).toBe("ok");
  });
});
```

- [ ] **Step 2: Run it locally**

Run: `npx vitest run apps/core/src/db/sqlite-availability.test.ts`
Expected: PASS on Node 24 (the module is unflagged there). A local pass proves nothing about Node 22.

- [ ] **Step 3: Commit and push so CI evaluates it on Node 22.23.2**

```bash
npm run format
git add apps/core/src/db/sqlite-availability.test.ts
git commit -m "test: probe node:sqlite availability on the pinned runtime"
git push -u origin feat/phase-1-foundation
```

- [ ] **Step 4: Read the CI result**

Run: `gh run list --branch feat/phase-1-foundation --limit 1`
Then: `gh run view <run-id> --log-failed`

Expected, one of two outcomes:

- **`javascript` job PASSES** — Node 22.23.2 has `node:sqlite` unflagged. No flag is needed anywhere. Skip Step 5 and go to Step 6.
- **`javascript` job FAILS** with `ERR_UNKNOWN_BUILTIN_MODULE` or `No such built-in module: node:sqlite` — the flag is required. Do Step 5.

- [ ] **Step 5: Only if CI failed — add the flag**

Add `NODE_OPTIONS` to both jobs in `.github/workflows/verify.yml`, directly under the `runs-on` line of each job:

```yaml
jobs:
  javascript:
    runs-on: windows-latest
    env:
      NODE_OPTIONS: --experimental-sqlite
    steps:
```

```yaml
rust:
  runs-on: windows-latest
  env:
    NODE_OPTIONS: --experimental-sqlite
  steps:
```

The flag is accepted on Node 24 as well, so this is safe for local runs. Developers on Node 22 set the same variable in their shell:

```powershell
$env:NODE_OPTIONS = "--experimental-sqlite"
```

Then commit and push, and confirm the run goes green:

```bash
git add .github/workflows/verify.yml
git commit -m "ci: enable node:sqlite on the pinned Node 22 runtime"
git push
```

- [ ] **Step 6: Record the answer in the spec**

Replace Section 8's open question in `docs/superpowers/specs/2026-09-01-noctis-phase-1-foundation-design.md` with the confirmed result — either "Node 22.23.2 has `node:sqlite` unflagged; no flag is required" or "Node 22.23.2 requires `--experimental-sqlite`, set via `NODE_OPTIONS` in CI and locally" — and state the run ID that proved it.

```bash
npm run format
git add docs/superpowers/specs/2026-09-01-noctis-phase-1-foundation-design.md
git commit -m "docs: record the confirmed node:sqlite flag requirement"
```

---

### Task 2: `Result` and `DomainConflict`

**Files:**

- Create: `packages/domain/src/result.ts`
- Create: `packages/domain/src/result.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**

- Consumes: nothing
- Produces: `Result<T>`, `DomainConflict`, `ok<T>(value: T): Result<T>`, `conflict<T>(c: DomainConflict): Result<T>`. Every later domain function returns `Result<T>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/domain/src/result.test.ts
import { describe, expect, it } from "vitest";

import { conflict, ok } from "./result.js";

describe("Result", () => {
  it("wraps a success value", () => {
    const result = ok(42);

    expect(result.ok).toBe(true);
    expect(result.ok ? result.value : undefined).toBe(42);
  });

  it("wraps a forbidden transition conflict", () => {
    const result = conflict<number>({
      kind: "forbidden_transition",
      machine: "objective",
      from: "completed",
      to: "active",
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.conflict.kind).toBe("forbidden_transition");
  });

  it("wraps a revision conflict", () => {
    const result = conflict<number>({ kind: "revision_conflict", expected: 3, actual: 5 });

    expect(result.ok ? undefined : result.conflict).toEqual({
      kind: "revision_conflict",
      expected: 3,
      actual: 5,
    });
  });

  it("wraps an idempotent replay", () => {
    const result = conflict<number>({
      kind: "idempotent_replay",
      key: "abc",
      existingId: "01941f29-7c00-7000-8000-000000000000",
    });

    expect(result.ok ? undefined : result.conflict.kind).toBe("idempotent_replay");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run packages/domain/src/result.test.ts`
Expected: FAIL — cannot resolve `./result.js`.

- [ ] **Step 3: Implement**

```ts
// packages/domain/src/result.ts

/** An expected refusal. Never an exception: a refusal must produce no event. */
export type DomainConflict =
  | { kind: "forbidden_transition"; machine: string; from: string; to: string }
  | { kind: "revision_conflict"; expected: number; actual: number }
  | { kind: "idempotent_replay"; key: string; existingId: string };

export type Result<T> = { ok: true; value: T } | { ok: false; conflict: DomainConflict };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function conflict<T>(domainConflict: DomainConflict): Result<T> {
  return { ok: false, conflict: domainConflict };
}
```

- [ ] **Step 4: Export it**

```ts
// packages/domain/src/index.ts
export * from "./result.js";
export * from "./state/objective-status.js";
```

- [ ] **Step 5: Run tests and the full check**

Run: `npx vitest run packages/domain/src/result.test.ts`
Expected: PASS (4 tests)

Run: `npm run format:check && npm run lint && npm run typecheck && npm run test:unit`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
npm run format
git add packages/domain/src/result.ts packages/domain/src/result.test.ts packages/domain/src/index.ts
git commit -m "feat(domain): add Result union for expected refusals"
```

---

### Task 3: `Clock` and `IdFactory`

**Files:**

- Create: `packages/domain/src/clock.ts`, `packages/domain/src/ids.ts`
- Create: `packages/domain/src/ids.test.ts`
- Modify: `packages/domain/package.json`, `packages/domain/src/index.ts`

**Interfaces:**

- Consumes: nothing
- Produces: `Clock` (`{ now(): number }`), `systemClock`, `fixedClock(ms)`, `createIdFactory(clock, options?)` returning `{ nextId(): string }`. Every later task that needs an ID or a timestamp takes one of these by parameter — never `Date.now()` directly.

**Background:** `uuid`'s `v7()` accepts `{ msecs, seq, random }`. Verified behaviour: increasing `seq` inside one millisecond yields strictly ascending IDs across the full 0…0x7fffffff range, and any ID at `msecs + 1` sorts above every ID at `msecs`. The factory therefore needs a plain counter and no stall logic.

- [ ] **Step 1: Add the dependency**

```bash
npm install uuid@14.0.2 --workspace @noctis/domain
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/domain/src/ids.test.ts
import { describe, expect, it } from "vitest";

import { fixedClock } from "./clock.js";
import { createIdFactory } from "./ids.js";

const FIXED_RANDOM = new Uint8Array(16).fill(0);

describe("createIdFactory", () => {
  it("produces strictly ascending ids within one millisecond", () => {
    const factory = createIdFactory(fixedClock(1_735_689_600_000), { random: FIXED_RANDOM });
    const ids = [factory.nextId(), factory.nextId(), factory.nextId()];

    expect(ids[0] < ids[1]).toBe(true);
    expect(ids[1] < ids[2]).toBe(true);
  });

  it("produces ascending ids across a millisecond boundary", () => {
    let current = 1_735_689_600_000;
    const factory = createIdFactory({ now: () => current }, { random: FIXED_RANDOM });

    const first = factory.nextId();
    current += 1;
    const second = factory.nextId();

    expect(first < second).toBe(true);
  });

  it("is deterministic for the same clock and random source", () => {
    const a = createIdFactory(fixedClock(1_735_689_600_000), { random: FIXED_RANDOM }).nextId();
    const b = createIdFactory(fixedClock(1_735_689_600_000), { random: FIXED_RANDOM }).nextId();

    expect(a).toBe(b);
  });

  it("emits version 7 identifiers", () => {
    const id = createIdFactory(fixedClock(1_735_689_600_000), { random: FIXED_RANDOM }).nextId();

    expect(id[14]).toBe("7");
  });

  it("resets the counter when the clock advances", () => {
    let current = 1_735_689_600_000;
    const factory = createIdFactory({ now: () => current }, { random: FIXED_RANDOM });

    factory.nextId();
    factory.nextId();
    current += 1;
    const afterAdvance = factory.nextId();
    const sameMillisecond = factory.nextId();

    expect(afterAdvance < sameMillisecond).toBe(true);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `npx vitest run packages/domain/src/ids.test.ts`
Expected: FAIL — cannot resolve `./clock.js`.

- [ ] **Step 4: Implement the clock**

```ts
// packages/domain/src/clock.ts

/** Injected time source. Never call Date.now() directly in domain or core code. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export function fixedClock(milliseconds: number): Clock {
  return { now: () => milliseconds };
}
```

- [ ] **Step 5: Implement the id factory**

```ts
// packages/domain/src/ids.ts
import { v7 as uuidv7 } from "uuid";

import type { Clock } from "./clock.js";

export interface IdFactory {
  nextId(): string;
}

export interface IdFactoryOptions {
  /** Fixed bytes for deterministic tests. Omit in production to use the default CSPRNG. */
  random?: Uint8Array;
}

/** uuid's v7 accepts a 31-bit sequence and stays monotonic across its whole range. */
const MAX_SEQUENCE = 0x7fffffff;

export function createIdFactory(clock: Clock, options: IdFactoryOptions = {}): IdFactory {
  let lastMilliseconds = -1;
  let sequence = 0;

  return {
    nextId(): string {
      const milliseconds = clock.now();

      if (milliseconds === lastMilliseconds) {
        if (sequence >= MAX_SEQUENCE) {
          throw new Error(`Exhausted UUIDv7 sequence space within millisecond ${milliseconds}`);
        }
        sequence += 1;
      } else {
        lastMilliseconds = milliseconds;
        sequence = 0;
      }

      return options.random === undefined
        ? uuidv7({ msecs: milliseconds, seq: sequence })
        : uuidv7({ msecs: milliseconds, seq: sequence, random: options.random });
    },
  };
}
```

Note the explicit branch on `options.random`: `exactOptionalPropertyTypes` forbids passing `random: undefined` to a property typed as optional-but-not-undefined.

- [ ] **Step 6: Export and verify**

```ts
// packages/domain/src/index.ts
export * from "./clock.js";
export * from "./ids.js";
export * from "./result.js";
export * from "./state/objective-status.js";
```

Run: `npx vitest run packages/domain/src/ids.test.ts`
Expected: PASS (5 tests)

Run: `npm run format:check && npm run lint && npm run typecheck && npm run test:unit`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
npm run format
git add packages/domain package.json package-lock.json
git commit -m "feat(domain): add injected clock and UUIDv7 id factory"
```

---

### Task 4: Contract primitives and enums

**Files:**

- Create: `packages/contracts/src/primitives.ts`, `packages/contracts/src/enums.ts`
- Create: `packages/contracts/src/primitives.test.ts`, `packages/contracts/src/enums.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**

- Consumes: nothing
- Produces: `UtcTimestampSchema`, `UuidSchema`, `RevisionSchema`, `IdempotencyKeySchema`, `SchemaVersionSchema`, and every status/role enum schema plus its inferred type. Tasks 5–9 build on these and must not redeclare them.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/contracts/src/primitives.test.ts
import { describe, expect, it } from "vitest";

import {
  IdempotencyKeySchema,
  RevisionSchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./primitives.js";

describe("primitives", () => {
  it("accepts a UUIDv7", () => {
    expect(UuidSchema.safeParse("01941f29-7c00-7000-8000-000000000000").success).toBe(true);
  });

  it("rejects a UUIDv4, because Phase 1 locked UUIDv7", () => {
    expect(UuidSchema.safeParse("9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d").success).toBe(false);
  });

  it("accepts an offset-bearing UTC timestamp", () => {
    expect(UtcTimestampSchema.safeParse("2026-09-01T12:00:00.000Z").success).toBe(true);
  });

  it("rejects a timestamp with no offset", () => {
    expect(UtcTimestampSchema.safeParse("2026-09-01T12:00:00").success).toBe(false);
  });

  it("rejects a negative revision", () => {
    expect(RevisionSchema.safeParse(-1).success).toBe(false);
  });

  it("rejects a non-integer revision", () => {
    expect(RevisionSchema.safeParse(1.5).success).toBe(false);
  });

  it("rejects an empty idempotency key", () => {
    expect(IdempotencyKeySchema.safeParse("").success).toBe(false);
  });
});
```

```ts
// packages/contracts/src/enums.test.ts
import { describe, expect, it } from "vitest";

import {
  MissionStatusSchema,
  NodeJobStatusSchema,
  NoirCaseStatusSchema,
  ObjectiveStatusSchema,
  SurfaceLifecycleSchema,
} from "./enums.js";

describe("status enums fail closed on unknown members", () => {
  it.each([
    ["objective", ObjectiveStatusSchema, "active", "archived"],
    ["mission", MissionStatusSchema, "running", "paused"],
    ["surface", SurfaceLifecycleSchema, "active", "hidden"],
    ["node job", NodeJobStatusSchema, "leased", "retrying"],
    ["noir case", NoirCaseStatusSchema, "investigating", "closed"],
  ] as const)(
    "%s accepts a known member and rejects an unknown one",
    (_name, schema, good, bad) => {
      expect(schema.safeParse(good).success).toBe(true);
      expect(schema.safeParse(bad).success).toBe(false);
    },
  );
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run packages/contracts/src/primitives.test.ts packages/contracts/src/enums.test.ts`
Expected: FAIL — cannot resolve `./primitives.js` and `./enums.js`.

- [ ] **Step 3: Implement primitives**

```ts
// packages/contracts/src/primitives.ts
import { z } from "zod";

/** UUIDv7 only. Phase 1 locked a monotonic sortable identifier. */
export const UuidSchema = z.uuidv7();

/** UTC ISO 8601. Local time exists only at presentation boundaries. */
export const UtcTimestampSchema = z.iso.datetime({ offset: true });

export const RevisionSchema = z.int().nonnegative();

export const IdempotencyKeySchema = z.string().trim().min(1).max(255);

export const SchemaVersionSchema = z.int().positive();

export type Uuid = z.infer<typeof UuidSchema>;
export type UtcTimestamp = z.infer<typeof UtcTimestampSchema>;
export type Revision = z.infer<typeof RevisionSchema>;
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;
export type SchemaVersion = z.infer<typeof SchemaVersionSchema>;
```

- [ ] **Step 4: Implement enums**

```ts
// packages/contracts/src/enums.ts
import { z } from "zod";

export const ConversationalIdentityIdSchema = z.enum(["vesper", "jester"]);
export const ProtocolIdSchema = z.enum(["noir"]);
export const AttentionStateSchema = z.enum([
  "presence",
  "active_canvas",
  "focus",
  "attention_required",
]);

export const ObjectiveStatusSchema = z.enum([
  "suggested",
  "draft",
  "active",
  "paused",
  "completed",
  "abandoned",
]);

export const MissionStatusSchema = z.enum([
  "draft",
  "awaiting_approval",
  "queued",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
]);

export const SurfaceRoleSchema = z.enum([
  "primary",
  "supporting",
  "context",
  "control",
  "attention",
]);

export const SurfacePersistenceSchema = z.enum(["ephemeral", "objective", "pinned", "restorable"]);

export const SurfaceLifecycleSchema = z.enum([
  "proposed",
  "entering",
  "active",
  "background",
  "exiting",
  "dismissed",
]);

/** Defined by Phase 1: Section 4.2 gives no diagram for node jobs. */
export const NodeJobStatusSchema = z.enum([
  "queued",
  "leased",
  "running",
  "expired",
  "succeeded",
  "failed",
  "cancelled",
]);

export const NoirCaseStatusSchema = z.enum([
  "forming",
  "investigating",
  "synthesising",
  "resolved",
  "blocked",
  "abandoned",
]);

export const OperationClassSchema = z.enum([
  "read_inspect",
  "local_reversible_edit",
  "external_write",
  "message_send",
  "publish",
  "spend",
  "destructive",
  "production_deploy",
  "credential_security",
]);

export type ConversationalIdentityId = z.infer<typeof ConversationalIdentityIdSchema>;
export type ProtocolId = z.infer<typeof ProtocolIdSchema>;
export type AttentionState = z.infer<typeof AttentionStateSchema>;
export type ObjectiveStatus = z.infer<typeof ObjectiveStatusSchema>;
export type MissionStatus = z.infer<typeof MissionStatusSchema>;
export type SurfaceRole = z.infer<typeof SurfaceRoleSchema>;
export type SurfacePersistence = z.infer<typeof SurfacePersistenceSchema>;
export type SurfaceLifecycle = z.infer<typeof SurfaceLifecycleSchema>;
export type NodeJobStatus = z.infer<typeof NodeJobStatusSchema>;
export type NoirCaseStatus = z.infer<typeof NoirCaseStatusSchema>;
export type OperationClass = z.infer<typeof OperationClassSchema>;
```

- [ ] **Step 5: Re-point the barrel**

`objective.ts` currently declares `ObjectiveStatusSchema` itself. Task 5 removes that duplicate. For now export enums and primitives first so the duplicate is visible to the compiler:

```ts
// packages/contracts/src/index.ts
export * from "./enums.js";
export * from "./primitives.js";
export * from "./objective.js";
```

Expect `npm run typecheck` to report a duplicate export of `ObjectiveStatusSchema`. That is the signal Task 5 resolves. To keep this task independently green, temporarily delete the `ObjectiveStatusSchema` and `ObjectiveStatus` declarations from `objective.ts` and import them instead:

```ts
// packages/contracts/src/objective.ts — top of file
import { z } from "zod";

import {
  ConversationalIdentityIdSchema,
  ObjectiveStatusSchema,
  ProtocolIdSchema,
} from "./enums.js";
import { RevisionSchema, UtcTimestampSchema, UuidSchema } from "./primitives.js";
```

and replace the body's field definitions with the shared schemas:

```ts
export const ObjectiveRecordSchema = z
  .object({
    id: UuidSchema,
    title: z.string().trim().min(1),
    intent: z.string().trim().min(1),
    status: ObjectiveStatusSchema,
    identityId: ConversationalIdentityIdSchema,
    protocolIds: z.array(ProtocolIdSchema),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    activatedAt: UtcTimestampSchema.optional(),
    completedAt: UtcTimestampSchema.optional(),
    revision: RevisionSchema,
  })
  .strict();

export type ObjectiveRecord = z.infer<typeof ObjectiveRecordSchema>;
```

- [ ] **Step 6: Run everything**

Run: `npx vitest run packages/contracts`
Expected: PASS

Run: `npm run format:check && npm run lint && npm run typecheck && npm run test:unit`
Expected: all pass. The existing `objective.test.ts` must still pass unchanged — if it fails, a shared schema is stricter than the inline one it replaced, and that is a real regression to investigate, not a test to edit.

- [ ] **Step 7: Commit**

```bash
npm run format
git add packages/contracts/src
git commit -m "feat(contracts): add shared primitives and closed status enums"
```

---

### Task 5: `defineTransition` and the Objective machine

**Files:**

- Create: `packages/domain/src/state/transition.ts`, `packages/domain/src/state/transition.test.ts`
- Modify: `packages/domain/src/state/objective-status.ts`, `packages/domain/src/state/objective-status.test.ts`

**Interfaces:**

- Consumes: `Result`, `conflict`, `ok` from Task 2; `ObjectiveStatus` from Task 4
- Produces: `defineTransition<TState extends string>(machine: string, table: Record<TState, readonly TState[]>): (from: TState, to: TState) => Result<TState>`. Tasks 6 uses this for four more machines.

- [ ] **Step 1: Write the failing test for the helper**

```ts
// packages/domain/src/state/transition.test.ts
import { describe, expect, it } from "vitest";

import { defineTransition } from "./transition.js";

type Light = "red" | "green";

const transitionLight = defineTransition<Light>("light", {
  red: ["green"],
  green: [],
});

describe("defineTransition", () => {
  it("returns the next state for an allowed transition", () => {
    const result = transitionLight("red", "green");

    expect(result).toEqual({ ok: true, value: "green" });
  });

  it("returns a forbidden_transition conflict naming the machine", () => {
    const result = transitionLight("green", "red");

    expect(result).toEqual({
      ok: false,
      conflict: { kind: "forbidden_transition", machine: "light", from: "green", to: "red" },
    });
  });

  it("refuses a self-transition that the table does not list", () => {
    expect(transitionLight("red", "red").ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run packages/domain/src/state/transition.test.ts`
Expected: FAIL — cannot resolve `./transition.js`.

- [ ] **Step 3: Implement the helper**

```ts
// packages/domain/src/state/transition.ts
import type { Result } from "../result.js";
import { conflict, ok } from "../result.js";

/**
 * Turns an allowed-transition table into a pure function returning Result.
 * A state missing from the table, or a target it does not list, is a refusal.
 */
export function defineTransition<TState extends string>(
  machine: string,
  table: Readonly<Record<TState, readonly TState[]>>,
): (from: TState, to: TState) => Result<TState> {
  return (from, to) => {
    const allowed = table[from];

    if (allowed === undefined || !allowed.includes(to)) {
      return conflict<TState>({ kind: "forbidden_transition", machine, from, to });
    }

    return ok(to);
  };
}
```

`noUncheckedIndexedAccess` is why `allowed` is checked for `undefined` before use.

- [ ] **Step 4: Rewrite the Objective machine onto it**

```ts
// packages/domain/src/state/objective-status.ts
import type { ObjectiveStatus } from "@noctis/contracts";

import { defineTransition } from "./transition.js";

export const transitionObjectiveStatus = defineTransition<ObjectiveStatus>("objective", {
  suggested: ["draft", "abandoned"],
  draft: ["active", "abandoned"],
  active: ["paused", "completed", "abandoned"],
  paused: ["active", "completed", "abandoned"],
  completed: [],
  abandoned: [],
});
```

- [ ] **Step 5: Rewrite its test from throwing to Result**

```ts
// packages/domain/src/state/objective-status.test.ts
import { describe, expect, it } from "vitest";

import { transitionObjectiveStatus } from "./objective-status.js";

describe("transitionObjectiveStatus", () => {
  it.each([
    ["suggested", "draft"],
    ["suggested", "abandoned"],
    ["draft", "active"],
    ["draft", "abandoned"],
    ["active", "paused"],
    ["active", "completed"],
    ["active", "abandoned"],
    ["paused", "active"],
    ["paused", "completed"],
    ["paused", "abandoned"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(transitionObjectiveStatus(from, to)).toEqual({ ok: true, value: to });
  });

  it.each([
    ["suggested", "active"],
    ["suggested", "completed"],
    ["draft", "completed"],
    ["draft", "paused"],
    ["active", "draft"],
    ["active", "suggested"],
    ["paused", "draft"],
    ["completed", "active"],
    ["completed", "abandoned"],
    ["abandoned", "draft"],
    ["abandoned", "active"],
    ["active", "active"],
  ] as const)("refuses %s -> %s and produces no value", (from, to) => {
    const result = transitionObjectiveStatus(from, to);

    expect(result).toEqual({
      ok: false,
      conflict: { kind: "forbidden_transition", machine: "objective", from, to },
    });
  });
});
```

- [ ] **Step 6: Run and verify**

Run: `npx vitest run packages/domain`
Expected: PASS

Run: `npm run format:check && npm run lint && npm run typecheck && npm run test:unit`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
npm run format
git add packages/domain/src
git commit -m "refactor(domain): return Result from transitions via defineTransition"
```

---

### Task 6: The remaining four transition machines

**Files:**

- Create: `packages/domain/src/state/mission-status.ts`, `surface-lifecycle.ts`, `node-job-status.ts`, `noir-case-status.ts`
- Create: a `.test.ts` beside each
- Modify: `packages/domain/src/index.ts`

**Interfaces:**

- Consumes: `defineTransition` from Task 5; `MissionStatus`, `SurfaceLifecycle`, `NodeJobStatus`, `NoirCaseStatus` from Task 4
- Produces: `transitionMissionStatus`, `transitionSurfaceLifecycle`, `transitionNodeJobStatus`, `transitionNoirCaseStatus`, each with the same `(from, to) => Result<TState>` signature.

- [ ] **Step 1: Implement all four machines**

```ts
// packages/domain/src/state/mission-status.ts
import type { MissionStatus } from "@noctis/contracts";

import { defineTransition } from "./transition.js";

export const transitionMissionStatus = defineTransition<MissionStatus>("mission", {
  draft: ["awaiting_approval", "cancelled"],
  awaiting_approval: ["queued", "cancelled"],
  queued: ["running", "cancelled"],
  running: ["succeeded", "failed", "blocked", "cancelled"],
  blocked: ["running", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
});
```

```ts
// packages/domain/src/state/surface-lifecycle.ts
import type { SurfaceLifecycle } from "@noctis/contracts";

import { defineTransition } from "./transition.js";

export const transitionSurfaceLifecycle = defineTransition<SurfaceLifecycle>("surface", {
  proposed: ["entering", "dismissed"],
  entering: ["active", "dismissed"],
  active: ["background", "exiting"],
  background: ["active", "exiting"],
  exiting: ["dismissed"],
  dismissed: [],
});
```

```ts
// packages/domain/src/state/node-job-status.ts
import type { NodeJobStatus } from "@noctis/contracts";

import { defineTransition } from "./transition.js";

/** Defined by Phase 1; expired returns a job to queued so a lost lease is retryable. */
export const transitionNodeJobStatus = defineTransition<NodeJobStatus>("node_job", {
  queued: ["leased", "cancelled"],
  leased: ["running", "expired", "cancelled"],
  running: ["succeeded", "failed", "expired", "cancelled"],
  expired: ["queued", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
});
```

```ts
// packages/domain/src/state/noir-case-status.ts
import type { NoirCaseStatus } from "@noctis/contracts";

import { defineTransition } from "./transition.js";

export const transitionNoirCaseStatus = defineTransition<NoirCaseStatus>("noir_case", {
  forming: ["investigating", "abandoned"],
  investigating: ["synthesising", "blocked", "abandoned"],
  synthesising: ["resolved", "blocked", "abandoned"],
  blocked: ["investigating", "abandoned"],
  resolved: [],
  abandoned: [],
});
```

- [ ] **Step 2: Write an exhaustive matrix test for each**

Each test enumerates the full cross-product of states and asserts that exactly the table's pairs are allowed. This is stronger than listing pairs by hand and catches an accidentally added edge. Repeat this shape for all four files, substituting the states and the machine name.

```ts
// packages/domain/src/state/mission-status.test.ts
import { describe, expect, it } from "vitest";

import type { MissionStatus } from "@noctis/contracts";

import { transitionMissionStatus } from "./mission-status.js";

const STATES: readonly MissionStatus[] = [
  "draft",
  "awaiting_approval",
  "queued",
  "running",
  "blocked",
  "succeeded",
  "failed",
  "cancelled",
];

const ALLOWED = new Set([
  "draft->awaiting_approval",
  "draft->cancelled",
  "awaiting_approval->queued",
  "awaiting_approval->cancelled",
  "queued->running",
  "queued->cancelled",
  "running->succeeded",
  "running->failed",
  "running->blocked",
  "running->cancelled",
  "blocked->running",
  "blocked->cancelled",
]);

describe("transitionMissionStatus", () => {
  const pairs = STATES.flatMap((from) => STATES.map((to) => [from, to] as const));

  it.each(pairs)("%s -> %s matches the declared matrix", (from, to) => {
    const result = transitionMissionStatus(from, to);

    if (ALLOWED.has(`${from}->${to}`)) {
      expect(result).toEqual({ ok: true, value: to });
    } else {
      expect(result).toEqual({
        ok: false,
        conflict: { kind: "forbidden_transition", machine: "mission", from, to },
      });
    }
  });

  it("treats every terminal state as terminal", () => {
    for (const terminal of ["succeeded", "failed", "cancelled"] as const) {
      for (const to of STATES) {
        expect(transitionMissionStatus(terminal, to).ok).toBe(false);
      }
    }
  });
});
```

Create the other three test files by copying `mission-status.test.ts` verbatim and replacing exactly four things: the import, the `STATES` array, the `ALLOWED` set, the machine name string in the expected conflict, and the terminal list. Everything else — the `pairs` cross-product, the two `it` blocks, the assertions — stays byte-identical. Those four substitutions are given in full below.

**`surface-lifecycle.test.ts`** — import `transitionSurfaceLifecycle` from `./surface-lifecycle.js`, type `SurfaceLifecycle`, machine name `"surface"`:

```ts
const STATES: readonly SurfaceLifecycle[] = [
  "proposed",
  "entering",
  "active",
  "background",
  "exiting",
  "dismissed",
];

const ALLOWED = new Set([
  "proposed->entering",
  "proposed->dismissed",
  "entering->active",
  "entering->dismissed",
  "active->background",
  "active->exiting",
  "background->active",
  "background->exiting",
  "exiting->dismissed",
]);

const TERMINAL = ["dismissed"] as const;
```

**`node-job-status.test.ts`** — import `transitionNodeJobStatus` from `./node-job-status.js`, type `NodeJobStatus`, machine name `"node_job"`:

```ts
const STATES: readonly NodeJobStatus[] = [
  "queued",
  "leased",
  "running",
  "expired",
  "succeeded",
  "failed",
  "cancelled",
];

const ALLOWED = new Set([
  "queued->leased",
  "queued->cancelled",
  "leased->running",
  "leased->expired",
  "leased->cancelled",
  "running->succeeded",
  "running->failed",
  "running->expired",
  "running->cancelled",
  "expired->queued",
  "expired->cancelled",
]);

const TERMINAL = ["succeeded", "failed", "cancelled"] as const;
```

**`noir-case-status.test.ts`** — import `transitionNoirCaseStatus` from `./noir-case-status.js`, type `NoirCaseStatus`, machine name `"noir_case"`:

```ts
const STATES: readonly NoirCaseStatus[] = [
  "forming",
  "investigating",
  "synthesising",
  "resolved",
  "blocked",
  "abandoned",
];

const ALLOWED = new Set([
  "forming->investigating",
  "forming->abandoned",
  "investigating->synthesising",
  "investigating->blocked",
  "investigating->abandoned",
  "synthesising->resolved",
  "synthesising->blocked",
  "synthesising->abandoned",
  "blocked->investigating",
  "blocked->abandoned",
]);

const TERMINAL = ["resolved", "abandoned"] as const;
```

In `mission-status.test.ts`, replace the inline `["succeeded", "failed", "cancelled"] as const` in the terminal-state test with a `TERMINAL` constant so all four files share one shape:

```ts
const TERMINAL = ["succeeded", "failed", "cancelled"] as const;
```

and the terminal test body becomes:

```ts
it("treats every terminal state as terminal", () => {
  for (const terminal of TERMINAL) {
    for (const to of STATES) {
      expect(transitionMissionStatus(terminal, to).ok).toBe(false);
    }
  }
});
```

- [ ] **Step 3: Export**

```ts
// packages/domain/src/index.ts
export * from "./clock.js";
export * from "./ids.js";
export * from "./result.js";
export * from "./state/mission-status.js";
export * from "./state/node-job-status.js";
export * from "./state/noir-case-status.js";
export * from "./state/objective-status.js";
export * from "./state/surface-lifecycle.js";
export * from "./state/transition.js";
```

- [ ] **Step 4: Run and verify**

Run: `npx vitest run packages/domain`
Expected: PASS. Mission alone contributes 64 matrix cases.

Run: `npm run format:check && npm run lint && npm run typecheck && npm run test:unit`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
npm run format
git add packages/domain/src
git commit -m "feat(domain): add mission, surface, node-job, and NOIR transition machines"
```

---

### Task 7: Objective, Mission, and Surface contracts

**Files:**

- Modify: `packages/contracts/src/objective.ts`
- Create: `packages/contracts/src/mission.ts`, `packages/contracts/src/surface.ts`
- Create: `packages/contracts/src/mission.test.ts`, `packages/contracts/src/surface.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**

- Consumes: primitives and enums from Task 4
- Produces: `ObjectiveLinkSchema`, `MissionRecordSchema`, `MissionStepSchema`, `MissionEvidenceSchema`, `SurfaceIntentSchema`, `SurfaceOverrideSchema`, `CompositionPlanSchema` and their inferred types.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/contracts/src/mission.test.ts
import { describe, expect, it } from "vitest";

import { MissionRecordSchema } from "./mission.js";

const valid = {
  id: "01941f29-7c00-7000-8000-000000000001",
  objectiveId: "01941f29-7c00-7000-8000-000000000002",
  title: "Verify the node agent",
  status: "draft",
  operationClass: "read_inspect",
  hostPolicy: "any_granted_host",
  revision: 0,
  createdAt: "2026-09-01T12:00:00.000Z",
  updatedAt: "2026-09-01T12:00:00.000Z",
};

describe("MissionRecordSchema", () => {
  it("accepts a well-formed mission", () => {
    expect(MissionRecordSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an unknown field", () => {
    expect(MissionRecordSchema.safeParse({ ...valid, injected: true }).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(MissionRecordSchema.safeParse({ ...valid, status: "paused" }).success).toBe(false);
  });

  it("rejects a non-UUIDv7 id", () => {
    expect(
      MissionRecordSchema.safeParse({ ...valid, id: "9f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d" })
        .success,
    ).toBe(false);
  });

  it("rejects a blank title", () => {
    expect(MissionRecordSchema.safeParse({ ...valid, title: "   " }).success).toBe(false);
  });
});
```

```ts
// packages/contracts/src/surface.test.ts
import { describe, expect, it } from "vitest";

import { SurfaceIntentSchema } from "./surface.js";

const valid = {
  id: "01941f29-7c00-7000-8000-000000000003",
  objectiveId: "01941f29-7c00-7000-8000-000000000002",
  kind: "timeline",
  role: "primary",
  persistence: "objective",
  lifecycle: "proposed",
  priority: 10,
  minSize: "standard",
  sourceIds: [],
  artifactIds: [],
  payloadVersion: 1,
  payload: { rows: [] },
  requestedAt: "2026-09-01T12:00:00.000Z",
};

describe("SurfaceIntentSchema", () => {
  it("accepts a well-formed intent", () => {
    expect(SurfaceIntentSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts an optional preferred region", () => {
    expect(SurfaceIntentSchema.safeParse({ ...valid, preferredRegion: "left" }).success).toBe(true);
  });

  it("rejects an unknown role", () => {
    expect(SurfaceIntentSchema.safeParse({ ...valid, role: "hero" }).success).toBe(false);
  });

  it("rejects an unknown field", () => {
    expect(SurfaceIntentSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });

  it("treats payload as unknown but still requires a version", () => {
    const { payloadVersion: _omitted, ...withoutVersion } = valid;

    expect(SurfaceIntentSchema.safeParse(withoutVersion).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run packages/contracts/src/mission.test.ts packages/contracts/src/surface.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the mission contracts**

```ts
// packages/contracts/src/mission.ts
import { z } from "zod";

import { MissionStatusSchema, OperationClassSchema } from "./enums.js";
import {
  RevisionSchema,
  SchemaVersionSchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./primitives.js";

export const MissionHostPolicySchema = z.enum(["core_only", "any_granted_host", "named_host"]);

export const MissionRecordSchema = z
  .object({
    id: UuidSchema,
    objectiveId: UuidSchema,
    title: z.string().trim().min(1),
    status: MissionStatusSchema,
    operationClass: OperationClassSchema,
    hostPolicy: MissionHostPolicySchema,
    hostId: z.string().trim().min(1).optional(),
    revision: RevisionSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
    startedAt: UtcTimestampSchema.optional(),
    completedAt: UtcTimestampSchema.optional(),
  })
  .strict();

export const MissionStepSchema = z
  .object({
    id: UuidSchema,
    missionId: UuidSchema,
    ordinal: z.int().nonnegative(),
    kind: z.enum(["deterministic", "model_backed"]),
    operationClass: OperationClassSchema,
    status: MissionStatusSchema,
    payloadVersion: SchemaVersionSchema,
    payload: z.unknown(),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .strict();

export const MissionEvidenceSchema = z
  .object({
    id: UuidSchema,
    missionId: UuidSchema,
    stepId: UuidSchema.optional(),
    kind: z.enum(["command", "result", "verification"]),
    hostId: z.string().trim().min(1),
    summary: z.string().trim().min(1),
    payloadVersion: SchemaVersionSchema,
    payload: z.unknown(),
    observedAt: UtcTimestampSchema,
  })
  .strict();

export type MissionHostPolicy = z.infer<typeof MissionHostPolicySchema>;
export type MissionRecord = z.infer<typeof MissionRecordSchema>;
export type MissionStep = z.infer<typeof MissionStepSchema>;
export type MissionEvidence = z.infer<typeof MissionEvidenceSchema>;
```

- [ ] **Step 4: Implement the surface contracts**

```ts
// packages/contracts/src/surface.ts
import { z } from "zod";

import { SurfaceLifecycleSchema, SurfacePersistenceSchema, SurfaceRoleSchema } from "./enums.js";
import { SchemaVersionSchema, UtcTimestampSchema, UuidSchema } from "./primitives.js";

export const SurfaceSizeSchema = z.enum(["compact", "standard", "wide", "stage"]);
export const SurfaceRegionSchema = z.enum(["left", "centre", "right", "bottom", "overlay"]);

export const SurfaceIntentSchema = z
  .object({
    id: UuidSchema,
    objectiveId: UuidSchema,
    kind: z.string().trim().min(1),
    role: SurfaceRoleSchema,
    persistence: SurfacePersistenceSchema,
    lifecycle: SurfaceLifecycleSchema,
    priority: z.int(),
    minSize: SurfaceSizeSchema,
    preferredRegion: SurfaceRegionSchema.optional(),
    sourceIds: z.array(UuidSchema),
    artifactIds: z.array(UuidSchema),
    payloadVersion: SchemaVersionSchema,
    payload: z.unknown(),
    requestedAt: UtcTimestampSchema,
  })
  .strict();

export const SurfaceOverrideSchema = z
  .object({
    id: UuidSchema,
    surfaceId: UuidSchema,
    clientId: z.string().trim().min(1),
    displayFingerprint: z.string().trim().min(1),
    region: SurfaceRegionSchema,
    size: SurfaceSizeSchema,
    createdAt: UtcTimestampSchema,
    releasedAt: UtcTimestampSchema.optional(),
  })
  .strict();

export const CompositionPlanSchema = z
  .object({
    objectiveId: UuidSchema,
    layoutId: z.string().trim().min(1),
    displayFingerprint: z.string().trim().min(1),
    slots: z.array(
      z
        .object({
          surfaceId: UuidSchema,
          region: SurfaceRegionSchema,
          order: z.int().nonnegative(),
          size: SurfaceSizeSchema,
          layer: z.int().nonnegative(),
        })
        .strict(),
    ),
    overflowSurfaceIds: z.array(UuidSchema),
    reasonCodes: z.array(z.string().trim().min(1)),
    generatedAt: UtcTimestampSchema,
  })
  .strict();

export type SurfaceSize = z.infer<typeof SurfaceSizeSchema>;
export type SurfaceRegion = z.infer<typeof SurfaceRegionSchema>;
export type SurfaceIntent = z.infer<typeof SurfaceIntentSchema>;
export type SurfaceOverride = z.infer<typeof SurfaceOverrideSchema>;
export type CompositionPlan = z.infer<typeof CompositionPlanSchema>;
```

- [ ] **Step 5: Add the objective link schema**

Append to `packages/contracts/src/objective.ts`:

```ts
export const ObjectiveLinkSchema = z
  .object({
    objectiveId: UuidSchema,
    relatedType: z.enum(["mission", "surface", "artifact", "source", "noir_case"]),
    relatedId: UuidSchema,
    relation: z.string().trim().min(1),
    createdAt: UtcTimestampSchema,
  })
  .strict();

export type ObjectiveLink = z.infer<typeof ObjectiveLinkSchema>;
```

- [ ] **Step 6: Export and verify**

```ts
// packages/contracts/src/index.ts
export * from "./enums.js";
export * from "./primitives.js";
export * from "./objective.js";
export * from "./mission.js";
export * from "./surface.js";
```

Run: `npx vitest run packages/contracts`
Expected: PASS

Run: `npm run format:check && npm run lint && npm run typecheck && npm run test:unit`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
npm run format
git add packages/contracts/src
git commit -m "feat(contracts): add mission, surface, and objective link schemas"
```

---

### Task 8: Node, NOIR, authority, identity, artifact, and source contracts

**Files:**

- Create: `packages/contracts/src/node.ts`, `noir.ts`, `authority.ts`, `identity.ts`, `artifact.ts`, `source.ts`
- Create: `packages/contracts/src/contracts.malformed.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**

- Consumes: primitives and enums from Task 4
- Produces: `NodeDescriptorSchema`, `CapabilityGrantSchema`, `NodeJobSchema`, `NoirCaseSchema`, `HypothesisSchema`, `EvidenceItemSchema`, `FalsifierSchema`, `UncertaintySchema`, `AuthorityRequestSchema`, `AuthorityDecisionSchema`, `StandingPermissionSchema`, `IdentityProfileSchema`, `ConversationThreadSchema`, `IdentityMessageSchema`, `ArtifactRecordSchema`, `SourceRecordSchema`, `SourceObservationSchema`.

- [ ] **Step 1: Implement the node contracts**

```ts
// packages/contracts/src/node.ts
import { z } from "zod";

import { NodeJobStatusSchema, OperationClassSchema } from "./enums.js";
import {
  IdempotencyKeySchema,
  RevisionSchema,
  SchemaVersionSchema,
  UtcTimestampSchema,
  UuidSchema,
} from "./primitives.js";

export const NodeDescriptorSchema = z
  .object({
    id: UuidSchema,
    hostId: z.string().trim().min(1),
    status: z.enum(["pending", "paired", "online", "offline", "revoked"]),
    fingerprint: z.string().trim().min(1),
    agentVersion: z.string().trim().min(1),
    lastSeenAt: UtcTimestampSchema.optional(),
    revokedAt: UtcTimestampSchema.optional(),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .strict();

export const CapabilityGrantSchema = z
  .object({
    id: UuidSchema,
    nodeId: UuidSchema,
    capability: z.string().trim().min(1),
    operationClass: OperationClassSchema,
    constraintsVersion: SchemaVersionSchema,
    constraints: z.unknown(),
    grantedAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema.optional(),
    revokedAt: UtcTimestampSchema.optional(),
  })
  .strict();

export const NodeJobSchema = z
  .object({
    id: UuidSchema,
    missionId: UuidSchema.optional(),
    nodeId: UuidSchema.optional(),
    capability: z.string().trim().min(1),
    status: NodeJobStatusSchema,
    idempotencyKey: IdempotencyKeySchema,
    leaseExpiresAt: UtcTimestampSchema.optional(),
    attempts: z.int().nonnegative(),
    payloadVersion: SchemaVersionSchema,
    payload: z.unknown(),
    revision: RevisionSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .strict();

export type NodeDescriptor = z.infer<typeof NodeDescriptorSchema>;
export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;
export type NodeJob = z.infer<typeof NodeJobSchema>;
```

- [ ] **Step 2: Implement the NOIR contracts**

```ts
// packages/contracts/src/noir.ts
import { z } from "zod";

import { NoirCaseStatusSchema } from "./enums.js";
import { RevisionSchema, UtcTimestampSchema, UuidSchema } from "./primitives.js";

export const NoirCaseSchema = z
  .object({
    id: UuidSchema,
    objectiveId: UuidSchema,
    question: z.string().trim().min(1),
    status: NoirCaseStatusSchema,
    synthesis: z.string().optional(),
    revision: RevisionSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .strict();

export const HypothesisSchema = z
  .object({
    id: UuidSchema,
    caseId: UuidSchema,
    statement: z.string().trim().min(1),
    rank: z.int().nonnegative(),
    status: z.enum(["open", "supported", "refuted", "withdrawn"]),
    confidenceRationale: z.string().trim().min(1),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .strict();

export const EvidenceItemSchema = z
  .object({
    id: UuidSchema,
    caseId: UuidSchema,
    hypothesisId: UuidSchema.optional(),
    sourceId: UuidSchema.optional(),
    artifactId: UuidSchema.optional(),
    stance: z.enum(["supports", "refutes", "neutral"]),
    verification: z.enum(["unverified", "verified", "failed"]),
    summary: z.string().trim().min(1),
    observedAt: UtcTimestampSchema,
  })
  .strict();

export const FalsifierSchema = z
  .object({
    id: UuidSchema,
    caseId: UuidSchema,
    hypothesisId: UuidSchema,
    check: z.string().trim().min(1),
    result: z.enum(["pending", "passed", "failed", "inconclusive"]),
    createdAt: UtcTimestampSchema,
    resolvedAt: UtcTimestampSchema.optional(),
  })
  .strict();

/** Uncertainty is retained, never silently resolved into false confidence. */
export const UncertaintySchema = z
  .object({
    id: UuidSchema,
    caseId: UuidSchema,
    statement: z.string().trim().min(1),
    reason: z.enum(["missing_evidence", "conflicting_evidence", "stale_source", "out_of_scope"]),
    createdAt: UtcTimestampSchema,
  })
  .strict();

export type NoirCase = z.infer<typeof NoirCaseSchema>;
export type Hypothesis = z.infer<typeof HypothesisSchema>;
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
export type Falsifier = z.infer<typeof FalsifierSchema>;
export type Uncertainty = z.infer<typeof UncertaintySchema>;
```

- [ ] **Step 3: Implement the authority contracts**

```ts
// packages/contracts/src/authority.ts
import { z } from "zod";

import { OperationClassSchema } from "./enums.js";
import { IdempotencyKeySchema, UtcTimestampSchema, UuidSchema } from "./primitives.js";

export const AuthorityRequestSchema = z
  .object({
    id: UuidSchema,
    objectiveId: UuidSchema.optional(),
    missionId: UuidSchema.optional(),
    actorId: z.string().trim().min(1),
    operationClass: OperationClassSchema,
    capability: z.string().trim().min(1),
    target: z
      .object({
        type: z.string().trim().min(1),
        id: z.string().trim().min(1),
        hostId: z.string().trim().min(1).optional(),
      })
      .strict(),
    consequenceSummary: z.string().trim().min(1),
    reversibility: z.enum(["reversible", "partially_reversible", "irreversible"]),
    estimatedCostGbp: z.number().nonnegative().optional(),
    idempotencyKey: IdempotencyKeySchema,
    requestedAt: UtcTimestampSchema,
  })
  .strict();

export const AuthorityDecisionSchema = z
  .object({
    requestId: UuidSchema,
    outcome: z.enum(["allow", "deny", "require_confirmation", "require_typed_confirmation"]),
    policyId: z.string().trim().min(1),
    reasonCodes: z.array(z.string().trim().min(1)),
    permissionId: UuidSchema.optional(),
    decidedAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema.optional(),
  })
  .strict();

export const StandingPermissionSchema = z
  .object({
    id: UuidSchema,
    actorId: z.string().trim().min(1),
    capability: z.string().trim().min(1),
    operationClass: OperationClassSchema,
    constraints: z.unknown(),
    grantedAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema.optional(),
    revokedAt: UtcTimestampSchema.optional(),
  })
  .strict();

export type AuthorityRequest = z.infer<typeof AuthorityRequestSchema>;
export type AuthorityDecision = z.infer<typeof AuthorityDecisionSchema>;
export type StandingPermission = z.infer<typeof StandingPermissionSchema>;
```

- [ ] **Step 4: Implement identity, artifact, and source contracts**

```ts
// packages/contracts/src/identity.ts
import { z } from "zod";

import { ConversationalIdentityIdSchema, ProtocolIdSchema } from "./enums.js";
import { RevisionSchema, UtcTimestampSchema, UuidSchema } from "./primitives.js";

export const IdentityProfileSchema = z
  .object({
    id: ConversationalIdentityIdSchema,
    displayName: z.string().trim().min(1),
    activationCommand: z.string().trim().min(1),
  })
  .strict();

export const ConversationThreadSchema = z
  .object({
    id: UuidSchema,
    identityId: ConversationalIdentityIdSchema,
    activeObjectiveId: UuidSchema.optional(),
    revision: RevisionSchema,
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .strict();

export const IdentityMessageSchema = z
  .object({
    id: UuidSchema,
    threadId: UuidSchema,
    role: z.enum(["user", "identity", "system"]),
    protocolId: ProtocolIdSchema.optional(),
    contentRef: z.string().trim().min(1),
    createdAt: UtcTimestampSchema,
  })
  .strict();

export type IdentityProfile = z.infer<typeof IdentityProfileSchema>;
export type ConversationThread = z.infer<typeof ConversationThreadSchema>;
export type IdentityMessage = z.infer<typeof IdentityMessageSchema>;
```

```ts
// packages/contracts/src/artifact.ts
import { z } from "zod";

import { SchemaVersionSchema, UtcTimestampSchema, UuidSchema } from "./primitives.js";

export const ArtifactRecordSchema = z
  .object({
    id: UuidSchema,
    kind: z.enum(["local_artifact", "external_reference"]),
    title: z.string().trim().min(1),
    uri: z.string().trim().min(1),
    mediaType: z.string().trim().min(1).optional(),
    objectiveId: UuidSchema.optional(),
    missionId: UuidSchema.optional(),
    sourceId: UuidSchema.optional(),
    hostId: z.string().trim().min(1).optional(),
    checksum: z.string().trim().min(1).optional(),
    provenanceVersion: SchemaVersionSchema,
    provenance: z.unknown(),
    createdAt: UtcTimestampSchema,
  })
  .strict();

export type ArtifactRecord = z.infer<typeof ArtifactRecordSchema>;
```

```ts
// packages/contracts/src/source.ts
import { z } from "zod";

import { SchemaVersionSchema, UtcTimestampSchema, UuidSchema } from "./primitives.js";

export const SourceRecordSchema = z
  .object({
    id: UuidSchema,
    sourceType: z.string().trim().min(1),
    externalId: z.string().trim().min(1),
    freshnessSeconds: z.int().positive(),
    createdAt: UtcTimestampSchema,
    updatedAt: UtcTimestampSchema,
  })
  .strict();

export const SourceObservationSchema = z
  .object({
    id: UuidSchema,
    sourceId: UuidSchema,
    status: z.enum(["current", "stale", "unavailable", "unknown"]),
    payloadVersion: SchemaVersionSchema,
    payload: z.unknown(),
    observedAt: UtcTimestampSchema,
    expiresAt: UtcTimestampSchema.optional(),
  })
  .strict();

export type SourceRecord = z.infer<typeof SourceRecordSchema>;
export type SourceObservation = z.infer<typeof SourceObservationSchema>;
```

- [ ] **Step 5: Write one hostile-input test covering every schema**

This is the gate's "malformed model, worker, and API data is rejected" evidence.

```ts
// packages/contracts/src/contracts.malformed.test.ts
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import { ArtifactRecordSchema } from "./artifact.js";
import { AuthorityRequestSchema } from "./authority.js";
import { ConversationThreadSchema } from "./identity.js";
import { MissionRecordSchema } from "./mission.js";
import { NodeJobSchema } from "./node.js";
import { NoirCaseSchema } from "./noir.js";
import { ObjectiveRecordSchema } from "./objective.js";
import { SourceObservationSchema } from "./source.js";
import { SurfaceIntentSchema } from "./surface.js";

const SCHEMAS: ReadonlyArray<readonly [string, ZodType]> = [
  ["ArtifactRecord", ArtifactRecordSchema],
  ["AuthorityRequest", AuthorityRequestSchema],
  ["ConversationThread", ConversationThreadSchema],
  ["MissionRecord", MissionRecordSchema],
  ["NodeJob", NodeJobSchema],
  ["NoirCase", NoirCaseSchema],
  ["ObjectiveRecord", ObjectiveRecordSchema],
  ["SourceObservation", SourceObservationSchema],
  ["SurfaceIntent", SurfaceIntentSchema],
];

const HOSTILE_INPUTS: ReadonlyArray<readonly [string, unknown]> = [
  ["null", null],
  ["undefined", undefined],
  ["a string", "not an object"],
  ["a number", 7],
  ["an array", []],
  ["an empty object", {}],
  ["a prototype-polluting payload", JSON.parse('{"__proto__":{"polluted":true}}')],
];

describe("every schema rejects hostile input", () => {
  for (const [schemaName, schema] of SCHEMAS) {
    it.each(HOSTILE_INPUTS)(`${schemaName} rejects %s`, (_label, input) => {
      expect(schema.safeParse(input).success).toBe(false);
    });
  }
});
```

- [ ] **Step 6: Export and verify**

```ts
// packages/contracts/src/index.ts
export * from "./enums.js";
export * from "./primitives.js";
export * from "./artifact.js";
export * from "./authority.js";
export * from "./identity.js";
export * from "./mission.js";
export * from "./node.js";
export * from "./noir.js";
export * from "./objective.js";
export * from "./source.js";
export * from "./surface.js";
```

Run: `npx vitest run packages/contracts`
Expected: PASS, including 63 hostile-input cases.

Run: `npm run format:check && npm run lint && npm run typecheck && npm run test:unit`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
npm run format
git add packages/contracts/src
git commit -m "feat(contracts): add node, NOIR, authority, identity, artifact, and source schemas"
```

---

### Task 9: Event envelope, name registry, and WebSocket frames

**Files:**

- Create: `packages/contracts/src/events.ts`, `packages/contracts/src/ws.ts`
- Create: `packages/contracts/src/events.test.ts`, `packages/contracts/src/ws.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**

- Consumes: primitives from Task 4
- Produces: `EventNameSchema`, `EVENT_NAMES`, `OrchestrationEventSchema`, `ClientFrameSchema`, `ServerFrameSchema`. Task 13 writes rows shaped by `OrchestrationEventSchema`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/contracts/src/events.test.ts
import { describe, expect, it } from "vitest";

import { EventNameSchema, OrchestrationEventSchema } from "./events.js";

const valid = {
  id: "01941f29-7c00-7000-8000-000000000010",
  sequence: 1,
  streamType: "objective",
  streamId: "01941f29-7c00-7000-8000-000000000002",
  type: "objective.created.v1",
  actorType: "user",
  actorId: "mushaf",
  payloadVersion: 1,
  payload: { title: "Ship Phase 1" },
  correlationId: "01941f29-7c00-7000-8000-000000000011",
  occurredAt: "2026-09-01T12:00:00.000Z",
};

describe("EventNameSchema", () => {
  it("accepts a registered versioned name", () => {
    expect(EventNameSchema.safeParse("objective.activated.v1").success).toBe(true);
  });

  it("rejects an unregistered name", () => {
    expect(EventNameSchema.safeParse("objective.exploded.v1").success).toBe(false);
  });

  it("rejects an unknown version of a registered name", () => {
    expect(EventNameSchema.safeParse("objective.created.v2").success).toBe(false);
  });

  it("rejects an unversioned name", () => {
    expect(EventNameSchema.safeParse("objective.created").success).toBe(false);
  });
});

describe("OrchestrationEventSchema", () => {
  it("accepts a well-formed event", () => {
    expect(OrchestrationEventSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts an optional causation id", () => {
    expect(
      OrchestrationEventSchema.safeParse({
        ...valid,
        causationId: "01941f29-7c00-7000-8000-000000000012",
      }).success,
    ).toBe(true);
  });

  it("rejects a sequence below one", () => {
    expect(OrchestrationEventSchema.safeParse({ ...valid, sequence: 0 }).success).toBe(false);
  });

  it("rejects an unknown stream type", () => {
    expect(OrchestrationEventSchema.safeParse({ ...valid, streamType: "vault" }).success).toBe(
      false,
    );
  });

  it("rejects an unknown field", () => {
    expect(OrchestrationEventSchema.safeParse({ ...valid, spoof: 1 }).success).toBe(false);
  });
});
```

```ts
// packages/contracts/src/ws.test.ts
import { describe, expect, it } from "vitest";

import { ClientFrameSchema, ServerFrameSchema } from "./ws.js";

describe("WebSocket frames", () => {
  it("accepts a subscribe frame carrying a resume point", () => {
    expect(
      ClientFrameSchema.safeParse({ kind: "subscribe", afterSequence: 42, envelopeVersion: 1 })
        .success,
    ).toBe(true);
  });

  it("rejects an unknown envelope version, failing closed", () => {
    expect(
      ClientFrameSchema.safeParse({ kind: "subscribe", afterSequence: 42, envelopeVersion: 2 })
        .success,
    ).toBe(false);
  });

  it("rejects an unknown client frame kind", () => {
    expect(ClientFrameSchema.safeParse({ kind: "mutate", envelopeVersion: 1 }).success).toBe(false);
  });

  it("accepts a server gap frame", () => {
    expect(
      ServerFrameSchema.safeParse({
        kind: "gap",
        envelopeVersion: 1,
        fromSequence: 10,
        toSequence: 99,
      }).success,
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run packages/contracts/src/events.test.ts packages/contracts/src/ws.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the event envelope and registry**

```ts
// packages/contracts/src/events.ts
import { z } from "zod";

import { SchemaVersionSchema, UtcTimestampSchema, UuidSchema } from "./primitives.js";

/**
 * The complete set of event names Phase 1 reserves. An unregistered name or an
 * unknown version fails to parse, satisfying the fail-closed contract rule.
 */
export const EVENT_NAMES = [
  "objective.created.v1",
  "objective.activated.v1",
  "objective.status_changed.v1",
  "mission.created.v1",
  "mission.approval_requested.v1",
  "mission.dispatched.v1",
  "mission.verified.v1",
  "surface.intent_upserted.v1",
  "surface.composition_changed.v1",
  "surface.override_set.v1",
  "identity.activated.v1",
  "identity.message_added.v1",
  "authority.decision_recorded.v1",
  "permission.revoked.v1",
  "node.connected.v1",
  "node.job_leased.v1",
  "node.job_result.v1",
  "source.observed.v1",
  "artifact.recorded.v1",
  "noir.hypothesis_added.v1",
  "noir.evidence_linked.v1",
  "noir.synthesis_updated.v1",
] as const;

export const EventNameSchema = z.enum(EVENT_NAMES);

export const StreamTypeSchema = z.enum([
  "objective",
  "mission",
  "identity",
  "surface",
  "node",
  "noir",
]);

export const ActorTypeSchema = z.enum(["user", "identity", "system", "node", "adapter"]);

export const OrchestrationEventSchema = z
  .object({
    id: UuidSchema,
    /** Global monotonic sequence. Monotonic, not guaranteed gapless. */
    sequence: z.int().positive(),
    streamType: StreamTypeSchema,
    streamId: UuidSchema,
    type: EventNameSchema,
    actorType: ActorTypeSchema,
    actorId: z.string().trim().min(1),
    payloadVersion: SchemaVersionSchema,
    payload: z.unknown(),
    correlationId: UuidSchema,
    causationId: UuidSchema.optional(),
    occurredAt: UtcTimestampSchema,
  })
  .strict();

export type EventName = z.infer<typeof EventNameSchema>;
export type StreamType = z.infer<typeof StreamTypeSchema>;
export type ActorType = z.infer<typeof ActorTypeSchema>;
export type OrchestrationEvent = z.infer<typeof OrchestrationEventSchema>;
```

- [ ] **Step 4: Implement the WebSocket frames**

```ts
// packages/contracts/src/ws.ts
import { z } from "zod";

import { OrchestrationEventSchema } from "./events.js";

/** Bumping this is a breaking protocol change; unknown versions fail closed. */
export const ENVELOPE_VERSION = 1;

const EnvelopeVersionSchema = z.literal(ENVELOPE_VERSION);

export const ClientFrameSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("subscribe"),
      envelopeVersion: EnvelopeVersionSchema,
      afterSequence: z.int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("acknowledge"),
      envelopeVersion: EnvelopeVersionSchema,
      sequence: z.int().positive(),
    })
    .strict(),
]);

export const ServerFrameSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("event"),
      envelopeVersion: EnvelopeVersionSchema,
      event: OrchestrationEventSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("gap"),
      envelopeVersion: EnvelopeVersionSchema,
      fromSequence: z.int().nonnegative(),
      toSequence: z.int().positive(),
    })
    .strict(),
]);

export type ClientFrame = z.infer<typeof ClientFrameSchema>;
export type ServerFrame = z.infer<typeof ServerFrameSchema>;
```

- [ ] **Step 5: Export and verify**

Add `export * from "./events.js";` and `export * from "./ws.js";` to `packages/contracts/src/index.ts`.

Run: `npx vitest run packages/contracts`
Expected: PASS

Run: `npm run format:check && npm run lint && npm run typecheck && npm run test:unit`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
npm run format
git add packages/contracts/src
git commit -m "feat(contracts): add versioned event envelope and WebSocket frames"
```

---

### Task 10: Database connection seam

**Files:**

- Create: `apps/core/src/db/connection.ts`, `apps/core/src/db/connection.test.ts`
- Modify: `apps/core/src/index.ts`

**Interfaces:**

- Consumes: nothing
- Produces: `openDatabase(path: string): NoctisDatabase` and the `NoctisDatabase` type. Tasks 12–14 accept a `NoctisDatabase`, never `DatabaseSync` directly — that is what keeps the driver swappable.

- [ ] **Step 1: Write the failing test**

```ts
// apps/core/src/db/connection.test.ts
import { describe, expect, it } from "vitest";

import { openDatabase } from "./connection.js";

describe("openDatabase", () => {
  it("enables foreign key enforcement", () => {
    const db = openDatabase(":memory:");
    const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    db.close();

    expect(row.foreign_keys).toBe(1);
  });

  it("actually rejects a violating write", () => {
    const db = openDatabase(":memory:");
    db.exec("CREATE TABLE parent (id TEXT PRIMARY KEY)");
    db.exec("CREATE TABLE child (parent_id TEXT REFERENCES parent(id))");

    expect(() => db.prepare("INSERT INTO child VALUES (?)").run("missing")).toThrow(/FOREIGN KEY/i);

    db.close();
  });

  it("round-trips a row", () => {
    const db = openDatabase(":memory:");
    db.exec("CREATE TABLE t (v TEXT NOT NULL)");
    db.prepare("INSERT INTO t VALUES (?)").run("hello");
    const row = db.prepare("SELECT v FROM t").get() as { v: string };
    db.close();

    expect(row.v).toBe("hello");
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run apps/core/src/db/connection.test.ts`
Expected: FAIL — cannot resolve `./connection.js`.

- [ ] **Step 3: Implement**

```ts
// apps/core/src/db/connection.ts
import { DatabaseSync } from "node:sqlite";

/**
 * The only module that names the SQLite driver. Phase 1 uses the built-in
 * node:sqlite; Phase 3 may qualify better-sqlite3 and swap it here alone.
 */
export type NoctisDatabase = DatabaseSync;

export function openDatabase(path: string): NoctisDatabase {
  const database = new DatabaseSync(path);

  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");

  if (path !== ":memory:") {
    database.exec("PRAGMA journal_mode = WAL");
  }

  return database;
}
```

WAL is skipped for in-memory databases because they do not support it.

- [ ] **Step 4: Export and verify**

```ts
// apps/core/src/index.ts
export * from "./config/environment.js";
export * from "./db/connection.js";
```

Run: `npx vitest run apps/core`
Expected: PASS

Run: `npm run format:check && npm run lint && npm run typecheck && npm run test:unit`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
npm run format
git add apps/core/src
git commit -m "feat(core): add SQLite connection seam with enforced pragmas"
```

---

### Task 11: The foundation migration

**Files:**

- Create: `apps/core/migrations/0001_foundation.sql`

**Interfaces:**

- Consumes: nothing
- Produces: all 26 tables. Task 12 applies this file; Tasks 13–14 write to `orchestration_events` and `idempotency_keys`.

- [ ] **Step 1: Write the migration**

```sql
-- apps/core/migrations/0001_foundation.sql
-- Phase 1 foundation schema. All timestamps are UTC ISO 8601 text.
-- All ids are UUIDv7 text. No secrets are stored in this database.

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  checksum   TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE objectives (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  intent            TEXT NOT NULL,
  status            TEXT NOT NULL,
  identity_id       TEXT NOT NULL,
  protocol_ids_json TEXT NOT NULL DEFAULT '[]',
  revision          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  activated_at      TEXT,
  completed_at      TEXT
);

CREATE INDEX idx_objectives_active ON objectives (status) WHERE status = 'active';

CREATE TABLE objective_links (
  objective_id TEXT NOT NULL REFERENCES objectives (id) ON DELETE CASCADE,
  related_type TEXT NOT NULL,
  related_id   TEXT NOT NULL,
  relation     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (objective_id, related_type, related_id, relation)
);

CREATE TABLE missions (
  id            TEXT PRIMARY KEY,
  objective_id  TEXT NOT NULL REFERENCES objectives (id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL,
  operation_class TEXT NOT NULL,
  host_policy   TEXT NOT NULL,
  host_id       TEXT,
  revision      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  started_at    TEXT,
  completed_at  TEXT
);

CREATE INDEX idx_missions_objective ON missions (objective_id);
CREATE INDEX idx_missions_status ON missions (status);

CREATE TABLE mission_steps (
  id              TEXT PRIMARY KEY,
  mission_id      TEXT NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  ordinal         INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  operation_class TEXT NOT NULL,
  status          TEXT NOT NULL,
  payload_version INTEGER NOT NULL,
  payload_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (mission_id, ordinal)
);

CREATE TABLE mission_evidence (
  id              TEXT PRIMARY KEY,
  mission_id      TEXT NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  step_id         TEXT REFERENCES mission_steps (id) ON DELETE SET NULL,
  kind            TEXT NOT NULL,
  host_id         TEXT NOT NULL,
  summary         TEXT NOT NULL,
  payload_version INTEGER NOT NULL,
  payload_json    TEXT NOT NULL,
  observed_at     TEXT NOT NULL
);

CREATE INDEX idx_mission_evidence_mission ON mission_evidence (mission_id);

CREATE TABLE approvals (
  id                  TEXT PRIMARY KEY,
  objective_id        TEXT REFERENCES objectives (id) ON DELETE SET NULL,
  mission_id          TEXT REFERENCES missions (id) ON DELETE SET NULL,
  actor_id            TEXT NOT NULL,
  operation_class     TEXT NOT NULL,
  capability          TEXT NOT NULL,
  target_json         TEXT NOT NULL,
  consequence_summary TEXT NOT NULL,
  reversibility       TEXT NOT NULL,
  estimated_cost_gbp  REAL,
  idempotency_key     TEXT NOT NULL,
  outcome             TEXT,
  policy_id           TEXT,
  reason_codes_json   TEXT NOT NULL DEFAULT '[]',
  permission_id       TEXT,
  requested_at        TEXT NOT NULL,
  decided_at          TEXT,
  expires_at          TEXT,
  UNIQUE (idempotency_key)
);

CREATE INDEX idx_approvals_pending ON approvals (outcome) WHERE outcome IS NULL;

CREATE TABLE standing_permissions (
  id               TEXT PRIMARY KEY,
  actor_id         TEXT NOT NULL,
  capability       TEXT NOT NULL,
  operation_class  TEXT NOT NULL,
  constraints_json TEXT NOT NULL DEFAULT '{}',
  granted_at       TEXT NOT NULL,
  expires_at       TEXT,
  revoked_at       TEXT
);

CREATE INDEX idx_standing_permissions_active
  ON standing_permissions (actor_id, capability) WHERE revoked_at IS NULL;

CREATE TABLE surface_intents (
  id               TEXT PRIMARY KEY,
  objective_id     TEXT NOT NULL REFERENCES objectives (id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  role             TEXT NOT NULL,
  persistence      TEXT NOT NULL,
  lifecycle        TEXT NOT NULL,
  priority         INTEGER NOT NULL,
  min_size         TEXT NOT NULL,
  preferred_region TEXT,
  source_ids_json  TEXT NOT NULL DEFAULT '[]',
  artifact_ids_json TEXT NOT NULL DEFAULT '[]',
  payload_version  INTEGER NOT NULL,
  payload_json     TEXT NOT NULL,
  requested_at     TEXT NOT NULL
);

CREATE INDEX idx_surface_intents_objective ON surface_intents (objective_id);

CREATE TABLE surface_overrides (
  id                  TEXT PRIMARY KEY,
  surface_id          TEXT NOT NULL REFERENCES surface_intents (id) ON DELETE CASCADE,
  client_id           TEXT NOT NULL,
  display_fingerprint TEXT NOT NULL,
  region              TEXT NOT NULL,
  size                TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  released_at         TEXT
);

CREATE TABLE composition_snapshots (
  id                  TEXT PRIMARY KEY,
  objective_id        TEXT NOT NULL REFERENCES objectives (id) ON DELETE CASCADE,
  layout_id           TEXT NOT NULL,
  display_fingerprint TEXT NOT NULL,
  plan_json           TEXT NOT NULL,
  reason_codes_json   TEXT NOT NULL DEFAULT '[]',
  generated_at        TEXT NOT NULL
);

CREATE TABLE orchestration_events (
  sequence        INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  stream_type     TEXT NOT NULL,
  stream_id       TEXT NOT NULL,
  type            TEXT NOT NULL,
  actor_type      TEXT NOT NULL,
  actor_id        TEXT NOT NULL,
  payload_version INTEGER NOT NULL,
  payload_json    TEXT NOT NULL,
  correlation_id  TEXT NOT NULL,
  causation_id    TEXT,
  occurred_at     TEXT NOT NULL
);

CREATE INDEX idx_events_stream ON orchestration_events (stream_type, stream_id, sequence);
CREATE INDEX idx_events_correlation ON orchestration_events (correlation_id);

CREATE TABLE identity_threads (
  id                 TEXT PRIMARY KEY,
  identity_id        TEXT NOT NULL,
  active_objective_id TEXT REFERENCES objectives (id) ON DELETE SET NULL,
  revision           INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX idx_identity_threads_identity ON identity_threads (identity_id);

CREATE TABLE identity_messages (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES identity_threads (id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  protocol_id TEXT,
  content_ref TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_identity_messages_thread ON identity_messages (thread_id, created_at);

CREATE TABLE nodes (
  id            TEXT PRIMARY KEY,
  host_id       TEXT NOT NULL,
  status        TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  last_seen_at  TEXT,
  revoked_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (host_id, fingerprint)
);

CREATE TABLE node_capabilities (
  id                  TEXT PRIMARY KEY,
  node_id             TEXT NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
  capability          TEXT NOT NULL,
  operation_class     TEXT NOT NULL,
  constraints_version INTEGER NOT NULL,
  constraints_json    TEXT NOT NULL DEFAULT '{}',
  granted_at          TEXT NOT NULL,
  expires_at          TEXT,
  revoked_at          TEXT
);

CREATE INDEX idx_node_capabilities_node ON node_capabilities (node_id) WHERE revoked_at IS NULL;

CREATE TABLE node_jobs (
  id               TEXT PRIMARY KEY,
  mission_id       TEXT REFERENCES missions (id) ON DELETE CASCADE,
  node_id          TEXT REFERENCES nodes (id) ON DELETE SET NULL,
  capability       TEXT NOT NULL,
  status           TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL,
  lease_expires_at TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  payload_version  INTEGER NOT NULL,
  payload_json     TEXT NOT NULL,
  revision         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (idempotency_key)
);

CREATE INDEX idx_node_jobs_lease ON node_jobs (status, lease_expires_at);

CREATE TABLE artifacts (
  id                 TEXT PRIMARY KEY,
  kind               TEXT NOT NULL,
  title              TEXT NOT NULL,
  uri                TEXT NOT NULL,
  media_type         TEXT,
  objective_id       TEXT REFERENCES objectives (id) ON DELETE SET NULL,
  mission_id         TEXT REFERENCES missions (id) ON DELETE SET NULL,
  source_id          TEXT,
  host_id            TEXT,
  checksum           TEXT,
  provenance_version INTEGER NOT NULL,
  provenance_json    TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL
);

CREATE INDEX idx_artifacts_objective ON artifacts (objective_id);

CREATE TABLE sources (
  id                TEXT PRIMARY KEY,
  source_type       TEXT NOT NULL,
  external_id       TEXT NOT NULL,
  freshness_seconds INTEGER NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (source_type, external_id)
);

CREATE TABLE source_observations (
  id              TEXT PRIMARY KEY,
  source_id       TEXT NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  status          TEXT NOT NULL,
  payload_version INTEGER NOT NULL,
  payload_json    TEXT NOT NULL,
  observed_at     TEXT NOT NULL,
  expires_at      TEXT
);

CREATE INDEX idx_source_observations_freshness ON source_observations (source_id, observed_at);

CREATE TABLE noir_cases (
  id           TEXT PRIMARY KEY,
  objective_id TEXT NOT NULL REFERENCES objectives (id) ON DELETE CASCADE,
  question     TEXT NOT NULL,
  status       TEXT NOT NULL,
  synthesis    TEXT,
  revision     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX idx_noir_cases_objective ON noir_cases (objective_id);

CREATE TABLE noir_hypotheses (
  id                   TEXT PRIMARY KEY,
  case_id              TEXT NOT NULL REFERENCES noir_cases (id) ON DELETE CASCADE,
  statement            TEXT NOT NULL,
  rank                 INTEGER NOT NULL,
  status               TEXT NOT NULL,
  confidence_rationale TEXT NOT NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE INDEX idx_noir_hypotheses_case ON noir_hypotheses (case_id, rank);

CREATE TABLE noir_evidence (
  id            TEXT PRIMARY KEY,
  case_id       TEXT NOT NULL REFERENCES noir_cases (id) ON DELETE CASCADE,
  hypothesis_id TEXT REFERENCES noir_hypotheses (id) ON DELETE SET NULL,
  source_id     TEXT REFERENCES sources (id) ON DELETE SET NULL,
  artifact_id   TEXT REFERENCES artifacts (id) ON DELETE SET NULL,
  stance        TEXT NOT NULL,
  verification  TEXT NOT NULL,
  summary       TEXT NOT NULL,
  observed_at   TEXT NOT NULL
);

CREATE INDEX idx_noir_evidence_case ON noir_evidence (case_id);

CREATE TABLE noir_falsifiers (
  id            TEXT PRIMARY KEY,
  case_id       TEXT NOT NULL REFERENCES noir_cases (id) ON DELETE CASCADE,
  hypothesis_id TEXT NOT NULL REFERENCES noir_hypotheses (id) ON DELETE CASCADE,
  check_text    TEXT NOT NULL,
  result        TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  resolved_at   TEXT
);

CREATE TABLE runtime_kv (
  key            TEXT PRIMARY KEY,
  value_version  INTEGER NOT NULL,
  value_json     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE idempotency_keys (
  key         TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  result_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
```

`check` is a reserved word in SQL, which is why the falsifier column is `check_text`.

- [ ] **Step 2: Commit**

```bash
npm run format
git add apps/core/migrations/0001_foundation.sql
git commit -m "feat(core): add the Phase 1 foundation migration"
```

Task 12 provides the tests that execute this file. Committing the schema separately keeps the migration reviewable on its own.

---

### Task 12: Migration ledger

**Files:**

- Create: `apps/core/src/db/migrate.ts`, `apps/core/src/db/migrate.test.ts`
- Modify: `apps/core/src/index.ts`, `package.json`

**Interfaces:**

- Consumes: `NoctisDatabase`, `openDatabase` from Task 10; `Clock` from Task 3
- Produces: `migrate(db: NoctisDatabase, options: MigrateOptions): MigrationOutcome` where `MigrateOptions` is `{ directory: string; clock: Clock }` and `MigrationOutcome` is `{ appliedVersions: number[] }`. Throws `MigrationError` for the two refusal cases.

- [ ] **Step 1: Write the failing test**

```ts
// apps/core/src/db/migrate.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fixedClock } from "@noctis/domain";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "./connection.js";
import { MigrationError, migrate } from "./migrate.js";

const clock = fixedClock(Date.parse("2026-09-01T12:00:00.000Z"));
const directories: string[] = [];

function makeMigrations(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "noctis-migrations-"));
  directories.push(directory);
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(directory, name), sql, "utf8");
  }
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("migrate", () => {
  it("applies a migration to an empty database", () => {
    const directory = makeMigrations({ "0001_init.sql": "CREATE TABLE a (id TEXT PRIMARY KEY);" });
    const db = openDatabase(":memory:");

    const outcome = migrate(db, { directory, clock });

    expect(outcome.appliedVersions).toEqual([1]);
    expect(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='a'").get()).toEqual({
      c: 1,
    });
    db.close();
  });

  it("is idempotent when re-run against a populated database", () => {
    const directory = makeMigrations({ "0001_init.sql": "CREATE TABLE a (id TEXT PRIMARY KEY);" });
    const db = openDatabase(":memory:");

    migrate(db, { directory, clock });
    db.prepare("INSERT INTO a VALUES (?)").run("row-1");
    const second = migrate(db, { directory, clock });

    expect(second.appliedVersions).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) c FROM a").get()).toEqual({ c: 1 });
    db.close();
  });

  it("applies multiple migrations in version order", () => {
    const directory = makeMigrations({
      "0002_second.sql": "CREATE TABLE b (id TEXT PRIMARY KEY);",
      "0001_first.sql": "CREATE TABLE a (id TEXT PRIMARY KEY);",
    });
    const db = openDatabase(":memory:");

    expect(migrate(db, { directory, clock }).appliedVersions).toEqual([1, 2]);
    db.close();
  });

  it("refuses a database recording a version newer than any known file", () => {
    const directory = makeMigrations({ "0001_init.sql": "CREATE TABLE a (id TEXT PRIMARY KEY);" });
    const db = openDatabase(":memory:");
    migrate(db, { directory, clock });
    db.prepare("INSERT INTO schema_migrations VALUES (?,?,?)").run(
      99,
      "x",
      "2026-09-01T12:00:00.000Z",
    );

    expect(() => migrate(db, { directory, clock })).toThrow(MigrationError);
    db.close();
  });

  it("refuses an applied migration whose checksum changed", () => {
    const directory = makeMigrations({ "0001_init.sql": "CREATE TABLE a (id TEXT PRIMARY KEY);" });
    const db = openDatabase(":memory:");
    migrate(db, { directory, clock });

    const tampered = makeMigrations({ "0001_init.sql": "CREATE TABLE tampered (id TEXT);" });

    expect(() => migrate(db, { directory: tampered, clock })).toThrow(/checksum/i);
    db.close();
  });

  it("leaves no ledger row and no objects when a migration fails", () => {
    const directory = makeMigrations({
      "0001_bad.sql": "CREATE TABLE good (id TEXT); THIS IS NOT SQL;",
    });
    const db = openDatabase(":memory:");

    expect(() => migrate(db, { directory, clock })).toThrow();
    expect(db.prepare("SELECT COUNT(*) c FROM schema_migrations").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='good'").get()).toEqual({
      c: 0,
    });
    db.close();
  });

  it("applies the real foundation migration and creates all 26 tables", () => {
    const db = openDatabase(":memory:");

    migrate(db, { directory: "apps/core/migrations", clock });
    const row = db
      .prepare(
        "SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .get() as { c: number };
    db.close();

    expect(row.c).toBe(26);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run apps/core/src/db/migrate.test.ts`
Expected: FAIL — cannot resolve `./migrate.js`.

- [ ] **Step 3: Implement**

```ts
// apps/core/src/db/migrate.ts
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Clock } from "@noctis/domain";

import type { NoctisDatabase } from "./connection.js";

export class MigrationError extends Error {}

export interface MigrateOptions {
  directory: string;
  clock: Clock;
}

export interface MigrationOutcome {
  appliedVersions: number[];
}

interface MigrationFile {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

const LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )
`;

function readMigrations(directory: string): MigrationFile[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => {
      const match = /^(\d+)_/.exec(name);
      if (match?.[1] === undefined) {
        throw new MigrationError(`Migration file name must start with a version: ${name}`);
      }
      const sql = readFileSync(join(directory, name), "utf8");
      return {
        version: Number.parseInt(match[1], 10),
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    })
    .sort((a, b) => a.version - b.version);
}

/**
 * Applies pending migrations. Each migration and its ledger row commit in one
 * transaction, so a failure leaves neither the schema change nor the record.
 */
export function migrate(db: NoctisDatabase, options: MigrateOptions): MigrationOutcome {
  db.exec(LEDGER);

  const files = readMigrations(options.directory);
  const known = new Map(files.map((file) => [file.version, file]));
  const applied = db
    .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
    .all() as Array<{ version: number; checksum: string }>;

  const highestKnown = files.reduce((max, file) => Math.max(max, file.version), 0);

  for (const row of applied) {
    if (row.version > highestKnown) {
      throw new MigrationError(
        `Database is at schema version ${row.version} but the newest known migration is ${highestKnown}. Refusing to start against an unknown newer schema.`,
      );
    }

    const file = known.get(row.version);
    if (file !== undefined && file.checksum !== row.checksum) {
      throw new MigrationError(
        `Migration ${file.name} has checksum ${file.checksum} but was applied as ${row.checksum}. An applied migration must never be edited.`,
      );
    }
  }

  const appliedVersions = new Set(applied.map((row) => row.version));
  const pending = files.filter((file) => !appliedVersions.has(file.version));
  const result: number[] = [];

  for (const file of pending) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(file.sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)",
      ).run(file.version, file.checksum, new Date(options.clock.now()).toISOString());
      db.exec("COMMIT");
      result.push(file.version);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  return { appliedVersions: result };
}
```

- [ ] **Step 4: Add the migration test script**

```json
"test:migrations": "vitest run apps/core/src/db"
```

- [ ] **Step 5: Run and verify**

Run: `npx vitest run apps/core/src/db/migrate.test.ts`
Expected: PASS (7 tests). The final test asserting 26 tables is the check that the migration file and the spec agree — if it reports a different number, reconcile the SQL against the spec's table list rather than editing the expected number.

Run: `npm run format:check && npm run lint && npm run typecheck && npm run test:unit`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
npm run format
git add apps/core/src/db package.json
git commit -m "feat(core): add checksummed migration ledger"
```

---

### Task 13: Atomic state-plus-event commit

**Files:**

- Create: `apps/core/src/db/events.ts`, `apps/core/src/db/transactions.ts`
- Create: `apps/core/src/db/transactions.test.ts`
- Modify: `apps/core/src/index.ts`

**Interfaces:**

- Consumes: `NoctisDatabase` from Task 10; `Result`, `ok`, `conflict` from Task 2; `OrchestrationEvent` from Task 9
- Produces: `appendEvent(db, event): number` returning the assigned sequence, and `commitStateAndEvent<T>(db, mutate): Result<CommittedOutcome<T>>` where `mutate: (db: NoctisDatabase) => Result<{ value: T; events: readonly EventDraft[] }>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/core/src/db/transactions.test.ts
import { fixedClock } from "@noctis/domain";
import { conflict, ok } from "@noctis/domain";
import { beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type NoctisDatabase } from "./connection.js";
import { migrate } from "./migrate.js";
import { commitStateAndEvent } from "./transactions.js";

const clock = fixedClock(Date.parse("2026-09-01T12:00:00.000Z"));

const OBJECTIVE_ID = "01941f29-7c00-7000-8000-000000000002";
const CORRELATION_ID = "01941f29-7c00-7000-8000-000000000011";

let db: NoctisDatabase;

function insertObjective(target: NoctisDatabase, id: string): void {
  target
    .prepare(
      `INSERT INTO objectives (id, title, intent, status, identity_id, created_at, updated_at)
       VALUES (?, 'T', 'I', 'draft', 'vesper', '2026-09-01T12:00:00.000Z', '2026-09-01T12:00:00.000Z')`,
    )
    .run(id);
}

function draftEvent(id: string, streamId: string) {
  return {
    id,
    streamType: "objective" as const,
    streamId,
    type: "objective.created.v1" as const,
    actorType: "user" as const,
    actorId: "mushaf",
    payloadVersion: 1,
    payload: {},
    correlationId: CORRELATION_ID,
    occurredAt: "2026-09-01T12:00:00.000Z",
  };
}

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db, { directory: "apps/core/migrations", clock });
});

describe("commitStateAndEvent", () => {
  it("commits state and its event together", () => {
    const result = commitStateAndEvent(db, (tx) => {
      insertObjective(tx, OBJECTIVE_ID);
      return ok({
        value: OBJECTIVE_ID,
        events: [draftEvent("01941f29-7c00-7000-8000-000000000020", OBJECTIVE_ID)],
      });
    });

    expect(result.ok).toBe(true);
    expect(db.prepare("SELECT COUNT(*) c FROM objectives").get()).toEqual({ c: 1 });
    expect(db.prepare("SELECT COUNT(*) c FROM orchestration_events").get()).toEqual({ c: 1 });
  });

  it("assigns a monotonic sequence to committed events", () => {
    for (const [index, id] of [
      "01941f29-7c00-7000-8000-00000000002a",
      "01941f29-7c00-7000-8000-00000000002b",
    ].entries()) {
      const objectiveId = `01941f29-7c00-7000-8000-00000000003${index}`;
      commitStateAndEvent(db, (tx) => {
        insertObjective(tx, objectiveId);
        return ok({ value: null, events: [draftEvent(id, objectiveId)] });
      });
    }

    const rows = db
      .prepare("SELECT sequence FROM orchestration_events ORDER BY sequence")
      .all() as Array<{ sequence: number }>;

    expect(rows).toHaveLength(2);
    expect(rows[1]!.sequence).toBeGreaterThan(rows[0]!.sequence);
  });

  it("THE GATE: a refusal writes neither state nor event", () => {
    const result = commitStateAndEvent(db, (tx) => {
      insertObjective(tx, OBJECTIVE_ID);
      return conflict({
        kind: "forbidden_transition",
        machine: "objective",
        from: "completed",
        to: "active",
      });
    });

    expect(result.ok).toBe(false);
    expect(db.prepare("SELECT COUNT(*) c FROM objectives").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM orchestration_events").get()).toEqual({ c: 0 });
  });

  it("THE GATE: a thrown failure between the writes leaves both tables empty", () => {
    expect(() =>
      commitStateAndEvent(db, (tx) => {
        insertObjective(tx, OBJECTIVE_ID);
        throw new Error("injected failure between state and event");
      }),
    ).toThrow("injected failure");

    expect(db.prepare("SELECT COUNT(*) c FROM objectives").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM orchestration_events").get()).toEqual({ c: 0 });
  });

  it("returns committed events so delivery happens only after commit", () => {
    const result = commitStateAndEvent(db, (tx) => {
      insertObjective(tx, OBJECTIVE_ID);
      return ok({
        value: OBJECTIVE_ID,
        events: [draftEvent("01941f29-7c00-7000-8000-000000000040", OBJECTIVE_ID)],
      });
    });

    expect(result.ok ? result.value.committedEvents[0]?.sequence : undefined).toBe(1);
  });

  it("rolls back a violating event without leaving the state row", () => {
    expect(() =>
      commitStateAndEvent(db, (tx) => {
        insertObjective(tx, OBJECTIVE_ID);
        return ok({
          value: null,
          events: [
            {
              ...draftEvent("01941f29-7c00-7000-8000-000000000050", OBJECTIVE_ID),
              type: "not.a.registered.event" as never,
            },
          ],
        });
      }),
    ).toThrow();

    expect(db.prepare("SELECT COUNT(*) c FROM objectives").get()).toEqual({ c: 0 });
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run apps/core/src/db/transactions.test.ts`
Expected: FAIL — cannot resolve `./transactions.js`.

- [ ] **Step 3: Implement the event writer**

```ts
// apps/core/src/db/events.ts
import type { OrchestrationEvent } from "@noctis/contracts";
import { OrchestrationEventSchema } from "@noctis/contracts";

import type { NoctisDatabase } from "./connection.js";

/** An event before the core assigns its global sequence. */
export type EventDraft = Omit<OrchestrationEvent, "sequence">;

/**
 * Appends one event and returns the sequence SQLite assigned. Must be called
 * inside an open transaction so the event and its state change commit together.
 */
export function appendEvent(db: NoctisDatabase, draft: EventDraft): OrchestrationEvent {
  const inserted = db
    .prepare(
      `INSERT INTO orchestration_events
         (id, stream_type, stream_id, type, actor_type, actor_id,
          payload_version, payload_json, correlation_id, causation_id, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING sequence`,
    )
    .get(
      draft.id,
      draft.streamType,
      draft.streamId,
      draft.type,
      draft.actorType,
      draft.actorId,
      draft.payloadVersion,
      JSON.stringify(draft.payload ?? null),
      draft.correlationId,
      draft.causationId ?? null,
      draft.occurredAt,
    ) as { sequence: number };

  // Parsing after insert proves the row we committed matches the contract.
  return OrchestrationEventSchema.parse({ ...draft, sequence: inserted.sequence });
}
```

- [ ] **Step 4: Implement the transaction helper**

```ts
// apps/core/src/db/transactions.ts
import type { OrchestrationEvent } from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { ok } from "@noctis/domain";

import type { NoctisDatabase } from "./connection.js";
import { appendEvent, type EventDraft } from "./events.js";

export interface Mutation<T> {
  value: T;
  events: readonly EventDraft[];
}

export interface CommittedOutcome<T> {
  value: T;
  /** Publish these only after this call returns. Delivery is at-least-once. */
  committedEvents: readonly OrchestrationEvent[];
}

/**
 * Commits relational state and its audit events in one transaction.
 *
 * A refusal returned by `mutate` rolls back and appends nothing, so the
 * event-append path is unreachable unless the mutation succeeded.
 */
export function commitStateAndEvent<T>(
  db: NoctisDatabase,
  mutate: (tx: NoctisDatabase) => Result<Mutation<T>>,
): Result<CommittedOutcome<T>> {
  db.exec("BEGIN IMMEDIATE");

  try {
    const outcome = mutate(db);

    if (!outcome.ok) {
      db.exec("ROLLBACK");
      return outcome;
    }

    const committedEvents = outcome.value.events.map((draft) => appendEvent(db, draft));

    db.exec("COMMIT");

    return ok({ value: outcome.value.value, committedEvents });
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
```

- [ ] **Step 5: Export and verify**

```ts
// apps/core/src/index.ts
export * from "./config/environment.js";
export * from "./db/connection.js";
export * from "./db/events.js";
export * from "./db/migrate.js";
export * from "./db/transactions.js";
```

Run: `npx vitest run apps/core`
Expected: PASS (6 transaction tests). The two tests marked THE GATE are the direct evidence for gate condition 4.

Run: `npm run format:check && npm run lint && npm run typecheck && npm run test:unit`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
npm run format
git add apps/core/src
git commit -m "feat(core): commit state and audit events atomically"
```

---

### Task 14: Revision checks and idempotency

**Files:**

- Create: `packages/domain/src/revision.ts`, `packages/domain/src/revision.test.ts`
- Create: `apps/core/src/db/idempotency.ts`, `apps/core/src/db/idempotency.test.ts`
- Modify: `packages/domain/src/index.ts`, `apps/core/src/index.ts`

**Interfaces:**

- Consumes: `Result`, `ok`, `conflict` from Task 2; `NoctisDatabase` from Task 10; `Clock` from Task 3
- Produces: `checkRevision(expected: number, actual: number): Result<number>` and `claimIdempotencyKey(db, { key, scope, resultId, clock }): Result<string>`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/domain/src/revision.test.ts
import { describe, expect, it } from "vitest";

import { checkRevision } from "./revision.js";

describe("checkRevision", () => {
  it("returns the next revision when the expected value matches", () => {
    expect(checkRevision(3, 3)).toEqual({ ok: true, value: 4 });
  });

  it("returns a revision_conflict when the record moved on", () => {
    expect(checkRevision(3, 5)).toEqual({
      ok: false,
      conflict: { kind: "revision_conflict", expected: 3, actual: 5 },
    });
  });

  it("returns a revision_conflict when the caller is ahead", () => {
    expect(checkRevision(7, 5).ok).toBe(false);
  });
});
```

```ts
// apps/core/src/db/idempotency.test.ts
import { fixedClock } from "@noctis/domain";
import { beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type NoctisDatabase } from "./connection.js";
import { claimIdempotencyKey } from "./idempotency.js";
import { migrate } from "./migrate.js";

const clock = fixedClock(Date.parse("2026-09-01T12:00:00.000Z"));
let db: NoctisDatabase;

beforeEach(() => {
  db = openDatabase(":memory:");
  migrate(db, { directory: "apps/core/migrations", clock });
});

describe("claimIdempotencyKey", () => {
  it("claims an unused key", () => {
    const result = claimIdempotencyKey(db, {
      key: "k1",
      scope: "objective.create",
      resultId: "01941f29-7c00-7000-8000-000000000002",
      clock,
    });

    expect(result).toEqual({ ok: true, value: "01941f29-7c00-7000-8000-000000000002" });
  });

  it("returns idempotent_replay with the original id on a second claim", () => {
    const options = {
      key: "k1",
      scope: "objective.create",
      resultId: "01941f29-7c00-7000-8000-000000000002",
      clock,
    };
    claimIdempotencyKey(db, options);

    const replay = claimIdempotencyKey(db, {
      ...options,
      resultId: "01941f29-7c00-7000-8000-00000000000f",
    });

    expect(replay).toEqual({
      ok: false,
      conflict: {
        kind: "idempotent_replay",
        key: "k1",
        existingId: "01941f29-7c00-7000-8000-000000000002",
      },
    });
  });

  it("treats the same key in a different scope as distinct", () => {
    const base = { key: "k1", resultId: "01941f29-7c00-7000-8000-000000000002", clock };
    claimIdempotencyKey(db, { ...base, scope: "objective.create" });

    expect(claimIdempotencyKey(db, { ...base, scope: "mission.create" }).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run packages/domain/src/revision.test.ts apps/core/src/db/idempotency.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the revision check**

```ts
// packages/domain/src/revision.ts
import type { Result } from "./result.js";
import { conflict, ok } from "./result.js";

/**
 * Optimistic concurrency. Returns the revision the caller should persist,
 * or a conflict when the stored record has moved on.
 */
export function checkRevision(expected: number, actual: number): Result<number> {
  if (expected !== actual) {
    return conflict<number>({ kind: "revision_conflict", expected, actual });
  }

  return ok(actual + 1);
}
```

- [ ] **Step 4: Implement the idempotency claim**

```ts
// apps/core/src/db/idempotency.ts
import type { Clock, Result } from "@noctis/domain";
import { conflict, ok } from "@noctis/domain";

import type { NoctisDatabase } from "./connection.js";

export interface ClaimOptions {
  key: string;
  scope: string;
  resultId: string;
  clock: Clock;
}

/**
 * Claims an idempotency key. Call inside the mutation's transaction so the
 * claim and the work it guards commit together.
 */
export function claimIdempotencyKey(db: NoctisDatabase, options: ClaimOptions): Result<string> {
  const scopedKey = `${options.scope}:${options.key}`;

  const existing = db
    .prepare("SELECT result_id FROM idempotency_keys WHERE key = ?")
    .get(scopedKey) as { result_id: string } | undefined;

  if (existing !== undefined) {
    return conflict<string>({
      kind: "idempotent_replay",
      key: options.key,
      existingId: existing.result_id,
    });
  }

  db.prepare(
    "INSERT INTO idempotency_keys (key, scope, result_id, created_at) VALUES (?, ?, ?, ?)",
  ).run(scopedKey, options.scope, options.resultId, new Date(options.clock.now()).toISOString());

  return ok(options.resultId);
}
```

- [ ] **Step 5: Export and verify**

Add `export * from "./revision.js";` to `packages/domain/src/index.ts` and `export * from "./db/idempotency.js";` to `apps/core/src/index.ts`.

Run: `npx vitest run packages/domain apps/core`
Expected: PASS

Run: `npm run format:check && npm run lint && npm run typecheck && npm run test:unit`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
npm run format
git add packages/domain/src apps/core/src
git commit -m "feat: add optimistic revision checks and idempotency claims"
```

---

### Task 15: Gate verification and acceptance record

**Files:**

- Modify: `docs/acceptance/IMPLEMENTATION-STATUS.md`
- Modify: `.github/workflows/verify.yml`

**Interfaces:**

- Consumes: everything from Tasks 1–14
- Produces: the recorded evidence that Phase 1 meets its gate

- [ ] **Step 1: Add the migration test to CI**

In `.github/workflows/verify.yml`, add to the `javascript` job's steps, after `npm run test:unit`:

```yaml
- run: npm run test:migrations
```

- [ ] **Step 2: Run the whole suite locally**

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:boundary
npm run test:unit
npm run test:migrations
npm run build
```

Expected: every command exits 0. Record the unit test count.

- [ ] **Step 3: Verify each gate condition explicitly**

Confirm by naming the test that proves it, and paste the run output into the record:

| Gate condition                                        | Proving test                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Migrations idempotent on empty and populated fixtures | `migrate.test.ts` — "applies a migration to an empty database", "is idempotent when re-run against a populated database" |
| Malformed model/worker/API data rejected              | `contracts.malformed.test.ts` — 63 hostile-input cases; `events.test.ts` — unknown name and version                      |
| All transition matrices pass                          | the five `state/*.test.ts` files, each enumerating its full state cross-product                                          |
| Rollback leaves no partial rows or events             | `transactions.test.ts` — the two tests marked THE GATE                                                                   |

- [ ] **Step 4: Push and confirm CI is green on the pinned runtime**

```bash
git push
gh run list --branch feat/phase-1-foundation --limit 1
```

Expected: both `javascript` and `rust` jobs pass. If `rust` fails, it is unrelated to Phase 1 — investigate separately rather than editing Phase 1 code.

- [ ] **Step 5: Record acceptance**

Append a dated section to `docs/acceptance/IMPLEMENTATION-STATUS.md` in the existing format: a Phase 1 check table, a verification-log table of the exact commands and their results, and the CI run ID. State plainly anything that was not verified locally and why.

Do not mark Phase 1 accepted until CI is green on the pinned runtime. Historical success is not current evidence.

- [ ] **Step 6: Commit**

```bash
npm run format
git add docs/acceptance/IMPLEMENTATION-STATUS.md .github/workflows/verify.yml
git commit -m "docs: record Phase 1 acceptance evidence"
git push
```

---

## Verification Checklist

Phase 1 is complete when all of these hold:

- [ ] `npm run format:check` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm run typecheck` exits 0
- [ ] `npm run test:boundary` exits 0
- [ ] `npm run test:unit` exits 0
- [ ] `npm run test:migrations` exits 0
- [ ] `npm run build` exits 0
- [ ] CI is green on Node 22.23.2 for both jobs
- [ ] The Node 22 `--experimental-sqlite` question in the spec's Section 8 is replaced with a confirmed answer
- [ ] The donor repository remains byte-for-byte unchanged against `DONOR-BASELINE.json`

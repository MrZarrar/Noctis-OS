import type { ModelRef, SetIdentityDefaultModelCommand } from "@noctis/contracts";
import { ELIGIBLE_AUTH_MODES, ModelRefSchema, RuntimeProbeSchema } from "@noctis/contracts";
import type { Result } from "@noctis/domain";
import { ok } from "@noctis/domain";

import type { NoctisDatabase } from "../db/connection.js";
import { ensureThread } from "../identities/service.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { runCommand } from "../kernel.js";

/** ADR-0026: model choice is data. The default lives in `runtime_kv`, per identity. */
function defaultKey(identityId: string): string {
  return `identity_model_default:${identityId}`;
}

const ProbesSchema = RuntimeProbeSchema.array();

/**
 * What can be chosen right now: the union of every connected, non-revoked
 * node's probed models, filtered to providers that are available under an
 * eligible auth mode (ADR-0023). Deduplicated by provider + model and sorted so
 * the Settings list is stable across nodes reporting the same thing.
 */
export function catalogue(
  db: NoctisDatabase,
  isConnected: (nodeId: string) => boolean,
): ModelRef[] {
  const rows = db
    .prepare(`SELECT id, providers_json FROM nodes WHERE status != 'revoked' ORDER BY id`)
    .all() as Array<{ id: string; providers_json: string }>;
  const seen = new Map<string, ModelRef>();

  for (const row of rows) {
    if (!isConnected(row.id)) {
      continue;
    }

    for (const probe of ProbesSchema.parse(JSON.parse(row.providers_json))) {
      if (!probe.available || !ELIGIBLE_AUTH_MODES.has(probe.authMode)) {
        continue;
      }

      for (const model of probe.models) {
        const key = `${model.providerId}:${model.model}`;

        if (!seen.has(key)) {
          seen.set(key, model);
        }
      }
    }
  }

  return [...seen.values()].sort(
    (left, right) =>
      left.providerId.localeCompare(right.providerId) || left.model.localeCompare(right.model),
  );
}

export function defaultModelFor(db: NoctisDatabase, identityId: string): ModelRef | undefined {
  const row = db
    .prepare(`SELECT value_json FROM runtime_kv WHERE key = ?`)
    .get(defaultKey(identityId)) as { value_json: string } | undefined;

  return row === undefined ? undefined : ModelRefSchema.parse(JSON.parse(row.value_json));
}

export function setDefaultModel(
  kernel: Kernel,
  context: CommandContext,
  command: SetIdentityDefaultModelCommand,
): Result<ModelRef> {
  const now = new Date(kernel.clock.now()).toISOString();

  return runCommand<ModelRef>(
    kernel,
    {
      scope: "identity.set_default_model",
      key: command.idempotencyKey,
      resultId: command.identityId,
    },
    (tx) => {
      // The event lives on the identity's free thread, like `identity.activated.v1`.
      const thread = ensureThread(tx, kernel, command.identityId, now);

      tx.prepare(
        `INSERT INTO runtime_kv (key, value_version, value_json, updated_at)
           VALUES (?, 1, ?, ?)
         ON CONFLICT (key) DO UPDATE SET
           value_version = value_version + 1,
           value_json = excluded.value_json,
           updated_at = excluded.updated_at`,
      ).run(defaultKey(command.identityId), JSON.stringify(command.model), now);

      return ok({
        value: command.model,
        events: [
          {
            id: kernel.ids.nextId(),
            streamType: "identity",
            streamId: thread.id,
            type: "identity.default_model_set.v1",
            actorType: context.actorType,
            actorId: context.actorId,
            payloadVersion: 1,
            payload: { identityId: command.identityId, model: command.model },
            correlationId: context.correlationId,
            occurredAt: now,
          },
        ],
      });
    },
  );
}

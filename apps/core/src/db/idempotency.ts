import type { Clock, Result } from "@noctis/domain";
import { conflict, ok } from "@noctis/domain";

import { inTransaction, type NoctisDatabase } from "./connection.js";

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
  if (!inTransaction(db)) {
    throw new Error("claimIdempotencyKey must run inside an open transaction");
  }

  const existing = db
    .prepare("SELECT result_id FROM idempotency_keys WHERE scope = ? AND key = ?")
    .get(options.scope, options.key) as { result_id: string } | undefined;

  if (existing !== undefined) {
    return conflict<string>({
      kind: "idempotent_replay",
      key: options.key,
      existingId: existing.result_id,
    });
  }

  db.prepare(
    "INSERT INTO idempotency_keys (key, scope, result_id, created_at) VALUES (?, ?, ?, ?)",
  ).run(options.key, options.scope, options.resultId, new Date(options.clock.now()).toISOString());

  return ok(options.resultId);
}

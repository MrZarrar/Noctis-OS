import type { RuntimeProposal } from "@noctis/contracts";
import {
  PANEL_PROPOSABLE_KINDS,
  SURFACE_PAYLOAD_SCHEMAS,
  RuntimeProposalSchema,
} from "@noctis/contracts";

import type { CommandContext, Kernel } from "../kernel.js";
import { createObjective, getObjective } from "../objectives/service.js";
import { upsertSurfaceIntent } from "../objectives/surface-intents.js";
import { createReminder, createNote } from "../productivity/service.js";
import {
  createTask,
  proposeTaskUpdate,
  getTask,
  pauseTask,
  runTaskNow,
} from "../productivity/tasks.js";
import type { TaskExecutionDeps } from "../productivity/tasks.js";
import { rememberPreference } from "../vault/brain.js";
import { addFact, createNote as createVaultNote, proposeRevision } from "../vault/promote.js";
import type { VaultRoot } from "../vault/root.js";
import type { Turn } from "./service.js";

/** What applying a proposal may reach beyond the kernel. Absent when no Vault is configured. */
export interface ProposalDeps {
  taskExecution?: TaskExecutionDeps;
  vaultRoot?: VaultRoot;
  vaultEnv?: Readonly<Record<string, string | undefined>>;
}

/**
 * ADR-0024: a model's proposal is data until the core turns it into one of the
 * existing commands, under `actorType: "identity"`. Nothing here trusts the
 * shape the runtime sent: a Surface payload is validated against the same
 * schema the renderer applies, and an Objective is born `suggested` (0.6) —
 * the model may suggest one, never activate one.
 *
 * Runs as its own command after the item that carried it has committed. It is
 * never nested inside that command.
 */
export function applyProposal(
  kernel: Kernel,
  context: CommandContext,
  turn: Turn,
  proposal: RuntimeProposal,
  idempotencyKey: string,
  deps: ProposalDeps = {},
): string | undefined {
  const skip = (reason: string, fields: Record<string, unknown> = {}): void => {
    kernel.logger.log("warn", "runtime proposal skipped", {
      turnId: turn.id,
      kind: proposal.kind,
      reason,
      ...fields,
    });
  };

  const validated = RuntimeProposalSchema.safeParse(proposal);
  if (!validated.success) {
    skip("invalid_proposal");
    return;
  }
  proposal = validated.data;
  if (
    proposal.kind === "vault_fact" ||
    proposal.kind === "vault_note" ||
    proposal.kind === "vault_revision"
  ) {
    const promote = { kernel, root: deps.vaultRoot, env: deps.vaultEnv ?? {} };
    const from = { path: proposal.path, source: proposal.source, turnId: turn.id };
    const edit =
      proposal.kind === "vault_fact"
        ? addFact(promote, { ...from, fact: proposal.fact })
        : proposal.kind === "vault_note"
          ? createVaultNote(promote, { ...from, title: proposal.title, body: proposal.body })
          : proposeRevision(promote, {
              ...from,
              find: proposal.find,
              replace: proposal.replace,
              reason: proposal.reason,
            });
    kernel.logger.log(edit.status === "refused" ? "warn" : "info", "vault edit", {
      turnId: turn.id,
      kind: edit.kind,
      status: edit.status,
      reason: edit.reason,
    });
    return;
  }
  if (proposal.kind === "task_action") {
    const task = getTask(kernel.db, proposal.taskId);
    if (task === undefined || task.identityId !== turn.identityId) {
      skip("foreign_or_missing_task");
      return;
    }
    const actor = { ...context, actorType: "identity" as const, actorId: turn.identityId };
    const command = { idempotencyKey, taskId: task.id, expectedRevision: task.revision };
    if (proposal.action === "run_now" && deps.taskExecution === undefined) {
      skip("task_execution_disabled");
      return;
    }
    const result =
      proposal.action === "pause"
        ? pauseTask(kernel, actor, command)
        : runTaskNow(kernel, actor, command, deps.taskExecution!);
    if (result.ok || result.conflict.kind === "idempotent_replay") return task.id;
    skip(result.conflict.kind);
    return;
  }
  if (proposal.kind === "reminder" || proposal.kind === "note" || proposal.kind === "task") {
    const capture = { idempotencyKey, identityId: turn.identityId, threadId: turn.threadId };
    const actor = { ...context, actorType: "identity" as const, actorId: turn.identityId };
    let created;
    if (proposal.kind === "reminder") {
      created = createReminder(kernel, actor, {
        ...capture,
        text: proposal.text,
        ...(proposal.note === undefined ? {} : { note: proposal.note }),
        trigger: proposal.trigger,
      });
    } else if (proposal.kind === "note") {
      created = createNote(kernel, actor, {
        ...capture,
        title: proposal.title,
        body: proposal.body,
      });
    } else {
      const fields = {
        name: proposal.name,
        prompt: proposal.prompt,
        model: proposal.model,
        nodeId: proposal.nodeId,
        rootGrantId: proposal.rootGrantId,
        trigger: proposal.trigger,
        threadMode: proposal.threadMode,
        maxRunMinutes: proposal.maxRunMinutes,
      };
      created =
        proposal.taskId === undefined
          ? createTask(kernel, actor, { ...capture, ...fields })
          : proposeTaskUpdate(kernel, actor, {
              idempotencyKey,
              taskId: proposal.taskId,
              ...fields,
            });
    }
    if (!created.ok && created.conflict.kind !== "idempotent_replay") skip(created.conflict.kind);
    return created.ok
      ? created.value.id
      : created.conflict.kind === "idempotent_replay"
        ? created.conflict.existingId
        : undefined;
  }

  if (proposal.kind === "preference") {
    // No command and no event: the Agent Brain is a file in the owner's Vault,
    // not orchestration state. A refusal is logged with its reason rather than
    // raised — a turn that learned something and could not write it down is
    // still a turn that did its work.
    const outcome = rememberPreference(
      { root: deps.vaultRoot, env: deps.vaultEnv ?? {} },
      proposal.bullet,
    );

    if (outcome.ok) {
      kernel.logger.log("info", "agent brain appended", { turnId: turn.id });
    } else {
      skip(outcome.refusal);
    }

    return;
  }

  if (proposal.kind === "objective") {
    const created = createObjective(kernel, context, {
      idempotencyKey,
      title: proposal.title,
      intent: proposal.intent,
      status: "suggested",
      identityId: turn.identityId,
      protocolIds: [],
    });

    if (!created.ok && created.conflict.kind !== "idempotent_replay") {
      skip(created.conflict.kind);
    }

    return;
  }

  if (!PANEL_PROPOSABLE_KINDS.has(proposal.surfaceKind)) {
    skip("kind_not_proposable", { surfaceKind: proposal.surfaceKind });
    return;
  }

  const contract = Object.hasOwn(SURFACE_PAYLOAD_SCHEMAS, proposal.surfaceKind)
    ? SURFACE_PAYLOAD_SCHEMAS[proposal.surfaceKind]
    : undefined;

  if (contract === undefined || contract.payloadVersion !== proposal.payloadVersion) {
    skip("unknown_surface_kind_or_version", { surfaceKind: proposal.surfaceKind });
    return;
  }

  const payload = contract.schema.safeParse(proposal.payload);

  if (!payload.success) {
    skip("invalid_surface_payload", { surfaceKind: proposal.surfaceKind });
    return;
  }

  const objectiveId = proposal.objectiveId;

  if (
    proposal.surfaceKind === "document" &&
    (payload.data as { content: { from: string } }).content.from !== "inline"
  ) {
    skip("document_must_be_inline");
    return;
  }

  if (objectiveId !== undefined && objectiveId !== turn.objectiveId) {
    skip("foreign_objective_for_surface");
    return;
  }

  if (objectiveId !== undefined && getObjective(kernel.db, objectiveId) === undefined) {
    skip("no_objective_for_surface");
    return;
  }

  const upserted = upsertSurfaceIntent(kernel, context, {
    idempotencyKey,
    ...(objectiveId === undefined ? { threadId: turn.threadId } : { objectiveId }),
    kind: proposal.surfaceKind,
    role: proposal.role,
    persistence: proposal.persistence,
    priority: proposal.priority,
    // The runtime never says how big: the smallest size, and composition decides.
    minSize: "compact",
    sourceIds: [turn.id],
    artifactIds: [],
    payloadVersion: proposal.payloadVersion,
    payload: payload.data,
  });

  if (!upserted.ok && upserted.conflict.kind !== "idempotent_replay") {
    skip(upserted.conflict.kind, { surfaceKind: proposal.surfaceKind });
  }
}

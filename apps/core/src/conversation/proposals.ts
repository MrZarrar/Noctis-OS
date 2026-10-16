import type { RuntimeProposal } from "@noctis/contracts";
import {
  PANEL_PROPOSABLE_KINDS,
  SURFACE_PAYLOAD_SCHEMAS,
  RuntimeProposalSchema,
  PathPanelProposalSchema,
} from "@noctis/contracts";
import type { PathPanelProposal } from "@noctis/contracts";
import { isWindowsPath, locateInRoots, viewerKind } from "@noctis/domain";

import { fileMediaType } from "../files/gateway.js";
import type { CommandContext, Kernel } from "../kernel.js";
import { listRuntimeRoots } from "../nodes/registry.js";
import { createObjective, getObjective } from "../objectives/service.js";
import { stableSourceId } from "../objectives/source-ids.js";
import {
  changeSurfaceLifecycle,
  listSurfaceIntents,
  upsertSurfaceIntent,
} from "../objectives/surface-intents.js";
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
import {
  addFact,
  captureToInbox,
  createNote as createVaultNote,
  proposeRevision,
} from "../vault/promote.js";
import type { VaultRoot } from "../vault/root.js";
import type { Turn } from "./service.js";

const FILE_PANEL_KINDS: ReadonlySet<string> = new Set(["document", "media", "visual"]);

/**
 * A panel for a file the agent names by path: the shared folder holding it on
 * the turn's PC, and the payload that kind takes. A string is why it cannot be.
 */
function fromPath(
  kernel: Kernel,
  turn: Turn,
  kind: string,
  asked: PathPanelProposal,
): { payload: unknown; sourceId: string } | string {
  const located =
    turn.nodeId === undefined
      ? undefined
      : locateInRoots(
          asked.path,
          turn.nodeId,
          listRuntimeRoots(kernel.db, () => true, kernel.clock.now()),
        );

  if (
    turn.nodeId === undefined ||
    located === undefined ||
    located.relativePath.split(/[\\/]/).includes("..")
  ) {
    return "file_outside_shared_folders";
  }

  const source = {
    from: "file",
    nodeId: turn.nodeId,
    grantId: located.root.grantId,
    relativePath: located.relativePath,
  };
  const name = located.relativePath.split("/").at(-1) ?? "";
  const viewer = viewerKind(name, 0);
  const actions = asked.actions === undefined ? {} : { actions: asked.actions };
  const payload =
    kind === "visual"
      ? /\.(?:html?|svg)$/i.test(name)
        ? { title: asked.title, source, ...actions }
        : undefined
      : kind === "document"
        ? viewer === "text"
          ? {
              title: asked.title,
              format: /\.md$/i.test(name) ? "markdown" : "text",
              content: source,
              ...actions,
            }
          : undefined
        : viewer === "image" || viewer === "video" || viewer === "audio"
          ? { title: asked.title, mediaType: fileMediaType(name), source }
          : undefined;

  if (payload === undefined) {
    return "file_does_not_fit_panel";
  }

  return {
    payload,
    sourceId: stableSourceId(
      turn.threadId,
      turn.nodeId,
      source.grantId,
      isWindowsPath(located.root.path) ? source.relativePath.toLowerCase() : source.relativePath,
    ),
  };
}

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
  if (proposal.kind === "inbox_note") {
    const saved = captureToInbox(
      { kernel, root: deps.vaultRoot, env: deps.vaultEnv ?? {} },
      { title: proposal.title, body: proposal.body, identityId: turn.identityId },
    );
    if ("reason" in saved) skip(saved.reason);
    else kernel.logger.log("info", "inbox note saved", { turnId: turn.id, path: saved.path });
    return;
  }
  if (
    proposal.kind === "vault_fact" ||
    proposal.kind === "vault_note" ||
    proposal.kind === "vault_revision"
  ) {
    // Only a promoter run may file into the Vault. Any other turn, Jester's or a
    // chat that read something hostile, is refused before anything is written.
    const promoterThread = kernel.db
      .prepare(`SELECT thread_id FROM vault_promoter WHERE id = 1`)
      .get() as { thread_id: string } | undefined;
    if (promoterThread?.thread_id !== turn.threadId) {
      skip("not_a_promoter_turn");
      return;
    }
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

  let raw = proposal.payload;
  let fileSourceId: string | undefined;
  const byPath = FILE_PANEL_KINDS.has(proposal.surfaceKind)
    ? PathPanelProposalSchema.safeParse(proposal.payload)
    : undefined;

  if (byPath?.success === true) {
    const shown = fromPath(kernel, turn, proposal.surfaceKind, byPath.data);

    if (typeof shown === "string") {
      skip(shown, { surfaceKind: proposal.surfaceKind });
      return;
    }

    raw = shown.payload;
    fileSourceId = shown.sourceId;
  } else if (proposal.surfaceKind === "visual" || proposal.surfaceKind === "media") {
    // A page that runs, or bytes from a PC, only ever come from a path the core
    // resolved itself, never from a node and grant the model named.
    skip("file_panel_needs_a_path", { surfaceKind: proposal.surfaceKind });
    return;
  }

  const payload = contract.schema.safeParse(raw);

  if (!payload.success) {
    skip("invalid_surface_payload", { surfaceKind: proposal.surfaceKind });
    return;
  }

  const objectiveId = proposal.objectiveId;

  if (
    proposal.surfaceKind === "document" &&
    fileSourceId === undefined &&
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

  const owner = objectiveId === undefined ? { threadId: turn.threadId } : { objectiveId };
  const sourceId =
    proposal.panelId !== undefined
      ? stableSourceId("panel", objectiveId ?? turn.threadId, proposal.panelId)
      : (fileSourceId ?? turn.id);

  if (proposal.withdrawn === true) {
    // Only a panel the agent can name again is withdrawn: one for a file or a panelId.
    const shown = listSurfaceIntents(kernel.db, owner).find(
      (intent) =>
        sourceId !== turn.id &&
        intent.kind === proposal.surfaceKind &&
        intent.sourceIds[0] === sourceId,
    );
    if (shown !== undefined && shown.lifecycle !== "dismissed") {
      const closed = changeSurfaceLifecycle(kernel, context, {
        idempotencyKey,
        surfaceId: shown.id,
        lifecycle: "dismissed",
      });
      if (!closed.ok && closed.conflict.kind !== "idempotent_replay") {
        skip(closed.conflict.kind, { surfaceKind: proposal.surfaceKind });
      }
    }
    return;
  }

  const upserted = upsertSurfaceIntent(kernel, context, {
    idempotencyKey,
    ...owner,
    kind: proposal.surfaceKind,
    role: proposal.role,
    persistence: proposal.persistence,
    priority: proposal.priority,
    // The runtime never says how big: the smallest size, and composition decides.
    minSize: "compact",
    // A shown file is the same panel the file gets when the agent writes it, so
    // editing it afterwards updates what the owner is already looking at.
    sourceIds: [sourceId],
    artifactIds: [],
    payloadVersion: proposal.payloadVersion,
    payload: payload.data,
  });

  if (!upserted.ok && upserted.conflict.kind !== "idempotent_replay") {
    skip(upserted.conflict.kind, { surfaceKind: proposal.surfaceKind });
  }
}

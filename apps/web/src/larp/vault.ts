import {
  PromoteVaultCommandSchema,
  RecallVaultCommandSchema,
  ReindexVaultCommandSchema,
  VaultEditCommandSchema,
} from "@noctis/contracts";
import type { VaultRecallEvidence } from "@noctis/contracts";
import { z } from "zod";

import type { VaultEdit } from "../pages/VaultEdits.js";
import type { CoreResponse } from "../transport/CoreTransport.js";

import type { LarpArea } from "./area.js";
import { ok, parsePath, rebase } from "./area.js";
import fixture from "./fixtures/vault.json" with { type: "json" };

// Each loaded demo keeps its changes here. The source fixture and storage stay untouched.
const state = rebase(fixture);
const edits: VaultEdit[] = structuredClone(state.edits) as VaultEdit[];
const changes = new Map<string, { before: string; after: string }>();
for (const edit of edits) {
  const note = state.notes.find((item) => item.path === edit.path);
  if (edit.kind === "fact" && edit.status === "applied" && note !== undefined) {
    changes.set(edit.id, { before: note.text.replace(`\n${edit.text}\n`, "\n"), after: note.text });
  }
}
const replays = new Map<string, { body: string; response: CoreResponse }>();
let unlocked = true;
let promoted = false;
let recallSequence = 0;

const refusal = (status: number, code: string, message: string): CoreResponse => ({
  status,
  body: { error: { code, message } },
});
const invalid = () => refusal(400, "invalid_request", "The request did not match its schema.");
const visibleNotes = () => state.notes.filter((note) => unlocked || !note.sensitive);
const passcodeStatus = () => ({ configured: true, unlocked, timeoutMinutes: 5, lockoutSeconds: 0 });

function findEvidence(query: string, limit: number): VaultRecallEvidence[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return [];
  const phrase = words.join(" ");
  const ranked = visibleNotes()
    .map((note) => {
      const title = note.title.toLowerCase();
      const text = note.text.toLowerCase();
      const matches = words.filter((word) => text.includes(word));
      // Require every query word. Titles and exact phrases rank ahead of passing mentions.
      const score =
        matches.length !== words.length
          ? 0
          : words.filter((word) => title.includes(word)).length * 10 +
            (title.includes(phrase) ? 25 : 0) +
            (text.includes(phrase) ? 5 : 0) +
            1;
      return { note, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.note.path.localeCompare(b.note.path));

  return ranked.slice(0, limit).map(({ note }) => {
    const lower = note.text.toLowerCase();
    const phraseStart = lower.indexOf(phrase);
    const hit = phraseStart < 0 ? lower.indexOf(words[0] ?? "") : phraseStart;
    const start = Math.max(0, hit - 70);
    const end = Math.min(note.text.length, Math.max(hit + phrase.length + 150, start + 240));
    const quote = note.text.slice(start, end);
    const byteStart = new TextEncoder().encode(note.text.slice(0, start)).length;
    return {
      itemId: note.itemId,
      entityId: note.id,
      path: note.path,
      quote,
      span: { start: byteStart, end: byteStart + new TextEncoder().encode(quote).length },
      freshness: "current",
    };
  });
}

function recall(query: string, limit = 10) {
  const evidence = findEvidence(query, limit);
  return {
    entityIds: evidence.map((item) => item.entityId),
    evidence,
    freshness: evidence.length === 0 ? ("unknown" as const) : ("current" as const),
  };
}

/** A strict VaultRecallPayloadSchema payload for conversation recall surfaces. */
export function recallVault(query: string) {
  const found = recall(query);
  return {
    query: query.trim() || "Vault",
    freshness: found.freshness,
    evidence: found.evidence.map(({ itemId, entityId, path, quote, freshness }) => ({
      itemId,
      entityId,
      path,
      quote,
      freshness,
    })),
  };
}

const commandSchemas: Record<string, z.ZodType<{ idempotencyKey: string }>> = {
  "vault.reindex": ReindexVaultCommandSchema,
  "vault.recall": RecallVaultCommandSchema,
  "vault.promote_now": PromoteVaultCommandSchema,
  "vault.undo_edit": VaultEditCommandSchema,
  "vault.apply_revision": VaultEditCommandSchema,
  "vault.decline_revision": VaultEditCommandSchema,
};

function command(name: string, body: unknown): CoreResponse | undefined {
  if (!Object.hasOwn(commandSchemas, name)) return undefined;
  const schema = commandSchemas[name];
  if (schema === undefined) return undefined;
  const parsed = schema.safeParse(body);
  if (!parsed.success) return invalid();
  const replayKey = `${name}:${parsed.data.idempotencyKey}`;
  const serialized = JSON.stringify(parsed.data);
  const previous = replays.get(replayKey);
  if (previous !== undefined) {
    return previous.body === serialized
      ? structuredClone(previous.response)
      : refusal(409, "idempotency_key_reused", "That key already belongs to another request.");
  }

  let response: CoreResponse;
  if (name === "vault.reindex") {
    response = ok({
      scanned: state.notes.length,
      added: 0,
      updated: 0,
      unchanged: state.notes.length,
      removed: 0,
      entities: state.notes.length,
      edges: state.edges.length,
    });
  } else if (name === "vault.recall") {
    const recallCommand = RecallVaultCommandSchema.parse(body);
    recallSequence += 1;
    response = ok({
      id: `01a05c32-8000-7000-a000-${String(recallSequence).padStart(12, "0")}`,
      ...(recallCommand.objectiveId === undefined
        ? {}
        : { objectiveId: recallCommand.objectiveId }),
      query: recallCommand.query,
      ...recall(recallCommand.query, recallCommand.limit),
      recordedAt: state.at,
    });
  } else if (name === "vault.promote_now") {
    const batch = promoted ? [] : state.promotions;
    edits.unshift(...(structuredClone(batch) as VaultEdit[]));
    promoted = true;
    response = ok(
      batch.length === 0 ? { notes: 0 } : { notes: batch.length, turnId: state.promotionTurnId },
    );
  } else {
    const { editId } = VaultEditCommandSchema.parse(body);
    const edit = edits.find((item) => item.id === editId);
    if (edit === undefined) return refusal(404, "not_found", "No such Vault edit.");
    const note = state.notes.find((item) => item.path === edit.path);
    const undo = name === "vault.undo_edit";
    if ((undo ? edit.status !== "applied" : edit.status !== "pending") || note === undefined) {
      return refusal(409, "forbidden_transition", "This Vault edit has already been decided.");
    }
    if (name === "vault.decline_revision") {
      edit.status = "declined";
    } else if (undo) {
      const change = changes.get(edit.id);
      if (change === undefined || note.text !== change.after) {
        edit.reason = "changed_since";
        return ok(structuredClone(edit));
      }
      note.text = change.before;
      edit.status = "undone";
    } else {
      if (edit.replaceText === undefined || note.text.split(edit.text).length !== 2) {
        return refusal(
          409,
          "conflict",
          "The quoted passage has changed since this revision was proposed.",
        );
      }
      const before = note.text;
      note.text = before.replace(edit.text, () => edit.replaceText ?? "");
      changes.set(edit.id, { before, after: note.text });
      edit.status = "applied";
    }
    delete edit.reason;
    edit.decidedAt = state.at;
    response = ok(structuredClone(edit));
  }
  replays.set(replayKey, { body: serialized, response: structuredClone(response) });
  return response;
}

export const vaultArea: LarpArea = {
  request(method, path, body) {
    const { segments, query } = parsePath(path);
    const [root, resource, id] = segments;
    if (method === "POST" && root === "commands" && segments.length === 2) {
      return command(resource ?? "", body);
    }
    if (root === "passcode") {
      if (method === "GET" && segments.length === 1) return ok(passcodeStatus());
      if (
        method !== "POST" ||
        segments.length !== 2 ||
        !["lock", "unlock", "setup"].includes(resource ?? "")
      )
        return undefined;
      if (resource === "lock") unlocked = false;
      else {
        const parsed = z.object({ passcode: z.string() }).safeParse(body);
        if (!parsed.success) return invalid();
        if (resource === "setup")
          return refusal(409, "already_configured", "A passcode is already set.");
        if (parsed.data.passcode !== "1234")
          return {
            status: 401,
            body: {
              error: {
                code: "wrong_passcode",
                message: "The passcode was not accepted.",
                details: { attemptsRemaining: 5 },
              },
            },
          };
        unlocked = true;
      }
      return ok(passcodeStatus());
    }
    if (method !== "GET" || root !== "vault") return undefined;
    const isGraph = resource === "graph" && segments.length === 2;
    if (!(
      segments.length === 1 ||
      (segments.length === 2 && ["graph", "edits", "recall"].includes(resource ?? "")) ||
      (segments.length === 3 && resource === "notes")
    ))
      return undefined;
    const max = isGraph ? 5000 : 500;
    const rawLimit = query.get("limit");
    const limit = rawLimit === null ? (isGraph ? 5000 : 100) : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > max) return invalid();
    const notes = visibleNotes();
    if (segments.length === 1) return ok({ configured: true, live: false, writesEnabled: true });
    if (resource === "edits") return ok({ edits: structuredClone(edits.slice(0, limit)) });
    if (resource === "notes") {
      const note = notes.find((item) => item.id === id);
      return note === undefined
        ? refusal(404, "not_found", "Note not found.")
        : ok({ path: note.path, title: note.title, text: note.text });
    }
    if (resource === "recall") {
      const text = query.get("query")?.trim() ?? "";
      return text === "" ? invalid() : ok(recall(text, limit));
    }
    const shown = notes.slice(0, limit);
    const ids = new Set(shown.map((note) => note.id));
    return ok({
      nodes: shown.map((note) => ({
        id: note.id,
        key: note.title.toLowerCase(),
        name: note.title,
        type: note.type,
        itemId: note.itemId,
        path: note.path,
        x: note.x,
        y: note.y,
        z: note.z,
      })),
      edges: structuredClone(
        state.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
      ),
      total: notes.length,
      truncated: shown.length < notes.length,
    });
  },
};

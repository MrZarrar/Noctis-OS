import { VaultRecallPayloadSchema, VaultRecallSchema } from "@noctis/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  EditsSchema,
  GraphSchema,
  NoteSchema,
  RecallSchema,
  StatusSchema,
} from "../pages/Vault.js";
import { VaultEditSchema } from "../pages/VaultEdits.js";
import { PasscodeStatusSchema, passcodeRefusal } from "../pages/vault-lock.js";
import type { CoreMethod, CoreResponse } from "../transport/CoreTransport.js";
import type * as VaultModule from "./vault.js";

let vault: typeof VaultModule;

beforeEach(async () => {
  vi.resetModules();
  vault = await import("./vault.js");
});

function request(method: CoreMethod, path: string, body?: unknown): CoreResponse {
  const response = vault.vaultArea.request?.(method, path, body);
  expect(response, path).toBeDefined();
  if (response === undefined) throw new Error(`Missing fixture for ${path}`);
  return response;
}

function graph() {
  return GraphSchema.parse(request("GET", "/vault/graph").body);
}

function edits() {
  return EditsSchema.parse(request("GET", "/vault/edits").body).edits;
}

function noteAt(path: string) {
  const node = graph().nodes.find((node) => node.path === path);
  expect(node).toBeDefined();
  return NoteSchema.parse(request("GET", `/vault/notes/${node?.id ?? ""}`).body);
}

describe("fictional Vault reads", () => {
  it("serves an indexed Vault and a dense graph with readable, linked notes in every PARA area", () => {
    expect(StatusSchema.parse(request("GET", "/vault").body)).toEqual({
      configured: true,
      live: false,
      writesEnabled: true,
    });
    const full = graph();
    expect(full.nodes.length).toBeGreaterThanOrEqual(300);
    expect(full.nodes.length).toBeLessThanOrEqual(400);
    expect(full.total).toBe(full.nodes.length);
    expect(full.truncated).toBe(false);
    expect(new Set(full.nodes.map((node) => node.path?.split("/")[0]))).toEqual(
      new Set(["projects", "people", "reference", "daily", "inbox", "agent"]),
    );
    const ids = new Set(full.nodes.map((node) => node.id));
    expect(ids.size).toBe(full.nodes.length);
    expect(full.edges.length).toBeGreaterThan(full.nodes.length * 4);
    for (const node of full.nodes) {
      expect(
        [node.x, node.y, node.z].every(
          (value) => typeof value === "number" && Number.isFinite(value),
        ),
      ).toBe(true);
      const note = NoteSchema.parse(
        request("GET", `/vault/notes/${encodeURIComponent(node.id)}`).body,
      );
      expect(note.path).toBe(node.path);
      expect(note.title).toBe(node.name);
      expect(note.text.length).toBeGreaterThan(180);
      expect(note.text).toContain("[[");
    }
    for (const edge of full.edges) {
      expect(ids.has(edge.source) && ids.has(edge.target)).toBe(true);
      expect(edge.source).not.toBe(edge.target);
    }
    expect(
      Math.max(
        ...full.nodes.map((node) => full.edges.filter((edge) => edge.target === node.id).length),
      ),
    ).toBeGreaterThan(20);
    expect(edits().some((edit) => edit.status === "pending")).toBe(true);
  });

  it("clips graph edges to the requested nodes and refuses invalid limits", () => {
    const clipped = GraphSchema.parse(request("GET", "/vault/graph?limit=12").body);
    expect(clipped.nodes).toHaveLength(12);
    expect(clipped.total).toBeGreaterThan(300);
    expect(clipped.truncated).toBe(true);
    expect(
      clipped.edges.every(
        (edge) =>
          clipped.nodes.some((n) => n.id === edge.source) &&
          clipped.nodes.some((n) => n.id === edge.target),
      ),
    ).toBe(true);
    for (const limit of ["0", "-1", "1.5", "5001", "nope"]) {
      expect(request("GET", `/vault/graph?limit=${limit}`).status).toBe(400);
    }
    expect(request("GET", "/vault/notes/unknown").status).toBe(404);
  });

  it.each(["hardware panel", "glucose", "Codex", "pricing"])(
    "recalls %s with evidence from actual note bodies",
    (query) => {
      const result = RecallSchema.parse(
        request("GET", `/vault/recall?query=${encodeURIComponent(query)}&limit=3`).body,
      );
      expect(result.evidence.length).toBeGreaterThan(0);
      expect(result.evidence.length).toBeLessThanOrEqual(3);
      expect(result.freshness).toBe("current");
      for (const evidence of result.evidence) {
        const note = NoteSchema.parse(request("GET", `/vault/notes/${evidence.entityId}`).body);
        expect(note.text).toContain(evidence.quote);
        expect(evidence.path).toBe(note.path);
        expect(result.entityIds).toContain(evidence.entityId);
      }
      const payload = VaultRecallPayloadSchema.parse(vault.recallVault(query));
      expect(payload.query).toBe(query);
      expect(payload.evidence.length).toBeGreaterThan(0);
    },
  );

  it("matches body words case-insensitively, and handles empty or unmatched queries", () => {
    expect(vault.recallVault("sPaRkLiNe").evidence.length).toBeGreaterThan(0);
    expect(vault.recallVault("quasarbananaxylophone").evidence).toEqual([]);
    expect(vault.recallVault("quasarbananaxylophone").freshness).toBe("unknown");
    expect(request("GET", "/vault/recall?query=%20").status).toBe(400);
  });
});

describe("in-memory Vault actions", () => {
  it("reindexes without moving the graph, and records a schema-valid recall", () => {
    const before = graph();
    const reindex = request("POST", "/commands/vault.reindex", { idempotencyKey: "index" });
    expect(reindex.status).toBe(200);
    expect(reindex.body).toMatchObject({
      scanned: before.total,
      unchanged: before.total,
      added: 0,
      removed: 0,
    });
    expect(graph()).toEqual(before);
    const command = request("POST", "/commands/vault.recall", {
      idempotencyKey: "recall",
      query: "hardware panel",
      limit: 2,
    });
    expect(command.status).toBe(200);
    const result = VaultRecallSchema.parse(command.body);
    expect(result.evidence).toHaveLength(2);
    for (const evidence of result.evidence) {
      const note = NoteSchema.parse(request("GET", `/vault/notes/${evidence.entityId}`).body);
      expect(
        new TextDecoder().decode(
          new TextEncoder().encode(note.text).slice(evidence.span.start, evidence.span.end),
        ),
      ).toBe(evidence.quote);
    }
  });

  it("applies a pending revision to the note and restores its text on undo", () => {
    const pending = edits().find(
      (edit) => edit.status === "pending" && edit.replaceText !== undefined,
    );
    expect(pending).toBeDefined();
    if (pending === undefined) throw new Error("Missing pending revision");
    const before = noteAt(pending.path).text;
    expect(before).toContain(pending.text);
    const applied = request("POST", "/commands/vault.apply_revision", {
      idempotencyKey: "apply",
      editId: pending.id,
    });
    expect(applied.status).toBe(200);
    expect(VaultEditSchema.parse(applied.body).status).toBe("applied");
    expect(noteAt(pending.path).text).toBe(before.replace(pending.text, pending.replaceText ?? ""));
    expect(edits().find((edit) => edit.id === pending.id)?.status).toBe("applied");
    const undone = request("POST", "/commands/vault.undo_edit", {
      idempotencyKey: "undo",
      editId: pending.id,
    });
    expect(VaultEditSchema.parse(undone.body).status).toBe("undone");
    expect(noteAt(pending.path).text).toBe(before);
    expect(
      request("POST", "/commands/vault.apply_revision", {
        idempotencyKey: "again",
        editId: pending.id,
      }).status,
    ).toBe(409);
  });

  it("declines a revision without changing its note, and undoes an applied fact", () => {
    const pending = edits().find((edit) => edit.status === "pending");
    const fact = edits().find((edit) => edit.kind === "fact" && edit.status === "applied");
    if (pending === undefined || fact === undefined) throw new Error("Missing editable fixtures");
    const before = noteAt(pending.path).text;
    const declined = request("POST", "/commands/vault.decline_revision", {
      idempotencyKey: "decline",
      editId: pending.id,
    });
    expect(VaultEditSchema.parse(declined.body).status).toBe("declined");
    expect(noteAt(pending.path).text).toBe(before);
    expect(noteAt(fact.path).text).toContain(fact.text);
    const undone = request("POST", "/commands/vault.undo_edit", {
      idempotencyKey: "fact",
      editId: fact.id,
    });
    expect(VaultEditSchema.parse(undone.body).status).toBe("undone");
    expect(noteAt(fact.path).text).not.toContain(fact.text);
  });

  it("promotes an inbox batch into visible revisions once per idempotency key", () => {
    const before = edits().length;
    const body = { idempotencyKey: "promote" };
    const response = request("POST", "/commands/vault.promote_now", body);
    expect(response.status).toBe(200);
    expect(
      z.object({ notes: z.number().positive(), turnId: z.uuid() }).parse(response.body).notes,
    ).toBeGreaterThan(0);
    expect(edits().length).toBeGreaterThan(before);
    const after = edits().length;
    expect(request("POST", "/commands/vault.promote_now", body)).toEqual(response);
    expect(edits()).toHaveLength(after);
  });

  it("rejects malformed commands and missing edits without changing state", () => {
    const before = edits();
    expect(request("POST", "/commands/vault.reindex", {}).status).toBe(400);
    expect(
      request("POST", "/commands/vault.apply_revision", {
        idempotencyKey: "bad",
        editId: "missing",
      }).status,
    ).toBe(400);
    expect(
      request("POST", "/commands/vault.undo_edit", {
        idempotencyKey: "missing",
        editId: "01a05c32-5e80-7208-b379-6be0ea7e7440",
      }).status,
    ).toBe(404);
    expect(edits()).toEqual(before);
  });

  it("locks sensitive notes and unlocks them only with 1234", () => {
    expect(PasscodeStatusSchema.parse(request("GET", "/passcode").body).unlocked).toBe(true);
    const full = graph();
    expect(PasscodeStatusSchema.parse(request("POST", "/passcode/lock", {}).body).unlocked).toBe(
      false,
    );
    const locked = graph();
    expect(locked.total).toBeLessThan(full.total);
    const hidden = full.nodes.find(
      (node) => !locked.nodes.some((candidate) => candidate.id === node.id),
    );
    expect(request("GET", `/vault/notes/${hidden?.id ?? ""}`).status).toBe(404);
    const wrong = request("POST", "/passcode/unlock", { passcode: "0000" });
    expect(wrong.status).toBe(401);
    expect(passcodeRefusal(wrong.body)).toContain("wrong");
    expect(request("POST", "/passcode/unlock", {}).status).toBe(400);
    expect(request("POST", "/passcode/setup", { passcode: "1234" }).status).toBe(409);
    expect(
      PasscodeStatusSchema.parse(request("POST", "/passcode/unlock", { passcode: "1234" }).body)
        .unlocked,
    ).toBe(true);
    expect(graph().total).toBe(full.total);
  });

  it("leaves other areas and unknown routes to DemoTransport", () => {
    for (const [method, path] of [
      ["GET", "/nodes"],
      ["POST", "/commands/health.dismiss"],
      ["GET", "/vault/unknown"],
      ["POST", "/commands/vault.unknown"],
      ["POST", "/commands/toString"],
      ["POST", "/commands/__proto__"],
      ["GET", "/passcode/unknown"],
      ["POST", "/vault/graph"],
    ] as const) {
      expect(vault.vaultArea.request?.(method, path, {})).toBeUndefined();
    }
  });

  it("preserves a newer revision when an older fact is undone", () => {
    const fact = edits().find((edit) => edit.kind === "fact" && edit.status === "applied");
    const pending = edits().find((edit) => edit.status === "pending" && edit.path === fact?.path);
    if (pending === undefined || fact === undefined) throw new Error("Missing related edits");
    request("POST", "/commands/vault.apply_revision", {
      idempotencyKey: "newer",
      editId: pending.id,
    });
    const before = noteAt(fact.path).text;
    const undo = request("POST", "/commands/vault.undo_edit", {
      idempotencyKey: "older",
      editId: fact.id,
    });
    expect(VaultEditSchema.parse(undo.body)).toMatchObject({
      status: "applied",
      reason: "changed_since",
    });
    expect(noteAt(fact.path).text).toBe(before);
  });
});

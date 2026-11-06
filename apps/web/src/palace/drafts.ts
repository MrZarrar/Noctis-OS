import { PalaceContentsSchema, SavePalaceCommandSchema, UuidSchema } from "@noctis/contracts";
import type { SavePalaceCommand } from "@noctis/contracts";
import { z } from "zod";

export interface DraftScope {
  ownerId: string;
  coreOrigin: string;
  fixture: boolean;
}
const DraftSchema = z
  .object({
    draftId: UuidSchema,
    command: SavePalaceCommandSchema.extend({
      contents: z.object({ ...PalaceContentsSchema.shape, tags: z.array(z.string()) }).strict(),
    }),
    dirty: z.boolean(),
  })
  .strict();
export type PalaceDraft = z.infer<typeof DraftSchema>;
const memory = new Map<string, PalaceDraft>();
const persisted = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();
let generation = 0;
function keyFor(scope: DraftScope, id: string): string {
  return JSON.stringify([scope.coreOrigin, scope.ownerId, scope.fixture, id]);
}
function ownerPrefix(scope: DraftScope): string {
  return JSON.stringify([scope.coreOrigin, scope.ownerId, scope.fixture]).slice(0, -1) + ",";
}
function ordered<T>(action: () => Promise<T>): Promise<T> {
  const next = queue.then(action, action);
  queue = next.catch(() => undefined);
  return next;
}

async function stored<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open("noctis-palace-drafts", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("drafts");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("Draft storage is unavailable"));
    open.onblocked = () => reject(new Error("Draft storage is blocked"));
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction("drafts", mode);
      const request = run(transaction.objectStore("drafts"));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? new Error("Draft write was aborted"));
      transaction.onerror = () => reject(transaction.error ?? new Error("Draft storage failed"));
    });
  } finally {
    db.close();
  }
}

export async function loadDraft(
  scope: DraftScope,
  id: string,
  sensitive = false,
): Promise<PalaceDraft | undefined> {
  const key = keyFor(scope, id);
  const inMemory = memory.get(key);
  if (inMemory !== undefined) return structuredClone(inMemory);
  if (sensitive) return undefined;
  return ordered(async () => {
    try {
      const parsed = DraftSchema.safeParse(await stored("readonly", (store) => store.get(key)));
      if (!parsed.success || parsed.data.command.contents.sensitive) return undefined;
      persisted.add(key);
      return parsed.data;
    } catch {
      return undefined;
    }
  });
}

export function saveDraft(
  scope: DraftScope,
  id: string,
  value: PalaceDraft,
): Promise<"device" | "memory" | "unavailable"> {
  const draft = structuredClone(value);
  const key = keyFor(scope, id);
  memory.set(key, structuredClone(draft));
  const started = generation;
  return ordered(async () => {
    if (started !== generation) return "unavailable";
    try {
      if (draft.command.contents.sensitive) {
        if (persisted.has(key)) {
          await stored("readwrite", (store) => store.delete(key));
          persisted.delete(key);
        }
        return "memory";
      }
      await stored("readwrite", (store) => store.put(draft, key));
      persisted.add(key);
      return "device";
    } catch {
      return "unavailable";
    }
  });
}

export function listDrafts(scope: DraftScope): Promise<PalaceDraft[]> {
  return ordered(async () => {
    const drafts = new Map<string, PalaceDraft>();
    try {
      await stored("readonly", (store) => {
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor === null) return;
          if (typeof cursor.key === "string" && cursor.key.startsWith(ownerPrefix(scope))) {
            const parsed = DraftSchema.safeParse(cursor.value);
            if (parsed.success) persisted.add(cursor.key);
            if (parsed.success && !parsed.data.command.contents.sensitive)
              drafts.set(parsed.data.draftId, parsed.data);
          }
          cursor.continue();
        };
        return request;
      });
    } catch {
      /* Memory recovery is available when device storage is disabled. */
    }
    for (const [key, value] of memory) {
      if (!key.startsWith(ownerPrefix(scope))) continue;
      if (value.command.contents.sensitive) drafts.delete(value.draftId);
      else drafts.set(value.draftId, value);
    }
    return [...drafts.values()].filter((draft) => draft.dirty);
  });
}

export function removeDraft(scope: DraftScope, id: string): Promise<void> {
  const key = keyFor(scope, id);
  memory.delete(key);
  persisted.delete(key);
  return ordered(async () => {
    try {
      await stored("readwrite", (store) => store.delete(key));
    } catch {
      /* Access may be disabled. */
    }
  });
}

export async function clearOwnerDrafts(scope: DraftScope): Promise<void> {
  generation += 1;
  const prefix = JSON.stringify([scope.coreOrigin, scope.ownerId]).slice(0, -1) + ",";
  for (const key of memory.keys()) if (key.startsWith(prefix)) memory.delete(key);
  await ordered(async () => {
    try {
      await stored("readwrite", (store) => {
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor === null) return;
          if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) cursor.delete();
          cursor.continue();
        };
        return request;
      });
    } catch {
      /* Memory is still cleared when device storage is unavailable. */
    }
  });
}

export function clearSensitiveDrafts(scope: DraftScope): void {
  generation += 1;
  const prefix = ownerPrefix(scope);
  for (const [key, value] of memory)
    if (key.startsWith(prefix) && value.command.contents.sensitive) memory.delete(key);
  window.dispatchEvent(new Event("palace-sensitive-cleared"));
}

export function newPalaceId(): string {
  const time = Date.now().toString(16).padStart(12, "0");
  const random = crypto.randomUUID().replaceAll("-", "");
  return UuidSchema.parse(
    `${time.slice(0, 8)}-${time.slice(8)}-7${random.slice(0, 3)}-${random.slice(16, 20)}-${random.slice(20)}`,
  );
}

export function hasSensitiveDrafts(scope: DraftScope): boolean {
  return [...memory].some(
    ([key, value]) => key.startsWith(ownerPrefix(scope)) && value.command.contents.sensitive,
  );
}
export function newPalaceDraft(): PalaceDraft {
  return {
    draftId: newPalaceId(),
    command: {
      entryId: newPalaceId(),
      idempotencyKey: newPalaceId(),
      contents: PalaceContentsSchema.parse({
        kind: "thought",
        body: "",
        sensitive: false,
        archived: false,
        connections: [],
        tags: [],
      }),
    },
    dirty: false,
  };
}

export async function protectSensitiveDrafts(
  scope: DraftScope,
  save: (command: SavePalaceCommand) => Promise<unknown>,
): Promise<boolean> {
  const drafts = [...memory.entries()].filter(
    ([key, value]) =>
      key.startsWith(ownerPrefix(scope)) && value.command.contents.sensitive && value.dirty,
  );
  if (drafts.length === 0) return true;
  const choice = await new Promise<"save" | "discard" | "cancel">((resolve) => {
    const dialog = document.createElement("dialog");
    const text = document.createElement("p");
    text.textContent =
      "Sensitive writing has unsaved changes. Save or discard them before continuing.";
    dialog.append(text);
    for (const [label, action] of [
      ["Save", "save"],
      ["Discard", "discard"],
      ["Keep editing", "cancel"],
    ] as const) {
      const button = document.createElement("button");
      button.textContent = label;
      button.onclick = () => {
        dialog.close();
        dialog.remove();
        resolve(action);
      };
      dialog.append(button);
    }
    dialog.oncancel = () => {
      dialog.remove();
      resolve("cancel");
    };
    document.body.append(dialog);
    dialog.showModal();
  });
  if (choice === "cancel") return false;
  if (choice === "save") {
    try {
      for (const [, draft] of drafts) await save(draft.command);
    } catch {
      return false;
    }
  }
  clearSensitiveDrafts(scope);
  return true;
}

import type { PalaceContents, PalaceEntry, PalaceRoom } from "@noctis/contracts";
import { PalaceContentsSchema } from "@noctis/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { createPalaceApi, palaceDraftScope, PalaceRequestError } from "./api.js";
import {
  clearSensitiveDrafts,
  listDrafts,
  newPalaceDraft,
  newPalaceId,
  protectSensitiveDrafts,
  removeDraft,
  saveDraft,
} from "./drafts.js";
import type { PalaceDraft } from "./drafts.js";

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "The entry could not be saved";
export function usePalace(transport: CoreTransport | undefined, focusId?: string) {
  const api = useMemo(() => createPalaceApi(transport), [transport]);
  const scope = useMemo(palaceDraftScope, []);
  const [room, setRoom] = useState<PalaceRoom>("gallery");
  const [thisRoom, setThisRoom] = useState(false);
  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [entries, setEntries] = useState<PalaceEntry[]>([]);
  const [books, setBooks] = useState<PalaceEntry[]>([]);
  const [notebook, setNotebook] = useState<PalaceEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [draft, setDraft] = useState<PalaceDraft>(newPalaceDraft);
  const draftRef = useRef(draft);
  const keyRef = useRef(draft.draftId);
  const privacySequence = useRef(0);
  const [recoverable, setRecoverable] = useState<PalaceDraft[]>([]);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [loadingEntry, setLoadingEntry] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState<PalaceEntry>();
  const [unlocked, setUnlocked] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const listSequence = useRef(0);
  const openSequence = useRef(0);
  const mounted = useRef(true);
  const replaceDraft = useCallback((value: PalaceDraft) => {
    draftRef.current = value;
    setDraft(value);
  }, []);
  const reload = useCallback(() => setRefresh((value) => value + 1), []);

  const flushDraft = useCallback(async () => {
    const current = draftRef.current;
    if (!current.dirty) return;
    const result = await saveDraft(scope, keyRef.current, current);
    if (draftRef.current !== current || !mounted.current) return;
    setStatus(
      result === "device"
        ? "Draft saved on this device"
        : result === "memory"
          ? "Sensitive draft held in memory. Device recovery is unavailable."
          : current.command.contents.sensitive
            ? "An earlier device draft could not be cleared. Sensitive writing is held in memory."
            : "Device recovery is unavailable. Keep this page open.",
    );
  }, [scope]);

  useEffect(() => {
    mounted.current = true;
    const flush = () => {
      void flushDraft();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      mounted.current = false;
      void flushDraft();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, [scope, replaceDraft, flushDraft]);

  useEffect(() => {
    let active = true;
    void listDrafts(scope).then((values) => {
      if (active) setRecoverable(values);
    });
    return () => {
      active = false;
    };
  }, [scope, refresh]);

  useEffect(() => {
    if (!draft.dirty) return;
    const timer = setTimeout(() => {
      void flushDraft();
    }, 400);
    return () => clearTimeout(timer);
  }, [draft, flushDraft]);

  useEffect(() => {
    let active = true;
    const privacy = privacySequence.current;
    void api
      .list({ kind: "book", archived: "all", limit: 200 })
      .then((page) => {
        if (active && privacy === privacySequence.current) setBooks(page.entries);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api, refresh]);

  useEffect(() => {
    const sequence = ++listSequence.current;
    void api
      .list({
        query,
        archived: archived ? "true" : "false",
        ...(thisRoom ? { room } : {}),
        limit: 100,
      })
      .then((page) => {
        if (sequence !== listSequence.current || !mounted.current) return;
        setEntries(page.entries);
        setNextCursor(page.nextCursor);
      })
      .catch((error) => {
        if (sequence === listSequence.current && mounted.current) setError(messageOf(error));
      });
    return () => {
      listSequence.current++;
    };
  }, [api, query, archived, thisRoom, room, refresh]);

  useEffect(() => {
    const cleared = () => {
      privacySequence.current++;
      openSequence.current++;
      listSequence.current++;
      setLoadingEntry(false);
      if (draftRef.current.command.contents.sensitive) {
        const blank = newPalaceDraft();
        keyRef.current = blank.draftId;
        replaceDraft(blank);
        setStatus("Sensitive writing cleared");
      }
      setConflict(undefined);
      setRecoverable([]);
      setEntries((values) => values.filter((value) => !value.sensitive));
      setBooks((values) => values.filter((value) => !value.sensitive));
      setNotebook((values) => values.filter((value) => !value.sensitive));
      setUnlocked(false);
      reload();
    };
    const check = async () => {
      try {
        const status = await api.passcode();
        if (!mounted.current) return;
        setUnlocked(status.unlocked);
        if (!status.unlocked) clearSensitiveDrafts(scope);
      } catch (error) {
        if (
          mounted.current &&
          error instanceof PalaceRequestError &&
          [401, 403].includes(error.status)
        )
          clearSensitiveDrafts(scope);
      }
    };
    window.addEventListener("palace-sensitive-cleared", cleared);
    void check();
    const timer = setInterval(() => {
      void check();
    }, 15_000);
    return () => {
      clearInterval(timer);
      window.removeEventListener("palace-sensitive-cleared", cleared);
    };
  }, [api, scope, replaceDraft, reload]);

  const update = (fields: Partial<PalaceContents>, replace = false) => {
    if (busy.current || loadingEntry) return;
    const current = draftRef.current;
    const next: PalaceDraft = {
      draftId: current.draftId,
      command: {
        ...current.command,
        idempotencyKey: newPalaceId(),
        contents: replace ? (fields as PalaceContents) : { ...current.command.contents, ...fields },
      },
      dirty: true,
    };
    replaceDraft(next);
    setStatus("");
    setError(undefined);
    if (next.command.contents.sensitive) {
      setRecoverable((values) => values.filter((value) => value.draftId !== next.draftId));
      void saveDraft(scope, keyRef.current, next);
    }
  };

  const save = async (): Promise<boolean> => {
    if (busy.current || loadingEntry) return false;
    busy.current = true;
    setPending(true);
    setError(undefined);
    setStatus("Saving...");
    const current = draftRef.current;
    const draftKey = keyRef.current;
    const privacy = privacySequence.current;
    try {
      await saveDraft(scope, draftKey, current);
      const receipt = await api.save(current.command);
      await removeDraft(scope, draftKey);
      if (privacy !== privacySequence.current || !mounted.current) return true;
      replaceDraft({
        draftId: current.draftId,
        command: {
          ...current.command,
          expectedHash: receipt.contentHash,
          idempotencyKey: newPalaceId(),
        },
        dirty: false,
      });
      setStatus(
        api.fixture
          ? "Fixture entry updated. Changes last for this tab."
          : receipt.indexStatus === "pending"
            ? "Saved. Vault indexing is pending."
            : "Saved",
      );
      setConflict(undefined);
      reload();
      return true;
    } catch (error) {
      setStatus("");
      setError(messageOf(error));
      if (error instanceof PalaceRequestError && error.status === 409) {
        try {
          const saved = await api.read(current.command.entryId);
          if (privacy === privacySequence.current && mounted.current) setConflict(saved);
        } catch {
          /* The local draft remains available. */
        }
      }
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  };

  const open = useCallback(
    async (id: string, recovered?: PalaceDraft) => {
      if (busy.current) return;
      const sequence = ++openSequence.current;
      setLoadingEntry(true);
      setError(undefined);
      try {
        await flushDraft();
        if (sequence !== openSequence.current || !mounted.current) return;
        const entry = await api.read(id);
        if (sequence !== openSequence.current || !mounted.current) return;
        const { id: entryId, contentHash } = entry;
        const contents = PalaceContentsSchema.strip().parse(entry);
        const restored =
          recovered === undefined
            ? {
                draftId: newPalaceId(),
                command: {
                  entryId,
                  expectedHash: contentHash,
                  idempotencyKey: newPalaceId(),
                  contents,
                },
                dirty: false,
              }
            : {
                ...recovered,
                command: {
                  ...recovered.command,
                  contents: {
                    ...recovered.command.contents,
                    sensitive: entry.sensitive || recovered.command.contents.sensitive,
                  },
                },
              };
        keyRef.current = restored.draftId;
        replaceDraft(restored);
        if (restored.command.contents.sensitive && restored.dirty)
          void saveDraft(scope, restored.draftId, restored);
        setStatus(recovered?.dirty ? "Recovered local draft" : "");
        setConflict(undefined);
      } catch (error) {
        if (sequence === openSequence.current) setError(messageOf(error));
      } finally {
        if (sequence === openSequence.current) setLoadingEntry(false);
      }
    },
    [api, scope, replaceDraft, flushDraft],
  );
  useEffect(() => {
    if (focusId !== undefined) void open(focusId);
  }, [focusId, open]);

  useEffect(() => {
    let active = true;
    const privacy = privacySequence.current;
    if (draft.command.contents.kind !== "book") {
      setNotebook([]);
      return;
    }
    void api
      .list({ bookId: draft.command.entryId, limit: 200 })
      .then((page) => {
        if (active && privacy === privacySequence.current) setNotebook(page.entries);
      })
      .catch(() => {
        if (active) setNotebook([]);
      });
    return () => {
      active = false;
    };
  }, [api, draft.command.entryId, draft.command.contents.kind, refresh]);

  const loadSaved = async () => {
    await removeDraft(scope, keyRef.current);
    replaceDraft({ ...draftRef.current, dirty: false });
    await open(draftRef.current.command.entryId);
  };

  const startNew = async () => {
    if (busy.current) return;
    setLoadingEntry(true);
    await flushDraft();
    openSequence.current++;
    setLoadingEntry(false);
    const blank = newPalaceDraft();
    keyRef.current = blank.draftId;
    replaceDraft(blank);
    setStatus("");
    setError(undefined);
    setConflict(undefined);
    setRecoverable(await listDrafts(scope));
  };
  const recover = async (value: PalaceDraft) => {
    if (busy.current) return;
    if (value.command.expectedHash !== undefined) {
      await open(value.command.entryId, value);
      return;
    }
    setLoadingEntry(true);
    await flushDraft();
    setLoadingEntry(false);
    keyRef.current = value.draftId;
    replaceDraft(value);
    setConflict(undefined);
    setStatus("Recovered local draft");
  };
  const keepReviewedEdits = () => {
    if (conflict === undefined || busy.current) return;
    const reviewed: PalaceDraft = {
      draftId: draftRef.current.draftId,
      dirty: true,
      command: {
        ...draftRef.current.command,
        expectedHash: conflict.contentHash,
        idempotencyKey: newPalaceId(),
        contents: {
          ...draftRef.current.command.contents,
          sensitive: conflict.sensitive || draftRef.current.command.contents.sensitive,
        },
      },
    };
    replaceDraft(reviewed);
    void saveDraft(scope, reviewed.draftId, reviewed);
    setConflict(undefined);
    setStatus("Reviewed edits are ready to save");
  };
  const archiveOrRestore = async () => {
    if (
      busy.current ||
      draftRef.current.dirty ||
      draftRef.current.command.expectedHash === undefined
    )
      return;
    busy.current = true;
    setPending(true);
    const current = draftRef.current;
    const privacy = privacySequence.current;
    try {
      const command = {
        entryId: current.command.entryId,
        expectedHash: current.command.expectedHash!,
        idempotencyKey: `${current.command.idempotencyKey}-archive`,
      };
      const receipt = await (current.command.contents.archived
        ? api.restore(command)
        : api.archive(command));
      if (privacy !== privacySequence.current || !mounted.current) return;
      replaceDraft({
        draftId: current.draftId,
        dirty: false,
        command: {
          ...current.command,
          expectedHash: receipt.contentHash,
          idempotencyKey: newPalaceId(),
          contents: { ...current.command.contents, archived: !current.command.contents.archived },
        },
      });
      setStatus(current.command.contents.archived ? "Restored" : "Archived");
      reload();
    } catch (error) {
      setError(messageOf(error));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const loadMore = async () => {
    if (nextCursor === undefined) return;
    const sequence = listSequence.current;
    try {
      const page = await api.list({
        query,
        archived: archived ? "true" : "false",
        ...(thisRoom ? { room } : {}),
        cursor: nextCursor,
        limit: 100,
      });
      if (sequence !== listSequence.current) return;
      setEntries((values) => [
        ...new Map([...values, ...page.entries].map((entry) => [entry.id, entry])).values(),
      ]);
      setNextCursor(page.nextCursor);
    } catch (error) {
      setError(messageOf(error));
    }
  };
  const lock = async () => {
    await flushDraft();
    if (!(await protectSensitiveDrafts(scope, api.save))) return;
    try {
      await api.lock();
      clearSensitiveDrafts(scope);
      reload();
    } catch (error) {
      setError(messageOf(error));
    }
  };
  const unlock = async (passcode: string) => {
    try {
      await api.unlock(passcode);
      setUnlocked(true);
      setError(undefined);
      reload();
    } catch (error) {
      setError(messageOf(error));
    }
  };
  return {
    api,
    room,
    setRoom,
    thisRoom,
    setThisRoom,
    query,
    setQuery,
    archived,
    setArchived,
    entries,
    books,
    notebook,
    nextCursor,
    draft,
    update,
    save,
    open,
    startNew,
    archiveOrRestore,
    loadMore,
    lock,
    unlock,
    unlocked,
    pending,
    loadingEntry,
    status,
    error,
    conflict,
    loadSaved,
    recoverable,
    recover,
    keepReviewedEdits,
  };
}

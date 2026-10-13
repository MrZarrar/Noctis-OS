import { useEffect, useRef, useState } from "react";
import {
  PAGE_PANEL_PAGES,
  type ConversationalIdentityId,
  type PagePanelPayload,
  type SurfaceOwner,
} from "@noctis/contracts";
import { corner, semantic, spacing, typography } from "@noctis/ui";
import { buttonStyle, glass } from "../layout/Page.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { openPagePanel } from "./page-panels.js";

export function AddPanel({
  transport,
  owner,
  identityId,
  contextFiles,
  focusId,
  onOpen,
  onAdded,
}: {
  transport: CoreTransport | undefined;
  owner?: SurfaceOwner;
  identityId: ConversationalIdentityId;
  contextFiles?: PagePanelPayload["folder"];
  focusId?: string | undefined;
  onOpen?: (id: string) => void;
  onAdded: () => void;
}): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ownerKey = `${identityId}:${JSON.stringify(owner)}`;
  const current = useRef({ key: ownerKey, generation: 0 });
  if (current.current.key !== ownerKey)
    current.current = { key: ownerKey, generation: current.current.generation + 1 };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function add(page: PagePanelPayload["page"]): Promise<void> {
    if (transport === undefined || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    dialog.current?.close();
    const generation = current.current.generation;
    let openedKey = ownerKey;
    const stillHere = () =>
      mounted.current &&
      ((current.current.generation === generation && current.current.key === ownerKey) ||
        (openedKey !== ownerKey &&
          current.current.generation === generation + 1 &&
          current.current.key === openedKey));
    try {
      await openPagePanel({
        transport,
        ...(owner === undefined ? {} : { owner }),
        identityId,
        payload: {
          page,
          ...(page === "Files" && contextFiles !== undefined ? { folder: contextFiles } : {}),
          ...(page === "Vault" && focusId !== undefined ? { focusId } : {}),
        },
        onOpen: (id) => {
          if (stillHere()) {
            openedKey = `${identityId}:${JSON.stringify({ threadId: id })}`;
            onOpen?.(id);
          }
        },
      });
      if (stillHere()) onAdded();
    } catch {
      if (stillHere()) setError("Could not open this panel. Try again.");
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <div>
      <button
        type="button"
        aria-label="Add panel"
        disabled={transport === undefined || busy}
        style={buttonStyle}
        onClick={() => dialog.current?.showModal()}
      >
        +
      </button>
      {error !== undefined && (
        <p role="alert" style={{ color: semantic.error }}>
          {error}
        </p>
      )}
      <dialog
        ref={dialog}
        aria-label="Add panel"
        style={{
          ...glass,
          color: typography.color.primary,
          borderRadius: corner.md,
          width: "min(320px, 90vw)",
          maxHeight: "70dvh",
          overflow: "auto",
          padding: spacing.md,
        }}
      >
        <div style={{ display: "grid", gap: spacing.sm }}>
          {PAGE_PANEL_PAGES.map((page) => (
            <button
              key={page}
              type="button"
              aria-label={`Open ${page} panel`}
              style={buttonStyle}
              onClick={() => void add(page)}
            >
              {page}
            </button>
          ))}
          <button type="button" style={buttonStyle} onClick={() => dialog.current?.close()}>
            Cancel
          </button>
        </div>
      </dialog>
    </div>
  );
}

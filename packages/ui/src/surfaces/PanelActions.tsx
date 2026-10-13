import { useRef, useState } from "react";
import type { PanelAction } from "@noctis/contracts";
import { corner, material, semantic, spacing } from "../tokens/index.js";

export function PanelActions({
  actions,
  onAction,
  disabled = false,
  error,
}: {
  actions: readonly PanelAction[];
  onAction?: (message: string) => void | Promise<void>;
  disabled?: boolean;
  error?: string;
}): JSX.Element {
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();
  async function act(message: string): Promise<void> {
    if (pendingRef.current || disabled || onAction === undefined) return;
    pendingRef.current = true;
    setPending(true);
    setFailure(undefined);
    try {
      await onAction(message);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : "Couldn't send choice. Try again.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  return (
    <div style={{ marginTop: spacing.md }}>
      <div
        role="group"
        aria-label="Panel choices"
        aria-busy={pending}
        style={{ display: "flex", flexWrap: "wrap", gap: spacing.sm }}
      >
        {actions.map((action, index) => (
          <button
            key={index}
            type="button"
            disabled={disabled || pending || onAction === undefined}
            onClick={() => {
              void act(action.message);
            }}
            style={{
              minHeight: 44,
              minWidth: 44,
              maxWidth: "100%",
              overflowWrap: "anywhere",
              padding: spacing.sm,
              borderRadius: corner.sm,
              border: `1px solid ${material.border}`,
              background: material.fillElevated,
              color: "inherit",
              cursor: "pointer",
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
      {pending && <p role="status">Sending choice…</p>}
      {(failure ?? error) !== undefined && (
        <p role="alert" style={{ color: semantic.warning }}>
          {failure ?? error}
        </p>
      )}
    </div>
  );
}

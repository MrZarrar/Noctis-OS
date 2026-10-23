import { semantic } from "@noctis/ui";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useCallback, useRef, useState } from "react";

import { buttonStyle } from "./Page.js";

export function usePendingAction() {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const run = useCallback(async (action: () => void | Promise<unknown>): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(undefined);
    try {
      await action();
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : "The action failed. Try again.");
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, []);

  return { pending, error, run };
}

export function ActionButton({
  onAction,
  pendingLabel = "Working...",
  children,
  disabled,
  style,
  type = "button",
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  onAction: () => void | Promise<unknown>;
  pendingLabel?: ReactNode;
}): JSX.Element {
  const action = usePendingAction();

  return (
    <>
      <button
        {...props}
        type={type}
        disabled={disabled || action.pending}
        aria-busy={action.pending}
        onClick={() => void action.run(onAction)}
        style={style ?? buttonStyle}
      >
        {action.pending ? pendingLabel : children}
      </button>
      {action.error !== undefined && (
        <span role="alert" style={{ color: semantic.error }}>
          {action.error}
        </span>
      )}
    </>
  );
}

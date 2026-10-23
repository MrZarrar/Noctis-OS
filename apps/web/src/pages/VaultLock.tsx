import { semantic, spacing, typography } from "@noctis/ui";
import { useCallback, useEffect, useState } from "react";

import { buttonStyle, fieldStyle } from "../layout/Page.js";
import { usePendingAction } from "../layout/ActionButton.js";
import type { CoreTransport } from "../transport/CoreTransport.js";

import type { PasscodeStatus } from "./vault-lock.js";
import { PasscodeStatusSchema, passcodeRefusal } from "./vault-lock.js";

/**
 * The passcode that shows notes marked `sensitive: true`. Locked, the core
 * leaves them out of the sphere and recall; `onChange` re-reads the Vault
 * whenever that changes.
 */
export function VaultLock({
  transport,
  onChange,
}: {
  transport: CoreTransport | undefined;
  onChange: () => void;
}): JSX.Element | null {
  const [status, setStatus] = useState<PasscodeStatus>();
  const [passcode, setPasscode] = useState("");
  const { pending, error: message, run } = usePendingAction();

  useEffect(() => {
    if (transport === undefined) {
      return;
    }

    void run(async () => {
      const response = await transport.request("GET", "/passcode");
      const parsed = PasscodeStatusSchema.safeParse(response.body);

      if (parsed.success) {
        setStatus(parsed.data);
      }
    });
  }, [transport, run]);

  const act = useCallback(
    async (action: "setup" | "unlock" | "lock") => {
      if (transport === undefined) {
        return;
      }

      await run(async () => {
        const response = await transport.request(
          "POST",
          `/passcode/${action}`,
          action === "lock" ? {} : { passcode },
        );
        const parsed = PasscodeStatusSchema.safeParse(response.body);

        if (response.status === 200 && parsed.success) {
          setStatus(parsed.data);
          setPasscode("");
          onChange();
        } else {
          throw new Error(passcodeRefusal(response.body));
        }
      });
    },
    [transport, passcode, onChange, run],
  );

  if (status === undefined) {
    return null;
  }

  if (status.unlocked) {
    return (
      <div style={{ display: "flex", gap: spacing.sm, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ color: typography.color.muted }}>Sensitive notes are shown.</span>
        <button
          type="button"
          disabled={pending}
          aria-busy={pending}
          onClick={() => void act("lock")}
          style={buttonStyle}
        >
          {pending ? "Locking..." : "Lock"}
        </button>
        {message !== undefined && (
          <span role="alert" style={{ color: semantic.error }}>
            {message}
          </span>
        )}
      </div>
    );
  }

  const action = status.configured ? "unlock" : "setup";

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void act(action);
      }}
      style={{ display: "flex", flexDirection: "column", gap: spacing.xs, maxWidth: 560 }}
    >
      <div style={{ display: "flex", gap: spacing.sm, alignItems: "center" }}>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          pattern="[0-9]*"
          maxLength={8}
          value={passcode}
          disabled={pending}
          aria-label={status.configured ? "Passcode" : "New passcode, 4 to 8 digits"}
          placeholder={status.configured ? "Passcode" : "New passcode, 4 to 8 digits"}
          onChange={(event) => {
            setPasscode(event.target.value.replace(/\D/g, ""));
          }}
          style={{ ...fieldStyle, flex: 1 }}
        />
        <button type="submit" disabled={pending} aria-busy={pending} style={buttonStyle}>
          {pending
            ? status.configured
              ? "Unlocking..."
              : "Saving..."
            : status.configured
              ? "Show sensitive"
              : "Set passcode"}
        </button>
      </div>
      <span
        role={message === undefined ? undefined : "alert"}
        style={{ color: message === undefined ? typography.color.muted : semantic.error }}
      >
        {message ??
          (status.configured
            ? "Notes marked sensitive are hidden."
            : "Set a passcode to see notes marked sensitive: true.")}
      </span>
    </form>
  );
}

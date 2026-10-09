import { semantic, spacing, typography } from "@noctis/ui";
import { useCallback, useEffect, useState } from "react";

import { buttonStyle, fieldStyle } from "../layout/Page.js";
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
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    if (transport === undefined) {
      return;
    }

    void transport.request("GET", "/passcode").then((response) => {
      const parsed = PasscodeStatusSchema.safeParse(response.body);

      if (parsed.success) {
        setStatus(parsed.data);
      }
    });
  }, [transport]);

  const act = useCallback(
    async (action: "setup" | "unlock" | "lock") => {
      if (transport === undefined) {
        return;
      }

      const response = await transport.request(
        "POST",
        `/passcode/${action}`,
        action === "lock" ? {} : { passcode },
      );
      const parsed = PasscodeStatusSchema.safeParse(response.body);

      if (response.status === 200 && parsed.success) {
        setStatus(parsed.data);
        setPasscode("");
        setMessage(undefined);
        onChange();
      } else {
        setMessage(passcodeRefusal(response.body));
      }
    },
    [transport, passcode, onChange],
  );

  if (status === undefined) {
    return null;
  }

  if (status.unlocked) {
    return (
      <div style={{ display: "flex", gap: spacing.sm, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ color: typography.color.muted }}>Sensitive notes are shown.</span>
        <button type="button" onClick={() => void act("lock")} style={buttonStyle}>
          Lock
        </button>
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
          aria-label={status.configured ? "Passcode" : "New passcode, 4 to 8 digits"}
          placeholder={status.configured ? "Passcode" : "New passcode, 4 to 8 digits"}
          onChange={(event) => {
            setPasscode(event.target.value.replace(/\D/g, ""));
          }}
          style={{ ...fieldStyle, flex: 1 }}
        />
        <button type="submit" style={buttonStyle}>
          {status.configured ? "Show sensitive" : "Set passcode"}
        </button>
      </div>
      <span style={{ color: message === undefined ? typography.color.muted : semantic.error }}>
        {message ??
          (status.configured
            ? "Notes marked sensitive are hidden."
            : "Set a passcode to see notes marked sensitive: true.")}
      </span>
    </form>
  );
}

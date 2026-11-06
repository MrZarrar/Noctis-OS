import { semantic, spacing, typography } from "@noctis/ui";
import { useEffect, useState } from "react";
import { z } from "zod";

import { ActionButton } from "../layout/ActionButton.js";
import { SectionHeading, buttonStyle, fieldStyle, glass } from "../layout/Page.js";
import type { CoreTransport } from "../transport/CoreTransport.js";

const StatusSchema = z.object({ configured: z.boolean() });

const muted = { margin: 0, color: typography.color.muted, fontSize: typography.scale.sm } as const;

export function DexcomSettings({
  transport,
}: {
  transport: CoreTransport | undefined;
}): JSX.Element {
  const [configured, setConfigured] = useState<boolean>();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (transport === undefined) return;
    let live = true;
    void transport
      .request("GET", "/integrations/dexcom")
      .then((response) => {
        const parsed = StatusSchema.safeParse(response.body);
        if (live && parsed.success) setConfigured(parsed.data.configured);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [transport]);

  async function connect(): Promise<void> {
    if (transport === undefined) return;
    setError(undefined);
    try {
      const response = await transport.request("POST", "/integrations/dexcom", {
        username,
        password,
      });
      if (response.status === 200) {
        setConfigured(true);
        setUsername("");
        setPassword("");
      } else {
        const body = response.body as { error?: { message?: string } } | undefined;
        setError(body?.error?.message ?? "Dexcom Share did not accept that login.");
      }
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : "The core could not reach Dexcom.");
    }
  }

  async function disconnect(): Promise<void> {
    if (transport === undefined) return;
    await transport.request("POST", "/integrations/dexcom/disconnect", {});
    setConfigured(false);
  }

  return (
    <section style={{ ...glass, padding: spacing.lg, display: "grid", gap: spacing.md }}>
      <SectionHeading>Dexcom</SectionHeading>
      <p style={{ ...muted, maxWidth: typography.measurePx }}>
        Your Dexcom Share login, the same one the Follow app uses. Read-only: Noctis polls your
        latest reading every 5 minutes and shows it on Health, Presence and in threads.
      </p>
      {configured === true ? (
        <div style={{ display: "flex", alignItems: "center", gap: spacing.md }}>
          <span>Connected.</span>
          <ActionButton onAction={disconnect} pendingLabel="Disconnecting...">
            Disconnect
          </ActionButton>
        </div>
      ) : configured === false ? (
        <div style={{ display: "grid", gap: spacing.sm, maxWidth: 360 }}>
          <input
            style={fieldStyle}
            placeholder="Dexcom Share username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
          />
          <input
            style={fieldStyle}
            type="password"
            placeholder="Password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
          <ActionButton
            style={buttonStyle}
            disabled={username.trim() === "" || password === ""}
            onAction={connect}
            pendingLabel="Connecting..."
          >
            Connect
          </ActionButton>
          {error !== undefined && <p style={{ margin: 0, color: semantic.error }}>{error}</p>}
        </div>
      ) : (
        <p style={muted}>Reading…</p>
      )}
    </section>
  );
}

import { RemoteDesktopTargetSchema } from "@noctis/contracts";
import { corner, material, spacing, typography } from "@noctis/ui";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import { mountRemoteDesktop } from "../remote/component.js";
import type { RemoteHandle, RemoteState, RemoteUserInteraction } from "../remote/session.js";
import { connectRemote, describeFailure } from "../remote/session.js";
import type { CoreTransport } from "../transport/CoreTransport.js";

import { buttonStyle } from "./ObjectiveList.js";

const HostsSchema = z.object({ hosts: z.array(RemoteDesktopTargetSchema) });

const fieldStyle = {
  background: material.fill,
  border: `1px solid ${material.border}`,
  borderRadius: corner.sm,
  color: "inherit",
  padding: spacing.sm,
  minHeight: 44,
  boxSizing: "border-box",
} as const;

function statusLine(state: RemoteState): string {
  switch (state.phase) {
    case "idle":
      return "Not connected.";
    case "requesting":
      return "Asking the core for a session…";
    case "connecting":
      return "Connecting through the Gateway…";
    case "connected":
      return `You have control of ${state.host} (${String(state.width)}×${String(state.height)}). Its own screen is locked while you are here, and agent GUI work on it is stopped.`;
    case "ended":
      return `Disconnected. ${state.reason}`;
    case "failed":
      return state.message;
  }
}

/**
 * The Nodes destination, which today is the embedded remote desktop (Task 3.9,
 * ADR-0035). The node list itself is a later task.
 *
 * The Windows password lives in this component's state only between typing it
 * and pressing Connect: it is handed to `connectRemote` and the field is
 * cleared in the same click. Nothing is saved, and there is no `<form>`, so
 * nothing is submitted for a browser to offer to remember.
 */
export function Nodes({ transport }: { transport: CoreTransport | undefined }): JSX.Element {
  const [hosts, setHosts] = useState<string[]>();
  const [hostsError, setHostsError] = useState<string>();
  const [host, setHost] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<RemoteState>({ phase: "idle" });
  const display = useRef<HTMLDivElement>(null);
  const session = useRef<{ handle: RemoteHandle; ui: RemoteUserInteraction }>();

  useEffect(() => {
    if (transport === undefined) {
      return;
    }

    let cancelled = false;

    void transport.request("GET", "/remote/hosts").then(
      (response) => {
        if (cancelled) {
          return;
        }

        const parsed = HostsSchema.safeParse(response.body);

        if (response.status !== 200 || !parsed.success) {
          setHostsError(
            `The core did not list its remote hosts (HTTP ${String(response.status)}).`,
          );
          return;
        }

        const names = parsed.data.hosts.map((target) => target.host);
        setHosts(names);
        setHost((current) => current || (names[0] ?? ""));
      },
      () => {
        if (!cancelled) {
          setHostsError("Noctis could not reach the core.");
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [transport]);

  // Leaving the page ends the session rather than orphaning it behind a
  // component that no longer exists.
  useEffect(
    () => () => {
      session.current?.handle.disconnect();
    },
    [],
  );

  const busy = state.phase === "requesting" || state.phase === "connecting";
  const connected = state.phase === "connected";

  const connect = async (): Promise<void> => {
    const container = display.current;

    if (transport === undefined || container === null) {
      return;
    }

    const typed = password;
    setPassword("");
    setState({ phase: "requesting" });

    try {
      const { ui, backend } = await mountRemoteDesktop(container);
      const handle = connectRemote({
        transport,
        ui,
        backend,
        host,
        username,
        password: typed,
        onState: setState,
      });
      session.current = { handle, ui };
      await handle.started;
    } catch (error) {
      // Only the component failing to load reaches here; connectRemote itself
      // never rejects.
      setState({ phase: "failed", message: describeFailure(error, "the Gateway") });
    }
  };

  return (
    <section
      aria-label="Nodes"
      style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: spacing.sm }}
    >
      <div style={{ padding: spacing.md, display: "grid", gap: spacing.sm }}>
        <h1 style={{ margin: 0, fontSize: typography.scale.lg }}>Remote desktop</h1>

        {hostsError !== undefined && <p role="alert">{hostsError}</p>}

        {hosts !== undefined && hosts.length === 0 && (
          <p>
            No remote desktop is set up on this core. AnyDesk is still the way in until it is
            (docs/operations/remote-access.md).
          </p>
        )}

        {hosts !== undefined && hosts.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: spacing.sm, alignItems: "end" }}>
            <label style={{ display: "grid", gap: spacing.xs }}>
              <span>Host</span>
              <select
                value={host}
                disabled={busy || connected}
                onChange={(event) => {
                  setHost(event.target.value);
                }}
                style={fieldStyle}
              >
                {hosts.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>

            {!connected && (
              <>
                <label style={{ display: "grid", gap: spacing.xs }}>
                  <span>Windows user</span>
                  <input
                    value={username}
                    autoComplete="username"
                    disabled={busy}
                    onChange={(event) => {
                      setUsername(event.target.value);
                    }}
                    style={fieldStyle}
                  />
                </label>
                <label style={{ display: "grid", gap: spacing.xs }}>
                  <span>Windows password (not saved)</span>
                  <input
                    type="password"
                    value={password}
                    autoComplete="off"
                    disabled={busy}
                    onChange={(event) => {
                      setPassword(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && username !== "" && password !== "") {
                        void connect();
                      }
                    }}
                    style={fieldStyle}
                  />
                </label>
                <button
                  type="button"
                  disabled={busy || host === "" || username === "" || password === ""}
                  onClick={() => {
                    void connect();
                  }}
                  style={{ ...buttonStyle, minHeight: 44 }}
                >
                  Connect
                </button>
              </>
            )}

            {connected && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    session.current?.ui.ctrlAltDel();
                  }}
                  style={{ ...buttonStyle, minHeight: 44 }}
                >
                  Ctrl+Alt+Del
                </button>
                <button
                  type="button"
                  onClick={() => {
                    session.current?.handle.disconnect();
                  }}
                  style={{ ...buttonStyle, minHeight: 44 }}
                >
                  Disconnect
                </button>
              </>
            )}
          </div>
        )}

        <p
          role={state.phase === "failed" ? "alert" : "status"}
          style={{ margin: 0, color: typography.color.muted }}
        >
          {statusLine(state)}
          {connected && " Keyboard input goes to the desktop while the pointer is over it."}
        </p>
      </div>

      {/* Always mounted, so the component has a box to fit into before it connects. */}
      <div
        ref={display}
        style={{
          flex: 1,
          minHeight: 0,
          background: state.phase === "idle" ? "transparent" : "#000",
        }}
      />
    </section>
  );
}

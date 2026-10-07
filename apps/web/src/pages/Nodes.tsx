import { NodeDescriptorSchema, RemoteDesktopTargetSchema } from "@noctis/contracts";
import { NavIcon, identityAccent, semantic, spacing, typography } from "@noctis/ui";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import { Page, SectionHeading, buttonStyle, fieldStyle, glass } from "../layout/Page.js";
import { useIsMobile } from "../layout/useIsMobile.js";
import { mountRemoteDesktop } from "../remote/component.js";
import type { RemoteHandle, RemoteState, RemoteUserInteraction } from "../remote/session.js";
import { connectRemote, describeFailure } from "../remote/session.js";
import type { CoreTransport } from "../transport/CoreTransport.js";

const HostsSchema = z.object({ hosts: z.array(RemoteDesktopTargetSchema) });
const NodesSchema = z.object({
  nodes: z.array(NodeDescriptorSchema.extend({ connected: z.boolean() })),
});

type NodeView = z.infer<typeof NodesSchema>["nodes"][number];

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
 * Nodes: the owner's PCs, which agents each one can run, and the embedded
 * remote desktop onto them (Task 3.9, ADR-0035).
 *
 * The Windows password lives in this component's state only between typing it
 * and pressing Connect: it is handed to `connectRemote` and the field is
 * cleared in the same click. Nothing is saved, and there is no `<form>`, so
 * nothing is submitted for a browser to offer to remember.
 */
export function Nodes({ transport }: { transport: CoreTransport | undefined }): JSX.Element {
  const isMobile = useIsMobile();
  const [nodes, setNodes] = useState<readonly NodeView[]>();
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

    void transport.request("GET", "/nodes").then(
      (response) => {
        const parsed = NodesSchema.safeParse(response.body);

        if (!cancelled && response.status === 200 && parsed.success) {
          setNodes(parsed.data.nodes.filter((node) => node.revokedAt === undefined));
        }
      },
      () => undefined,
    );

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

  const online = nodes?.filter((node) => node.connected).length ?? 0;

  return (
    <Page
      title="Nodes"
      subtitle={
        nodes === undefined
          ? "Your PCs"
          : `${String(nodes.length)} PC${nodes.length === 1 ? "" : "s"}, ${String(online)} online`
      }
    >
      <section aria-label="PCs" style={{ display: "grid", gap: spacing.md }}>
        <SectionHeading>PCs</SectionHeading>
        {nodes !== undefined && nodes.length === 0 && (
          <p style={{ margin: 0, color: typography.color.muted }}>
            No PC is paired with this core yet.
          </p>
        )}
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 260px), 1fr))",
            gap: spacing.md,
          }}
        >
          {(nodes ?? []).map((node) => (
            <NodeCard key={node.id} node={node} />
          ))}
        </ul>
      </section>

      <section aria-label="Remote desktop" style={{ display: "grid", gap: spacing.md }}>
        <SectionHeading>Remote desktop</SectionHeading>

        <div style={{ ...glass, padding: spacing.lg, display: "grid", gap: spacing.md }}>
          {hostsError !== undefined && (
            <p role="alert" style={{ margin: 0 }}>
              {hostsError}
            </p>
          )}

          {hosts !== undefined && hosts.length === 0 && (
            <p style={{ margin: 0 }}>
              No remote desktop is set up on this core. AnyDesk is still the way in until it is
              (docs/operations/remote-access.md).
            </p>
          )}

          {hosts !== undefined && hosts.length > 0 && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: isMobile
                  ? "minmax(0, 1fr)"
                  : "repeat(auto-fit, minmax(180px, 1fr))",
                gap: spacing.md,
                alignItems: "end",
              }}
            >
              <label style={labelStyle}>
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
                  <label style={labelStyle}>
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
                  <label style={labelStyle}>
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
                    style={primaryButton}
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
                    style={buttonStyle}
                  >
                    Ctrl+Alt+Del
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      session.current?.handle.disconnect();
                    }}
                    style={buttonStyle}
                  >
                    Disconnect
                  </button>
                </>
              )}
            </div>
          )}

          <p
            role={state.phase === "failed" ? "alert" : "status"}
            style={{ margin: 0, color: typography.color.muted, fontSize: typography.scale.sm }}
          >
            {statusLine(state)}
            {connected && " Keyboard input goes to the desktop while the pointer is over it."}
          </p>
        </div>

        {/* Always mounted, so the component has a box to fit into. Sized from
            the moment a connect starts, because the element scales to fit
            whatever box it finds when it mounts. */}
        <div
          ref={display}
          style={{
            height: state.phase === "idle" ? 0 : "min(70vh, 760px)",
            borderRadius: 12,
            overflow: "hidden",
            background: state.phase === "idle" ? "transparent" : "#000",
          }}
        />
      </section>
    </Page>
  );
}

function NodeCard({ node }: { node: NodeView }): JSX.Element {
  const agents = node.providers.filter((provider) => provider.available);

  return (
    <li
      data-node={node.hostId}
      style={{ ...glass, padding: spacing.lg, display: "grid", gap: spacing.sm }}
    >
      <p style={{ margin: 0, display: "flex", alignItems: "center", gap: spacing.sm }}>
        <span
          style={{
            color: node.connected ? identityAccent.vesper.primary : typography.color.muted,
          }}
        >
          <NavIcon item="Nodes" />
        </span>
        <strong style={{ fontWeight: 600, fontSize: typography.scale.md }}>{node.hostId}</strong>
        <span style={{ flex: 1 }} />
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: node.connected ? semantic.current : semantic.unavailable,
            boxShadow: node.connected ? `0 0 8px ${semantic.current}` : "none",
          }}
        />
        <span style={{ fontSize: typography.scale.sm }}>
          {node.connected ? "Online" : "Offline"}
        </span>
      </p>
      <p style={{ margin: 0, color: typography.color.muted, fontSize: typography.scale.sm }}>
        {node.connected
          ? "Connected now"
          : node.lastSeenAt === undefined
            ? "Never connected"
            : `Last seen ${new Date(node.lastSeenAt).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}`}
      </p>
      <p style={{ margin: 0, display: "flex", flexWrap: "wrap", gap: spacing.xs }}>
        {agents.length === 0 ? (
          <span style={{ color: typography.color.muted, fontSize: typography.scale.sm }}>
            No agent found on this PC
          </span>
        ) : (
          agents.map((agent) => (
            <span key={agent.providerId} style={chipStyle}>
              {AGENT_NAMES[agent.providerId] ?? agent.providerId}
            </span>
          ))
        )}
      </p>
    </li>
  );
}

const AGENT_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex",
  hermes: "Hermes",
  local: "Local model",
};

const labelStyle = {
  display: "grid",
  gap: spacing.xs,
  fontSize: typography.scale.sm,
  color: typography.color.muted,
} as const;

const primaryButton = {
  ...buttonStyle,
  background: identityAccent.vesper.secondary,
  borderColor: identityAccent.vesper.primary,
} as const;

const chipStyle = {
  fontSize: typography.scale.xs,
  letterSpacing: typography.tracking.wide,
  padding: `2px ${String(spacing.sm)}px`,
  borderRadius: 999,
  border: `1px solid ${identityAccent.vesper.secondary}`,
  color: typography.color.primary,
} as const;

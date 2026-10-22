import type { HealthStatus, RuntimeProviderId } from "@noctis/contracts";
import {
  HealthStatusSchema,
  NodeDescriptorSchema,
  RUNTIME_PROVIDERS,
  RemoteDesktopTargetSchema,
} from "@noctis/contracts";
import { NavIcon, identityAccent, semantic, spacing, typography } from "@noctis/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { nextKey } from "../idempotency.js";
import { Page, SectionHeading, buttonStyle, fieldStyle, glass } from "../layout/Page.js";
import { Picker } from "../layout/Picker.js";
import { useIsMobile } from "../layout/useIsMobile.js";
import { mountRemoteDesktop } from "../remote/component.js";
import type { RemoteHandle, RemoteState, RemoteUserInteraction } from "../remote/session.js";
import { connectRemote, describeFailure } from "../remote/session.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { parseCoreBody } from "../transport/CoreTransport.js";
import { agentName } from "./conversations-view.js";
import type { SharedFolder } from "./folders-view.js";
import { folderGrant, sharedFolders } from "./folders-view.js";
import type { MirrorFps, MirrorState, MirrorWidth } from "./mirror-view.js";
import { createMirrorDiagnostics, mirrorAllowed, mirrorPath } from "./mirror-view.js";

export const HostsSchema = z.object({ hosts: z.array(RemoteDesktopTargetSchema) });
export const NodesSchema = z.object({
  nodes: z.array(NodeDescriptorSchema.extend({ connected: z.boolean() })),
});
export const GrantsSchema = z.object({
  grants: z.array(
    z.object({
      capability: z.string(),
      constraints: z.unknown().optional(),
      revokedAt: z.string().optional(),
      expiresAt: z.string().optional(),
    }),
  ),
});

export const RootIdsSchema = z.object({ roots: z.array(z.object({ grantId: z.string() })) });

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
  const [mode, setMode] = useState<"mirror" | "remote">("mirror");
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
      // The remote screen mounts inside this page, so it is kept out of page effects.
      still
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

      <section aria-label="Folders" style={{ display: "grid", gap: spacing.md }}>
        <SectionHeading>Folders</SectionHeading>
        <Folders transport={transport} nodes={nodes} />
      </section>

      <section aria-label="Screen" style={{ display: "grid", gap: spacing.md }}>
        <SectionHeading>Screen</SectionHeading>

        <div role="group" aria-label="Screen mode" style={{ display: "flex", gap: spacing.sm }}>
          <button
            type="button"
            aria-pressed={mode === "mirror"}
            onClick={() => {
              setMode("mirror");
            }}
            style={mode === "mirror" ? primaryButton : buttonStyle}
          >
            Mirror
          </button>
          <button
            type="button"
            aria-pressed={mode === "remote"}
            onClick={() => {
              setMode("remote");
            }}
            style={mode === "remote" ? primaryButton : buttonStyle}
          >
            Remote desktop
          </button>
        </div>

        {mode === "mirror" && <Mirror transport={transport} nodes={nodes} />}
        <Health transport={transport} nodes={nodes} />
      </section>

      {/* Hidden rather than unmounted, so a session survives a look at the mirror. */}
      <section
        aria-label="Remote desktop"
        style={{ display: mode === "remote" ? "grid" : "none", gap: spacing.md }}
      >
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
              <div style={labelStyle}>
                <span aria-hidden="true">Host</span>
                <Picker
                  label="Host"
                  value={host}
                  disabled={busy || connected}
                  onChange={setHost}
                  options={hosts.map((name) => ({ value: name, label: name }))}
                />
              </div>

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

const FPS_OPTIONS = [
  { value: "15", label: "15 fps" },
  { value: "30", label: "30 fps" },
] as const;

const WIDTH_OPTIONS = [
  { value: "960", label: "960 wide" },
  { value: "1280", label: "1280 wide" },
  { value: "1920", label: "1920 wide" },
] as const;

const ACCESS_OPTIONS = [
  { value: "write", label: "Read and write" },
  { value: "read", label: "Read only" },
] as const;

/**
 * Folders: what each PC lets its agents work in. Sharing one adds a
 * `runtime.turn` grant for the agents that PC has, and the core sends it to
 * the PC at once. The path is not checked here, because only the PC can see
 * its disk: a turn started in a folder that is not there is refused, and no
 * other turn is.
 */
function Folders({
  transport,
  nodes,
}: {
  transport: CoreTransport | undefined;
  nodes: readonly NodeView[] | undefined;
}): JSX.Element {
  const isMobile = useIsMobile();
  const [chosen, setChosen] = useState("");
  const [folders, setFolders] = useState<{ nodeId: string; list: SharedFolder[] }>();
  const [path, setPath] = useState("");
  const [mode, setMode] = useState<"read" | "write">("write");
  const [sharing, setSharing] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [revision, setRevision] = useState(0);

  const node = nodes?.find((candidate) => candidate.id === chosen) ?? nodes?.[0];
  const nodeId = node?.id ?? "";

  useEffect(() => {
    if (transport === undefined || nodeId === "") {
      return;
    }

    let cancelled = false;

    void transport.request("GET", `/nodes/${nodeId}`).then(
      (response) => {
        const parsed = GrantsSchema.safeParse(response.body);

        if (!cancelled && response.status === 200 && parsed.success) {
          setFolders({ nodeId, list: sharedFolders(parsed.data.grants, Date.now()) });
        }
      },
      () => undefined,
    );

    return () => {
      cancelled = true;
    };
  }, [transport, nodeId, revision]);

  if (nodes !== undefined && node === undefined) {
    return (
      <div style={{ ...glass, padding: spacing.lg }}>
        <p style={{ margin: 0 }}>No PC is paired with this core yet.</p>
      </div>
    );
  }

  const list = folders?.nodeId === nodeId ? folders.list : undefined;

  const share = async (): Promise<void> => {
    if (transport === undefined || node === undefined) {
      return;
    }

    setProblem(undefined);
    setSharing(true);

    try {
      // The composer's picker lists every PC's folders by id, so every PC's ids count.
      const models = await transport.request("GET", "/models");
      const roots = RootIdsSchema.safeParse(models.body);
      const constraints = folderGrant({
        path,
        mode,
        providers: node.providers
          .filter((provider) => provider.available)
          .map((provider) => provider.providerId)
          .filter((id): id is RuntimeProviderId =>
            (RUNTIME_PROVIDERS as readonly string[]).includes(id),
          ),
        taken: [
          ...(list ?? []).map((folder) => folder.grantId),
          ...(roots.success ? roots.data.roots.map((root) => root.grantId) : []),
        ],
      });

      if (constraints === undefined) {
        setProblem("Give the folder's full path, such as C:\\Users\\you\\Documents\\project.");
        return;
      }

      const response = await transport.request("POST", "/commands/node.grant_capability", {
        idempotencyKey: nextKey("node.grant_capability"),
        nodeId: node.id,
        capability: "runtime.turn",
        constraints,
      });

      if (response.status === 200) {
        setPath("");
        setRevision((current) => current + 1);
      } else {
        setProblem(`The core refused (HTTP ${String(response.status)}).`);
      }
    } catch {
      setProblem("Noctis could not reach the core.");
    } finally {
      setSharing(false);
    }
  };

  const unshare = async (folder: SharedFolder): Promise<void> => {
    if (
      transport === undefined ||
      node === undefined ||
      !window.confirm(
        `Stop sharing ${folder.path}? Agents on ${node.hostId} lose access to it, and a conversation pinned to it can no longer run there.`,
      )
    ) {
      return;
    }

    setProblem(undefined);
    setSharing(true);

    try {
      const response = await transport.request("POST", "/commands/node.unshare_folder", {
        idempotencyKey: nextKey("node.unshare_folder"),
        nodeId: node.id,
        rootGrantId: folder.grantId,
      });

      if (response.status === 200) {
        setRevision((current) => current + 1);
      } else {
        setProblem(`The core refused (HTTP ${String(response.status)}).`);
      }
    } catch {
      setProblem("Noctis could not reach the core.");
    } finally {
      setSharing(false);
    }
  };

  return (
    <div style={{ ...glass, padding: spacing.lg, display: "grid", gap: spacing.md }}>
      <p style={{ margin: 0, color: typography.color.muted, fontSize: typography.scale.sm }}>
        Agents on a PC work only in the folders it shares. A session started in one opens there,
        with that folder&apos;s own CLAUDE.md and AGENTS.md.
      </p>
      <div style={labelStyle}>
        <span aria-hidden="true">PC</span>
        <Picker
          label="PC"
          value={nodeId}
          onChange={setChosen}
          options={(nodes ?? []).map((candidate) => ({
            value: candidate.id,
            label: candidate.hostId,
            ...(candidate.connected ? {} : { detail: "offline" }),
          }))}
        />
      </div>
      {list !== undefined && list.length === 0 && (
        <p style={{ margin: 0 }}>{node?.hostId ?? "This PC"} shares no folder yet.</p>
      )}
      {list !== undefined && list.length > 0 && (
        <ul
          aria-label="Shared folders"
          style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: spacing.xs }}
        >
          {list.map((folder) => (
            <li
              key={folder.grantId}
              style={{ display: "flex", flexWrap: "wrap", gap: spacing.sm, alignItems: "center" }}
            >
              <span style={{ fontFamily: typography.monoFamily, overflowWrap: "anywhere" }}>
                {folder.path}
              </span>
              <span style={chipStyle}>
                {folder.mode === "write" ? "read and write" : "read only"}
              </span>
              <button
                type="button"
                aria-label={`Stop sharing ${folder.path}`}
                disabled={sharing}
                onClick={() => {
                  void unshare(folder);
                }}
                style={{
                  marginLeft: "auto",
                  minHeight: 44,
                  background: "transparent",
                  border: "none",
                  color: typography.color.muted,
                  cursor: "pointer",
                  fontSize: typography.scale.sm,
                }}
              >
                Stop sharing
              </button>
            </li>
          ))}
        </ul>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile
            ? "minmax(0, 1fr)"
            : "minmax(0, 3fr) minmax(140px, 1fr) auto",
          gap: spacing.md,
          alignItems: "end",
        }}
      >
        <label style={labelStyle}>
          <span>Folder path</span>
          <input
            value={path}
            placeholder="C:\Users\you\Documents\project"
            spellCheck={false}
            disabled={sharing}
            onChange={(event) => {
              setPath(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && path.trim() !== "") {
                void share();
              }
            }}
            style={fieldStyle}
          />
        </label>
        <div style={labelStyle}>
          <span aria-hidden="true">Access</span>
          <Picker
            label="Access"
            value={mode}
            disabled={sharing}
            onChange={(value) => {
              setMode(value === "read" ? "read" : "write");
            }}
            options={ACCESS_OPTIONS}
          />
        </div>
        <button
          type="button"
          disabled={sharing || path.trim() === "" || node === undefined}
          onClick={() => {
            void share();
          }}
          style={primaryButton}
        >
          Share folder
        </button>
      </div>
      {problem !== undefined && (
        <p role="alert" style={{ margin: 0, color: semantic.error }}>
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * Mirror: a PC's desktop as it is, view only, in a plain `<img>` so an iPhone
 * plays it with no decoder and nobody is signed out of the PC. A PC streams
 * only once the owner allows it here, and nothing is captured while nobody
 * watches: stopping, leaving or switching away drops the image's request, and
 * that is what stops ffmpeg on the PC.
 */
function Mirror({
  transport,
  nodes,
}: {
  transport: CoreTransport | undefined;
  nodes: readonly NodeView[] | undefined;
}): JSX.Element {
  const isMobile = useIsMobile();
  const [chosen, setChosen] = useState("");
  const [allowed, setAllowed] = useState<{ nodeId: string; value: boolean }>();
  const [allowing, setAllowing] = useState(false);
  const [problem, setProblem] = useState<string>();
  // ponytail: 15 fps at 1280 wide is MJPEG at about 1-2 MB/s. H.264 over
  // Media Source Extensions is the upgrade if that hurts on mobile data.
  const [fps, setFps] = useState<MirrorFps>(15);
  const [width, setWidth] = useState<MirrorWidth>(1280);
  const [state, setState] = useState<MirrorState>({ phase: "idle" });
  const [diagnostics] = useState(createMirrorDiagnostics);
  const frame = useRef<HTMLDivElement>(null);

  const node =
    nodes?.find((candidate) => candidate.id === chosen) ??
    nodes?.find((candidate) => candidate.connected) ??
    nodes?.[0];
  const nodeId = node?.id ?? "";
  const watching = state.phase === "connecting" || state.phase === "live";
  const url = transport?.contentUrl?.(mirrorPath(nodeId, fps, width));
  const image = useRef<HTMLImageElement>(null);

  useEffect(() => diagnostics.cancel, [diagnostics, transport, nodeId, fps, width, watching]);

  // Chrome keeps a multipart image loading after its element is gone, and a
  // stream held open is a PC still capturing. Emptying the source ends it.
  useEffect(() => {
    const element = image.current;

    return () => {
      element?.setAttribute("src", "");
    };
  }, [url, watching]);

  useEffect(() => {
    if (transport === undefined || nodeId === "") {
      return;
    }

    let cancelled = false;

    void transport.request("GET", `/nodes/${nodeId}`).then(
      (response) => {
        const parsed = GrantsSchema.safeParse(response.body);

        if (!cancelled && response.status === 200 && parsed.success) {
          setAllowed({ nodeId, value: mirrorAllowed(parsed.data.grants, Date.now()) });
        }
      },
      () => undefined,
    );

    return () => {
      cancelled = true;
    };
  }, [transport, nodeId]);

  const allow = async (): Promise<void> => {
    if (transport === undefined) {
      return;
    }

    setAllowing(true);
    setProblem(undefined);

    try {
      const response = await transport.request("POST", "/commands/node.grant_capability", {
        idempotencyKey: nextKey("node.grant_capability"),
        nodeId,
        capability: "screen.view",
        constraints: {},
      });

      if (response.status === 200) {
        setAllowed({ nodeId, value: true });
        setState({ phase: "idle" });
      } else {
        setProblem(`The core refused (HTTP ${String(response.status)}).`);
      }
    } catch {
      setProblem("Noctis could not reach the core.");
    } finally {
      setAllowing(false);
    }
  };

  // An image's error carries no status, so the same question is asked again
  // as a probe, which hangs up as soon as frames would flow.
  const failed = useCallback(async (): Promise<void> => {
    const probeUrl = transport?.contentUrl?.(mirrorPath(nodeId, fps, width, true));

    if (!watching || probeUrl === undefined) {
      return;
    }

    const next = await diagnostics.check(async (signal) => {
      const response = await fetch(probeUrl, { credentials: "include", signal });

      return { status: response.status, body: parseCoreBody(await response.text()) };
    });

    if (next === undefined) return;

    if (next.phase === "not_granted") {
      setAllowed({ nodeId, value: false });
    }

    setState(next);
  }, [diagnostics, transport, nodeId, fps, width, watching]);

  const restart = (): void => {
    diagnostics.cancel();
    if (watching) {
      setState({ phase: "connecting" });
    }
  };

  if (nodes !== undefined && node === undefined) {
    return (
      <div data-region="mirror" style={{ ...glass, padding: spacing.lg }}>
        <p style={{ margin: 0 }}>No PC is paired with this core yet.</p>
      </div>
    );
  }

  const host = node?.hostId ?? "the PC";
  const granted = allowed?.nodeId === nodeId ? allowed.value : undefined;

  return (
    <div data-region="mirror" style={{ display: "grid", gap: spacing.md }}>
      <div style={{ ...glass, padding: spacing.lg, display: "grid", gap: spacing.md }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: isMobile
              ? "minmax(0, 1fr)"
              : "repeat(auto-fit, minmax(160px, 1fr))",
            gap: spacing.md,
            alignItems: "end",
          }}
        >
          <div style={labelStyle}>
            <span aria-hidden="true">PC</span>
            <Picker
              label="PC"
              value={nodeId}
              onChange={(value) => {
                diagnostics.cancel();
                setChosen(value);
                setState({ phase: "idle" });
              }}
              options={(nodes ?? []).map((candidate) => ({
                value: candidate.id,
                label: candidate.hostId,
                ...(candidate.connected ? {} : { detail: "offline" }),
              }))}
            />
          </div>

          {granted === true && (
            <>
              <div style={labelStyle}>
                <span aria-hidden="true">Rate</span>
                <Picker
                  label="Rate"
                  value={String(fps)}
                  onChange={(value) => {
                    setFps(value === "30" ? 30 : 15);
                    restart();
                  }}
                  options={FPS_OPTIONS}
                />
              </div>
              <div style={labelStyle}>
                <span aria-hidden="true">Size</span>
                <Picker
                  label="Size"
                  value={String(width)}
                  onChange={(value) => {
                    setWidth(value === "960" ? 960 : value === "1920" ? 1920 : 1280);
                    restart();
                  }}
                  options={WIDTH_OPTIONS}
                />
              </div>
            </>
          )}
        </div>

        {granted === false && (
          <>
            <p style={{ margin: 0 }}>
              {host} is not allowed to show its screen. Mirroring stays off until you allow it here:
              sharing folders with the agents does not include it.
            </p>
            <button
              type="button"
              disabled={allowing}
              onClick={() => {
                void allow();
              }}
              style={primaryButton}
            >
              Allow mirroring this PC
            </button>
          </>
        )}

        {granted === true && url === undefined && (
          <p style={{ margin: 0, color: typography.color.muted }}>
            This window cannot show a live screen. Open Noctis from your phone or browser to watch
            it.
          </p>
        )}

        {granted === true && url !== undefined && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: spacing.sm }}>
            {watching ? (
              <button
                type="button"
                onClick={() => {
                  diagnostics.cancel();
                  setState({ phase: "idle" });
                }}
                style={buttonStyle}
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                disabled={node?.connected !== true}
                onClick={() => {
                  setState({ phase: "connecting" });
                }}
                style={primaryButton}
              >
                Watch
              </button>
            )}
            {watching && document.fullscreenEnabled && (
              <button
                type="button"
                onClick={() => {
                  void frame.current?.requestFullscreen();
                }}
                style={buttonStyle}
              >
                Fullscreen
              </button>
            )}
          </div>
        )}

        {problem !== undefined && (
          <p role="alert" style={{ margin: 0 }}>
            {problem}
          </p>
        )}

        {granted === true && (
          <p
            role={state.phase === "unavailable" || state.phase === "locked" ? "alert" : "status"}
            style={{ margin: 0, color: typography.color.muted, fontSize: typography.scale.sm }}
          >
            {mirrorLine(state, host, node?.connected === true)}
          </p>
        )}
      </div>

      {watching && url !== undefined && (
        <div
          ref={frame}
          style={{
            aspectRatio: "16 / 9",
            borderRadius: 12,
            overflow: "hidden",
            background: "#000",
            display: "grid",
            placeItems: "center",
          }}
        >
          <img
            key={url}
            ref={image}
            src={url}
            alt={`The screen of ${host}`}
            // Chrome fires `load` once for a multipart image, not per frame,
            // so it marks the first frame and nothing more.
            onLoad={() => {
              setState({ phase: "live" });
            }}
            onError={() => {
              void failed();
            }}
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        </div>
      )}
    </div>
  );
}

function mirrorLine(state: MirrorState, host: string, online: boolean): string {
  switch (state.phase) {
    case "idle":
      return online
        ? "Not watching. View only: nothing you do here reaches the PC."
        : `${host} is offline.`;
    case "connecting":
      return `Asking ${host} for its screen…`;
    case "live":
      return `Live from ${host}. View only.`;
    case "locked":
      return "The PC is locked. Sign in at the PC, or use Remote desktop.";
    case "not_granted":
      return `${host} is not allowed to show its screen.`;
    case "unavailable":
      return state.message;
  }
}

function Health({
  transport,
  nodes,
}: {
  transport: CoreTransport | undefined;
  nodes: readonly NodeView[] | undefined;
}): JSX.Element {
  const [status, setStatus] = useState<HealthStatus>();
  const [repos, setRepos] = useState<Record<string, string>>({});
  const [allowing, setAllowing] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    setStatus(undefined);
    if (transport === undefined) return;

    let cancelled = false;
    void transport.request("GET", "/glucose").then(
      (response) => {
        if (cancelled) return;
        const parsed = HealthStatusSchema.safeParse(response.body);
        if (response.status === 200 && parsed.success) {
          setStatus(parsed.data);
        } else {
          setProblem(`The core could not read health status (HTTP ${String(response.status)}).`);
        }
      },
      () => {
        if (!cancelled) setProblem("Noctis could not reach the core.");
      },
    );

    return () => {
      cancelled = true;
    };
  }, [transport, revision]);

  const change = async (nodeId: string, granted: boolean): Promise<void> => {
    const repo = repos[nodeId]?.trim() ?? "";
    if (transport === undefined || status === undefined || allowing || (!granted && repo === "")) {
      return;
    }

    setAllowing(true);
    setProblem(undefined);
    const command = granted ? "health.disallow" : "health.allow";

    try {
      const response = await transport.request("POST", `/commands/${command}`, {
        idempotencyKey: nextKey(command),
        nodeId,
        ...(granted ? {} : { repo }),
      });
      if (response.status !== 200) {
        setProblem(`The core refused (HTTP ${String(response.status)}).`);
      }
    } catch {
      setProblem("Noctis could not reach the core.");
    } finally {
      setRevision((current) => current + 1);
      setAllowing(false);
    }
  };

  return (
    <div style={{ display: "grid", gap: spacing.md }}>
      {(nodes ?? [])
        .filter((node) => node.connected)
        .map((node) => {
          const granted = status?.granted === true && status.nodeId === node.id;
          const repo = repos[node.id] ?? "";

          return (
            <form
              key={node.id}
              aria-label={`Health on ${node.hostId}`}
              onSubmit={(event) => {
                event.preventDefault();
                void change(node.id, granted);
              }}
              style={{ ...glass, padding: spacing.lg, display: "grid", gap: spacing.md }}
            >
              <p style={{ margin: 0 }}>
                <strong>Health (glycolens)</strong> · {node.hostId}
              </p>
              {granted ? (
                <>
                  <span style={chipStyle}>Allowed</span>
                  <button type="submit" disabled={allowing} style={buttonStyle}>
                    Stop
                  </button>
                </>
              ) : (
                <>
                  <label style={labelStyle}>
                    <span>glycolens folder</span>
                    <input
                      value={repo}
                      placeholder="C:\Users\you\Documents\glycolens"
                      required
                      spellCheck={false}
                      disabled={allowing}
                      onChange={(event) => {
                        setRepos((current) => ({ ...current, [node.id]: event.target.value }));
                      }}
                      style={fieldStyle}
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={allowing || status === undefined || repo.trim() === ""}
                    style={primaryButton}
                  >
                    Allow health on this PC
                  </button>
                </>
              )}
              <p
                style={{ margin: 0, color: typography.color.muted, fontSize: typography.scale.sm }}
              >
                Runs glycolens on this PC weekly and when you press Run now. The report stays on
                your machines.
              </p>
            </form>
          );
        })}
      {problem !== undefined && (
        <p role="alert" style={{ margin: 0 }}>
          {problem}
        </p>
      )}
    </div>
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
              {agentName(agent.providerId)}
            </span>
          ))
        )}
      </p>
    </li>
  );
}

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

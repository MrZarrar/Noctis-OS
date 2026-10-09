import { useEffect, useState } from "react";

import { NavIcon, elevation, identityAccent, semantic, spacing, typography } from "@noctis/ui";

import { folderName } from "../conversation/PromptForm.js";
import type { RuntimeRootOption } from "../conversation/useConversation.js";
import { useIsMobile } from "../layout/useIsMobile.js";
import { Page, SectionHeading, buttonStyle, glass } from "../layout/Page.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import type { FileTarget } from "./files-view.js";
import { childPath, filesQuery, parentPath, viewerKind } from "./files-view.js";

/**
 * Files: what the agents made, on whichever PC made it (v1 S4).
 *
 * Places are the folders each PC shares with its agents. Opening one lists it
 * through that PC's node; opening a file shows it in the viewer — beside the
 * list on a desktop, over everything on a phone — streamed from the PC rather
 * than copied anywhere first.
 */

interface Entry {
  name: string;
  kind: "file" | "directory";
  sizeBytes: number;
  modifiedAt: string;
}

type Listing =
  | { state: "loading" }
  | { state: "ready"; entries: Entry[]; truncated: boolean }
  | { state: "failed"; reason: string };

/** The core's refusal in its own words, or the status when it gave none. */
function reasonOf(response: { status: number; body: unknown }): string {
  const message = (response.body as { error?: { message?: unknown } } | null)?.error?.message;

  return typeof message === "string" ? message : `the core answered ${String(response.status)}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] ?? "GB"}`;
}

const rowStyle = {
  ...glass,
  borderRadius: 12,
  display: "flex",
  alignItems: "center",
  gap: spacing.md,
  width: "100%",
  minHeight: 52,
  padding: `0 ${String(spacing.md)}px`,
  font: `${String(typography.scale.base)}px ${typography.family}`,
  color: typography.color.primary,
  textAlign: "left",
  cursor: "pointer",
} as const;

const ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;

export function Files({
  roots,
  transport,
  target,
  onTargetOpened,
}: {
  roots: readonly RuntimeRootOption[];
  /** Absent until the page has a session; nothing opens without one. */
  transport: CoreTransport | undefined;
  /** A file to open on arrival, offered by a thread that wrote it. */
  target?: FileTarget<RuntimeRootOption> | undefined;
  /** Called once the target is taken, so coming back to Files later starts fresh. */
  onTargetOpened?: () => void;
}): JSX.Element {
  const isMobile = useIsMobile();
  // The page mounts each time it is opened, so a target is simply where it starts.
  const [place, setPlace] = useState<RuntimeRootOption | undefined>(target?.root);
  const [folder, setFolder] = useState(target === undefined ? "" : parentPath(target.relativePath));
  const [pending, setPending] = useState(target?.relativePath.split("/").at(-1));
  const [listing, setListing] = useState<Listing>({ state: "loading" });
  const [opened, setOpened] = useState<Entry & { path: string }>();

  useEffect(() => {
    if (target !== undefined) {
      onTargetOpened?.();
    }
    // Once, on arrival: the target is the starting state above.
  }, []);

  // The file a thread asked for, once its folder has been listed.
  useEffect(() => {
    if (pending === undefined || listing.state !== "ready") {
      return;
    }

    const entry = listing.entries.find((item) => item.kind === "file" && item.name === pending);

    if (entry !== undefined) {
      setOpened({ ...entry, path: childPath(folder, entry.name) });
    }

    setPending(undefined);
  }, [pending, listing, folder]);

  useEffect(() => {
    if (place === undefined || transport === undefined) {
      return;
    }

    let live = true;

    setListing({ state: "loading" });
    void transport
      .request("GET", `/files/list?${filesQuery(place, folder)}`)
      .then((response) => {
        if (!live) {
          return;
        }

        setListing(
          response.status === 200
            ? { state: "ready", ...(response.body as { entries: Entry[]; truncated: boolean }) }
            : { state: "failed", reason: reasonOf(response) },
        );
      })
      .catch((error: unknown) => {
        if (live) {
          setListing({
            state: "failed",
            reason: error instanceof Error ? error.message : "the core did not answer",
          });
        }
      });

    return () => {
      live = false;
    };
  }, [transport, place, folder]);

  const hosts = [...new Set(roots.map((root) => root.hostId))];

  function back(): void {
    setOpened(undefined);

    if (folder === "") {
      setPlace(undefined);
    } else {
      setFolder(parentPath(folder));
    }
  }

  const browser =
    place === undefined ? (
      <section aria-label="Places" style={{ display: "grid", gap: spacing.md }}>
        <SectionHeading>Places</SectionHeading>

        {roots.length === 0 ? (
          <p style={{ margin: 0, color: typography.color.muted }}>
            No PC has shared a folder with Noctis yet.
          </p>
        ) : (
          hosts.map((host) => {
            const own = roots.filter((root) => root.hostId === host);
            const online = own.some((root) => root.connected);

            return (
              <div key={host} style={{ display: "grid", gap: spacing.xs }}>
                <p
                  style={{
                    margin: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: spacing.sm,
                    fontSize: typography.scale.sm,
                  }}
                >
                  <NavIcon item="Nodes" size={16} />
                  <span>{host}</span>
                  <span
                    aria-hidden="true"
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: online ? semantic.current : semantic.unavailable,
                    }}
                  />
                  <span style={{ color: typography.color.muted }}>
                    {online ? "online" : "offline"}
                  </span>
                </p>
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
                  {own.map((root) => (
                    <li key={`${root.nodeId}:${root.grantId}`}>
                      <button
                        type="button"
                        title={root.path}
                        disabled={!root.connected || transport === undefined}
                        onClick={() => {
                          setPlace(root);
                          setFolder("");
                          setOpened(undefined);
                        }}
                        style={{
                          ...rowStyle,
                          opacity: root.connected ? 1 : 0.6,
                          cursor: root.connected ? "pointer" : "default",
                        }}
                      >
                        <span style={{ color: identityAccent.vesper.primary }}>
                          <NavIcon item="Files" size={20} />
                        </span>
                        <span style={{ display: "grid", minWidth: 0 }}>
                          <span style={ellipsis}>{folderName(root.path)}</span>
                          <span
                            style={{ color: typography.color.muted, fontSize: typography.scale.xs }}
                          >
                            on {root.hostId}
                            {root.mode === "read" ? " · read only" : ""}
                            {root.connected ? "" : " · offline"}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </section>
    ) : (
      <section aria-label="Folder" style={{ display: "grid", gap: spacing.md, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: spacing.sm, minWidth: 0 }}>
          <button type="button" onClick={back} style={buttonStyle}>
            {folder === "" ? "Places" : "Up"}
          </button>
          <span style={{ display: "grid", minWidth: 0 }}>
            <span style={ellipsis}>
              {folder === "" ? folderName(place.path) : (folder.split("/").at(-1) ?? folder)}
            </span>
            <span
              style={{ ...ellipsis, color: typography.color.muted, fontSize: typography.scale.xs }}
            >
              {place.hostId} · {folderName(place.path)}
              {folder === "" ? "" : `/${folder}`}
            </span>
          </span>
        </div>

        {listing.state === "loading" && (
          <p style={{ margin: 0, color: typography.color.muted }}>Asking {place.hostId}…</p>
        )}
        {listing.state === "failed" && (
          <p role="alert" style={{ margin: 0, color: semantic.error }}>
            {listing.reason}
          </p>
        )}
        {listing.state === "ready" && (
          <ul
            aria-label="Folder contents"
            style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}
          >
            {listing.entries.length === 0 && (
              <li style={{ color: typography.color.muted }}>This folder is empty.</li>
            )}
            {listing.entries.map((entry) => {
              const path = childPath(folder, entry.name);
              const selected = opened?.path === path;

              return (
                <li key={entry.name}>
                  <button
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    onClick={() => {
                      if (entry.kind === "directory") {
                        setOpened(undefined);
                        setFolder(path);
                      } else {
                        setOpened({ ...entry, path });
                      }
                    }}
                    style={{
                      ...rowStyle,
                      outline: selected ? `2px solid ${identityAccent.vesper.primary}` : "none",
                    }}
                  >
                    <span
                      style={{
                        color:
                          entry.kind === "directory"
                            ? identityAccent.vesper.primary
                            : typography.color.muted,
                      }}
                    >
                      <NavIcon item="Files" size={18} />
                    </span>
                    <span style={{ ...ellipsis, flex: 1, minWidth: 0 }}>{entry.name}</span>
                    <span
                      style={{
                        color: typography.color.muted,
                        fontSize: typography.scale.xs,
                        flexShrink: 0,
                      }}
                    >
                      {entry.kind === "directory" ? "folder" : formatSize(entry.sizeBytes)}
                    </span>
                  </button>
                </li>
              );
            })}
            {listing.truncated && (
              <li style={{ color: typography.color.muted, fontSize: typography.scale.sm }}>
                Only the first {String(listing.entries.length)} entries are shown.
              </li>
            )}
          </ul>
        )}
      </section>
    );

  // On a phone the viewer is its own screen, over the tab bar; with nothing
  // open there is nothing to cover the list with.
  if (isMobile && opened !== undefined && place !== undefined && transport !== undefined) {
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: elevation.modal,
          background: "#050409",
          display: "flex",
          flexDirection: "column",
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
        }}
      >
        <Viewer
          place={place}
          file={opened}
          transport={transport}
          onClose={() => setOpened(undefined)}
          fullScreen
        />
      </div>
    );
  }

  return (
    <Page title="Files" subtitle="What your agents made, on any of your PCs">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "minmax(0, 1fr)" : "minmax(260px, 340px) minmax(0, 1fr)",
          gap: spacing.lg,
          alignItems: "start",
          flex: 1,
        }}
      >
        {browser}

        {!isMobile && (
          <section
            aria-label="Viewer"
            data-region="viewer"
            style={{
              ...glass,
              display: "flex",
              flexDirection: "column",
              minHeight: 420,
              overflow: "hidden",
            }}
          >
            {opened !== undefined && place !== undefined && transport !== undefined ? (
              <Viewer
                place={place}
                file={opened}
                transport={transport}
                onClose={() => setOpened(undefined)}
              />
            ) : (
              <EmptyViewer />
            )}
          </section>
        )}
      </div>
    </Page>
  );
}

function EmptyViewer(): JSX.Element {
  return (
    <div
      style={{
        flex: 1,
        display: "grid",
        justifyItems: "center",
        alignContent: "center",
        gap: spacing.md,
        textAlign: "center",
        padding: `${String(spacing.xl)}px ${String(spacing.lg)}px`,
      }}
    >
      <img
        src="/assets/generated/files-empty.webp"
        alt=""
        width={240}
        height={240}
        style={{
          width: "min(240px, 60vw)",
          height: "auto",
          maxWidth: "100%",
          // Its ground is the floor colour; screen drops it out so the
          // sheets float on the glass instead of sitting in a black square.
          mixBlendMode: "screen",
          maskImage: "radial-gradient(ellipse at center, #000 55%, transparent 72%)",
          WebkitMaskImage: "radial-gradient(ellipse at center, #000 55%, transparent 72%)",
        }}
      />
      <p style={{ margin: 0, fontSize: typography.scale.md }}>Open a place, then a file.</p>
      <p style={{ margin: 0, color: typography.color.muted, maxWidth: 380 }}>
        Scripts, storyboard frames and videos open here, straight from the PC that holds them.
      </p>
    </div>
  );
}

/**
 * One file. Text is fetched through the transport, so it works on every one;
 * images, video and the download need a URL the browser can fetch by itself,
 * which only the cookie session — the phone's — can give.
 */
function Viewer({
  place,
  file,
  transport,
  onClose,
  fullScreen = false,
}: {
  place: RuntimeRootOption;
  file: Entry & { path: string };
  transport: CoreTransport;
  onClose: () => void;
  fullScreen?: boolean;
}): JSX.Element {
  const kind = viewerKind(file.name, file.sizeBytes);
  const contentPath = `/files/content?${filesQuery(place, file.path)}`;
  const url = transport.contentUrl?.(contentPath);
  const [text, setText] = useState<{ path: string; value: string }>();

  useEffect(() => {
    if (kind !== "text") {
      return;
    }

    let live = true;

    void transport
      .request("GET", contentPath)
      .then((response) => {
        if (live) {
          setText({
            path: contentPath,
            value:
              response.status !== 200
                ? reasonOf(response)
                : typeof response.body === "string"
                  ? response.body
                  : // A JSON file comes back parsed; show it as the text it was.
                    JSON.stringify(response.body, null, 2),
          });
        }
      })
      .catch((error: unknown) => {
        if (live) {
          setText({
            path: contentPath,
            value: error instanceof Error ? error.message : "the core did not answer",
          });
        }
      });

    return () => {
      live = false;
    };
  }, [transport, kind, contentPath]);

  const unreachable = (
    <p style={{ margin: 0, color: typography.color.muted, maxWidth: 380, textAlign: "center" }}>
      This window cannot load files by link. Open Noctis from your phone or browser to see it.
    </p>
  );

  return (
    <div
      data-region={fullScreen ? "viewer" : undefined}
      aria-label={fullScreen ? "Viewer" : undefined}
      role={fullScreen ? "dialog" : undefined}
      style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: spacing.sm,
          padding: spacing.md,
          borderBottom: `1px solid rgba(255, 255, 255, 0.08)`,
        }}
      >
        <span style={{ ...ellipsis, flex: 1, minWidth: 0 }}>{file.name}</span>
        {url !== undefined && (
          <a
            href={`${url}&download=1`}
            download={file.name}
            target="_blank"
            rel="noopener"
            style={{
              ...buttonStyle,
              display: "inline-flex",
              alignItems: "center",
              textDecoration: "none",
            }}
          >
            Download
          </a>
        )}
        <button type="button" onClick={onClose} style={buttonStyle}>
          Close
        </button>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          display: "grid",
          placeItems: kind === "text" ? "start stretch" : "center",
          padding: spacing.md,
        }}
      >
        {kind === "text" &&
          (text?.path === contentPath ? (
            <pre
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                font: `${String(typography.scale.sm)}px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
              }}
            >
              {text.value}
            </pre>
          ) : (
            <p style={{ margin: 0, color: typography.color.muted }}>Opening…</p>
          ))}
        {kind === "image" &&
          (url === undefined ? (
            unreachable
          ) : (
            <img
              src={url}
              alt={file.name}
              style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
            />
          ))}
        {kind === "video" &&
          (url === undefined ? (
            unreachable
          ) : (
            <video
              src={url}
              controls
              playsInline
              preload="metadata"
              style={{ width: "100%", maxHeight: "100%", background: "#000" }}
            />
          ))}
        {kind === "audio" && (url === undefined ? unreachable : <audio src={url} controls />)}
        {kind === "download" && (
          <p style={{ margin: 0, color: typography.color.muted, textAlign: "center" }}>
            No preview for this kind of file ({formatSize(file.sizeBytes)}).
            {url === undefined ? "" : " Download it to open it on this device."}
          </p>
        )}
      </div>
    </div>
  );
}

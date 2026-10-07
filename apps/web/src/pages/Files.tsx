import { NavIcon, identityAccent, semantic, spacing, typography } from "@noctis/ui";

import { folderName } from "../conversation/PromptForm.js";
import type { RuntimeRootOption } from "../conversation/useConversation.js";
import { useIsMobile } from "../layout/useIsMobile.js";
import { Page, SectionHeading, glass } from "../layout/Page.js";

/**
 * Files: what the agents made, on whichever PC made it.
 *
 * The layout S4 fills in. Places are the folders each PC has granted, the same
 * ones a thread can be pinned to; the viewer is where a script, a frame or a
 * video opens. Nothing here browses yet, and the page says so rather than
 * drawing controls that do nothing.
 */
export function Files({ roots }: { roots: readonly RuntimeRootOption[] }): JSX.Element {
  const isMobile = useIsMobile();
  const hosts = [...new Set(roots.map((root) => root.hostId))];

  return (
    <Page title="Files" subtitle="What your agents made, on any of your PCs">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "minmax(0, 1fr)" : "minmax(240px, 300px) minmax(0, 1fr)",
          gap: spacing.lg,
          alignItems: "start",
          flex: 1,
        }}
      >
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
                      <li
                        key={root.grantId}
                        title={root.path}
                        style={{
                          ...glass,
                          borderRadius: 12,
                          display: "flex",
                          alignItems: "center",
                          gap: spacing.md,
                          minHeight: 52,
                          padding: `0 ${String(spacing.md)}px`,
                          // Not a control until S4 makes it one.
                          opacity: root.connected ? 1 : 0.6,
                        }}
                      >
                        <span style={{ color: identityAccent.vesper.primary }}>
                          <NavIcon item="Files" size={20} />
                        </span>
                        <span style={{ display: "grid", minWidth: 0 }}>
                          <span
                            style={{
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {folderName(root.path)}
                          </span>
                          <span
                            style={{ color: typography.color.muted, fontSize: typography.scale.xs }}
                          >
                            on {root.hostId}
                            {root.mode === "read" ? " · read only" : ""}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })
          )}
        </section>

        <section
          aria-label="Viewer"
          data-region="viewer"
          style={{
            ...glass,
            display: "grid",
            justifyItems: "center",
            alignContent: "center",
            gap: spacing.md,
            textAlign: "center",
            minHeight: isMobile ? 0 : 420,
            padding: `${String(spacing.xl)}px ${String(spacing.lg)}px`,
            overflow: "hidden",
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
          <p style={{ margin: 0, fontSize: typography.scale.md }}>
            File browsing is not switched on yet.
          </p>
          <p style={{ margin: 0, color: typography.color.muted, maxWidth: 380 }}>
            Once it is, open scripts, storyboard frames and videos from any of these places here,
            and download them to this device.
          </p>
        </section>
      </div>
    </Page>
  );
}

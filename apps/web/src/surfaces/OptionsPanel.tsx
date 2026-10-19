import { useEffect, useState } from "react";
import type { z } from "zod";
import type { OptionsPayloadSchema } from "@noctis/contracts";
import { corner, depth, glass, PanelActions, spacing, typography } from "@noctis/ui";

import type { SurfaceContext } from "./renderers.js";
import { FileMedia, releaseFileImage } from "./FileMedia.js";
import "./options.css";

function Screenshot({ url, title }: { url: string | undefined; title: string }): JSX.Element {
  const [failed, setFailed] = useState(false);
  return (
    <div
      style={{
        display: "grid",
        placeItems: "center",
        aspectRatio: "16 / 10",
        background: depth.layers[0],
        overflow: "hidden",
        borderRadius: `${corner.sm}px ${corner.sm}px 0 0`,
      }}
    >
      {url === undefined || failed ? (
        <span style={{ color: typography.color.muted, fontSize: typography.scale.sm }}>
          Screenshot unavailable
        </span>
      ) : (
        <img
          src={url}
          alt={title}
          loading="lazy"
          onError={() => setFailed(true)}
          style={{ width: "100%", height: "100%", minHeight: 0, objectFit: "contain" }}
        />
      )}
    </div>
  );
}

export function OptionsPanel({
  payload,
  context,
}: {
  payload: z.infer<typeof OptionsPayloadSchema>;
  context: SurfaceContext;
}): JSX.Element {
  const owner = context.panelOwner;
  const onAction = context.onPanelAction;
  const retained = context.fileMedia;
  useEffect(() => {
    if (retained === undefined) return;
    const live = new Set(
      payload.options.flatMap((option, index) =>
        option.image === undefined ? [] : [JSON.stringify([retained.surfaceId, option.id, index])],
      ),
    );
    for (const [id, entry] of retained.cache)
      if (entry.ownerId === retained.surfaceId && !live.has(id))
        releaseFileImage(retained.cache, id);
  }, [retained, payload.options]);
  return (
    <div className="options-panel">
      {payload.options.map((option, index) => {
        const imageUrl =
          option.image === undefined
            ? undefined
            : context.mediaUrl?.(option.image, context.contentRevision);
        let link: URL | undefined;
        try {
          const parsed = new URL(option.url ?? "");
          if (parsed.protocol === "http:" || parsed.protocol === "https:") link = parsed;
        } catch {
          // A stale payload must not turn a card into an unsafe link.
        }
        return (
          <article
            key={JSON.stringify([option.id, index])}
            style={{
              ...glass,
              borderRadius: corner.sm,
              minWidth: 0,
              overflowWrap: "anywhere",
              display: "flex",
              flexDirection: "column",
            }}
          >
            {option.image !== undefined && retained !== undefined ? (
              <FileMedia
                payload={{ title: option.title, source: option.image, mediaType: "image/*" }}
                url={imageUrl}
                size="standard"
                retained={{
                  cache: retained.cache,
                  surfaceId: JSON.stringify([retained.surfaceId, option.id, index]),
                  ownerId: retained.surfaceId,
                }}
                renderImage={(url) => (
                  <Screenshot key={url ?? "missing"} url={url} title={option.title} />
                )}
              />
            ) : (
              <Screenshot key={imageUrl ?? "missing"} url={imageUrl} title={option.title} />
            )}
            <div
              style={{
                padding: spacing.md,
                display: "flex",
                flexDirection: "column",
                flex: 1,
                gap: spacing.sm,
              }}
            >
              <h3
                style={{
                  margin: 0,
                  fontSize: typography.scale.base,
                  fontWeight: 600,
                  lineHeight: 1.4,
                }}
              >
                {option.title}
              </h3>
              {option.price !== undefined && (
                <p
                  style={{
                    margin: 0,
                    fontSize: typography.scale.lg,
                    fontWeight: 600,
                    letterSpacing: typography.tracking.tight,
                  }}
                >
                  {option.price}
                </p>
              )}
              {option.detail !== undefined && (
                <p
                  style={{
                    margin: 0,
                    color: typography.color.muted,
                    fontSize: typography.scale.sm,
                    lineHeight: 1.6,
                  }}
                >
                  {option.detail}
                </p>
              )}
              {link !== undefined && (
                <div style={{ fontSize: typography.scale.sm, lineHeight: 1.6 }}>
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={option.url}
                    aria-label={`Open listing: ${option.url}`}
                    style={{
                      color: typography.color.primary,
                      display: "inline-flex",
                      alignItems: "center",
                      minHeight: 44,
                    }}
                  >
                    {link.host}
                  </a>
                  <details>
                    <summary
                      style={{
                        cursor: "pointer",
                        color: typography.color.muted,
                        minHeight: 44,
                        alignContent: "center",
                      }}
                    >
                      View address
                    </summary>
                    <p style={{ margin: 0 }}>{option.url}</p>
                  </details>
                </div>
              )}
              {option.action !== undefined && (
                <div style={{ marginTop: "auto" }}>
                  <PanelActions
                    actions={[option.action]}
                    {...(onAction === undefined || owner === undefined
                      ? {}
                      : { onAction: (message: string) => onAction(message, owner) })}
                    {...(context.panelActionsDisabled === undefined
                      ? {}
                      : { disabled: context.panelActionsDisabled })}
                    {...(context.panelActionsError === undefined
                      ? {}
                      : { error: context.panelActionsError })}
                  />
                </div>
              )}
            </div>
          </article>
        );
      })}
    </div>
  );
}

import type { SurfaceSize } from "@noctis/contracts";

import { corner, material, spacing, typography } from "../tokens/index.js";

export function mediaElement(mediaType: string): "image" | "video" | "audio" | "link" {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  return "link";
}

export interface MediaSurfaceProps {
  title: string;
  mediaType: string;
  url?: string | undefined;
  size?: SurfaceSize;
}

export function MediaSurface({ title, mediaType, url, size }: MediaSurfaceProps): JSX.Element {
  if (url === undefined || url.trim().length === 0) {
    return <p style={{ margin: 0, color: typography.color.muted }}>This file opens from Threads</p>;
  }

  const style = {
    width: "100%",
    maxHeight: size === "compact" ? 96 : "100%",
    objectFit: "contain",
  } as const;
  switch (mediaElement(mediaType)) {
    case "image":
      return (
        <img
          src={url}
          alt={title}
          style={{ ...style, height: size === "compact" ? "auto" : "100%" }}
        />
      );
    case "video":
      return (
        <video src={url} controls playsInline preload="metadata" aria-label={title} style={style} />
      );
    case "audio":
      return <audio src={url} controls aria-label={title} style={style} />;
    case "link":
      return (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            minHeight: 44,
            boxSizing: "border-box",
            display: "inline-flex",
            alignItems: "center",
            font: `500 ${String(typography.scale.sm)}px ${typography.family}`,
            color: typography.color.primary,
            background: material.fillElevated,
            border: `1px solid ${material.border}`,
            borderRadius: corner.md,
            padding: `0 ${String(spacing.lg)}px`,
            cursor: "pointer",
          }}
        >
          {mediaType === "application/pdf" ? "Open PDF" : "Open file"}
        </a>
      );
  }
}

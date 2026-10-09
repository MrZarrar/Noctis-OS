import { corner, depth, spacing, typography } from "@noctis/ui";
import { useEffect, useRef, useState } from "react";

import { buttonStyle, glass } from "../layout/Page.js";
import { useIsMobile } from "../layout/useIsMobile.js";

const TEXT_LIMIT = 200 * 1024;

export function previewKind(file: {
  name: string;
  type: string;
}): "image" | "video" | "text" | "other" {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (
    file.type.startsWith("text/") ||
    /^(application\/(json|xml|javascript)|application\/[^;]+\+json)(;|$)/.test(file.type) ||
    /\.(txt|md|markdown|json|csv|ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|c|h|cpp|cs|css|html|xml|ya?ml|toml|sh|ps1|sql|log)$/i.test(
      file.name,
    )
  )
    return "text";
  return "other";
}

export function AttachmentPreview({
  file,
  onDismiss,
  onRemove,
}: {
  file: File;
  onDismiss: () => void;
  onRemove: () => void;
}): JSX.Element {
  const dialog = useRef<HTMLDialogElement>(null);
  const mobile = useIsMobile();
  const kind = previewKind(file);
  const [url, setUrl] = useState<string>();
  const [text, setText] = useState("Loading…");

  useEffect(() => {
    const sheet = dialog.current;
    const trigger = document.activeElement;
    const composer =
      trigger instanceof HTMLElement ? trigger.closest("form")?.querySelector("textarea") : null;
    let live = true;
    const made = kind === "image" || kind === "video" ? URL.createObjectURL(file) : undefined;
    setUrl(made);
    if (kind === "text") {
      void file
        .slice(0, TEXT_LIMIT)
        .text()
        .then(
          (contents) => {
            if (live) setText(contents);
          },
          () => {
            if (live) setText("This file could not be read.");
          },
        );
    }
    sheet?.showModal();
    return () => {
      live = false;
      sheet?.close();
      if (made !== undefined) URL.revokeObjectURL(made);
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
      else if (composer?.isConnected === true) composer.focus();
    };
  }, [file, kind]);

  return (
    <dialog
      ref={dialog}
      aria-label={file.name}
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
      onClick={(event) => {
        const sheet = event.currentTarget;
        const box = sheet.getBoundingClientRect();
        if (
          event.target === sheet &&
          (event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom)
        )
          onDismiss();
      }}
      style={{
        ...glass,
        background: `${glass.background}, ${depth.layers[1]}`,
        color: typography.color.primary,
        fontFamily: typography.family,
        boxSizing: "border-box",
        padding: spacing.md,
        maxHeight: "90dvh",
        overflowY: "auto",
        ...(mobile
          ? {
              margin: "auto 0 0",
              width: "100%",
              maxWidth: "100%",
              borderRadius: `${String(corner.xl)}px ${String(corner.xl)}px 0 0`,
              paddingBottom: `calc(${String(spacing.md)}px + env(safe-area-inset-bottom))`,
            }
          : { width: "min(900px, 90vw)", maxWidth: "90vw" }),
      }}
    >
      <h2 style={{ margin: 0, fontSize: typography.scale.md, overflowWrap: "anywhere" }}>
        {file.name}
      </h2>
      <p style={{ color: typography.color.muted }}>
        {file.type || "Unknown type"} · {file.size.toLocaleString()} bytes
      </p>
      {kind === "image" && url !== undefined && (
        <img
          src={url}
          alt={file.name}
          style={{ display: "block", maxWidth: "100%", maxHeight: "65dvh", margin: "auto" }}
        />
      )}
      {kind === "video" && url !== undefined && (
        <video
          src={url}
          controls
          playsInline
          style={{ display: "block", width: "100%", maxHeight: "65dvh" }}
        />
      )}
      {kind === "text" && (
        <>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              fontSize: typography.scale.sm,
            }}
          >
            {text}
          </pre>
          {file.size > TEXT_LIMIT && <p>Showing the first 200 KB.</p>}
        </>
      )}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: spacing.sm,
          marginTop: spacing.md,
        }}
      >
        <button type="button" onClick={onRemove} style={buttonStyle}>
          Remove
        </button>
        <button type="button" onClick={onDismiss} style={buttonStyle}>
          Close
        </button>
      </div>
    </dialog>
  );
}

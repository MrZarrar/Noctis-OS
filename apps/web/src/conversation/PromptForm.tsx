import type { ConversationalIdentityId, ModelRef } from "@noctis/contracts";
import { ATTACHMENT_MEDIA_TYPES } from "@noctis/contracts";
import {
  IDENTITY_PROFILES,
  corner,
  material,
  promptPlaceholder,
  spacing,
  typography,
} from "@noctis/ui";
import { useState } from "react";

export interface PromptFormProps {
  identityId: ConversationalIdentityId;
  /** What connected nodes offer right now (`GET /models`). */
  models: readonly ModelRef[];
  /** The identity's Settings default; preselected, and sent implicitly when kept. */
  defaultModel: ModelRef | undefined;
  disabled: boolean;
  /**
   * Whether this transport can upload at all. False in the packaged shell,
   * which proxies through a Rust command that takes JSON — so the control is
   * hidden rather than offered and then failing (`CoreTransport.upload`).
   */
  canAttach?: boolean;
  /** `model` is present only when the selector overrides the default. */
  onSend: (text: string, model?: ModelRef, files?: readonly File[]) => void;
}

/** `SendConversationMessageCommandSchema.attachmentIds` caps the array at eight. */
const MAX_FILES = 8;

const attachedListStyle = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexWrap: "wrap",
  gap: spacing.xs,
} as const;

const attachedItemStyle = {
  display: "flex",
  alignItems: "center",
  gap: spacing.xs,
  padding: `0 ${String(spacing.xs)}px`,
  background: material.fill,
  border: `1px solid ${material.border}`,
  borderRadius: corner.sm,
  fontSize: typography.scale.sm,
} as const;

export function modelKey(model: ModelRef): string {
  return `${model.providerId}:${model.model}`;
}

export function modelLabel(model: ModelRef): string {
  return `${model.label ?? model.model} (${model.providerId})`;
}

/**
 * The prompt and its model selector, shared by Presence and Chat (0.3: a
 * per-turn override beside the per-identity default). Enter sends, Shift+Enter
 * breaks a line — the textarea is a message box, not a document.
 */
export function PromptForm({
  identityId,
  models,
  defaultModel,
  disabled,
  canAttach = false,
  onSend,
}: PromptFormProps): JSX.Element {
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<string>();
  const [files, setFiles] = useState<readonly File[]>([]);

  const displayName =
    IDENTITY_PROFILES.find((profile) => profile.id === identityId)?.displayName ?? identityId;
  const defaultKey = defaultModel === undefined ? undefined : modelKey(defaultModel);
  // The default belongs in the list even when no node currently offers it, so
  // the selector never shows an empty choice for a configured identity.
  const options =
    defaultModel !== undefined && !models.some((model) => modelKey(model) === defaultKey)
      ? [defaultModel, ...models]
      : models;
  const selectedKey = chosen ?? defaultKey ?? "";

  const submit = (): void => {
    const trimmed = text.trim();

    if (disabled || trimmed === "") {
      return;
    }

    const override = options.find((model) => modelKey(model) === selectedKey);

    onSend(
      text,
      override !== undefined && selectedKey !== defaultKey ? override : undefined,
      files.length === 0 ? undefined : files,
    );
    setText("");
    setFiles([]);
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      style={{ display: "grid", gap: spacing.sm, width: "100%", maxWidth: 720 }}
    >
      <textarea
        aria-label={`Message ${displayName}`}
        placeholder={promptPlaceholder(identityId)}
        value={text}
        disabled={disabled}
        rows={2}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        style={{
          width: "100%",
          boxSizing: "border-box",
          padding: `${String(spacing.sm)}px ${String(spacing.md)}px`,
          background: material.fill,
          border: `1px solid ${material.border}`,
          borderRadius: spacing.md,
          color: "inherit",
          fontFamily: typography.family,
          fontSize: typography.scale.base,
          resize: "vertical",
        }}
      />
      {files.length > 0 && (
        // Named and removable before the send, because an attachment the owner
        // cannot see is one they cannot take back — and the upload only happens
        // on submit, so removing one here costs nothing.
        <ul aria-label="Attached files" style={{ ...attachedListStyle }}>
          {files.map((file) => (
            <li key={`${file.name}:${String(file.size)}`} style={attachedItemStyle}>
              <span>{file.name}</span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() => {
                  setFiles(files.filter((candidate) => candidate !== file));
                }}
                style={{
                  background: "transparent",
                  border: "none",
                  color: typography.color.muted,
                  cursor: "pointer",
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div style={{ display: "flex", gap: spacing.sm, alignItems: "center" }}>
        {canAttach && (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: spacing.xs,
              cursor: disabled ? "default" : "pointer",
            }}
          >
            <span style={{ color: typography.color.muted }}>Attach</span>
            <input
              type="file"
              multiple
              // The same allowlist the core enforces, so the picker does not
              // offer a file the upload would refuse. It is a convenience, not
              // the check: `accept` is a hint a browser is free to ignore.
              accept={ATTACHMENT_MEDIA_TYPES.join(",")}
              disabled={disabled}
              onChange={(event) => {
                setFiles([...files, ...Array.from(event.target.files ?? [])].slice(0, MAX_FILES));
                // Cleared so picking the same file twice in a row still fires.
                event.target.value = "";
              }}
              style={{ maxWidth: 160, color: typography.color.muted }}
            />
          </label>
        )}
        <label style={{ display: "flex", alignItems: "center", gap: spacing.xs }}>
          <span style={{ color: typography.color.muted }}>Model</span>
          <select
            value={selectedKey}
            disabled={disabled || options.length === 0}
            onChange={(event) => {
              setChosen(event.target.value);
            }}
            style={{
              background: material.fill,
              border: `1px solid ${material.border}`,
              borderRadius: corner.sm,
              color: "inherit",
              padding: spacing.xs,
            }}
          >
            {options.length === 0 && <option value="">No model offered by any node</option>}
            {options.map((model) => (
              <option key={modelKey(model)} value={modelKey(model)}>
                {modelLabel(model)}
              </option>
            ))}
          </select>
        </label>
        <span style={{ flex: 1 }} />
        <button
          type="submit"
          disabled={disabled || text.trim() === ""}
          style={{
            background: material.fillElevated,
            color: "inherit",
            border: `1px solid ${material.border}`,
            borderRadius: corner.sm,
            padding: `${String(spacing.xs)}px ${String(spacing.md)}px`,
            cursor: disabled ? "default" : "pointer",
          }}
        >
          Send
        </button>
      </div>
    </form>
  );
}

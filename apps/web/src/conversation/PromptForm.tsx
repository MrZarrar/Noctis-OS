import type { ConversationalIdentityId, ModelRef } from "@noctis/contracts";
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
  /** `model` is present only when the selector overrides the default. */
  onSend: (text: string, model?: ModelRef) => void;
}

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
  onSend,
}: PromptFormProps): JSX.Element {
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<string>();

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

    onSend(text, override !== undefined && selectedKey !== defaultKey ? override : undefined);
    setText("");
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
      <div style={{ display: "flex", gap: spacing.sm, alignItems: "center" }}>
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

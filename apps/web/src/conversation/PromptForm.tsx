import type { ConversationalIdentityId, ModelRef } from "@noctis/contracts";
import { ATTACHMENT_MEDIA_TYPES } from "@noctis/contracts";
import {
  IDENTITY_PROFILES,
  JesterGlyph,
  activationFor,
  corner,
  identityAccent,
  material,
  promptPlaceholder,
  spacing,
  typography,
} from "@noctis/ui";
import { useState } from "react";

import { buttonStyle, fieldStyle } from "../layout/Page.js";
import type { RuntimeRootOption, SendOptions } from "./useConversation.js";

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
  /**
   * The granted folders this turn could be pinned to. Empty means the core
   * chooses, which is what every send did before Slice 2 Part 2 — the page had
   * no way to name a root at all.
   */
  roots?: readonly RuntimeRootOption[];
  /**
   * Where a pinned thread always runs ("Claude · hyperframes on home"). Set,
   * the agent and folder pickers give way to saying so: the thread holds one
   * agent's session in one folder, and choosing another would start afresh.
   */
  lockedTo?: string;
  onSend: (text: string, options: SendOptions) => void;
  onListeningChange?: (listening: boolean) => void;
  /**
   * Offered, the Vesper/Jester switch shows above the box, and typing exactly
   * `JESTER` or `VESPER` switches instead of sending (master plan §6).
   */
  onSwitchIdentity?: (identityId: ConversationalIdentityId) => void;
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

const pickerStyle = {
  display: "grid",
  gap: 2,
  minWidth: 0,
  fontSize: typography.scale.xs,
  letterSpacing: typography.tracking.wide,
  color: typography.color.muted,
} as const;

const sendStyle = {
  vesper: {
    ...buttonStyle,
    background: identityAccent.vesper.secondary,
    borderColor: identityAccent.vesper.primary,
  },
  // Lime on dark rather than a lime fill: white type does not read on lime.
  jester: {
    ...buttonStyle,
    background: "rgba(182, 255, 59, 0.12)",
    borderColor: identityAccent.jester.primary,
    color: identityAccent.jester.primary,
  },
} as const;

const switchStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: spacing.xs,
  minHeight: 32,
  padding: `0 ${String(spacing.sm)}px`,
  background: "transparent",
  border: `1px solid ${material.border}`,
  borderRadius: corner.sm,
  color: typography.color.muted,
  fontFamily: typography.family,
  fontSize: typography.scale.xs,
  letterSpacing: typography.tracking.wide,
  cursor: "pointer",
} as const;

/** The last segment of a granted folder's path: the name the owner knows it by. */
export function folderName(path: string): string {
  return (
    path
      .split(/[\\/]+/)
      .filter((part) => part !== "")
      .at(-1) ?? path
  );
}

/**
 * A folder named the way the owner thinks of it: the machine, the last path
 * segment, and whether that machine is awake.
 *
 * The offline ones are listed rather than hidden (task 2.6). Picking one is
 * how the owner finds out the machine is asleep — the core refuses the send
 * with `node_offline` and writes nothing — and hiding it would leave them
 * looking for the only root they wanted.
 */
export function rootLabel(root: RuntimeRootOption): string {
  return `${folderName(root.path)} on ${root.hostId}${root.connected ? "" : " (offline)"}${root.mode === "read" ? " — read only" : ""}`;
}

/** What the identity may run on: Jester is Hermes (ADR-0030), and the core refuses anything else. */
export function offeredModels(
  identityId: ConversationalIdentityId,
  models: readonly ModelRef[],
): readonly ModelRef[] {
  return identityId === "jester" ? models.filter((model) => model.providerId === "hermes") : models;
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
  canAttach = false,
  roots = [],
  lockedTo,
  onSend,
  onListeningChange,
  onSwitchIdentity,
}: PromptFormProps): JSX.Element {
  const [text, setText] = useState("");
  const [chosen, setChosen] = useState<string>();
  const [files, setFiles] = useState<readonly File[]>([]);
  const [rootGrantId, setRootGrantId] = useState("");

  const displayName =
    IDENTITY_PROFILES.find((profile) => profile.id === identityId)?.displayName ?? identityId;
  const offered = offeredModels(identityId, models);
  // A default Jester cannot run on (one set before ADR-0030 held) is no default.
  const usableDefault =
    defaultModel !== undefined && offeredModels(identityId, [defaultModel]).length === 1
      ? defaultModel
      : undefined;
  const defaultKey = usableDefault === undefined ? undefined : modelKey(usableDefault);
  // The default belongs in the list even when no node currently offers it, so
  // the selector never shows an empty choice for a configured identity.
  const options =
    usableDefault !== undefined && !offered.some((model) => modelKey(model) === defaultKey)
      ? [usableDefault, ...offered]
      : offered;
  const selectedKey = chosen ?? defaultKey ?? "";

  const submit = (): void => {
    const trimmed = text.trim();

    if (disabled || trimmed === "") {
      return;
    }

    const activates = onSwitchIdentity === undefined ? undefined : activationFor(trimmed);

    if (activates !== undefined) {
      onSwitchIdentity?.(activates);
      setText("");
      setChosen(undefined);
      return;
    }

    const override = options.find((model) => modelKey(model) === selectedKey);

    // A pinned thread chooses its own model; the core refuses another agent's.
    const model =
      lockedTo === undefined && override !== undefined && selectedKey !== defaultKey
        ? override
        : undefined;

    onSend(text, {
      ...(model === undefined ? {} : { model }),
      ...(files.length === 0 ? {} : { files }),
      ...(rootGrantId === "" || lockedTo !== undefined ? {} : { rootGrantId }),
    });
    setText("");
    onListeningChange?.(false);
    setFiles([]);
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      style={{ display: "grid", gap: spacing.sm, width: "100%" }}
    >
      {onSwitchIdentity !== undefined && lockedTo === undefined && (
        <div role="group" aria-label="Who to talk to" style={{ display: "flex", gap: spacing.xs }}>
          {IDENTITY_PROFILES.map((profile) => {
            const active = profile.id === identityId;
            const accent = identityAccent[profile.id].primary;

            return (
              <button
                key={profile.id}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  if (!active) {
                    setChosen(undefined);
                    onSwitchIdentity(profile.id);
                  }
                }}
                style={{
                  ...switchStyle,
                  ...(active ? { borderColor: accent, color: accent } : {}),
                }}
              >
                {profile.id === "jester" ? (
                  <JesterGlyph size={14} />
                ) : (
                  <span aria-hidden="true">✦</span>
                )}
                {profile.displayName}
              </button>
            );
          })}
        </div>
      )}
      <div style={{ display: "flex", gap: spacing.sm, alignItems: "stretch" }}>
        <textarea
          aria-label={`Message ${displayName}`}
          placeholder={promptPlaceholder(identityId)}
          value={text}
          disabled={disabled}
          rows={2}
          onFocus={() => onListeningChange?.(true)}
          onBlur={() => onListeningChange?.(false)}
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
            minHeight: 52,
            boxSizing: "border-box",
            padding: `${String(spacing.sm)}px ${String(spacing.md)}px`,
            background: material.fill,
            border: `1px solid ${material.border}`,
            borderRadius: corner.lg,
            color: "inherit",
            fontFamily: typography.family,
            // 16px or more, or iOS zooms the page in when the box takes focus.
            fontSize: 16,
            lineHeight: 1.45,
            resize: "none",
          }}
        />
        <button
          type="submit"
          disabled={disabled || text.trim() === ""}
          style={{
            ...sendStyle[identityId],
            opacity: disabled || text.trim() === "" ? 0.55 : 1,
            cursor: disabled ? "default" : "pointer",
          }}
        >
          Send
        </button>
      </div>
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
                  minWidth: 44,
                  minHeight: 44,
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

      {/* Which agent, and which PC it runs on: the two choices a thread is
          started with. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: canAttach
            ? "minmax(0, 1fr) minmax(0, 1fr) auto"
            : "minmax(0, 1fr) minmax(0, 1fr)",
          alignItems: "end",
          gap: spacing.sm,
        }}
      >
        {lockedTo !== undefined ? (
          <p
            style={{
              ...pickerStyle,
              gridColumn: canAttach ? "1 / 3" : "1 / -1",
              margin: 0,
              alignSelf: "center",
            }}
          >
            Continuing in {lockedTo}
          </p>
        ) : (
          <>
            <label style={pickerStyle}>
              <span>Agent</span>
              <select
                value={selectedKey}
                disabled={disabled || options.length === 0}
                onChange={(event) => {
                  setChosen(event.target.value);
                }}
                style={fieldStyle}
              >
                {options.length === 0 && (
                  <option value="">
                    {identityId === "jester"
                      ? "Jester needs Hermes and LM Studio on a connected PC"
                      : "No agent offered by any PC"}
                  </option>
                )}
                {options.map((model) => (
                  <option key={modelKey(model)} value={modelKey(model)}>
                    {modelLabel(model)}
                  </option>
                ))}
              </select>
            </label>
            {roots.length > 0 && (
              <label style={pickerStyle}>
                <span>PC and folder</span>
                <select
                  value={rootGrantId}
                  disabled={disabled}
                  onChange={(event) => {
                    setRootGrantId(event.target.value);
                  }}
                  style={fieldStyle}
                >
                  {/* The core's own rule when nothing is named: the chosen node's
                  first writable root. Said out loud rather than left blank. */}
                  <option value="">Wherever Noctis chooses</option>
                  {roots.map((root) => (
                    <option key={root.grantId} value={root.grantId}>
                      {rootLabel(root)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}
        {canAttach && (
          // The native picker, invisible and stretched over a button-shaped
          // label: it keeps the keyboard and the file dialog without the
          // browser's own control, which no two platforms draw alike.
          <label
            className="noctis-file-pick"
            style={{
              ...buttonStyle,
              position: "relative",
              display: "inline-flex",
              alignItems: "center",
              color: typography.color.muted,
              cursor: disabled ? "default" : "pointer",
            }}
          >
            Attach
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
              style={{
                position: "absolute",
                // Over the border too, so the input is the whole button.
                inset: -1,
                opacity: 0,
                cursor: "inherit",
              }}
            />
          </label>
        )}
      </div>
    </form>
  );
}

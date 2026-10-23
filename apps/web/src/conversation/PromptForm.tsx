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
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

import { buttonStyle } from "../layout/Page.js";
import type { PickerOption } from "../layout/Picker.js";
import { Picker } from "../layout/Picker.js";
import { useBackLayer } from "../navigation/back.js";
import { AttachmentPreview } from "./AttachmentPreview.js";
import { carriesFiles } from "./file-drops.js";
import { createWakeGuard } from "./wake.js";
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
   * the folder picker gives way to saying so, and the model picker offers
   * only `pinnedProvider`'s models: the thread holds one agent's session in
   * one folder, and another agent or folder would start afresh.
   */
  lockedTo?: string;
  pinnedProvider?: string;
  /** The open thread. Another one brings its own model and folder with it. */
  threadId?: string;
  /** What the thread's latest turn ran on, shown until the owner picks otherwise. */
  current?: { model?: ModelRef; rootGrantId?: string };
  /** A turn is still working: what is sent now joins it, so the box says so. */
  steering?: boolean;
  /** Under the identity switch: the clock, and the usage of the agent the picker is set to. */
  status?: (providerId: string | undefined) => ReactNode;
  onSend: (text: string, options: SendOptions) => void;
  /**
   * Offered, the Vesper/Jester switch shows above the box, and typing exactly
   * `JESTER` or `VESPER` switches instead of sending (master plan §6).
   */
  onSwitchIdentity?: (identityId: ConversationalIdentityId) => void;
  /** At the right of the switch row, which never scrolls away: Threads puts the core here. */
  aside?: ReactNode;
  /** The agent loads a model before it can answer, and has not been woken. */
  asleep?: boolean;
  /** Wakes it: offered as a button while asleep, and on the first keystroke when allowed. */
  onWake?: () => void;
  /** The Settings toggle: wake as the owner starts typing. */
  wakeWhileTyping?: boolean;
}

/** `SendConversationMessageCommandSchema.attachmentIds` caps the array at eight. */
const MAX_FILES = 8;

const ALLOWED_TYPES: readonly string[] = ATTACHMENT_MEDIA_TYPES;

/**
 * The images on a clipboard, named for when they were pasted: the browser calls
 * every one of them `image.png`, which says nothing in the attached list and
 * collides on a second paste. A file type the core would refuse is left out.
 */
export function pastedFiles(
  items: ReadonlyArray<{ kind: string; type: string; getAsFile(): File | null }>,
  now: Date,
  firstNumber = 1,
): File[] {
  const two = (value: number): string => String(value).padStart(2, "0");
  const stamp =
    `${String(now.getFullYear())}${two(now.getMonth() + 1)}${two(now.getDate())}` +
    `-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;

  return items
    .filter(
      (item) =>
        item.kind === "file" && item.type.startsWith("image/") && ALLOWED_TYPES.includes(item.type),
    )
    .flatMap((item) => {
      const file = item.getAsFile();
      return file === null ? [] : [{ file, type: item.type }];
    })
    .map(({ file, type }, index) => {
      const number = firstNumber + index;
      const extension = type.slice("image/".length).replace("jpeg", "jpg");
      const name = `screenshot-${stamp}${number === 1 ? "" : `-${String(number)}`}.${extension}`;
      return new File([file], name, { type, lastModified: now.getTime() });
    });
}

/** A small preview of an attached image; the object URL goes with the file. */
function Thumbnail({ file }: { file: File }): JSX.Element | null {
  const [url, setUrl] = useState<string>();

  useEffect(() => {
    const made = URL.createObjectURL(file);
    setUrl(made);
    return () => {
      URL.revokeObjectURL(made);
    };
  }, [file]);

  return url === undefined ? null : (
    <img
      src={url}
      alt=""
      style={{ width: 32, height: 32, objectFit: "cover", borderRadius: corner.sm }}
    />
  );
}

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
  // The phone gate's touch floor.
  minHeight: 44,
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
export function rootOption(root: RuntimeRootOption): PickerOption<string> {
  const notes = [
    ...(root.connected ? [] : ["offline"]),
    ...(root.mode === "read" ? ["read only"] : []),
  ];

  return {
    value: root.grantId,
    label: `${folderName(root.path)} on ${root.hostId}`,
    ...(notes.length === 0 ? {} : { detail: notes.join(" · ") }),
  };
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

/**
 * The models the picker offers and the one it shows: the owner's pick, else
 * what the thread last ran on, else the Settings default. What it shows is what
 * is sent, so the core never has to guess. A pinned thread with nothing to go
 * on shows the first of its agent's models, as the core would choose.
 */
export function modelChoice({
  identityId,
  models,
  defaultModel,
  current,
  pinnedProvider,
  chosenKey,
}: {
  identityId: ConversationalIdentityId;
  models: readonly ModelRef[];
  defaultModel: ModelRef | undefined;
  current?: ModelRef | undefined;
  pinnedProvider?: string | undefined;
  chosenKey?: string | undefined;
}): { options: readonly ModelRef[]; selected: ModelRef | undefined } {
  const fits = (model: ModelRef | undefined): model is ModelRef =>
    model !== undefined &&
    offeredModels(identityId, [model]).length === 1 &&
    (pinnedProvider === undefined || model.providerId === pinnedProvider);
  const offered = offeredModels(identityId, models).filter((model) => fits(model));
  // The default and the thread's own model belong in the list even when no
  // node offers them right now, so the picker never shows an empty choice.
  const options = [current, defaultModel]
    .filter(fits)
    .reduce<ModelRef[]>(
      (list, extra) =>
        list.some((model) => modelKey(model) === modelKey(extra)) ? list : [extra, ...list],
      [...offered],
    );
  const byKey = (key: string | undefined) => options.find((model) => modelKey(model) === key);
  const fallback = pinnedProvider === undefined ? undefined : offered[0];

  return {
    options,
    selected:
      byKey(chosenKey) ??
      (fits(current) ? current : undefined) ??
      (fits(defaultModel) ? defaultModel : undefined) ??
      fallback,
  };
}

/** What a thread's latest turn ran on: the `current` a composer shows. */
export function lastRun(
  turns: ReadonlyArray<{ model: ModelRef; rootGrantId?: string | undefined }>,
): { model: ModelRef; rootGrantId?: string } | undefined {
  const turn = turns.at(-1);

  return turn === undefined
    ? undefined
    : {
        model: turn.model,
        ...(turn.rootGrantId === undefined ? {} : { rootGrantId: turn.rootGrantId }),
      };
}

/**
 * The folder the picker shows. A thread that has run somewhere stays there,
 * so "wherever Noctis chooses" is only offered before its first turn.
 */
export function rootChoice({ current, chosen }: { current?: string; chosen?: string }): {
  selected: string;
  offerAnywhere: boolean;
} {
  return { selected: chosen ?? current ?? "", offerAnywhere: current === undefined };
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
  pinnedProvider,
  threadId,
  current,
  steering = false,
  status,
  onSend,
  onSwitchIdentity,
  aside,
  asleep = false,
  onWake,
  wakeWhileTyping = true,
}: PromptFormProps): JSX.Element {
  const [text, setText] = useState("");
  const wakeGuard = useRef(createWakeGuard());

  // Re-armed whenever the agent is awake, so the next sleep wakes on typing again.
  useEffect(() => {
    if (!asleep) {
      wakeGuard.current.typed({ asleep: false, enabled: wakeWhileTyping });
    }
  }, [asleep, wakeWhileTyping]);
  const [chosen, setChosen] = useState<string>();
  const [files, setFiles] = useState<readonly File[]>([]);
  const [preview, setPreview] = useState<File>();
  const previewLayer = useBackLayer("attachment", preview !== undefined, () => {
    setPreview(undefined);
  });
  const [chosenRoot, setChosenRoot] = useState<string>();
  // Screenshots pasted so far, so two in the same second never share a name.
  const pasted = useRef(0);

  // Opening another thread shows that thread's own model and folder. A new
  // thread getting its id from its first send keeps what was picked for it.
  const [shownThread, setShownThread] = useState(threadId);
  const sentUnstarted = useRef(false);
  if (threadId !== shownThread) {
    setShownThread(threadId);
    if (shownThread !== undefined || !sentUnstarted.current) {
      setChosen(undefined);
      setChosenRoot(undefined);
    }
    sentUnstarted.current = false;
  }

  const displayName =
    IDENTITY_PROFILES.find((profile) => profile.id === identityId)?.displayName ?? identityId;
  const { options, selected } = modelChoice({
    identityId,
    models,
    defaultModel,
    current: current?.model,
    pinnedProvider,
    chosenKey: chosen,
  });
  const selectedKey = selected === undefined ? "" : modelKey(selected);
  const root = rootChoice({
    ...(current?.rootGrantId === undefined ? {} : { current: current.rootGrantId }),
    ...(chosenRoot === undefined ? {} : { chosen: chosenRoot }),
  });
  const rootGrantId = root.selected;

  const attach = (incoming: readonly File[]): void => {
    setFiles((current) => [...current, ...incoming].slice(0, MAX_FILES));
  };

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

    sentUnstarted.current = threadId === undefined;
    // What the picker shows is what is sent, the default included, so the
    // thread keeps it for the next message.
    onSend(text, {
      ...(selected === undefined ? {} : { model: selected }),
      ...(files.length === 0 ? {} : { files }),
      ...(rootGrantId === "" || lockedTo !== undefined ? {} : { rootGrantId }),
    });
    setText("");
    setFiles([]);
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      onDragOver={(event) => {
        // A drop only lands where the dragover said it may.
        if (canAttach && !disabled && carriesFiles(event.dataTransfer)) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        // Text dragged into the box is the browser's to insert.
        if (!canAttach || disabled || !carriesFiles(event.dataTransfer)) {
          return;
        }

        event.preventDefault();
        attach(
          Array.from(event.dataTransfer.files).filter((file) => ALLOWED_TYPES.includes(file.type)),
        );
      }}
      style={{ display: "grid", gap: spacing.sm, width: "100%" }}
    >
      {((onSwitchIdentity !== undefined && lockedTo === undefined) ||
        aside !== undefined ||
        status !== undefined) && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: spacing.sm,
          }}
        >
          <div style={{ display: "grid", gap: spacing.sm, minWidth: 0, flex: "0 1 auto" }}>
            {onSwitchIdentity !== undefined && lockedTo === undefined && (
              <div
                role="group"
                aria-label="Who to talk to"
                style={{ display: "flex", gap: spacing.xs }}
              >
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
            {status?.(selected?.providerId)}
          </div>
          {aside}
        </div>
      )}
      <div style={{ display: "flex", gap: spacing.sm, alignItems: "stretch" }}>
        <textarea
          aria-label={`Message ${displayName}`}
          placeholder={
            steering ? `Add to what ${displayName} is doing...` : promptPlaceholder(identityId)
          }
          value={text}
          disabled={disabled}
          rows={2}
          onChange={(event) => {
            setText(event.target.value);

            if (
              onWake !== undefined &&
              wakeGuard.current.typed({ asleep, enabled: wakeWhileTyping })
            ) {
              onWake();
            }
          }}
          onPaste={(event) => {
            const images = canAttach
              ? pastedFiles(Array.from(event.clipboardData.items), new Date(), pasted.current + 1)
              : [];

            if (images.length === 0) {
              return;
            }

            pasted.current += images.length;
            attach(images);

            // Text copied along with the image still pastes as text.
            if (event.clipboardData.getData("text/plain") === "") {
              event.preventDefault();
            }
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
        {asleep && onWake !== undefined && (
          <button type="button" onClick={onWake} style={buttonStyle}>
            Wake
          </button>
        )}
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
              <button
                type="button"
                aria-label={`Preview ${file.name}`}
                onClick={() => {
                  setPreview(file);
                  previewLayer.pushed();
                }}
                style={{
                  ...buttonStyle,
                  display: "flex",
                  alignItems: "center",
                  gap: spacing.xs,
                  background: "transparent",
                  border: "none",
                  overflowWrap: "anywhere",
                }}
              >
                {file.type.startsWith("image/") && <Thumbnail file={file} />}
                <span>{file.name}</span>
              </button>
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

      {preview !== undefined && (
        <AttachmentPreview
          file={preview}
          onDismiss={previewLayer.dismiss}
          onRemove={() => {
            setFiles((attached) => attached.filter((file) => file !== preview));
            previewLayer.dismiss();
          }}
        />
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
        <div style={pickerStyle}>
          <span aria-hidden="true">Agent</span>
          <Picker
            label="Agent"
            value={selectedKey}
            disabled={disabled || options.length === 0}
            onChange={setChosen}
            options={
              options.length === 0
                ? [
                    {
                      value: "",
                      label:
                        identityId === "jester"
                          ? "Jester needs Hermes and LM Studio on a connected PC"
                          : "No agent offered by any PC",
                    },
                  ]
                : options.map((model) => ({ value: modelKey(model), label: modelLabel(model) }))
            }
          />
        </div>
        {lockedTo !== undefined ? (
          <p style={{ ...pickerStyle, margin: 0, alignSelf: "center" }}>Continuing in {lockedTo}</p>
        ) : (
          <>
            {roots.length > 0 && (
              <div style={pickerStyle}>
                <span aria-hidden="true">PC and folder</span>
                <Picker
                  label="PC and folder"
                  value={rootGrantId}
                  disabled={disabled}
                  onChange={setChosenRoot}
                  // The core's own rule when nothing is named: the chosen node's
                  // first writable root. Said out loud rather than left blank,
                  // and only before the thread has run somewhere.
                  options={[
                    ...(root.offerAnywhere
                      ? [{ value: "", label: "Wherever Noctis chooses" }]
                      : []),
                    ...roots.map(rootOption),
                  ]}
                />
              </div>
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
                attach(Array.from(event.target.files ?? []));
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

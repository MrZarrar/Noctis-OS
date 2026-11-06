import { PalaceKindSchema, UuidSchema } from "@noctis/contracts";
import type { PalaceContents } from "@noctis/contracts";
import { useEffect, useState } from "react";

import { Chrome } from "../palace/scene/Chrome.js";
import type { SearchScope } from "../palace/scene/Chrome.js";
import { Collection } from "../palace/scene/Collection.js";
import { Desk } from "../palace/scene/Desk.js";
import type { SaveState } from "../palace/scene/Desk.js";
import { PalaceScene } from "../palace/scene/PalaceScene.js";
import type { RoomId } from "../palace/scene/rooms.js";
import { ROOMS } from "../palace/scene/rooms.js";
import { usePalace } from "../palace/usePalace.js";
import type { CoreTransport } from "../transport/CoreTransport.js";

type Palace = ReturnType<typeof usePalace>;

function saveState(palace: Palace): SaveState {
  if (palace.pending) return { kind: "saving" };
  if (palace.conflict !== undefined) return { kind: "conflict" };
  if (palace.error !== undefined) return { kind: "failed", reason: `${palace.error}. Draft kept.` };
  if (palace.status === "")
    return palace.api.fixture
      ? { kind: "message", text: "LARP sample collection. Changes reset on refresh." }
      : { kind: "idle" };
  if (palace.status.startsWith("Draft saved")) return { kind: "draft" };
  if (palace.status.startsWith("Saved")) return { kind: "saved" };
  return { kind: "message", text: palace.status };
}

export function ThoughtPalace({
  transport,
  focusId,
  onLeave,
}: {
  transport: CoreTransport | undefined;
  focusId?: string;
  /** Absent in a panel, which already has the shell's own way out. */
  onLeave?: () => void;
}): JSX.Element {
  const linked = UuidSchema.safeParse(new URL(window.location.href).searchParams.get("entry"));
  const palace = usePalace(transport, focusId ?? (linked.success ? linked.data : undefined));
  const [room, setRoom] = useState<RoomId>("atrium");
  const [exploring, setExploring] = useState(false);
  const [scope, setScope] = useState<SearchScope>("palace");
  const contents = palace.draft.command.contents;

  const searching = palace.query.trim() !== "";
  const scoped = room !== "atrium" && (!searching || scope === "room");
  const { setRoom: setDataRoom, setThisRoom } = palace;
  useEffect(() => {
    if (room !== "atrium") setDataRoom(room);
    setThisRoom(scoped);
  }, [room, scoped, setDataRoom, setThisRoom]);

  const showCollection = room !== "atrium" || searching;
  const openId =
    palace.draft.command.expectedHash === undefined ? undefined : palace.draft.command.entryId;

  return (
    <section
      aria-label="Thought Palace"
      style={{ position: "relative", flex: 1, minHeight: 0, overflow: "hidden" }}
    >
      <PalaceScene room={room} onRoomChange={setRoom} exploring={exploring}>
        <Chrome
          roomName={ROOMS[room].name}
          query={palace.query}
          onQuery={palace.setQuery}
          scope={scope}
          onScope={setScope}
          exploring={exploring}
          onExplore={setExploring}
          {...(onLeave === undefined ? {} : { onLeave })}
          {...(room === "atrium"
            ? {}
            : {
                onReturnToAtrium: () => {
                  setRoom("atrium");
                },
              })}
        />

        {showCollection && (
          <Collection
            title={searching ? "Search" : ROOMS[room].name}
            entries={palace.entries}
            {...(openId === undefined ? {} : { openId })}
            onOpen={(id) => {
              void palace.open(id);
              setExploring(false);
            }}
            {...(palace.nextCursor === undefined
              ? {}
              : {
                  onMore: () => {
                    void palace.loadMore();
                  },
                })}
            dimmed={exploring}
            empty={searching ? "Nothing here matches that." : "This room is empty so far."}
          />
        )}

        <Desk
          value={contents.body}
          onChange={(body) => {
            palace.update({ body });
          }}
          onSave={() => {
            void palace.save();
          }}
          state={saveState(palace)}
          dimmed={exploring}
          disabled={palace.loadingEntry}
          allowEmptyBody={contents.kind === "book" && Boolean(contents.title?.trim())}
          placeholder={
            openId === undefined ? "What is on your mind?" : (contents.title ?? "Your writing")
          }
          actions={<DeskActions palace={palace} />}
          details={<DeskDetails palace={palace} />}
        />
      </PalaceScene>
    </section>
  );
}

const LINK = {
  font: "400 13px/1 Georgia, 'Times New Roman', serif",
  color: "#6b5b43",
  background: "transparent",
  border: 0,
  cursor: "pointer",
  padding: "6px 2px",
} as const;

function DeskActions({ palace }: { palace: Palace }): JSX.Element {
  const saved = palace.draft.command.expectedHash !== undefined;

  return (
    <>
      {saved && (
        <button
          type="button"
          style={LINK}
          onClick={() => {
            void palace.startNew();
          }}
        >
          New thought
        </button>
      )}
      {saved && (
        <button
          type="button"
          style={LINK}
          disabled={palace.draft.dirty}
          onClick={() => {
            void palace.archiveOrRestore();
          }}
        >
          {palace.draft.command.contents.archived ? "Restore" : "Archive"}
        </button>
      )}
      {palace.conflict !== undefined && (
        <>
          <button type="button" style={LINK} onClick={palace.keepReviewedEdits}>
            Keep my version
          </button>
          <button
            type="button"
            style={LINK}
            onClick={() => {
              void palace.loadSaved();
            }}
          >
            Load the saved one
          </button>
        </>
      )}
      {palace.recoverable.map((value, index) => (
        <button
          key={value.draftId}
          type="button"
          style={LINK}
          onClick={() => {
            void palace.recover(value);
          }}
        >
          Recover draft {index + 1}
        </button>
      ))}
    </>
  );
}

const FIELD = { font: "inherit", padding: "5px 7px", maxWidth: "15rem" } as const;

function DeskDetails({ palace }: { palace: Palace }): JSX.Element {
  const contents = palace.draft.command.contents;

  const optional = (
    key: "title" | "author" | "bookId" | "location" | "readingLane",
    value: string,
  ): void => {
    const next = { ...contents };
    if (value === "") delete next[key];
    else next[key] = value;
    palace.update(next, true);
  };

  return (
    <>
      <label>
        Kind{" "}
        <select
          style={FIELD}
          value={contents.kind}
          onChange={(event) => {
            const next: PalaceContents = {
              ...contents,
              kind: PalaceKindSchema.parse(event.target.value),
            };
            if (next.kind !== "book") {
              delete next.author;
              delete next.edition;
              delete next.readingStatus;
              delete next.readingLane;
            }
            if (next.kind === "book") next.readingStatus ??= "planned";
            if (next.kind === "quote" && next.bookId === undefined && palace.books[0] !== undefined)
              next.bookId = palace.books[0].id;
            palace.update(next, true);
          }}
        >
          {PalaceKindSchema.options.map((kind) => (
            <option
              key={kind}
              disabled={kind === "quote" && palace.books.length === 0}
              value={kind}
            >
              {kind === "art" ? "art idea" : kind}
            </option>
          ))}
        </select>
      </label>

      <label>
        Title{" "}
        <input
          style={FIELD}
          maxLength={200}
          required={contents.kind === "book"}
          value={contents.title ?? ""}
          onChange={(event) => {
            optional("title", event.target.value);
          }}
        />
      </label>

      <label>
        Tags{" "}
        <input
          style={FIELD}
          value={contents.tags.join(", ")}
          onChange={(event) => {
            palace.update({
              tags: event.target.value
                .split(",")
                .map((tag) => tag.trim())
                .filter(Boolean),
            });
          }}
        />
      </label>

      {contents.kind === "book" ? (
        <>
          <label>
            Author{" "}
            <input
              style={FIELD}
              maxLength={200}
              value={contents.author ?? ""}
              onChange={(event) => {
                optional("author", event.target.value);
              }}
            />
          </label>
          <label>
            Reading{" "}
            <select
              style={FIELD}
              value={contents.readingStatus ?? ""}
              onChange={(event) => {
                const next = { ...contents };
                if (event.target.value === "") delete next.readingStatus;
                else
                  next.readingStatus = event.target.value as NonNullable<
                    PalaceContents["readingStatus"]
                  >;
                palace.update(next, true);
              }}
            >
              <option value="">Unspecified</option>
              {["planned", "reading", "paused", "finished"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <label>
            Reading group{" "}
            <input
              style={FIELD}
              maxLength={100}
              value={contents.readingLane ?? ""}
              onChange={(event) => {
                optional("readingLane", event.target.value);
              }}
            />
          </label>
        </>
      ) : (
        <label>
          {contents.kind === "quote" ? "Source book" : "Book"}{" "}
          <select
            style={FIELD}
            required={contents.kind === "quote"}
            value={contents.bookId ?? ""}
            onChange={(event) => {
              optional("bookId", event.target.value);
            }}
          >
            <option value="">None</option>
            {palace.books.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.title}
              </option>
            ))}
          </select>
        </label>
      )}

      {contents.kind === "quote" && (
        <label>
          Page or chapter{" "}
          <input
            style={FIELD}
            maxLength={1000}
            value={contents.location ?? ""}
            onChange={(event) => {
              optional("location", event.target.value);
            }}
          />
        </label>
      )}

      <label title={palace.unlocked ? undefined : "Unlock the Vault to mark writing sensitive"}>
        <input
          type="checkbox"
          disabled={!palace.unlocked}
          checked={contents.sensitive}
          onChange={(event) => {
            palace.update({ sensitive: event.target.checked });
          }}
        />{" "}
        Sensitive
      </label>

      <label>
        <input
          type="checkbox"
          checked={palace.archived}
          onChange={(event) => {
            palace.setArchived(event.target.checked);
          }}
        />{" "}
        Show archived
      </label>
    </>
  );
}

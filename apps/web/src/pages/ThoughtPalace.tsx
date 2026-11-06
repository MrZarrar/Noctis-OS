import { PalaceKindSchema, UuidSchema } from "@noctis/contracts";
import type { PalaceContents } from "@noctis/contracts";
import { useState } from "react";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { usePalace } from "../palace/usePalace.js";

export function ThoughtPalace({
  transport,
  focusId,
}: {
  transport: CoreTransport | undefined;
  focusId?: string;
}): JSX.Element {
  const linked = UuidSchema.safeParse(new URL(window.location.href).searchParams.get("entry"));
  const palace = usePalace(transport, focusId ?? (linked.success ? linked.data : undefined));
  const [passcode, setPasscode] = useState("");
  const contents = palace.draft.command.contents;
  const optional = (
    key: "title" | "author" | "edition" | "readingLane" | "location" | "bookId",
    value: string,
  ) => {
    const next = { ...contents };
    if (value === "") delete next[key];
    else next[key] = value;
    palace.update(next, true);
  };
  const book = palace.books.find((entry) => entry.id === contents.bookId);
  return (
    <section aria-label="Thought Palace" style={{ overflow: "auto", padding: 16, flex: 1 }}>
      <h1>Thought Palace</h1>
      {palace.api.fixture && (
        <p>
          Fixture data. Saved changes last for this tab. Local drafts can be recovered on this
          device.
        </p>
      )}
      <nav aria-label="Palace rooms">
        <button
          type="button"
          aria-pressed={palace.room === "library"}
          onClick={() => palace.setRoom("library")}
        >
          Library
        </button>
        <button
          type="button"
          aria-pressed={palace.room === "gallery"}
          onClick={() => palace.setRoom("gallery")}
        >
          Gallery
        </button>
      </nav>
      <p>
        <label>
          Search{" "}
          <input
            type="search"
            maxLength={500}
            value={palace.query}
            onChange={(event) => palace.setQuery(event.target.value)}
          />
        </label>{" "}
        <label>
          Search scope{" "}
          <select
            value={palace.thisRoom ? "room" : "all"}
            onChange={(event) => palace.setThisRoom(event.target.value === "room")}
          >
            <option value="all">All palace</option>
            <option value="room">This room</option>
          </select>
        </label>{" "}
        <label>
          <input
            type="checkbox"
            checked={palace.archived}
            onChange={(event) => palace.setArchived(event.target.checked)}
          />
          Archived entries
        </label>
      </p>
      {palace.unlocked ? (
        <button type="button" disabled={palace.pending} onClick={() => void palace.lock()}>
          Lock sensitive entries
        </button>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void palace.unlock(passcode);
            setPasscode("");
          }}
        >
          <label>
            Vault passcode{" "}
            <input
              type="password"
              inputMode="numeric"
              maxLength={8}
              value={passcode}
              onChange={(event) => setPasscode(event.target.value)}
            />
          </label>
          <button type="submit">Unlock</button>
          {palace.api.fixture && <span> Demo passcode: 1234</span>}
        </form>
      )}
      <p>
        <button type="button" disabled={palace.pending} onClick={() => void palace.startNew()}>
          New thought
        </button>
      </p>
      {palace.recoverable.length > 0 && (
        <div aria-label="Local recovery drafts">
          <p>Local drafts are available on this device.</p>
          {palace.recoverable.map((value, index) => (
            <button
              type="button"
              key={value.draftId}
              disabled={palace.pending}
              onClick={() => void palace.recover(value)}
            >
              Recover draft {index + 1}
            </button>
          ))}
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void palace.save();
        }}
      >
        <fieldset disabled={palace.pending || palace.loadingEntry}>
          <legend>
            {palace.draft.command.expectedHash === undefined ? "New entry" : "Edit entry"}
          </legend>
          <p>
            <label>
              Kind{" "}
              <select
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
                  if (
                    next.kind === "quote" &&
                    next.bookId === undefined &&
                    palace.books[0] !== undefined
                  )
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
                    {kind}
                  </option>
                ))}
              </select>
            </label>
          </p>
          <p>
            <label>
              Title{contents.kind === "book" ? " (required)" : " (optional)"}{" "}
              <input
                maxLength={200}
                required={contents.kind === "book"}
                value={contents.title ?? ""}
                onChange={(event) => optional("title", event.target.value)}
              />
            </label>
          </p>
          <label>
            Writing
            <textarea
              aria-label="Entry body"
              maxLength={100_000}
              rows={10}
              style={{ display: "block", width: "100%", boxSizing: "border-box" }}
              value={contents.body}
              onChange={(event) => palace.update({ body: event.target.value })}
            />
          </label>
          <p>
            <label>
              Tags, separated by commas{" "}
              <input
                value={contents.tags.join(", ")}
                onChange={(event) =>
                  palace.update({
                    tags: event.target.value
                      .split(",")
                      .map((tag) => tag.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
          </p>
          <p>
            <label>
              <input
                type="checkbox"
                disabled={!palace.unlocked}
                checked={contents.sensitive}
                onChange={(event) => palace.update({ sensitive: event.target.checked })}
              />
              Sensitive
            </label>
          </p>
          {contents.sensitive && (
            <p>
              Device recovery is unavailable for sensitive writing. Save before closing this page.
            </p>
          )}
          {contents.kind === "book" ? (
            <>
              <p>
                <label>
                  Author{" "}
                  <input
                    maxLength={200}
                    value={contents.author ?? ""}
                    onChange={(event) => optional("author", event.target.value)}
                  />
                </label>
              </p>
              <p>
                <label>
                  Edition{" "}
                  <input
                    maxLength={500}
                    value={contents.edition ?? ""}
                    onChange={(event) => optional("edition", event.target.value)}
                  />
                </label>
              </p>
              <p>
                <label>
                  Reading status{" "}
                  <select
                    value={contents.readingStatus ?? "planned"}
                    onChange={(event) =>
                      palace.update({
                        readingStatus: event.target.value as NonNullable<
                          PalaceContents["readingStatus"]
                        >,
                      })
                    }
                  >
                    {["planned", "reading", "paused", "finished"].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
              </p>
              <p>
                <label>
                  Reading lane{" "}
                  <input
                    maxLength={100}
                    value={contents.readingLane ?? ""}
                    onChange={(event) => optional("readingLane", event.target.value)}
                  />
                </label>
              </p>
            </>
          ) : (
            <p>
              <label>
                {contents.kind === "quote" ? "Source book" : "Book (optional)"}{" "}
                <select
                  required={contents.kind === "quote"}
                  value={contents.bookId ?? ""}
                  onChange={(event) => optional("bookId", event.target.value)}
                >
                  <option value="">Choose a book</option>
                  {palace.books.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.title}
                      {entry.archived ? " (archived)" : ""}
                    </option>
                  ))}
                </select>
              </label>
            </p>
          )}
          {contents.kind === "quote" && (
            <p>
              <label>
                Page, chapter or section{" "}
                <input
                  maxLength={1000}
                  value={contents.location ?? ""}
                  onChange={(event) => optional("location", event.target.value)}
                />
              </label>
            </p>
          )}
          <button type="submit" aria-busy={palace.pending} disabled={!palace.draft.dirty}>
            {palace.pending ? "Saving..." : "Save"}
          </button>{" "}
          {palace.draft.command.expectedHash !== undefined && (
            <button
              type="button"
              disabled={palace.draft.dirty}
              onClick={() => void palace.archiveOrRestore()}
            >
              {contents.archived ? "Restore" : "Archive"}
            </button>
          )}
        </fieldset>
      </form>
      <p role="status">{palace.status}</p>
      {palace.error !== undefined && (
        <p role="alert">{palace.error}. Your local draft has been retained.</p>
      )}
      {palace.conflict !== undefined && (
        <aside aria-label="Saved version">
          <h2>Current saved version</h2>
          <pre style={{ whiteSpace: "pre-wrap" }}>{palace.conflict.body}</pre>
          <p>
            Your version remains in the writing field. Review both versions before editing again.
          </p>
          <button type="button" onClick={palace.keepReviewedEdits}>
            Keep my edits after reviewing both versions
          </button>{" "}
          <button type="button" onClick={() => void palace.loadSaved()}>
            Discard local edits and load saved version
          </button>
        </aside>
      )}
      {book !== undefined && (
        <p>
          Source:{" "}
          <button type="button" onClick={() => void palace.open(book.id)}>
            {book.title}
          </button>
          {contents.location === undefined ? "" : `, ${contents.location}`}
        </p>
      )}
      {contents.connections.length > 0 && (
        <div>
          <h2>Connections</h2>
          <ul>
            {contents.connections.map((connection, index) => (
              <li key={index}>
                <button type="button" onClick={() => void palace.open(connection.targetId)}>
                  {connection.relationship.replaceAll("_", " ")}:{" "}
                  {palace.entries.find((entry) => entry.id === connection.targetId)?.title ??
                    "Open entry"}
                </button>
                {connection.reason === undefined ? "" : `: ${connection.reason}`}
              </li>
            ))}
          </ul>
        </div>
      )}
      {contents.kind === "book" && (
        <div>
          <h2>Book notebook</h2>
          <ul>
            {palace.notebook.map((entry) => (
              <li key={entry.id}>
                <button type="button" onClick={() => void palace.open(entry.id)}>
                  {entry.kind}: {entry.title ?? entry.body.slice(0, 80)}
                </button>
                {entry.location === undefined ? "" : `, ${entry.location}`}
              </li>
            ))}
          </ul>
        </div>
      )}
      <h2>{palace.archived ? "Archived entries" : "Entries"}</h2>
      <ul>
        {palace.entries.map((entry) => (
          <li key={entry.id}>
            <button type="button" onClick={() => void palace.open(entry.id)}>
              {entry.title ?? (entry.body.slice(0, 80) || "Untitled entry")}
            </button>{" "}
            ({entry.kind}
            {entry.readingStatus === undefined ? "" : `, ${entry.readingStatus}`})
          </li>
        ))}
      </ul>
      {palace.nextCursor !== undefined && (
        <button type="button" onClick={() => void palace.loadMore()}>
          Load more
        </button>
      )}
    </section>
  );
}

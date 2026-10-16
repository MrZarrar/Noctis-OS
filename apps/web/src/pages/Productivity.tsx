import { Fragment, useEffect, useState, useRef } from "react";
import { motion } from "motion/react";
import { z } from "zod";
import {
  ReminderSchema,
  NoteSchema,
  ScheduledTaskSchema,
  TaskRunSchema,
  type Trigger,
  type Reminder,
  type Note,
  type ScheduledTask,
  type ModelRef,
} from "@noctis/contracts";
import { material, corner, semantic, spacing, typography, identityAccent } from "@noctis/ui";
import { Page, buttonStyle, fieldStyle, glass, SectionHeading } from "../layout/Page.js";
import { useArrivals, entrance, SETTLED } from "../layout/motion.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import type { RuntimeRootOption } from "../conversation/useConversation.js";
import { SnoozeChoices } from "./SnoozeChoices.js";
import { TaskPermissions } from "./TaskPermissions.js";
import {
  ownerDate,
  localToInstant,
  triggerLabel,
  searchNotes,
  compareReminders,
  reminderDueAt,
  reminderDueLabel,
} from "./productivity-view.js";

export type ProductivityPage = "Reminders" | "To-dos" | "Notes";
interface Props {
  focusId?: string;
  task?: boolean;
  transport: CoreTransport | undefined;
  page: ProductivityPage;
  roots?: readonly RuntimeRootOption[];
  models?: readonly ModelRef[];
  onOpenThread?: (id: string) => void;
}
const row = { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" } as const;
const card = {
  ...glass,
  display: "grid",
  gap: 12,
  padding: 16,
  border: `1px solid ${material.border}`,
  borderRadius: corner.md,
  background: material.fill,
  minWidth: 0,
  overflowWrap: "anywhere",
} as const;
const titleStyle = { margin: 0, fontSize: typography.scale.md, fontWeight: 600 } as const;
const metaStyle = { color: typography.color.muted, fontSize: typography.scale.sm } as const;
const previewStyle = {
  margin: 0,
  whiteSpace: "pre-wrap",
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 3,
  overflow: "hidden",
} as const;
interface Draft {
  id?: string;
  revision?: number;
  text: string;
  note: string;
  title: string;
  body: string;
  trigger: Trigger;
  name: string;
  prompt: string;
  identityId: "vesper" | "jester";
  model: number;
  root: number;
  threadMode: "new" | "continue";
  maxRunMinutes: number;
}
const blank = (): Draft => ({
  text: "",
  note: "",
  title: "",
  body: "",
  trigger: null,
  name: "",
  prompt: "",
  identityId: "vesper",
  model: 0,
  root: 0,
  threadMode: "new",
  maxRunMinutes: 30,
});
// Drafts live above page/panel remounts, scoped to the authenticated transport.
const drafts = new WeakMap<CoreTransport, Map<string, Draft>>();
function taskDraft(
  task: ScheduledTask,
  models: readonly ModelRef[],
  roots: readonly RuntimeRootOption[],
): Draft {
  const effective = { ...task, ...task.proposedUpdate };
  return {
    ...blank(),
    ...effective,
    model: models.findIndex(
      (m) => m.model === effective.model.model && m.providerId === effective.model.providerId,
    ),
    root: roots.findIndex(
      (r) => r.nodeId === effective.nodeId && r.grantId === effective.rootGrantId,
    ),
  };
}
function freshDraft(kind: string): Draft {
  return {
    ...blank(),
    trigger:
      kind === "tasks" || kind === "reminders"
        ? {
            kind: "repeat",
            rule: {
              kind: "weekly",
              daysOfWeek: [1, 2, 3, 4, 5],
              timeOfDay: "09:00",
              timeZone: "Europe/London",
            },
          }
        : null,
  };
}
function useDraft(transport: CoreTransport | undefined, key: string) {
  const [value, setValue] = useState<Draft>(() =>
    transport ? (drafts.get(transport)?.get(key) ?? freshDraft(key)) : freshDraft(key),
  );
  const set = (next: Draft) => {
    if (transport) {
      let cache = drafts.get(transport);
      if (!cache) {
        cache = new Map();
        drafts.set(transport, cache);
      }
      cache.set(key, next);
    }
    setValue(next);
  };
  return [value, set] as const;
}
export async function productivityCommand(
  transport: CoreTransport | undefined,
  name: string,
  payload: object,
): Promise<void> {
  if (!transport) throw new Error("Connect to the core to save changes.");
  const normalized = { ...payload } as Record<string, unknown>;
  const entity = name.split(".")[0];
  if ("id" in normalized) {
    normalized[`${entity}Id`] = normalized.id;
    delete normalized.id;
  }
  if (name === "note.update" || name === "reminder.update" || name === "task.update")
    delete normalized.identityId;
  const result = await transport.request("POST", `/commands/${name}`, {
    idempotencyKey: crypto.randomUUID(),
    ...normalized,
  });
  if (result.status !== 200) {
    const body = result.body as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? "The change was refused. Refresh and try again.");
  }
}
function TriggerFields({
  value,
  onChange,
  nodes,
  allowNone,
}: {
  allowNone: boolean;
  nodes: readonly { id: string; hostId: string }[];
  value: Trigger;
  onChange: (t: Trigger) => void;
}) {
  const [local, setLocal] = useState(() =>
    value?.kind === "at"
      ? new Intl.DateTimeFormat("sv-SE", {
          timeZone: "Europe/London",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        })
          .format(new Date(value.at))
          .replace(" ", "T")
      : "",
  );
  const [error, setError] = useState("");
  const mode = value === null ? "none" : value.kind === "repeat" ? value.rule.kind : value.kind;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <label>
        When
        <select
          aria-label="When"
          style={fieldStyle}
          value={mode}
          onChange={(e) => {
            setError("");
            const kind = e.target.value;
            onChange(
              kind === "none"
                ? null
                : kind === "at"
                  ? { kind: "at", at: new Date(Date.now() + 3600000).toISOString() }
                  : kind === "at_pc"
                    ? { kind: "at_pc", nodeId: nodes[0]?.id ?? "", repeat: false }
                    : kind === "interval"
                      ? { kind: "repeat", rule: { kind: "interval", hours: 24 } }
                      : {
                          kind: "repeat",
                          rule: {
                            kind: "weekly",
                            daysOfWeek: [1, 2, 3, 4, 5],
                            timeOfDay: "09:00",
                            timeZone: "Europe/London",
                          },
                        },
            );
          }}
        >
          {allowNone && <option value="none">No date (move to To-dos)</option>}
          <option value="at">At a time</option>
          <option value="weekly">Weekly</option>
          <option value="interval">Every few hours</option>
          <option value="at_pc">When I use a PC</option>
        </select>
      </label>
      {value?.kind === "at" && (
        <label>
          Date and time (Europe/London)
          <input
            aria-label="Date and time (Europe/London)"
            type="datetime-local"
            required
            style={fieldStyle}
            value={local}
            onChange={(e) => {
              setLocal(e.target.value);
              try {
                onChange({ kind: "at", at: localToInstant(e.target.value) });
                setError("");
                e.target.setCustomValidity("");
              } catch (err) {
                setError((err as Error).message);
                e.target.setCustomValidity((err as Error).message);
              }
            }}
          />
          <small>{triggerLabel(value)}</small>
        </label>
      )}
      {value?.kind === "repeat" && value.rule.kind === "weekly" && (
        <>
          <div style={row}>
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, index) => (
              <label key={day} style={{ ...row, minHeight: 44 }}>
                <input
                  type="checkbox"
                  checked={value.rule.kind === "weekly" && value.rule.daysOfWeek.includes(index)}
                  onChange={(e) => {
                    if (value.rule.kind === "weekly")
                      onChange({
                        ...value,
                        rule: {
                          ...value.rule,
                          daysOfWeek: e.target.checked
                            ? [...value.rule.daysOfWeek, index]
                            : value.rule.daysOfWeek.filter((d) => d !== index),
                        },
                      });
                  }}
                />
                {day}
              </label>
            ))}
          </div>
          <label>
            Time (Europe/London)
            <input
              type="time"
              required
              style={fieldStyle}
              value={value.rule.timeOfDay}
              onChange={(e) => {
                if (value.rule.kind === "weekly")
                  onChange({ ...value, rule: { ...value.rule, timeOfDay: e.target.value } });
              }}
            />
          </label>
        </>
      )}
      {value?.kind === "repeat" && value.rule.kind === "interval" && (
        <label>
          Every (hours)
          <input
            type="number"
            min="1"
            required
            style={fieldStyle}
            value={value.rule.hours}
            onChange={(e) =>
              onChange({ ...value, rule: { kind: "interval", hours: Number(e.target.value) } })
            }
          />
        </label>
      )}
      {value?.kind === "at_pc" && (
        <>
          <label>
            PC
            <select
              required
              style={fieldStyle}
              value={value.nodeId}
              onChange={(e) => onChange({ ...value, nodeId: e.target.value })}
            >
              <option value="">Choose a PC</option>
              {nodes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.hostId}
                </option>
              ))}
            </select>
          </label>
          <label style={{ ...row, minHeight: 44 }}>
            <input
              type="checkbox"
              checked={value.repeat}
              onChange={(e) => onChange({ ...value, repeat: e.target.checked })}
            />{" "}
            Every time my session is unlocked
          </label>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
/** The chosen view is lit and edged, like the navigation's current page. */
const tabStyle = (selected: boolean) =>
  selected
    ? {
        ...buttonStyle,
        color: identityAccent.vesper.primary,
        background: "rgba(91, 79, 224, 0.18)",
        border: `1px solid ${identityAccent.vesper.secondary}`,
        boxShadow: `inset 0 -2px 0 ${identityAccent.vesper.primary}`,
      }
    : buttonStyle;
export function Productivity(props: Props) {
  const [tab, setTab] = useState<"reminders" | "tasks">(props.task ? "tasks" : "reminders");
  return (
    <Page
      title={props.page}
      subtitle={
        props.page === "Notes"
          ? "Your notebook, saved in Noctis."
          : props.page === "To-dos"
            ? "A clear place for things still to do."
            : "The right thought, at the right time."
      }
      maxWidth={860}
    >
      {props.page === "Reminders" && (
        <div style={row} role="tablist" aria-label="Reminder views">
          <button
            style={tabStyle(tab === "reminders")}
            role="tab"
            aria-selected={tab === "reminders"}
            onClick={() => setTab("reminders")}
          >
            Reminders
          </button>
          <button
            style={tabStyle(tab === "tasks")}
            role="tab"
            aria-selected={tab === "tasks"}
            onClick={() => setTab("tasks")}
          >
            Scheduled tasks
          </button>
        </div>
      )}
      <ProductivityContent
        key={`${props.page}:${tab}`}
        {...props}
        kind={props.page === "Notes" ? "notes" : props.page === "To-dos" ? "todos" : tab}
      />
    </Page>
  );
}
function ProductivityContent({
  focusId,
  transport,
  page,
  kind,
  roots = [],
  models = [],
  onOpenThread,
}: Props & { kind: "notes" | "todos" | "reminders" | "tasks" }) {
  const [draft, setDraft] = useDraft(transport, kind);
  const [nodes, setNodes] = useState<readonly { id: string; hostId: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    void transport
      ?.request("GET", "/nodes")
      .then((r) => {
        const parsed = z
          .object({ nodes: z.array(z.object({ id: z.string(), hostId: z.string() })) })
          .safeParse(r.body);
        if (!cancelled && parsed.success) setNodes(parsed.data.nodes);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [transport]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  const editorRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (draft.id) editorRef.current?.querySelector("input")?.focus();
  }, [draft.id]);
  const [recentlyCompleted, setRecentlyCompleted] = useState<string>();
  const completedRef = useRef<HTMLElement>(null);
  const completionVisible = reminders.some(
    (r) => r.id === recentlyCompleted && r.status === "done",
  );
  useEffect(() => {
    if (!completionVisible) return;
    completedRef.current?.focus({ preventScroll: true });
    const timer = window.setTimeout(() => setRecentlyCompleted(undefined), 1600);
    return () => window.clearTimeout(timer);
  }, [recentlyCompleted, completionVisible]);
  const fresh = useArrivals(
    (kind === "notes" ? notes : kind === "tasks" ? tasks : reminders).map((r) => r.id),
    loaded ? transport : undefined,
  );
  const focused = useRef(false);
  useEffect(() => {
    if (!focusId || focused.current) return;
    const record =
      kind === "tasks"
        ? tasks.find((t) => t.id === focusId)
        : kind === "notes"
          ? notes.find((n) => n.id === focusId)
          : reminders.find((r) => r.id === focusId);
    if (!record) return;
    focused.current = true;
    if ("model" in record) setDraft(taskDraft(record, models, roots));
    else if ("text" in record)
      setDraft({ ...blank(), ...record, identityId: "vesper", note: record.note ?? "" });
    else setDraft({ ...blank(), ...record, identityId: "vesper" });
  }, [focusId, tasks, notes, reminders, models, roots]);
  const endpoint = kind === "todos" ? "reminders" : kind;
  useEffect(() => {
    let cancelled = false;
    if (!transport) return;
    void transport
      .request("GET", `/${endpoint}`)
      .then((response) => {
        if (cancelled) return;
        if (response.status !== 200) throw new Error("Could not load this list.");
        if (endpoint === "notes")
          setNotes(z.object({ notes: z.array(NoteSchema) }).parse(response.body).notes);
        else if (endpoint === "tasks")
          setTasks(z.object({ tasks: z.array(ScheduledTaskSchema) }).parse(response.body).tasks);
        else
          setReminders(
            z.object({ reminders: z.array(ReminderSchema) }).parse(response.body).reminders,
          );
        setLoaded(true);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load this list.");
      });
    return () => {
      cancelled = true;
    };
  }, [transport, endpoint, revision]);
  async function command(name: string, payload: object, reset = false) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await productivityCommand(transport, name, payload);
      if (name === "reminder.complete" && "id" in payload && typeof payload.id === "string")
        setRecentlyCompleted(payload.id);
      if (reset) setDraft(freshDraft(kind));
      setRevision((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const existing = draft.id ? { id: draft.id, expectedRevision: draft.revision } : {};
  const update = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const agenda = reminders
    .filter((r) => (kind === "todos" ? r.trigger === null : r.trigger !== null))
    .sort(compareReminders);
  const editor = (
    <form
      ref={editorRef}
      aria-label={draft.id ? "Edit record" : "New record"}
      style={{
        display: "grid",
        gap: spacing.md,
        paddingBlock: spacing.md,
        borderTop: `1px solid ${material.border}`,
        minWidth: 0,
      }}
      onSubmit={(e) => {
        e.preventDefault();
        const suffix = draft.id ? "update" : "create";
        if (kind === "notes")
          void command(
            `note.${suffix}`,
            { ...existing, title: draft.title, body: draft.body },
            true,
          );
        else if (kind === "tasks") {
          const root = roots[draft.root],
            model = models[draft.model];
          if (!root || !model) {
            setError("Choose an available model and shared folder.");
            return;
          }
          void command(
            `task.${suffix}`,
            {
              ...existing,
              name: draft.name,
              prompt: draft.prompt,
              identityId: draft.identityId,
              model,
              nodeId: root.nodeId,
              rootGrantId: root.grantId,
              trigger: draft.trigger,
              threadMode: draft.threadMode,
              maxRunMinutes: draft.maxRunMinutes,
            },
            true,
          );
        } else
          void command(
            `reminder.${suffix}`,
            {
              ...existing,
              text: draft.text,
              note: draft.note,
              trigger: kind === "todos" ? null : draft.trigger,
            },
            true,
          );
      }}
    >
      <h2 style={{ ...titleStyle, color: typography.color.muted }}>
        {draft.id
          ? "Edit"
          : kind === "tasks"
            ? "Create a scheduled task"
            : kind === "notes"
              ? "Capture a note"
              : `Add ${kind === "todos" ? "a to-do" : "a reminder"}`}
      </h2>
      {kind === "notes" ? (
        <>
          <label>
            Title
            <input
              required
              maxLength={200}
              style={fieldStyle}
              value={draft.title}
              onChange={(e) => update({ title: e.target.value })}
            />
          </label>
          <label>
            Note
            <textarea
              aria-label="Note"
              required
              rows={5}
              style={{ ...fieldStyle, padding: 12 }}
              value={draft.body}
              onChange={(e) => update({ body: e.target.value })}
            />
          </label>
        </>
      ) : kind === "tasks" ? (
        <>
          <label>
            Task name
            <input
              required
              style={fieldStyle}
              value={draft.name}
              onChange={(e) => update({ name: e.target.value })}
            />
          </label>
          <label>
            Prompt
            <textarea
              aria-label="Prompt"
              required
              rows={3}
              style={{ ...fieldStyle, padding: 12 }}
              value={draft.prompt}
              onChange={(e) => update({ prompt: e.target.value })}
            />
          </label>
          <label>
            Model
            <select
              required
              style={fieldStyle}
              value={draft.model}
              onChange={(e) => update({ model: Number(e.target.value) })}
            >
              {models.map((m, i) => (
                <option key={i} value={i}>
                  {m.label ?? m.model}
                </option>
              ))}
            </select>
          </label>
          <label>
            PC and shared folder
            <select
              required
              style={fieldStyle}
              value={draft.root}
              onChange={(e) => update({ root: Number(e.target.value) })}
            >
              {roots.map((r, i) => (
                <option key={i} value={i}>
                  {r.hostId}: {r.path}
                </option>
              ))}
            </select>
          </label>
          <label>
            Each run
            <select
              style={fieldStyle}
              value={draft.threadMode}
              onChange={(e) => update({ threadMode: e.target.value as Draft["threadMode"] })}
            >
              <option value="new">Start a new thread</option>
              <option value="continue">Continue the same thread</option>
            </select>
          </label>
          <label>
            Maximum minutes
            <input
              required
              type="number"
              min="1"
              max="240"
              style={fieldStyle}
              value={draft.maxRunMinutes}
              onChange={(e) => update({ maxRunMinutes: Number(e.target.value) })}
            />
          </label>
        </>
      ) : (
        <>
          <label>
            {kind === "todos" ? "To-do" : "Reminder"}
            <input
              required
              style={fieldStyle}
              value={draft.text}
              onChange={(e) => update({ text: e.target.value })}
            />
          </label>
          <label>
            Extra note (optional)
            <textarea
              aria-label="Extra note (optional)"
              rows={2}
              style={{ ...fieldStyle, padding: 12 }}
              value={draft.note}
              onChange={(e) => update({ note: e.target.value })}
            />
          </label>
        </>
      )}
      {(kind === "reminders" || kind === "tasks") && (
        <TriggerFields
          key={`${draft.id ?? "new"}:${draft.trigger?.kind ?? "none"}`}
          value={draft.trigger}
          onChange={(trigger) => update({ trigger })}
          nodes={
            nodes.length
              ? nodes
              : [
                  ...new Map(
                    roots.map((r) => [r.nodeId, { id: r.nodeId, hostId: r.hostId }]),
                  ).values(),
                ]
          }
          allowNone={kind !== "tasks"}
        />
      )}
      {kind === "tasks" && (
        <label>
          Runs as
          <select
            style={fieldStyle}
            disabled={draft.id !== undefined}
            value={draft.identityId}
            onChange={(e) => update({ identityId: e.target.value as Draft["identityId"] })}
          >
            <option value="vesper">Vesper</option>
            <option value="jester">Jester</option>
          </select>
        </label>
      )}
      {kind === "tasks" && !draft.id && (
        <p style={{ margin: 0, color: typography.color.muted }}>
          Saved paused. Review it, then Turn on when you are ready.
        </p>
      )}
      <div style={row}>
        <button disabled={busy || !transport} style={buttonStyle}>
          {busy
            ? "Saving..."
            : draft.id
              ? "Save changes"
              : kind === "notes"
                ? "Save note"
                : kind === "tasks"
                  ? "Create paused task"
                  : kind === "todos"
                    ? "Add to-do"
                    : "Add reminder"}
        </button>
        {draft.id && (
          <button type="button" style={buttonStyle} onClick={() => setDraft(freshDraft(kind))}>
            Cancel edit
          </button>
        )}
      </div>
    </form>
  );
  return (
    <>
      {error && (
        <p role="alert" style={{ color: semantic.error }}>
          {error}
        </p>
      )}
      {kind === "notes" && (
        <label>
          Search notes
          <input
            type="search"
            style={fieldStyle}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      )}
      <div aria-label={`${page} list`} style={{ display: "grid", gap: spacing.md, minWidth: 0 }}>
        <SectionHeading>
          {kind === "tasks" ? "Scheduled tasks" : kind === "reminders" ? "Agenda" : page}
        </SectionHeading>
        {kind === "notes"
          ? searchNotes(notes, query).map((n) => (
              <motion.article
                key={n.id}
                initial={entrance(fresh, n.id)}
                animate={SETTLED}
                style={{
                  ...card,
                  borderLeft:
                    draft.id === n.id ? `3px solid ${identityAccent.vesper.primary}` : card.border,
                }}
              >
                <h2 style={{ ...titleStyle, fontSize: typography.scale.lg }}>{n.title}</h2>
                {draft.id !== n.id && <p style={previewStyle}>{n.body}</p>}
                <small style={metaStyle}>
                  {n.identityId ?? "You"} · {ownerDate(n.updatedAt)}
                </small>
                {draft.id === n.id ? (
                  editor
                ) : (
                  <div style={row}>
                    <button
                      style={buttonStyle}
                      onClick={() => setDraft({ ...blank(), ...n, identityId: "vesper" })}
                    >
                      Edit
                    </button>
                    <button
                      disabled={busy}
                      style={buttonStyle}
                      onClick={() =>
                        void command("note.delete", { id: n.id, expectedRevision: n.revision })
                      }
                    >
                      Delete
                    </button>
                  </div>
                )}
              </motion.article>
            ))
          : kind === "tasks"
            ? tasks.map((t) => (
                <motion.article
                  key={t.id}
                  initial={entrance(fresh, t.id)}
                  animate={SETTLED}
                  style={card}
                >
                  <div style={{ ...row, justifyContent: "space-between" }}>
                    <h2 style={titleStyle}>{t.name}</h2>
                    <span style={{ ...metaStyle, ...row, gap: spacing.xs }}>
                      <span aria-hidden="true">{t.paused ? "Ⅱ" : "●"}</span>
                      {t.paused ? "Paused" : "On"}
                    </span>
                  </div>
                  {t.proposedUpdate && (
                    <strong style={{ color: semantic.warning }}>
                      <span aria-hidden="true">◇ </span>Suggested changes
                    </strong>
                  )}
                  <p style={previewStyle}>{t.prompt}</p>
                  <small style={metaStyle}>
                    {triggerLabel(t.trigger)} · {t.identityId}
                  </small>
                  <small style={metaStyle}>
                    {t.model.model} ·{" "}
                    {roots.find((r) => r.grantId === t.rootGrantId)?.path ?? t.rootGrantId} ·{" "}
                    {t.maxRunMinutes} minute limit
                  </small>
                  {t.proposedUpdate && (
                    <section
                      aria-label="Suggested task changes"
                      style={{ borderLeft: "2px solid " + material.border, paddingLeft: 12 }}
                    >
                      <h3>Suggested changes</h3>
                      <p>Your current task keeps running unchanged until you save these changes.</p>
                      <dl>
                        <dt>Current prompt</dt>
                        <dd>{t.prompt}</dd>
                        <dt>Suggested prompt</dt>
                        <dd>{t.proposedUpdate.prompt}</dd>
                        <dt>Current schedule</dt>
                        <dd>{triggerLabel(t.trigger)}</dd>
                        <dt>Suggested schedule</dt>
                        <dd>{triggerLabel(t.proposedUpdate.trigger)}</dd>
                        <dt>Suggested model and folder</dt>
                        <dd>
                          {t.proposedUpdate.model.model}, {t.proposedUpdate.nodeId},{" "}
                          {t.proposedUpdate.rootGrantId}
                        </dd>
                      </dl>
                      <button
                        style={buttonStyle}
                        onClick={() => setDraft(taskDraft(t, models, roots))}
                      >
                        Review suggested changes
                      </button>
                    </section>
                  )}
                  <div style={row}>
                    <button
                      disabled={busy}
                      style={buttonStyle}
                      onClick={() =>
                        void command(t.paused ? "task.resume" : "task.pause", {
                          id: t.id,
                          expectedRevision: t.revision,
                        })
                      }
                    >
                      {t.paused ? "Turn on" : "Pause"}
                    </button>
                    <button
                      disabled={busy || t.paused}
                      style={buttonStyle}
                      onClick={() =>
                        void command("task.run_now", { id: t.id, expectedRevision: t.revision })
                      }
                    >
                      Run now
                    </button>
                    <button
                      style={buttonStyle}
                      onClick={() => setDraft(taskDraft(t, models, roots))}
                    >
                      Edit
                    </button>
                    <button
                      disabled={busy}
                      style={buttonStyle}
                      onClick={() =>
                        void command("task.delete", { id: t.id, expectedRevision: t.revision })
                      }
                    >
                      Delete
                    </button>
                  </div>
                  <TaskPermissions
                    key={`${t.id}:${t.revision}`}
                    transport={transport}
                    taskId={t.id}
                    actorId={t.identityId}
                  />
                  <RunHistory
                    transport={transport}
                    taskId={t.id}
                    revision={revision}
                    onOpenThread={onOpenThread}
                  />
                </motion.article>
              ))
            : agenda.map((r, index) => {
                const dueLabel = reminderDueLabel(r, now);
                const dueAt = reminderDueAt(r);
                const quiet = r.status === "done" || r.status === "snoozed";
                const urgent =
                  dueLabel === "Overdue" || dueLabel === "Due now" || dueLabel === "Due soon";
                const acknowledged = r.status === "done" && r.id === recentlyCompleted;
                return (
                  <Fragment key={r.id}>
                    {r.status === "done" && agenda[index - 1]?.status !== "done" && (
                      <SectionHeading>Done</SectionHeading>
                    )}
                    <motion.article
                      key={r.id}
                      ref={acknowledged ? completedRef : undefined}
                      tabIndex={-1}
                      initial={entrance(fresh, r.id)}
                      animate={SETTLED}
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: spacing.md,
                        minWidth: 0,
                        padding: kind === "todos" ? spacing.md : spacing.lg,
                        border: `1px ${r.status === "snoozed" ? "dashed" : "solid"} ${acknowledged ? semantic.success : material.border}`,
                        borderRadius: corner.md,
                        background: acknowledged
                          ? material.fillElevated
                          : quiet
                            ? "transparent"
                            : material.fill,
                      }}
                    >
                      {kind !== "todos" && (
                        <div
                          style={{
                            flex: "0 1 7rem",
                            display: "grid",
                            alignContent: "start",
                            gap: spacing.xs,
                          }}
                        >
                          <strong
                            style={{
                              color: urgent ? semantic.warning : typography.color.primary,
                              fontSize: typography.scale.sm,
                            }}
                          >
                            <span aria-hidden="true">
                              {r.status === "done"
                                ? "✓"
                                : r.status === "snoozed"
                                  ? "◷"
                                  : urgent
                                    ? "!"
                                    : "○"}{" "}
                            </span>
                            {dueLabel === "snoozed"
                              ? "Snoozed"
                              : dueLabel === "done"
                                ? "Done"
                                : dueLabel}
                          </strong>
                          {dueAt && !r.snoozedUntilPcId && r.status !== "done" && (
                            <time
                              dateTime={dueAt}
                              style={{ ...metaStyle, fontVariantNumeric: "tabular-nums" }}
                            >
                              {r.status === "due" && Date.parse(dueAt) > now && "Next due: "}
                              {ownerDate(dueAt)}
                            </time>
                          )}
                        </div>
                      )}
                      <div
                        style={{
                          display: "grid",
                          gap: spacing.sm,
                          flex: "1 1 14rem",
                          minWidth: 0,
                          overflowWrap: "anywhere",
                        }}
                      >
                        <div style={{ display: "flex", gap: spacing.sm, alignItems: "baseline" }}>
                          {kind === "todos" && (
                            <span aria-hidden="true">{r.status === "done" ? "☑" : "□"}</span>
                          )}
                          <strong
                            style={{
                              ...titleStyle,
                              minWidth: 0,
                              color:
                                quiet && !acknowledged
                                  ? typography.color.muted
                                  : typography.color.primary,
                            }}
                          >
                            {r.text}
                          </strong>
                        </div>
                        {acknowledged && (
                          <motion.p
                            key="completion"
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            role="status"
                            style={{ margin: 0, color: semantic.success }}
                          >
                            ✓ Completed
                          </motion.p>
                        )}
                        {r.note && <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{r.note}</p>}
                        <small style={metaStyle}>
                          {r.status} ·{" "}
                          {r.snoozedUntilPcId
                            ? `Next time at ${nodes.find((n) => n.id === r.snoozedUntilPcId)?.hostId ?? r.snoozedUntilPcId}`
                            : r.status === "snoozed" && r.nextDueAt
                              ? ownerDate(r.nextDueAt)
                              : triggerLabel(r.trigger)}{" "}
                          · {r.identityId ?? "You"}
                        </small>
                        <div style={row}>
                          {r.status !== "done" && (
                            <>
                              <button
                                disabled={busy}
                                style={buttonStyle}
                                onClick={() =>
                                  void command("reminder.complete", {
                                    id: r.id,
                                    expectedRevision: r.revision,
                                  })
                                }
                              >
                                Done
                              </button>
                              {kind !== "todos" && (
                                <>
                                  {" "}
                                  <button
                                    disabled={busy}
                                    style={buttonStyle}
                                    onClick={() =>
                                      void command("reminder.snooze", {
                                        id: r.id,
                                        expectedRevision: r.revision,
                                        until: new Date(Date.now() + 3600000).toISOString(),
                                      })
                                    }
                                  >
                                    Snooze 1 hour
                                  </button>
                                  <SnoozeChoices
                                    disabled={busy}
                                    nodes={nodes}
                                    onSnooze={(until) =>
                                      void command("reminder.snooze", {
                                        id: r.id,
                                        expectedRevision: r.revision,
                                        until,
                                      })
                                    }
                                    onPc={(atPcNodeId) =>
                                      void command("reminder.snooze", {
                                        id: r.id,
                                        expectedRevision: r.revision,
                                        atPcNodeId,
                                      })
                                    }
                                  />
                                </>
                              )}
                            </>
                          )}
                          <button
                            style={buttonStyle}
                            onClick={() =>
                              setDraft({
                                ...blank(),
                                ...r,
                                identityId: "vesper",
                                note: r.note ?? "",
                              })
                            }
                          >
                            Edit
                          </button>
                          <button
                            disabled={busy}
                            style={buttonStyle}
                            onClick={() =>
                              void command("reminder.delete", {
                                id: r.id,
                                expectedRevision: r.revision,
                              })
                            }
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    </motion.article>
                  </Fragment>
                );
              })}
      </div>
      {!(kind === "notes" && searchNotes(notes, query).some((n) => n.id === draft.id)) && editor}
    </>
  );
}
function RunHistory({
  transport,
  taskId,
  revision,
  onOpenThread,
}: {
  transport: CoreTransport | undefined;
  taskId: string;
  revision: number;
  onOpenThread: ((id: string) => void) | undefined;
}) {
  const [runs, setRuns] = useState<z.infer<typeof TaskRunSchema>[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const fresh = useArrivals(
    runs.map((r) => r.id),
    loaded ? taskId : undefined,
  );
  useEffect(() => {
    let cancelled = false;
    void transport
      ?.request("GET", `/tasks/${taskId}/runs`)
      .then((r) => {
        if (!cancelled) {
          setRuns(z.object({ runs: z.array(TaskRunSchema) }).parse(r.body).runs);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Could not load run history.");
      });
    return () => {
      cancelled = true;
    };
  }, [transport, taskId, revision]);
  return (
    <details>
      <summary style={{ cursor: "pointer", minHeight: 44 }}>Run history ({runs.length})</summary>
      {error && <p role="alert">{error}</p>}
      {runs.length === 0 && <p>No runs yet.</p>}
      {runs.map((r) => (
        <motion.article
          key={r.id}
          initial={entrance(fresh, r.id)}
          animate={SETTLED}
          style={{
            display: "grid",
            gap: spacing.sm,
            paddingBlock: spacing.md,
            borderTop: `1px solid ${material.border}`,
            borderLeft: `2px solid ${material.highlight}`,
            paddingLeft: spacing.md,
            minWidth: 0,
          }}
        >
          <div style={{ ...row, justifyContent: "space-between" }}>
            <strong>
              <span aria-hidden="true">
                {
                  { completed: "✓", running: "○", failed: "!", needs_you: "◇", skipped: "–" }[
                    r.status
                  ]
                }{" "}
              </span>
              {r.status.replaceAll("_", " ")}
            </strong>
            <time dateTime={r.startedAt} style={metaStyle}>
              {ownerDate(r.startedAt)}
            </time>
          </div>
          {r.reason && <p style={{ margin: 0 }}>{r.reason}</p>}
          {r.result && <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{r.result}</p>}
          {r.threadId && onOpenThread && (
            <button style={buttonStyle} onClick={() => onOpenThread(r.threadId!)}>
              Open thread
            </button>
          )}
        </motion.article>
      ))}
    </details>
  );
}

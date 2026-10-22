import type {
  ApprovalRecord,
  AttentionState,
  ConversationThread,
  ConversationalIdentityId,
  ModelRef,
  OrchestrationEvent,
  RuntimeItem,
  ServerFrame,
  SurfaceIntent,
  SurfaceOwner,
} from "@noctis/contracts";
import { ApprovalRecordSchema, AttentionStateSchema } from "@noctis/contracts";
import { compose, createIdFactory, systemClock } from "@noctis/domain";

import type { Message, Turn } from "../conversation/useConversation.js";
import type { CoreMethod, CoreResponse, SubscribeOptions } from "../transport/CoreTransport.js";
import { ok, parsePath, rebase } from "./area.js";
import conversationsFixture from "./fixtures/conversations.json" with { type: "json" };
import script from "./fixtures/script.json" with { type: "json" };
import { setHardwareLoad } from "./hardware.js";
import { LARP_IDS } from "./ids.js";

/**
 * LARP mode's stand-in for the core's conversation side: threads, turns,
 * approvals, Presence panels and the event ledger, all in memory.
 *
 * It answers with the core's own shapes and emits the core's own events and
 * token deltas, so every page reacts exactly as it would to a live core. The
 * scripted replies and the demo task live in `fixtures/script.json`.
 */

type Agent = "vesper" | "claude" | "codex";
type Step = (typeof script.demoTask.steps)[number] & { command?: string; output?: string };
type FixtureTurn = Omit<Turn, "threadId" | "identityId" | "model"> & { model: string };

export interface LarpCoreOptions {
  /** Shows an OS notification; the browser wires this to the service worker. */
  notify?: (title: string, body: string, url: string) => void;
  /** `approval` starts with the demo task already waiting on the owner (a tapped notification). */
  seed?: "approval";
}

export interface LarpCore {
  request: (method: CoreMethod, path: string, body: unknown) => CoreResponse | undefined;
  subscribe: (options: SubscribeOptions) => () => void;
  /** The phone shot: the demo approval, fast-forwarded, raised after a delay. */
  raiseApprovalIn: (ms: number) => void;
}

const HOME = { nodeId: LARP_IDS.homeNode, hostId: "Home PC" } as const;
const AWAKE_MS = 8 * 3_600_000;
const NOT_FOUND = { status: 404, body: { error: { code: "not_found", message: "Not found" } } };

export function createLarpCore(options: LarpCoreOptions = {}): LarpCore {
  const ids = createIdFactory(systemClock);
  const fixture = rebase(conversationsFixture);
  const models = fixture.models as Record<string, ModelRef>;
  const iso = (): string => new Date().toISOString();

  let sequence = 0;
  const ledger: OrchestrationEvent[] = [];
  const listeners = new Set<SubscribeOptions>();
  let activeIdentity: ConversationalIdentityId = "vesper";
  const threads = new Map<string, ConversationThread>();
  const messages = new Map<string, Message[]>();
  const turns = new Map<string, Turn[]>();
  const approvals: ApprovalRecord[] = ApprovalRecordSchema.array().parse(fixture.approvals);
  const intents: SurfaceIntent[] = [];
  const free: Record<ConversationalIdentityId, string> = {
    vesper: LARP_IDS.vesperThread,
    jester: LARP_IDS.jesterThread,
  };
  const cycles = new Map<string, number>();
  /** What a confirmed approval resumes, by approval id. */
  const continuations = new Map<string, () => void>();
  const cancelled = new Set<string>();
  const panelSources = new Map<string, string>();

  const timeline = fixture.threads.flatMap((entry) => entry.thread.createdAt).sort();
  for (const [identityId, id] of Object.entries(free)) {
    addThread({
      id,
      identityId: identityId as ConversationalIdentityId,
      kind: "free",
      revision: 1,
      createdAt: timeline[0] ?? iso(),
      updatedAt: timeline[0] ?? iso(),
    });
  }
  for (const entry of fixture.threads) {
    const thread = entry.thread as ConversationThread;
    addThread(thread);
    messages.set(
      thread.id,
      entry.messages.map((message) => ({ ...(message as Message), threadId: thread.id })),
    );
    turns.set(
      thread.id,
      (entry.turns as FixtureTurn[]).map((turn) => ({
        ...turn,
        threadId: thread.id,
        identityId: thread.identityId,
        model: models[turn.model] ?? models.claude!,
      })),
    );
  }

  function addThread(thread: ConversationThread): void {
    threads.set(thread.id, thread);
    messages.set(thread.id, messages.get(thread.id) ?? []);
    turns.set(thread.id, turns.get(thread.id) ?? []);
  }

  function emit(
    streamType: OrchestrationEvent["streamType"],
    streamId: string,
    type: OrchestrationEvent["type"],
    payload: unknown,
  ): void {
    sequence += 1;
    const event: OrchestrationEvent = {
      id: ids.nextId(),
      sequence,
      streamType,
      streamId,
      type,
      actorType: "system",
      actorId: "noctis",
      payloadVersion: 1,
      payload,
      correlationId: ids.nextId(),
      occurredAt: iso(),
    };
    ledger.push(event);
    for (const listener of listeners) {
      void Promise.resolve().then(() => listener.onEvent(event));
    }
  }

  function frame(threadId: string, jobId: string, itemId: string, text: string): void {
    const delta: ServerFrame = {
      kind: "runtime_delta",
      envelopeVersion: 1,
      threadId,
      jobId,
      itemId,
      text,
    };
    for (const listener of listeners) {
      void Promise.resolve().then(() => listener.onFrame?.(delta));
    }
  }

  const later = (ms: number, run: () => void): void => {
    setTimeout(run, ms);
  };

  // --- threads, messages, turns -------------------------------------------

  function touch(threadId: string): void {
    const thread = threads.get(threadId);
    if (thread !== undefined) {
      threads.set(threadId, { ...thread, revision: thread.revision + 1, updatedAt: iso() });
    }
  }

  function addMessage(
    threadId: string,
    role: Message["role"],
    body: string,
    itemId?: string,
  ): Message {
    const message: Message = { id: ids.nextId(), threadId, role, body, createdAt: iso() };
    messages.get(threadId)?.push(message);
    touch(threadId);
    emit("identity", threadId, "identity.message_added.v1", {
      messageId: message.id,
      role,
      ...(itemId === undefined ? {} : { itemId }),
    });
    return message;
  }

  function startTurn(
    thread: ConversationThread,
    userMessageId: string,
    model: ModelRef,
    nodeId?: string,
  ): Turn {
    const turn: Turn = {
      id: ids.nextId(),
      threadId: thread.id,
      identityId: thread.identityId,
      userMessageId,
      jobId: ids.nextId(),
      ...(nodeId === undefined ? {} : { nodeId }),
      model,
      status: "queued",
      items: [],
      startedAt: iso(),
    };
    turns.get(thread.id)?.push(turn);
    emit("identity", thread.id, "identity.turn_started.v1", { turnId: turn.id, jobId: turn.jobId });
    return turn;
  }

  function findTurn(turnId: string): Turn | undefined {
    for (const list of turns.values()) {
      const turn = list.find((candidate) => candidate.id === turnId);
      if (turn !== undefined) return turn;
    }
    return undefined;
  }

  function putItem(turn: Turn, item: RuntimeItem): void {
    const index = turn.items.findIndex((existing) => existing.itemId === item.itemId);
    if (index === -1) turn.items.push(item);
    else turn.items[index] = item;
    if (turn.status === "queued") turn.status = "running";
    emit("identity", turn.threadId, "identity.turn_item.v1", { turnId: turn.id, item });
  }

  function finishTurn(turn: Turn, replyMessageId?: string): void {
    if (cancelled.has(turn.id)) return;
    turn.status = "completed";
    turn.completedAt = iso();
    if (replyMessageId !== undefined) turn.replyMessageId = replyMessageId;
    emit("identity", turn.threadId, "identity.turn_completed.v1", {
      turnId: turn.id,
      status: "completed",
    });
  }

  /** Streams `text` as one agent message on the turn, then commits it. */
  function speak(turn: Turn, text: string, done: (message: Message) => void): void {
    const itemId = `msg-${ids.nextId()}`;
    const { charsPerSecond, settleMs } = script.typing;
    let at = 0;
    for (let start = 0; start < text.length;) {
      const size = 2 + ((start * 7) % 5);
      const chunk = text.slice(start, start + size);
      at += (chunk.length / charsPerSecond) * 1000;
      start += size;
      later(at, () => {
        if (!cancelled.has(turn.id)) frame(turn.threadId, turn.jobId ?? "", itemId, chunk);
      });
    }
    later(at + settleMs, () => {
      if (cancelled.has(turn.id)) return;
      putItem(turn, { itemId, kind: "agent_message", status: "completed", text });
      done(addMessage(turn.threadId, "identity", text, itemId));
    });
  }

  function nextLine(key: string, lines: readonly string[]): string {
    const index = cycles.get(key) ?? 0;
    cycles.set(key, index + 1);
    return lines[index % lines.length] ?? "";
  }

  const matches = (text: string, phrases: readonly string[]): boolean =>
    phrases.some((phrase) => text.toLowerCase().includes(phrase.toLowerCase()));

  function reply(turn: Turn, text: string, after?: () => void): void {
    later(script.typing.thinkMs, () => {
      if (cancelled.has(turn.id)) return;
      if (turn.status === "queued") turn.status = "running";
      speak(turn, text, (message) => {
        after?.();
        finishTurn(turn, message.id);
      });
    });
  }

  // --- the send -----------------------------------------------------------

  function send(body: Record<string, unknown>): CoreResponse {
    const identityId = body.identityId === "jester" ? "jester" : "vesper";
    const text = typeof body.text === "string" ? body.text : "";
    const thread = threads.get(
      typeof body.threadId === "string" ? body.threadId : free[identityId],
    );
    if (thread === undefined) return NOT_FOUND;

    const user = addMessage(thread.id, "user", text);
    const model =
      (body.model as ModelRef | undefined) ??
      (identityId === "jester" ? models.hermes! : models.claude!);
    const turn = startTurn(thread, user.id, model, HOME.nodeId);
    const vesper = script.vesper;

    if (identityId === "jester") {
      const takeover = matches(text, script.jester.takeover.match);
      reply(
        turn,
        takeover
          ? nextLine("jester.takeover", script.jester.takeover.replies)
          : nextLine("jester.fallback", script.jester.fallback),
      );
    } else if (matches(text, vesper.wake.match)) {
      reply(turn, nextLine("vesper.wake", vesper.wake.replies));
    } else if (matches(text, vesper.benchmark.match)) {
      setHardwareLoad(true);
      later(vesper.benchmark.loadMs, () => setHardwareLoad(false));
      reply(turn, nextLine("vesper.benchmark", vesper.benchmark.replies));
    } else if (matches(text, vesper.panels.match)) {
      reply(turn, nextLine("vesper.panels", vesper.panels.replies));
      later(script.typing.thinkMs + 600, () => {
        vesper.panels.panels.forEach((panel, index) => {
          later(index * vesper.panels.intervalMs, () => openPresencePanel(panel));
        });
      });
    } else if (matches(text, script.demoTask.match)) {
      runDemoTask(thread, turn, false);
    } else {
      reply(turn, nextLine("vesper.fallback", vesper.fallback));
    }

    return ok(turn);
  }

  // --- the demo task ------------------------------------------------------

  function runDemoTask(thread: ConversationThread, main: Turn, instant: boolean): void {
    const task = script.demoTask;
    const children = new Map<Agent, { turn: Turn; agentItemId: string; lastMessageId?: string }>();
    const startedAt = Date.now();
    const turnOf = (agent: Agent): Turn | undefined =>
      agent === "vesper" ? main : children.get(agent)?.turn;

    function activity(agent: Agent, line: string): void {
      const child = children.get(agent);
      const item = main.items.find((candidate) => candidate.itemId === child?.agentItemId);
      if (item?.kind === "sub_agent" && item.status === "in_progress") {
        putItem(main, { ...item, activity: line.slice(0, 200) });
      }
    }

    function mirror(agent: Agent, item: RuntimeItem): void {
      const turn = turnOf(agent);
      if (turn === undefined) return;
      putItem(turn, item);
      const child = children.get(agent);
      if (child !== undefined) putItem(main, { ...item, parentItemId: child.agentItemId });
    }

    function run(step: Step): void {
      if (cancelled.has(main.id)) return;
      const agent = step.agent as Agent;
      const turn = turnOf(agent);

      if ("start" in step && agent !== "vesper") {
        const spec = task.agents[agent];
        const child: ConversationThread = {
          id: ids.nextId(),
          identityId: "vesper",
          parentThreadId: thread.id,
          parentTurnId: main.id,
          kind: "free",
          title: spec.label,
          nodeId: HOME.nodeId,
          providerId: agent,
          revision: 1,
          createdAt: iso(),
          updatedAt: iso(),
        };
        addThread(child);
        const prompt = addMessage(child.id, "user", spec.task);
        const agentItemId = `agent-${agent}-${main.id}`;
        putItem(main, {
          itemId: agentItemId,
          kind: "sub_agent",
          status: "in_progress",
          label: spec.label,
          task: spec.task,
          activity: "Reading the code",
        });
        children.set(agent, {
          turn: startTurn(child, prompt.id, models[agent]!, HOME.nodeId),
          agentItemId,
        });
        return;
      }
      if (turn === undefined) return;

      if ("say" in step && step.say !== undefined) {
        activity(agent, "Writing");
        if (instant) {
          const itemId = `msg-${ids.nextId()}`;
          putItem(turn, { itemId, kind: "agent_message", status: "completed", text: step.say });
          const message = addMessage(turn.threadId, "identity", step.say, itemId);
          const child = children.get(agent);
          if (child !== undefined) child.lastMessageId = message.id;
        } else {
          speak(turn, step.say, (message) => {
            const child = children.get(agent);
            if (child !== undefined) child.lastMessageId = message.id;
          });
        }
        return;
      }

      if ("command" in step && step.command !== undefined) {
        const itemId = `cmd-${ids.nextId()}`;
        const command = {
          itemId,
          kind: "command",
          command: step.command,
          cwd: "~/projects/noctis",
        } as const;
        activity(agent, `Running ${step.command}`);
        const complete = (): void =>
          mirror(agent, {
            ...command,
            status: step.exitCode === 0 ? "completed" : "failed",
            ...(step.output === undefined ? {} : { output: step.output }),
            exitCode: step.exitCode ?? 0,
          });
        if (instant) {
          complete();
        } else {
          mirror(agent, { ...command, status: "in_progress" });
          later(step.durationMs ?? 1500, complete);
        }
        return;
      }

      if ("file" in step && step.file !== undefined) {
        const item = {
          itemId: `file-${ids.nextId()}`,
          kind: "file_change",
          paths: step.file,
          ...(step.summary === undefined ? {} : { summary: step.summary }),
        } as const;
        activity(agent, `Editing ${step.file[0]?.split("/").at(-1) ?? "files"}`);
        if (instant) {
          mirror(agent, { ...item, status: "completed" });
        } else {
          mirror(agent, { ...item, status: "in_progress" });
          later(700, () => mirror(agent, { ...item, status: "completed" }));
        }
        return;
      }

      if ("done" in step) {
        const child = children.get(agent);
        if (child === undefined) {
          finishTurn(main, messages.get(thread.id)?.at(-1)?.id);
          return;
        }
        finishTurn(child.turn, child.lastMessageId);
        const item = main.items.find((candidate) => candidate.itemId === child.agentItemId);
        if (item?.kind === "sub_agent") {
          const rest = { ...item };
          delete rest.activity;
          putItem(main, {
            ...rest,
            status: "completed",
            report: task.agents[agent as "claude" | "codex"].report,
            tokens: agent === "claude" ? 48_210 : 39_877,
            toolUses: child.turn.items.filter((step) => step.kind !== "agent_message").length,
            durationMs: Date.now() - startedAt,
          });
        }
        return;
      }

      if ("approval" in step) {
        raiseApproval(main, instant, () => {
          for (const next of task.afterApproval as Step[]) later(next.at, () => run(next));
        });
        return;
      }

      if ("panel" in step) {
        openPresencePanel({ kind: "hardware" });
      }
    }

    const steps = task.steps as Step[];
    if (instant) {
      main.status = "running";
      steps.forEach(run);
    } else {
      for (const step of steps) later(script.typing.thinkMs + step.at, () => run(step));
    }
  }

  function raiseApproval(turn: Turn, quiet: boolean, resume: () => void): void {
    const spec = script.demoTask.approval;
    const approval: ApprovalRecord = {
      id: ids.nextId(),
      actorId: "vesper",
      operationClass: "local_reversible_edit",
      capability: spec.capability,
      target: { type: "node", id: HOME.nodeId, hostId: HOME.hostId },
      consequenceSummary: spec.summary,
      reversibility: "reversible",
      outcome: "require_confirmation",
      policyId: "owner-approval",
      reasonCodes: ["restart_needs_owner"],
      requestedAt: iso(),
      decidedAt: iso(),
      ...(turn.jobId === undefined ? {} : { nodeJobId: turn.jobId }),
    };
    approvals.push(approval);
    continuations.set(approval.id, resume);
    emit("authority", approval.id, "authority.decision_recorded.v1", {
      requestId: approval.id,
      outcome: approval.outcome,
      ...(turn.jobId === undefined ? {} : { nodeJobId: turn.jobId }),
    });
    if (!quiet) options.notify?.(spec.notificationTitle, spec.notificationBody, "/?larp=approval");
  }

  function fastForwardDemo(notify: boolean): void {
    const thread = threads.get(free.vesper);
    if (thread === undefined) return;
    const user = addMessage(thread.id, "user", "Build me a hardware monitoring panel");
    const turn = startTurn(thread, user.id, models.claude!, HOME.nodeId);
    runDemoTask(thread, turn, true);
    const pending = approvals.at(-1);
    if (notify && pending !== undefined) {
      const spec = script.demoTask.approval;
      options.notify?.(spec.notificationTitle, spec.notificationBody, "/?larp=approval");
    }
  }

  // --- approvals ----------------------------------------------------------

  function refuse(status: number, message: string, reasonCodes: string[]): CoreResponse {
    return { status, body: { error: { code: "conflict", message, details: { reasonCodes } } } };
  }

  function authority(name: string, body: Record<string, unknown>): CoreResponse {
    const approval = approvals.find((candidate) => candidate.id === body.requestId);
    if (approval === undefined) return NOT_FOUND;

    if (name === "authority.decline") {
      approval.declinedAt = iso();
      approval.declinedBy = "owner";
      continuations.delete(approval.id);
      emit("authority", approval.id, "authority.declined.v1", { requestId: approval.id });
      return ok(approval);
    }

    if (name === "authority.execute") {
      approval.executedAt = iso();
      emit("authority", approval.id, "authority.executed.v1", { requestId: approval.id });
      return ok(approval);
    }

    if (approval.confirmedAt !== undefined) {
      return refuse(409, "Already confirmed", ["already_confirmed"]);
    }
    if (
      approval.outcome === "require_typed_confirmation" &&
      body.typedConfirmation !== approval.confirmationPhrase
    ) {
      return refuse(409, `Type ${approval.confirmationPhrase ?? "DESTROY"} to confirm`, [
        "typed_confirmation_mismatch",
      ]);
    }
    approval.confirmedAt = iso();
    approval.confirmedBy = "owner";
    emit("authority", approval.id, "authority.confirmed.v1", { requestId: approval.id });
    const resume = continuations.get(approval.id);
    continuations.delete(approval.id);
    resume?.();
    return ok(approval);
  }

  // --- surfaces -----------------------------------------------------------

  const ownerKey = (owner: {
    presence?: true | undefined;
    threadId?: string | undefined;
    objectiveId?: string | undefined;
  }): string =>
    owner.presence === true ? "presence" : (owner.threadId ?? owner.objectiveId ?? "");

  function ownerOf(body: { threadId?: unknown; objectiveId?: unknown }): SurfaceOwner {
    if (typeof body.threadId === "string") return { threadId: body.threadId };
    if (typeof body.objectiveId === "string") return { objectiveId: body.objectiveId };
    return { presence: true };
  }

  function upsertIntent(body: Record<string, unknown>): SurfaceIntent {
    const owner = ownerOf(body);
    const sourceIds = Array.isArray(body.sourceIds) ? (body.sourceIds as string[]) : [];
    const existing = intents.find(
      (intent) =>
        ownerKey(intent) === ownerKey(owner) &&
        intent.kind === body.kind &&
        JSON.stringify(intent.sourceIds) === JSON.stringify(sourceIds),
    );
    const intent = {
      id: existing?.id ?? ids.nextId(),
      ...owner,
      kind: String(body.kind),
      role: (body.role as SurfaceIntent["role"] | undefined) ?? "supporting",
      persistence: (body.persistence as SurfaceIntent["persistence"] | undefined) ?? "restorable",
      lifecycle: existing?.lifecycle ?? "proposed",
      priority: typeof body.priority === "number" ? body.priority : 50,
      minSize: (body.minSize as SurfaceIntent["minSize"] | undefined) ?? "standard",
      sourceIds,
      artifactIds: Array.isArray(body.artifactIds) ? (body.artifactIds as string[]) : [],
      payloadVersion: typeof body.payloadVersion === "number" ? body.payloadVersion : 1,
      payload: body.payload ?? null,
      requestedAt: iso(),
    } as SurfaceIntent;
    if (existing === undefined) intents.push(intent);
    else intents[intents.indexOf(existing)] = intent;
    emit("surface", intent.id, "surface.intent_upserted.v1", {
      ...owner,
      kind: intent.kind,
      role: intent.role,
      created: existing === undefined,
    });
    return intent;
  }

  function openPresencePanel(panel: { kind: string; page?: string; threadTitle?: string }): void {
    const payload =
      panel.kind === "page"
        ? { page: panel.page }
        : panel.kind === "conversation"
          ? { messages: conversationPayload(panel.threadTitle) }
          : {};
    upsertIntent({
      kind: panel.kind,
      role: "supporting",
      persistence: "restorable",
      priority: 50,
      minSize: "standard",
      payloadVersion: 1,
      sourceIds: [panelSource(`${panel.kind}:${panel.page ?? panel.threadTitle ?? ""}`)],
      payload,
    });
  }

  /** The same panel asked for twice is one panel, as the core dedupes it by source. */
  function panelSource(key: string): string {
    const id = panelSources.get(key) ?? ids.nextId();
    panelSources.set(key, id);
    return id;
  }

  function conversationPayload(title: string | undefined): Array<Record<string, string>> {
    const thread = [...threads.values()].find((candidate) => candidate.title === title);
    return (messages.get(thread?.id ?? "") ?? []).map((message) => ({
      id: message.id,
      author: message.role === "user" ? "You" : "Vesper",
      text: message.body,
    }));
  }

  function surfaceRead(owner: SurfaceOwner, query: URLSearchParams): CoreResponse {
    const display = {
      fingerprint: query.get("fingerprint") ?? "larp",
      widthPx: Number(query.get("widthPx") ?? 1440),
    };
    const focusedSurfaceId = query.get("focusedSurfaceId") ?? undefined;
    const mine = intents.filter((intent) => ownerKey(intent) === ownerKey(owner));
    return ok({
      intents: mine,
      overrides: [],
      snapshot: null,
      plan: planOf(owner, display, attentionOf(query.get("attentionState")), focusedSurfaceId),
    });
  }

  const attentionOf = (value: unknown): AttentionState =>
    AttentionStateSchema.safeParse(value).data ?? "presence";

  function planOf(
    owner: SurfaceOwner,
    display: { fingerprint: string; widthPx: number },
    attentionState: AttentionState,
    focusedSurfaceId?: string,
  ) {
    return compose({
      owner,
      intents: intents.filter((intent) => ownerKey(intent) === ownerKey(owner)),
      overrides: [],
      display,
      attentionState,
      ...(focusedSurfaceId === undefined ? {} : { focusedSurfaceId }),
      generatedAt: iso(),
    }).plan;
  }

  function surface(name: string, body: Record<string, unknown>): CoreResponse {
    if (name === "surface.upsert_intent") return ok(upsertIntent(body));
    if (name === "surface.change_lifecycle") {
      const index = intents.findIndex((intent) => intent.id === body.surfaceId);
      const current = intents[index];
      if (current === undefined) return NOT_FOUND;
      const next = { ...current, lifecycle: body.lifecycle as SurfaceIntent["lifecycle"] };
      intents[index] = next;
      emit("surface", next.id, "surface.lifecycle_changed.v1", {
        ...ownerOf(next),
        from: current.lifecycle,
        to: next.lifecycle,
      });
      return ok(next);
    }
    const display = body.display as { fingerprint: string; widthPx: number } | undefined;
    const plan = planOf(
      ownerOf(body),
      display ?? { fingerprint: "larp", widthPx: 1440 },
      attentionOf(body.attentionState),
      typeof body.focusedSurfaceId === "string" ? body.focusedSurfaceId : undefined,
    );
    return ok({ plan, changed: false });
  }

  // --- reads --------------------------------------------------------------

  function summaries(identityId: string, archived: boolean) {
    return [...threads.values()]
      .filter(
        (thread) =>
          thread.identityId === identityId &&
          thread.parentThreadId === undefined &&
          thread.id !== free[thread.identityId] &&
          (messages.get(thread.id)?.length ?? 0) > 0 &&
          (thread.archivedAt !== undefined) === archived,
      )
      .map((thread) => {
        const last = messages.get(thread.id)?.at(-1);
        return {
          ...thread,
          lastActiveAt: last?.createdAt ?? thread.updatedAt,
          ...(last === undefined ? {} : { preview: last.body.slice(0, 200) }),
        };
      })
      .sort((left, right) => right.lastActiveAt.localeCompare(left.lastActiveAt));
  }

  function read(path: string): CoreResponse | undefined {
    const { segments, query } = parsePath(path);
    const [collection, id, sub] = segments;

    if (collection === "events" && id === undefined) {
      const after = Number(query.get("after") ?? 0);
      const limit = Number(query.get("limit") ?? 500);
      return ok({
        events: ledger.filter((event) => event.sequence > after).slice(0, limit),
        latestSequence: sequence,
      });
    }
    if (collection === "identities") {
      const awakeUntil = new Date(Date.now() + AWAKE_MS).toISOString();
      return ok({
        activeIdentityId: activeIdentity,
        threads: (["vesper", "jester"] as const).map((identityId) => ({
          ...threads.get(free[identityId]),
          awakeUntil,
        })),
      });
    }
    if (collection === "threads" && id === undefined) {
      if (query.get("objectiveId") !== null) return NOT_FOUND;
      return ok(threads.get(free[query.get("identityId") === "jester" ? "jester" : "vesper"]));
    }
    if (collection === "conversations") {
      return ok({
        conversations: summaries(
          query.get("identityId") ?? "vesper",
          query.get("archived") === "1",
        ),
      });
    }
    if (collection === "presence" && id === "surfaces")
      return surfaceRead({ presence: true }, query);
    if (collection === "turns") {
      if (id !== undefined) return findTurn(id) === undefined ? NOT_FOUND : ok(findTurn(id));
      const all = [...turns.values()].flat();
      return ok({
        turns: all
          .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
          .slice(0, 50),
      });
    }
    if (collection === "approvals") {
      if (id === undefined) {
        return ok({
          approvals: [...approvals].sort((left, right) =>
            right.requestedAt.localeCompare(left.requestedAt),
          ),
        });
      }
      const approval = approvals.find((candidate) => candidate.id === id);
      return approval === undefined ? NOT_FOUND : ok(approval);
    }
    if (collection === "objectives") return NOT_FOUND;
    if (collection !== "threads" || id === undefined) return undefined;

    const thread = threads.get(id);
    if (sub === undefined) return thread === undefined ? NOT_FOUND : ok(thread);
    if (sub === "messages") return ok({ messages: messages.get(id) ?? [] });
    if (sub === "turns") return ok({ turns: turns.get(id) ?? [] });
    if (sub === "children") {
      return ok({
        threads: [...threads.values()].filter((candidate) => candidate.parentThreadId === id),
      });
    }
    if (sub === "surfaces") return surfaceRead({ threadId: id }, query);
    return undefined;
  }

  // --- commands -----------------------------------------------------------

  function command(name: string, body: Record<string, unknown>): CoreResponse | undefined {
    switch (name) {
      case "conversation.send":
        return send(body);
      case "conversation.cancel": {
        const turn = [...turns.values()].flat().find((candidate) => candidate.jobId === body.jobId);
        if (turn === undefined) return NOT_FOUND;
        cancelled.add(turn.id);
        turn.status = "cancelled";
        turn.completedAt = iso();
        emit("identity", turn.threadId, "identity.turn_completed.v1", {
          turnId: turn.id,
          status: "cancelled",
        });
        return ok({ jobId: body.jobId });
      }
      case "conversation.start_fresh": {
        const identityId = body.identityId === "jester" ? "jester" : "vesper";
        const old = threads.get(free[identityId]);
        const fresh: ConversationThread = {
          id: ids.nextId(),
          identityId,
          kind: "free",
          revision: 1,
          createdAt: iso(),
          updatedAt: iso(),
        };
        addThread(fresh);
        free[identityId] = fresh.id;
        if (old !== undefined)
          threads.set(old.id, { ...old, kind: "named", title: "Earlier chat" });
        return ok(fresh);
      }
      case "conversation.warm":
        return ok({
          threadId: free[body.identityId === "jester" ? "jester" : "vesper"],
          jobId: ids.nextId(),
          awakeUntil: new Date(Date.now() + AWAKE_MS).toISOString(),
        });
      case "conversation.create_thread": {
        const thread: ConversationThread = {
          id: ids.nextId(),
          identityId: body.identityId === "jester" ? "jester" : "vesper",
          kind: "named",
          ...(typeof body.title === "string" ? { title: body.title } : {}),
          ...(typeof body.nodeId === "string" ? { nodeId: body.nodeId } : {}),
          revision: 1,
          createdAt: iso(),
          updatedAt: iso(),
        };
        addThread(thread);
        return ok(thread);
      }
      case "conversation.rename_thread":
      case "conversation.archive_thread": {
        const thread = threads.get(String(body.threadId));
        if (thread === undefined) return NOT_FOUND;
        const next: ConversationThread =
          name === "conversation.rename_thread"
            ? { ...thread, title: typeof body.title === "string" ? body.title : "" }
            : { ...thread, archivedAt: iso() };
        if (name === "conversation.archive_thread" && body.archived === false)
          delete next.archivedAt;
        threads.set(thread.id, next);
        return ok(next);
      }
      case "identity.activate":
        activeIdentity = body.identityId === "jester" ? "jester" : "vesper";
        emit("identity", free[activeIdentity], "identity.activated.v1", {
          identityId: activeIdentity,
        });
        return ok({ activeIdentityId: activeIdentity });
      case "identity.set_default_model":
        return ok({ identityId: body.identityId, model: body.model });
      default:
        if (name.startsWith("authority.") && "requestId" in body) return authority(name, body);
        if (name.startsWith("surface.")) return surface(name, body);
        return undefined;
    }
  }

  if (options.seed === "approval") fastForwardDemo(false);

  return {
    request: (method, path, body) => {
      if (method === "GET") return read(path);
      const { segments } = parsePath(path);
      return segments[0] === "commands" && segments[1] !== undefined
        ? command(segments[1], (body ?? {}) as Record<string, unknown>)
        : undefined;
    },
    subscribe: (subscriber) => {
      listeners.add(subscriber);
      for (const event of ledger.filter((entry) => entry.sequence > subscriber.afterSequence)) {
        void Promise.resolve().then(() => subscriber.onEvent(event));
      }
      return () => listeners.delete(subscriber);
    },
    raiseApprovalIn: (ms) => later(ms, () => fastForwardDemo(true)),
  };
}

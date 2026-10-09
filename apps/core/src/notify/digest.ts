import type { NoctisDatabase } from "../db/connection.js";

/**
 * What the agents did in a window of time, read straight from the ledger:
 * turns by agent and thread, files written, outputs made, and the approvals
 * the owner was asked for. Deterministic, no model call, so it costs nothing
 * to ask for.
 */
export interface Digest {
  from: string;
  to: string;
  turns: { total: number; completed: number; failed: number; cancelled: number };
  agents: Array<{ providerId: string; turns: number }>;
  threads: Array<{
    threadId: string;
    identityId: string;
    title: string | null;
    turns: number;
    failed: number;
  }>;
  files: number;
  outputs: number;
  approvals: { asked: number; approved: number; declined: number; unanswered: number };
}

/** The classes that wait for the owner; the rest were decided by policy. */
const ASKED = "('require_confirmation', 'require_typed_confirmation')";

export function readDigest(db: NoctisDatabase, from: string, to: string): Digest {
  const turns = db
    .prepare(
      `SELECT t.thread_id, t.provider_id, t.status, t.items_json, th.identity_id, th.title
         FROM identity_turns t JOIN identity_threads th ON th.id = t.thread_id
        WHERE t.started_at >= ? AND t.started_at < ?`,
    )
    .all(from, to) as Array<{
    thread_id: string;
    provider_id: string;
    status: string;
    items_json: string;
    identity_id: string;
    title: string | null;
  }>;

  const agents = new Map<string, number>();
  const threads = new Map<string, Digest["threads"][number]>();
  let files = 0;
  let outputs = 0;

  for (const row of turns) {
    agents.set(row.provider_id, (agents.get(row.provider_id) ?? 0) + 1);

    const thread = threads.get(row.thread_id) ?? {
      threadId: row.thread_id,
      identityId: row.identity_id,
      title: row.title,
      turns: 0,
      failed: 0,
    };
    thread.turns += 1;
    thread.failed += row.status === "failed" ? 1 : 0;
    threads.set(row.thread_id, thread);

    for (const item of JSON.parse(row.items_json) as Array<{ kind?: string; paths?: unknown[] }>) {
      files += item.kind === "file_change" ? (item.paths?.length ?? 0) : 0;
      outputs += item.kind === "output" ? 1 : 0;
    }
  }

  const count = (status: string): number => turns.filter((row) => row.status === status).length;
  const approvals = db
    .prepare(
      `SELECT COUNT(*) AS asked,
              COUNT(confirmed_at) AS approved,
              COUNT(declined_at) AS declined,
              SUM(confirmed_at IS NULL AND declined_at IS NULL) AS unanswered
         FROM approvals
        WHERE outcome IN ${ASKED} AND requested_at >= ? AND requested_at < ?`,
    )
    .get(from, to) as { asked: number; approved: number; declined: number; unanswered: number };

  return {
    from,
    to,
    turns: {
      total: turns.length,
      completed: count("completed"),
      failed: count("failed"),
      cancelled: count("cancelled"),
    },
    agents: [...agents]
      .map(([providerId, n]) => ({ providerId, turns: n }))
      .sort((a, b) => b.turns - a.turns || a.providerId.localeCompare(b.providerId)),
    threads: [...threads.values()].sort(
      (a, b) => b.turns - a.turns || a.threadId.localeCompare(b.threadId),
    ),
    files,
    outputs,
    approvals: { ...approvals, unanswered: approvals.unanswered ?? 0 },
  };
}

const AGENT_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  hermes: "Hermes",
  local: "Local model",
};

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? "" : "s"}`;
}

/** The digest as one line, short enough for a lock screen. */
export function digestLine(digest: Digest): string {
  if (digest.turns.total === 0 && digest.approvals.asked === 0) {
    return "The agents did nothing.";
  }

  const agents = digest.agents
    .map((agent) => `${AGENT_NAMES[agent.providerId] ?? agent.providerId} ${String(agent.turns)}`)
    .join(", ");
  const parts = [
    `${plural(digest.turns.total, "turn")} in ${plural(digest.threads.length, "thread")}` +
      (agents === "" ? "" : ` (${agents})`) +
      (digest.turns.failed === 0 ? "" : `, ${String(digest.turns.failed)} failed`),
  ];

  if (digest.files > 0) {
    parts.push(`${plural(digest.files, "file")} written`);
  }

  if (digest.outputs > 0) {
    parts.push(`${plural(digest.outputs, "output")} made`);
  }

  if (digest.approvals.asked > 0) {
    const { approved, declined, unanswered } = digest.approvals;
    const answers = [
      approved > 0 ? `${String(approved)} approved` : "",
      declined > 0 ? `${String(declined)} declined` : "",
      unanswered > 0 ? `${String(unanswered)} unanswered` : "",
    ].filter((part) => part !== "");
    parts.push(`${plural(digest.approvals.asked, "approval")} asked: ${answers.join(", ")}`);
  }

  return `${parts.join(". ")}.`;
}

/**
 * Milliseconds from `now` to the next `HH:MM` on the core's local clock,
 * tomorrow if today's has passed. Undefined for anything that is not a time.
 */
export function msUntilNext(now: Date, at: string): number | undefined {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at);

  if (match === null) {
    return undefined;
  }

  const next = new Date(now);
  next.setHours(Number(match[1]), Number(match[2]), 0, 0);

  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }

  return next.getTime() - now.getTime();
}

import { folderName } from "../conversation/PromptForm.js";
import type { RuntimeRootOption } from "../conversation/useConversation.js";

/** What the conversation list decides without a browser. */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago, in the unit a person would say it. */
export function ago(iso: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(iso));

  if (elapsed < MINUTE) {
    return "just now";
  }

  if (elapsed < HOUR) {
    return `${String(Math.floor(elapsed / MINUTE))} min ago`;
  }

  if (elapsed < DAY) {
    return `${String(Math.floor(elapsed / HOUR))} h ago`;
  }

  const days = Math.floor(elapsed / DAY);

  return `${String(days)} ${days === 1 ? "day" : "days"} ago`;
}

/** A conversation's name: its title, else what it is, else its first line. */
export function conversationLabel(conversation: {
  kind: "free" | "named";
  title?: string | undefined;
  preview?: string | undefined;
}): string {
  if (conversation.title !== undefined) {
    return conversation.title;
  }

  if (conversation.kind === "free") {
    return "Free chat";
  }

  return conversation.preview?.split("\n")[0]?.trim() || "New conversation";
}

/** Ordinary conversations first, then each scheduled task's runs under the task's name. */
export function conversationGroups<
  T extends { id: string; taskId?: string | undefined; taskName?: string | undefined },
>(conversations: readonly T[]): { label: string; taskId?: string; conversations: T[] }[] {
  const free: T[] = [];
  const tasks = new Map<string, { label: string; taskId: string; conversations: T[] }>();

  for (const conversation of conversations) {
    if (conversation.taskId === undefined) {
      free.push(conversation);
      continue;
    }

    const group = tasks.get(conversation.taskId) ?? {
      label: conversation.taskName ?? "Scheduled task",
      taskId: conversation.taskId,
      conversations: [],
    };
    group.conversations.push(conversation);
    tasks.set(conversation.taskId, group);
  }

  return [{ label: "Conversations", conversations: free }, ...tasks.values()];
}

const AGENT_NAMES: Readonly<Record<string, string>> = {
  claude: "Claude",
  codex: "Codex",
  hermes: "Hermes",
  local: "Local model",
};

export function agentName(providerId: string): string {
  return AGENT_NAMES[providerId] ?? providerId;
}

/** Where a pinned thread always runs, or undefined for one that runs wherever a message says. */
export function pinnedTo(
  thread: {
    providerId?: string | undefined;
    rootGrantId?: string | undefined;
    nodeId?: string | undefined;
  },
  roots: readonly RuntimeRootOption[],
): string | undefined {
  if (thread.providerId === undefined) {
    return undefined;
  }

  const root = roots.find(
    (candidate) => candidate.grantId === thread.rootGrantId && candidate.nodeId === thread.nodeId,
  );
  const agent = agentName(thread.providerId);

  return root === undefined ? agent : `${agent} · ${folderName(root.path)} on ${root.hostId}`;
}

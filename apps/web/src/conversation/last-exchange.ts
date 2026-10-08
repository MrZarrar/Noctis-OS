import type { ConversationSnapshot } from "./useConversation.js";

/**
 * What Presence shows under the core after a send: the owner's latest line and
 * the reply as far as it has come, as in the Jester mockup. Threads keeps the
 * history; this is only the exchange in progress.
 */
export function lastExchange(
  snapshot: Pick<ConversationSnapshot, "messages" | "turns" | "streaming">,
): { you: string; reply: string } | undefined {
  const turn = snapshot.turns.at(-1);

  if (turn === undefined) {
    return undefined;
  }

  const body = (id: string | undefined): string | undefined =>
    snapshot.messages.find((message) => message.id === id)?.body;
  const said = turn.items.filter((item) => item.kind === "agent_message").at(-1);
  const streamed = said === undefined ? undefined : snapshot.streaming.get(said.itemId);
  const reply =
    body(turn.replyMessageId) ??
    (turn.status === "failed" && turn.failureReason !== undefined
      ? `Failed: ${turn.failureReason}`
      : undefined) ??
    (said?.kind === "agent_message" && said.text.length >= (streamed?.length ?? 0)
      ? said.text
      : streamed) ??
    "";

  return { you: body(turn.userMessageId) ?? "", reply };
}

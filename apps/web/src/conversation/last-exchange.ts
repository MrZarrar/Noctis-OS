import type { ConversationSnapshot } from "./useConversation.js";

export interface ExchangeOutput {
  attachmentId: string;
  mediaType: string;
  path?: string;
}

/**
 * What Presence shows under the core after a send: the owner's latest line, the
 * reply as far as it has come, as in the Jester mockup, and any file the turn
 * made. Threads keeps the history; this is only the exchange in progress.
 */
export function lastExchange(
  snapshot: Pick<ConversationSnapshot, "messages" | "turns" | "streaming"> &
    Partial<Pick<ConversationSnapshot, "partialReplies">>,
): { you: string; reply: string; outputs: ExchangeOutput[] } | undefined {
  const turn = snapshot.turns.at(-1);

  if (turn === undefined) {
    return undefined;
  }

  const body = (id: string | undefined): string | undefined =>
    snapshot.messages.find((message) => message.id === id)?.body;
  const said = turn.items.filter((item) => item.kind === "agent_message").at(-1);
  const partial = [...(snapshot.partialReplies ?? [])]
    .filter(([key]) => turn.jobId !== undefined && key.startsWith(`${turn.jobId}:`))
    .map(([, text]) => text)
    .join("\n\n");
  const streamed =
    (said === undefined ? undefined : snapshot.streaming.get(said.itemId)) ?? partial;
  const reply =
    body(turn.replyMessageId) ??
    (turn.status === "failed" && turn.failureReason !== undefined
      ? `Failed: ${turn.failureReason}`
      : undefined) ??
    (said?.kind === "agent_message" && said.text.length >= (streamed?.length ?? 0)
      ? said.text
      : streamed) ??
    "";

  const outputs = turn.items.flatMap((item) =>
    item.kind === "output" && item.attachmentId !== undefined
      ? [
          {
            attachmentId: item.attachmentId,
            mediaType: item.mediaType,
            ...(item.path === undefined ? {} : { path: item.path }),
          },
        ]
      : [],
  );

  return { you: body(turn.userMessageId) ?? "", reply, outputs };
}

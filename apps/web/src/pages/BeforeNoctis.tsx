import { useEffect, useState } from "react";

import type { SessionExchange } from "@noctis/contracts";
import { SessionExchangeSchema } from "@noctis/contracts";
import { material, spacing, typography } from "@noctis/ui";
import { z } from "zod";

import { SectionHeading } from "../layout/Page.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { agentName } from "./conversations-view.js";

const HistorySchema = z.object({ exchanges: z.array(SessionExchangeSchema) }).strict();

const bubble = {
  maxWidth: `min(${String(typography.measurePx)}px, 88%)`,
  boxSizing: "border-box",
  padding: `${String(spacing.sm)}px ${String(spacing.md)}px`,
  borderRadius: 12,
  border: `1px dashed ${material.border}`,
  color: typography.color.muted,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
} as const;

const who = { display: "block", fontSize: typography.scale.xs, marginBottom: 2 } as const;

/**
 * What was said in an adopted session before Noctis picked it up, read from
 * the PC that keeps it each time the thread opens. Read-only and drawn apart
 * from the thread's own messages: it is where the agent's memory starts, not
 * something said here.
 */
export function BeforeNoctis({
  transport,
  threadId,
  providerId,
}: {
  transport: CoreTransport;
  threadId: string;
  providerId: string;
}): JSX.Element | null {
  const [exchanges, setExchanges] = useState<SessionExchange[]>();
  const [problem, setProblem] = useState<string>();

  useEffect(() => {
    let live = true;

    setExchanges(undefined);
    setProblem(undefined);
    void transport
      .request("GET", `/threads/${threadId}/history`)
      .then((response) => {
        const parsed = HistorySchema.safeParse(response.body);

        if (live) {
          if (parsed.success) {
            setExchanges(parsed.data.exchanges);
          } else {
            setProblem("The PC could not read this session's earlier messages.");
          }
        }
      })
      .catch(() => {
        if (live) {
          setProblem("The PC did not answer.");
        }
      });

    return () => {
      live = false;
    };
  }, [transport, threadId]);

  if (exchanges?.length === 0) {
    return null;
  }

  const agent = agentName(providerId);

  return (
    <section aria-label="Before Noctis" style={{ display: "grid", gap: spacing.sm }}>
      <SectionHeading>Before Noctis</SectionHeading>
      <p style={{ margin: 0, color: typography.color.muted, fontSize: typography.scale.xs }}>
        {problem ??
          (exchanges === undefined
            ? "Reading what was said before…"
            : `Where this session left off, read-only. ${agent} remembers all of it.`)}
      </p>
      {exchanges !== undefined && (
        <ul
          aria-label="Earlier exchanges"
          style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: spacing.sm }}
        >
          {exchanges.flatMap((exchange, index) => [
            <li key={`${String(index)}-prompt`} style={{ ...bubble, justifySelf: "end" }}>
              <span style={who}>You, earlier</span>
              {exchange.prompt}
            </li>,
            ...(exchange.reply === ""
              ? []
              : [
                  <li key={`${String(index)}-reply`} style={{ ...bubble, justifySelf: "start" }}>
                    <span style={who}>{agent}, earlier</span>
                    {exchange.reply}
                  </li>,
                ]),
          ])}
        </ul>
      )}
    </section>
  );
}

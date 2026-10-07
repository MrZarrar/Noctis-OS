import {
  ApprovalSurface,
  NavIcon,
  identityAccent,
  semantic,
  spacing,
  typography,
} from "@noctis/ui";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import { nextKey } from "../idempotency.js";
import { Page, glass } from "../layout/Page.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { isWaiting } from "./waiting.js";

/**
 * Everything waiting on the owner, from every thread and every PC: where a push
 * notification about an approval lands. It used to be half of the Artifacts
 * page, which put the one thing that blocks an agent behind the page for what
 * agents had already finished.
 */

const ApprovalSchema = z.object({
  id: z.string(),
  consequenceSummary: z.string(),
  operationClass: z.string(),
  capability: z.string(),
  target: z.object({ type: z.string(), id: z.string() }),
  reversibility: z.enum(["reversible", "partially_reversible", "irreversible"]),
  outcome: z.enum(["allow", "deny", "require_confirmation", "require_typed_confirmation"]),
  reasonCodes: z.array(z.string()),
  estimatedCostGbp: z.number().optional(),
  confirmationPhrase: z.string().optional(),
  confirmedAt: z.string().optional(),
  executedAt: z.string().optional(),
  declinedAt: z.string().optional(),
  nodeJobId: z.string().optional(),
  requestedAt: z.string(),
});

type Approval = z.infer<typeof ApprovalSchema>;

export function Approvals({ transport }: { transport: CoreTransport | undefined }): JSX.Element {
  const [approvals, setApprovals] = useState<readonly Approval[]>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (transport === undefined) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const response = await transport.request("GET", "/approvals");

        if (cancelled) {
          return;
        }

        const parsed = z.object({ approvals: z.array(ApprovalSchema) }).safeParse(response.body);

        if (!parsed.success) {
          setError("The core returned a shape that does not match its contract");
          return;
        }

        setApprovals(parsed.data.approvals);
        setError(undefined);
      } catch (failure: unknown) {
        if (!cancelled) {
          setError(failure instanceof Error ? failure.message : "could not read approvals");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [transport, revision]);

  const send = useCallback(
    async (name: string, body: Record<string, unknown>) => {
      if (transport === undefined) {
        return;
      }

      const response = await transport.request("POST", `/commands/${name}`, {
        idempotencyKey: nextKey(name),
        ...body,
      });

      if (response.status === 200) {
        setRevision((current) => current + 1);
        setError(undefined);
      } else {
        const failure = response.body as {
          error?: { details?: { reasonCodes?: string[] }; message?: string };
        };

        // The reason codes verbatim. A generic "that failed" would hide the one
        // distinction that matters here: refused by policy, versus already done.
        setError(
          failure.error?.details?.reasonCodes?.join(", ") ??
            failure.error?.message ??
            "the core refused that",
        );
      }
    },
    [transport],
  );

  const waiting = (approvals ?? [])
    .filter(isWaiting)
    .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt));

  return (
    <Page
      title="Approvals"
      subtitle={
        approvals === undefined
          ? "Reading what is waiting…"
          : waiting.length === 0
            ? "Nothing is waiting on you"
            : `${String(waiting.length)} waiting on you`
      }
    >
      {approvals !== undefined && waiting.length === 0 ? (
        <div
          style={{
            display: "grid",
            justifyItems: "center",
            gap: spacing.sm,
            padding: `${String(spacing.xxxl)}px ${String(spacing.lg)}px`,
            color: typography.color.muted,
            textAlign: "center",
          }}
        >
          <span style={{ color: identityAccent.vesper.primary }}>
            <NavIcon item="Approvals" size={40} />
          </span>
          <p style={{ margin: 0, maxWidth: 320 }}>
            When an agent reaches a step that needs you, it waits here and your phone is told.
          </p>
        </div>
      ) : (
        <ul
          aria-label="Approvals waiting"
          style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: spacing.md }}
        >
          {waiting.map((approval) => (
            <li
              key={approval.id}
              data-entry="approval"
              style={{
                ...glass,
                padding: spacing.lg,
                borderLeft: `2px solid ${semantic.approval}`,
              }}
            >
              <ApprovalSurface
                id={approval.id}
                consequenceSummary={approval.consequenceSummary}
                operationClass={approval.operationClass}
                capability={approval.capability}
                targetType={approval.target.type}
                targetId={approval.target.id}
                reversibility={approval.reversibility}
                outcome={approval.outcome}
                reasonCodes={approval.reasonCodes}
                {...(approval.estimatedCostGbp === undefined
                  ? {}
                  : { estimatedCostGbp: approval.estimatedCostGbp })}
                {...(approval.confirmationPhrase === undefined
                  ? {}
                  : { confirmationPhrase: approval.confirmationPhrase })}
                {...(approval.confirmedAt === undefined
                  ? {}
                  : { confirmedAt: approval.confirmedAt })}
                onConfirm={(typedConfirmation) => {
                  void send("authority.confirm", {
                    requestId: approval.id,
                    ...(typedConfirmation === undefined ? {} : { typedConfirmation }),
                  });
                }}
                onDecline={() => {
                  void send("authority.decline", { requestId: approval.id });
                }}
                onExecute={() => {
                  void send("authority.execute", {
                    requestId: approval.id,
                    evidenceVersion: 1,
                    // Phase 8 records the boundary; the adapters that will
                    // produce real evidence arrive with Phases 10 and 11.
                    evidence: { confirmedInWorkbench: true },
                  });
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {error !== undefined && <p style={{ color: semantic.error, margin: 0 }}>{error}</p>}
    </Page>
  );
}

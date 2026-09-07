import {
  ApprovalSurface,
  ArtifactSurface,
  corner,
  material,
  semantic,
  spacing,
  typography,
} from "@noctis/ui";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import type { CoreTransport } from "../transport/CoreTransport.js";

/**
 * Artifacts, and the approval queue that produces them.
 *
 * The two live on one page because they are two halves of one story: an
 * approval is where an external consequence is agreed to, and an artifact is
 * what came back. Section 12.2's distinction is the thing this page exists to
 * make unmissable — an external reference is a link, and it stays a link until
 * an import puts bytes on a named host with a checksum.
 */

const ArtifactSchema = z.object({
  id: z.string(),
  kind: z.enum(["local_artifact", "external_reference"]),
  title: z.string(),
  uri: z.string(),
  mediaType: z.string().optional(),
  hostId: z.string().optional(),
  checksum: z.string().optional(),
  derivedFromArtifactId: z.string().optional(),
  importedAs: z.string().nullable(),
});

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
});

type Artifact = z.infer<typeof ArtifactSchema>;
type Approval = z.infer<typeof ApprovalSchema>;

let keySequence = 0;

function nextKey(): string {
  keySequence += 1;

  return `web-artifacts-${String(keySequence)}-${String(Date.now())}`;
}

export interface ArtifactsProps {
  transport: CoreTransport | undefined;
}

export function Artifacts({ transport }: ArtifactsProps): JSX.Element {
  const [artifacts, setArtifacts] = useState<readonly Artifact[]>([]);
  const [approvals, setApprovals] = useState<readonly Approval[]>([]);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (transport === undefined) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const [artifactResponse, approvalResponse] = await Promise.all([
          transport.request("GET", "/artifacts"),
          transport.request("GET", "/approvals"),
        ]);

        if (cancelled) {
          return;
        }

        const parsedArtifacts = z
          .object({ artifacts: z.array(ArtifactSchema) })
          .safeParse(artifactResponse.body);
        const parsedApprovals = z
          .object({ approvals: z.array(ApprovalSchema) })
          .safeParse(approvalResponse.body);

        if (!parsedArtifacts.success || !parsedApprovals.success) {
          setError("The core returned a shape that does not match its contract");
          return;
        }

        setArtifacts(parsedArtifacts.data.artifacts);
        setApprovals(parsedApprovals.data.approvals);
        setError(undefined);
      } catch (failure: unknown) {
        if (!cancelled) {
          setError(failure instanceof Error ? failure.message : "could not read artifacts");
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
        idempotencyKey: nextKey(),
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

  const pending = approvals.filter((approval) => approval.executedAt === undefined);

  return (
    <section
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        gap: spacing.lg,
        padding: spacing.lg,
        minWidth: 0,
        overflow: "auto",
      }}
    >
      <h1 style={{ margin: 0, font: `${String(typography.scale.lg)}px ${typography.family}` }}>
        Artifacts
      </h1>

      <section style={{ display: "grid", gap: spacing.sm }}>
        <h2 style={{ margin: 0, font: `${String(typography.scale.md)}px ${typography.family}` }}>
          Waiting for you
        </h2>

        {pending.length === 0 ? (
          <p style={{ margin: 0, color: typography.color.muted }}>
            Nothing is waiting at a consequence boundary.
          </p>
        ) : (
          <ul aria-label="Approvals waiting" style={listStyle}>
            {pending.map((approval) => (
              <li key={approval.id} style={cardStyle}>
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
      </section>

      <section style={{ display: "grid", gap: spacing.sm }}>
        <h2 style={{ margin: 0, font: `${String(typography.scale.md)}px ${typography.family}` }}>
          Everything Noctis has produced or pointed at
        </h2>

        {artifacts.length === 0 ? (
          <p style={{ margin: 0, color: typography.color.muted }}>No artifacts yet.</p>
        ) : (
          <ul aria-label="Artifacts" style={listStyle}>
            {artifacts.map((artifact) => (
              <li key={artifact.id} style={cardStyle}>
                <ArtifactSurface
                  kind={artifact.kind}
                  title={artifact.title}
                  uri={artifact.uri}
                  {...(artifact.mediaType === undefined ? {} : { mediaType: artifact.mediaType })}
                  {...(artifact.hostId === undefined ? {} : { hostId: artifact.hostId })}
                  {...(artifact.checksum === undefined ? {} : { checksum: artifact.checksum })}
                  {...(artifact.derivedFromArtifactId === undefined
                    ? {}
                    : { derivedFromArtifactId: artifact.derivedFromArtifactId })}
                  {...(artifact.importedAs === null ? {} : { importedAs: artifact.importedAs })}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {error !== undefined && <p style={{ color: semantic.error, margin: 0 }}>{error}</p>}
    </section>
  );
}

const listStyle = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: spacing.md,
} as const;

const cardStyle = {
  border: `1px solid ${material.border}`,
  borderRadius: corner.md,
  padding: spacing.md,
} as const;

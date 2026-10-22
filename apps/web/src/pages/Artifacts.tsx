import { ArtifactSurface, corner, material, semantic, spacing, typography } from "@noctis/ui";
import { useEffect, useState } from "react";
import { z } from "zod";

import type { CoreTransport } from "../transport/CoreTransport.js";

/**
 * Artifacts: what external steps produced or pointed at. The approvals that
 * lead to them have their own page now. Section 12.2's distinction is the
 * thing this page exists to make unmissable — an external reference is a link, and it stays a link until
 * an import puts bytes on a named host with a checksum.
 */

export const ArtifactSchema = z.object({
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

type Artifact = z.infer<typeof ArtifactSchema>;

export interface ArtifactsProps {
  transport: CoreTransport | undefined;
}

export function Artifacts({ transport }: ArtifactsProps): JSX.Element {
  const [artifacts, setArtifacts] = useState<readonly Artifact[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (transport === undefined) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const artifactResponse = await transport.request("GET", "/artifacts");

        if (cancelled) {
          return;
        }

        const parsedArtifacts = z
          .object({ artifacts: z.array(ArtifactSchema) })
          .safeParse(artifactResponse.body);

        if (!parsedArtifacts.success) {
          setError("The core returned a shape that does not match its contract");
          return;
        }

        setArtifacts(parsedArtifacts.data.artifacts);
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
  }, [transport]);

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

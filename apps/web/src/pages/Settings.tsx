import { corner, material, semantic, spacing, typography } from "@noctis/ui";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import type { CoreTransport } from "../transport/CoreTransport.js";

/**
 * Settings: the standing permissions screen (Section 9.1).
 *
 * "Standing permissions are narrow, revocable, time-bound, target-bound, and
 * visible in Settings." This is the visible part, and it shows revoked grants
 * alongside live ones on purpose — a permission that disappeared when it was
 * revoked would leave every decision it once upgraded unexplainable.
 *
 * There is no edit control anywhere on this page. Widening a grant means
 * revoking it and granting a new one, so the audit trail shows two acts rather
 * than one mutation with no before.
 */

const PermissionSchema = z.object({
  id: z.string(),
  actorId: z.string(),
  capability: z.string(),
  operationClass: z.string(),
  constraints: z.object({
    targetType: z.string(),
    targetIds: z.array(z.string()),
    hostIds: z.array(z.string()).optional(),
  }),
  grantedAt: z.string(),
  grantedBy: z.string(),
  expiresAt: z.string().optional(),
  revokedAt: z.string().optional(),
  revokedReason: z.string().optional(),
});

const PermissionsSchema = z.object({ permissions: z.array(PermissionSchema) });

type Permission = z.infer<typeof PermissionSchema>;

let keySequence = 0;

function nextKey(): string {
  keySequence += 1;

  return `web-settings-${String(keySequence)}-${String(Date.now())}`;
}

export interface SettingsProps {
  transport: CoreTransport | undefined;
}

export function Settings({ transport }: SettingsProps): JSX.Element {
  const [permissions, setPermissions] = useState<readonly Permission[]>([]);
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (transport === undefined) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const response = await transport.request("GET", "/permissions");
        const parsed = PermissionsSchema.safeParse(response.body);

        if (cancelled) {
          return;
        }

        if (parsed.success) {
          setPermissions(parsed.data.permissions);
          setError(undefined);
        } else {
          setError("The core returned permissions that do not match their contract");
        }
      } catch (failure: unknown) {
        if (!cancelled) {
          setError(failure instanceof Error ? failure.message : "could not read permissions");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [transport, revision]);

  const revoke = useCallback(
    async (permission: Permission) => {
      if (transport === undefined) {
        return;
      }

      // A reason is required by the command schema, so the UI asks for one
      // rather than inventing a placeholder the audit trail would then carry.
      const reason = window.prompt(
        `Why is "${permission.capability}" being revoked for ${permission.actorId}?`,
      );

      if (reason === null || reason.trim() === "") {
        return;
      }

      const response = await transport.request("POST", "/commands/authority.revoke_permission", {
        idempotencyKey: nextKey(),
        permissionId: permission.id,
        reason: reason.trim(),
      });

      if (response.status === 200) {
        setRevision((current) => current + 1);
        setError(undefined);
      } else {
        setError("The core refused to revoke that permission");
      }
    },
    [transport],
  );

  const live = permissions.filter((permission) => permission.revokedAt === undefined);
  const revoked = permissions.filter((permission) => permission.revokedAt !== undefined);

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
        Settings
      </h1>

      <section style={{ display: "grid", gap: spacing.sm }}>
        <h2 style={{ margin: 0, font: `${String(typography.scale.md)}px ${typography.family}` }}>
          Standing permissions
        </h2>
        <p style={{ margin: 0, maxWidth: typography.measurePx, color: typography.color.muted }}>
          A standing permission turns one confirmation into an allow, for one actor, one capability,
          and the exact targets it names. It can never cover spending, a destructive operation, a
          production activation, a credential change, or the granting of permissions.
        </p>

        {live.length === 0 ? (
          <p style={{ margin: 0, color: typography.color.muted }}>
            No standing permissions. Every consequential action asks.
          </p>
        ) : (
          <ul aria-label="Standing permissions" style={listStyle}>
            {live.map((permission) => (
              <PermissionRow
                key={permission.id}
                permission={permission}
                onRevoke={() => {
                  void revoke(permission);
                }}
              />
            ))}
          </ul>
        )}
      </section>

      {revoked.length > 0 && (
        <section style={{ display: "grid", gap: spacing.sm }}>
          <h2 style={{ margin: 0, font: `${String(typography.scale.md)}px ${typography.family}` }}>
            Revoked
          </h2>
          <p style={{ margin: 0, maxWidth: typography.measurePx, color: typography.color.muted }}>
            Kept, not deleted. A decision these once upgraded has to stay explainable.
          </p>
          <ul aria-label="Revoked permissions" style={listStyle}>
            {revoked.map((permission) => (
              <PermissionRow key={permission.id} permission={permission} />
            ))}
          </ul>
        </section>
      )}

      {error !== undefined && <p style={{ color: semantic.error, margin: 0 }}>{error}</p>}
    </section>
  );
}

const listStyle = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "grid",
  gap: spacing.sm,
} as const;

function PermissionRow({
  permission,
  onRevoke,
}: {
  permission: Permission;
  onRevoke?: () => void;
}): JSX.Element {
  const revoked = permission.revokedAt !== undefined;

  return (
    <li
      style={{
        border: `1px solid ${material.border}`,
        borderRadius: corner.md,
        padding: spacing.md,
        display: "grid",
        gap: spacing.xs,
        opacity: revoked ? 0.7 : 1,
      }}
    >
      <p style={{ margin: 0 }}>
        <strong>{permission.capability}</strong> for {permission.actorId}
      </p>
      <p style={{ margin: 0, color: typography.color.muted }}>
        {permission.operationClass} · {permission.constraints.targetType}:{" "}
        {permission.constraints.targetIds.join(", ")}
        {permission.constraints.hostIds === undefined
          ? ""
          : ` · on ${permission.constraints.hostIds.join(", ")}`}
      </p>
      <p style={{ margin: 0, color: typography.color.muted }}>
        granted {permission.grantedAt} by {permission.grantedBy}
        {permission.expiresAt === undefined ? " · no expiry" : ` · expires ${permission.expiresAt}`}
      </p>
      {revoked ? (
        <p style={{ margin: 0, color: semantic.stale }}>
          revoked {permission.revokedAt} — {permission.revokedReason ?? "no reason recorded"}
        </p>
      ) : (
        onRevoke !== undefined && (
          <div>
            <button
              type="button"
              onClick={onRevoke}
              style={{
                background: material.fillElevated,
                color: "inherit",
                border: `1px solid ${material.border}`,
                borderRadius: corner.sm,
                padding: `${String(spacing.xs)}px ${String(spacing.md)}px`,
                cursor: "pointer",
              }}
            >
              Revoke {permission.capability}
            </button>
          </div>
        )
      )}
    </li>
  );
}

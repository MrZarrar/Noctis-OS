import type { ConversationalIdentityId, ModelRef } from "@noctis/contracts";
import { ModelRefSchema } from "@noctis/contracts";
import { IDENTITY_PROFILES, corner, material, semantic, spacing, typography } from "@noctis/ui";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import { modelKey, modelLabel } from "../conversation/PromptForm.js";
import { Page, SectionHeading, buttonStyle, fieldStyle, glass } from "../layout/Page.js";
import type { PushState } from "../notify/subscribe.js";
import { enablePush, initialPushState } from "../notify/subscribe.js";
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

/** `GET /models` (ADR-0026): what connected nodes offer, and what each identity defaults to. */
const ModelsSchema = z
  .object({
    catalogue: z.array(ModelRefSchema),
    defaults: z
      .object({ vesper: ModelRefSchema.optional(), jester: ModelRefSchema.optional() })
      .strict(),
  })
  .strict();

type Models = z.infer<typeof ModelsSchema>;

let keySequence = 0;

function nextKey(): string {
  keySequence += 1;

  return `web-settings-${String(keySequence)}-${String(Date.now())}`;
}

export interface SettingsProps {
  transport: CoreTransport | undefined;
  /**
   * Ends the browser session. Absent for the packaged shell and a token build,
   * which hold no session and have nothing to sign out of.
   */
  onSignedOut?: () => void;
}

export function Settings({ transport, onSignedOut }: SettingsProps): JSX.Element {
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

  const [models, setModels] = useState<Models>();

  useEffect(() => {
    if (transport === undefined) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const response = await transport.request("GET", "/models");
        const parsed = ModelsSchema.safeParse(response.body);

        if (cancelled) {
          return;
        }

        if (response.status === 200 && parsed.success) {
          setModels(parsed.data);
        } else {
          setError("The core returned a model catalogue that does not match its contract");
        }
      } catch (failure: unknown) {
        if (!cancelled) {
          setError(failure instanceof Error ? failure.message : "could not read the models");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [transport, revision]);

  /** 0.3: the per-identity default is data; changing it is a command, not a code change. */
  const setDefaultModel = useCallback(
    async (identityId: ConversationalIdentityId, model: ModelRef) => {
      if (transport === undefined) {
        return;
      }

      const response = await transport.request("POST", "/commands/identity.set_default_model", {
        idempotencyKey: nextKey(),
        identityId,
        model,
      });

      if (response.status === 200) {
        setRevision((current) => current + 1);
        setError(undefined);
      } else {
        setError(`The core refused that default model for ${identityId}`);
      }
    },
    [transport],
  );

  /** Decision 0.25: the phone is told, so it is not a screen you have to remember to look at. */
  const [push, setPush] = useState<PushState | undefined>(initialPushState);
  const [pushBusy, setPushBusy] = useState(false);
  /**
   * Why the last attempt ended where it did.
   *
   * `PUSH_STATUS` says which of four states this device is in; it cannot say
   * which step produced it, and the four steps fail for entirely different
   * reasons. A card that says only "it did not work" sends the owner to check
   * the one thing they can see — permission — when the cause is usually a step
   * further in that nothing surfaces.
   */
  const [pushDetail, setPushDetail] = useState<string>();

  const turnOnPush = useCallback(async () => {
    if (transport === undefined) {
      return;
    }

    setPushBusy(true);
    setPushDetail(undefined);
    setPush(await enablePush(transport, globalThis, setPushDetail));
    setPushBusy(false);
  }, [transport]);

  /**
   * The client half of the cascade.
   *
   * `push_subscriptions.session_id` cascades from `sessions`, and a session
   * lasts `NOCTIS_SESSION_TTL_HOURS` — thirty days by default. When it expires
   * and the next login sweeps it, the core loses this device's subscription
   * while the browser still holds a live `PushSubscription` and a granted
   * permission. Nothing in the browser can notice: the phone simply stops
   * ringing, and a card that read permission alone would still say it was on.
   *
   * So re-post it on every visit to this page. `pushManager.subscribe` returns
   * the subscription the browser already has, and the core's
   * `ON CONFLICT (endpoint) DO UPDATE SET session_id` rebinds the row to the
   * current session. No prompt: permission is already granted, so
   * `requestPermission` resolves without asking.
   */
  useEffect(() => {
    if (transport === undefined || initialPushState() !== "enabled") {
      return;
    }

    let cancelled = false;

    void enablePush(transport, globalThis, (detail) => {
      if (!cancelled) {
        setPushDetail(detail);
      }
    }).then((state) => {
      if (!cancelled) {
        setPush(state);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [transport]);

  /**
   * `POST /session/logout` was implemented, tested, and called by nothing — so
   * the only way off a borrowed or shared browser was to wait thirty days.
   *
   * The page returns to the login screen whether or not the core answered: the
   * in-memory CSRF value is gone either way, and staying on a workbench that
   * cannot write would be a worse answer than asking to log in again. A refusal
   * does leave the cookie alive on this device, which is the honest ceiling — a
   * lost phone is closed by deleting the row, not from the phone.
   */
  const signOut = useCallback(async () => {
    if (onSignedOut === undefined) {
      return;
    }

    try {
      await transport?.request("POST", "/session/logout", {});
    } catch {
      /* the session is being abandoned regardless of what the core said */
    }

    onSignedOut();
  }, [transport, onSignedOut]);

  const live = permissions.filter((permission) => permission.revokedAt === undefined);
  const revoked = permissions.filter((permission) => permission.revokedAt !== undefined);

  return (
    <Page title="Settings" subtitle="Defaults, notifications and standing permissions">
      <section style={{ ...glass, padding: spacing.lg, display: "grid", gap: spacing.md }}>
        <SectionHeading>Default model</SectionHeading>
        <p style={{ margin: 0, maxWidth: typography.measurePx, color: typography.color.muted }}>
          What each identity runs on when a prompt does not choose. The list is what connected nodes
          offer right now; a model appears here as data, never as a role.
        </p>
        {IDENTITY_PROFILES.map((profile) => {
          const current = models?.defaults[profile.id];
          const currentKey = current === undefined ? "" : modelKey(current);
          const catalogue = models?.catalogue ?? [];
          // The saved default stays selectable even while no node offers it, so
          // the control shows the truth rather than the first available option.
          const options =
            current !== undefined && !catalogue.some((model) => modelKey(model) === currentKey)
              ? [current, ...catalogue]
              : catalogue;

          return (
            <label key={profile.id} style={{ display: "grid", gap: spacing.xs, maxWidth: 420 }}>
              <span>{profile.displayName}</span>
              <select
                value={currentKey}
                disabled={transport === undefined || options.length === 0}
                onChange={(event) => {
                  const chosen = options.find((model) => modelKey(model) === event.target.value);

                  if (chosen !== undefined) {
                    void setDefaultModel(profile.id, chosen);
                  }
                }}
                style={fieldStyle}
              >
                {current === undefined && (
                  <option value="">
                    {options.length === 0 ? "No model offered by any node" : "Not set"}
                  </option>
                )}
                {options.map((model) => (
                  <option key={modelKey(model)} value={modelKey(model)}>
                    {modelLabel(model)}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </section>

      <section style={{ ...glass, padding: spacing.lg, display: "grid", gap: spacing.md }}>
        <SectionHeading>Notifications</SectionHeading>
        <p style={{ margin: 0, maxWidth: typography.measurePx, color: typography.color.muted }}>
          This device is told when an approval is waiting and when a turn fails or is blocked —
          those two, and nothing else. Per device: turning them on here does not turn them on
          anywhere else you are logged in.
        </p>
        <p style={{ margin: 0 }}>{PUSH_STATUS[push ?? "off"]}</p>
        {pushDetail !== undefined && (
          <p
            style={{
              margin: 0,
              maxWidth: typography.measurePx,
              color: typography.color.muted,
              font: `${String(typography.scale.sm)}px ${typography.monoFamily}`,
            }}
          >
            Last attempt: {pushDetail}
          </p>
        )}
        {/*
          Still offered when it is already on. The core can lose this device's
          subscription without the browser ever finding out — the session it
          hung off expired — and while the page re-registers on its own each
          time it opens, a person who thinks the phone has gone quiet needs
          something to press rather than advice to clear their site data.
        */}
        {push !== "unsupported" && (
          <div>
            <button
              type="button"
              disabled={transport === undefined || pushBusy}
              onClick={() => {
                void turnOnPush();
              }}
              style={buttonStyle}
            >
              {push === "enabled" ? "Re-register this device" : "Turn on notifications"}
            </button>
          </div>
        )}
      </section>

      <section style={{ ...glass, padding: spacing.lg, display: "grid", gap: spacing.md }}>
        <SectionHeading>Standing permissions</SectionHeading>
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
        <section style={{ ...glass, padding: spacing.lg, display: "grid", gap: spacing.md }}>
          <SectionHeading>Revoked</SectionHeading>
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

      {onSignedOut !== undefined && (
        <section style={{ ...glass, padding: spacing.lg, display: "grid", gap: spacing.md }}>
          <SectionHeading>This browser</SectionHeading>
          <p style={{ margin: 0, maxWidth: typography.measurePx, color: typography.color.muted }}>
            Signing out ends this browser&apos;s session and asks for the core token again. It
            affects nothing anywhere else, and it does not turn notifications off — this device
            stops being told when the core forgets the subscription that hung off the session.
          </p>
          <div>
            <button
              type="button"
              onClick={() => {
                void signOut();
              }}
              style={buttonStyle}
            >
              Sign out
            </button>
          </div>
        </section>
      )}

      {error !== undefined && <p style={{ color: semantic.error, margin: 0 }}>{error}</p>}
    </Page>
  );
}

/**
 * Said plainly, because every one of these is a different thing to do next. The
 * iOS sentence is the one that matters most: Safari has no `Notification` at
 * all until the page is on the Home Screen, so "unsupported" there means "not
 * yet" rather than "never".
 */
const PUSH_STATUS: Readonly<Record<PushState | "off", string>> = {
  enabled: "Notifications are on for this device.",
  denied: "Notifications are blocked in browser settings. Allow them there, then reload.",
  unsupported:
    "This browser does not support notifications. On an iPhone, add Noctis to the Home Screen and open it from there.",
  failed:
    "Notifications could not be turned on. The core refused the subscription or could not be reached — this browser is capable, so try again, and check the core has its VAPID keys.",
  off: "Notifications are off for this device.",
};

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
            <button type="button" onClick={onRevoke} style={buttonStyle}>
              Revoke {permission.capability}
            </button>
          </div>
        )
      )}
    </li>
  );
}

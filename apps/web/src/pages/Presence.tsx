import {
  IDENTITY_PROFILES,
  IntelligenceRenderer,
  depth,
  material,
  promptPlaceholder,
  semantic,
  spacing,
  typography,
} from "@noctis/ui";

import type { CoreTransport } from "../transport/CoreTransport.js";
import { useIdentityRuntime } from "../identities/useIdentityRuntime.js";

export interface PresenceProps {
  transport: CoreTransport | undefined;
}

/** Phase 5's outcome: "Presence renders Vesper" and switches to Jester on command. */
export function Presence({ transport }: PresenceProps): JSX.Element {
  const { activeIdentityId, protocolIds, activate, toggleNoir, error } =
    useIdentityRuntime(transport);
  const identityId = activeIdentityId ?? "vesper";

  return (
    <section
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: spacing.xl,
        background: depth.floor,
        color: "#E7E6EE",
        fontFamily: typography.family,
      }}
    >
      <IntelligenceRenderer identityId={identityId} protocolIds={protocolIds} />

      <input
        aria-label={`Message ${IDENTITY_PROFILES.find((p) => p.id === identityId)?.displayName ?? identityId}`}
        placeholder={promptPlaceholder(identityId)}
        style={{
          width: 420,
          padding: `${String(spacing.sm)}px ${String(spacing.md)}px`,
          background: material.fill,
          border: `1px solid ${material.border}`,
          borderRadius: spacing.md,
          color: "inherit",
          fontSize: typography.scale.base,
        }}
      />

      <div style={{ display: "flex", gap: spacing.sm }}>
        {IDENTITY_PROFILES.map((profile) => (
          <button
            key={profile.id}
            type="button"
            aria-pressed={profile.id === identityId}
            onClick={() => {
              void activate(profile.id);
            }}
            style={{
              padding: `${String(spacing.xs)}px ${String(spacing.md)}px`,
              background: profile.id === identityId ? material.fillElevated : "transparent",
              border: `1px solid ${material.border}`,
              borderRadius: spacing.sm,
              color: "inherit",
              cursor: "pointer",
            }}
          >
            {profile.activationCommand}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={protocolIds.includes("noir")}
          onClick={toggleNoir}
          style={{
            padding: `${String(spacing.xs)}px ${String(spacing.md)}px`,
            background: protocolIds.includes("noir") ? material.fillElevated : "transparent",
            border: `1px solid ${material.border}`,
            borderRadius: spacing.sm,
            color: "inherit",
            cursor: "pointer",
          }}
        >
          NOIR
        </button>
      </div>

      {error !== undefined && <p style={{ color: semantic.error }}>{error}</p>}
      {transport === undefined && (
        <p style={{ color: semantic.stale }}>
          No core transport available — run inside the desktop shell, or set VITE_CORE_URL and
          VITE_CORE_TOKEN for local development.
        </p>
      )}
    </section>
  );
}

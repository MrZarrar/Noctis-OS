import type { ModelRef } from "@noctis/contracts";
import {
  IDENTITY_PROFILES,
  IntelligenceRenderer,
  depth,
  material,
  semantic,
  spacing,
  typography,
} from "@noctis/ui";

import { PromptForm } from "../conversation/PromptForm.js";
import type { ConversationState } from "../conversation/useConversation.js";
import type { IdentityRuntimeState } from "../identities/useIdentityRuntime.js";
import type { CoreTransport } from "../transport/CoreTransport.js";

export interface PresenceProps {
  /**
   * Owned above this page, not created here. Two `useIdentityRuntime` calls would
   * be two fetches and two copies of "which identity is active" that could
   * disagree — and the one that lost would be the one steering the canvas.
   */
  identity: IdentityRuntimeState;
  transport: CoreTransport | undefined;
  /** The same conversation Chat shows; Presence only needs its model catalogue. */
  conversation: Pick<ConversationState, "models" | "defaultModel" | "canAttach">;
  /** Sends on the active identity's thread and takes the rail to Chat. */
  onSend: (text: string, model?: ModelRef) => void;
}

/** Phase 5's outcome: "Presence renders Vesper" and switches to Jester on command. */
export function Presence({
  identity,
  transport,
  conversation,
  onSend,
}: PresenceProps): JSX.Element {
  const { activeIdentityId, protocolIds, activate, toggleNoir, error } = identity;
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

      <div style={{ width: 480 }}>
        <PromptForm
          identityId={identityId}
          models={conversation.models}
          defaultModel={conversation.defaultModel}
          disabled={transport === undefined}
          canAttach={conversation.canAttach}
          onSend={onSend}
        />
      </div>

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

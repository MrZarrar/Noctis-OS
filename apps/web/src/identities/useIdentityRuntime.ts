import type { ConversationalIdentityId, ProtocolId } from "@noctis/contracts";
import { useCallback, useEffect, useState } from "react";

import type { CoreTransport } from "../transport/CoreTransport.js";

export interface IdentityRuntimeState {
  activeIdentityId: ConversationalIdentityId | undefined;
  /**
   * The Objective this identity was last working on, read back from its own
   * thread. This is what the workbench restores to after a restart, and it is
   * per-identity for the same reason threads are: Jester must not resume into
   * Vesper's work.
   */
  activeObjectiveId: string | undefined;
  protocolIds: readonly ProtocolId[];
  activate: (identityId: ConversationalIdentityId) => Promise<void>;
  setActiveObjectiveId: (objectiveId: string | undefined) => void;
  toggleNoir: () => void;
  error: string | undefined;
}

let activationCounter = 0;

/**
 * Loads the persisted active identity once, then activates through
 * `identity.activate` on every explicit switch (Section 6: "no implicit
 * identity switching"). NOIR is local UI state, not a command — activating it
 * never touches `identity_threads`, which is what makes "NOIR preserves the
 * active identity" true by construction rather than by convention.
 */
export function useIdentityRuntime(transport: CoreTransport | undefined): IdentityRuntimeState {
  const [activeIdentityId, setActiveIdentityId] = useState<ConversationalIdentityId>();
  const [activeObjectiveId, setActiveObjectiveId] = useState<string>();
  const [protocolIds, setProtocolIds] = useState<readonly ProtocolId[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (transport === undefined) {
      return;
    }

    let cancelled = false;

    transport
      .request("GET", "/identities")
      .then((response) => {
        if (cancelled || response.status !== 200) {
          return;
        }

        const body = response.body as {
          activeIdentityId?: ConversationalIdentityId | null;
          threads?: Array<{ identityId: ConversationalIdentityId; activeObjectiveId?: string }>;
        };

        if (body.activeIdentityId !== null && body.activeIdentityId !== undefined) {
          setActiveIdentityId(body.activeIdentityId);
        }

        // The restore point. Falling back to whichever identity is active means
        // a first run with no persisted identity still finds its Objective.
        const identityId = body.activeIdentityId ?? "vesper";
        const thread = body.threads?.find((candidate) => candidate.identityId === identityId);

        setActiveObjectiveId(thread?.activeObjectiveId);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "failed to load identities");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [transport]);

  const activate = useCallback(
    async (identityId: ConversationalIdentityId) => {
      if (transport === undefined) {
        return;
      }

      activationCounter += 1;

      const response = await transport.request("POST", "/commands/identity.activate", {
        idempotencyKey: `web-activate-${String(activationCounter)}-${String(Date.now())}`,
        identityId,
      });

      if (response.status === 200) {
        setActiveIdentityId(identityId);
        setError(undefined);
      } else {
        setError(`Could not activate ${identityId}`);
      }
    },
    [transport],
  );

  const toggleNoir = useCallback(() => {
    setProtocolIds((current) => (current.includes("noir") ? [] : ["noir"]));
  }, []);

  return {
    activeIdentityId,
    activeObjectiveId,
    protocolIds,
    activate,
    setActiveObjectiveId,
    toggleNoir,
    error,
  };
}

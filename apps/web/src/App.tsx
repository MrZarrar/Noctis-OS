import type { ModelRef } from "@noctis/contracts";
import { Rail, depth, typography } from "@noctis/ui";
import type { RailItem } from "@noctis/ui";
import { useState } from "react";

import { useConversation } from "./conversation/useConversation.js";
import { coreBaseUrl, needsLogin, resolveCoreTransport } from "./core-client.js";
import { useIdentityRuntime } from "./identities/useIdentityRuntime.js";
import { Artifacts } from "./pages/Artifacts.js";
import { Chat } from "./pages/Chat.js";
import { Command } from "./pages/Command.js";
import { Login } from "./pages/Login.js";
import { Settings } from "./pages/Settings.js";
import { Vault } from "./pages/Vault.js";
import type { CoreTransport } from "./transport/CoreTransport.js";

/**
 * Where the workbench came from when it jumped to the Vault.
 *
 * Section 7 asks for "Open in Vault and return-to-objective preserve selection
 * and composition context". Keeping the return destination and the focused
 * entity here — above both pages — is what makes the jump a round trip: Command
 * keeps its own state while Vault is showing, so returning restores it rather
 * than rebuilding it.
 */
interface VaultHandoff {
  entityId: string;
  returnTo: RailItem;
}

/**
 * A page with no token cannot build a transport until it has a session, and it
 * cannot run the hooks below until it has a transport — React forbids calling
 * them conditionally. So the gate is a component split: `App` decides, and
 * `Workbench` is everything that needs a reachable core.
 *
 * A dev build that was handed a token, and the packaged shell, never see the
 * login screen: `needsLogin` is false and the transport exists immediately.
 */
export function App(): JSX.Element {
  const [csrf, setCsrf] = useState<string>();

  if (needsLogin() && csrf === undefined) {
    return <Login baseUrl={coreBaseUrl()} onAuthenticated={setCsrf} />;
  }

  // Rebuilt only when `csrf` changes, because that is the only state this
  // component holds; everything that re-renders often lives in `Workbench`.
  return <Workbench transport={resolveCoreTransport(csrf)} />;
}

function Workbench({ transport }: { transport: CoreTransport | undefined }): JSX.Element {
  const [active, setActive] = useState<RailItem>("Command");
  const [handoff, setHandoff] = useState<VaultHandoff>();

  // Identity and conversation live here, above Command and Chat, so Presence's
  // prompt and Chat's history are one thread with one subscription (0.12).
  const identity = useIdentityRuntime(transport);
  const identityId = identity.activeIdentityId ?? "vesper";
  const conversation = useConversation(transport, identityId, identity.activeObjectiveId);

  const openInVault = (entityId: string): void => {
    setHandoff({ entityId, returnTo: active });
    setActive("Vault");
  };

  const sendAndShow = (text: string, model?: ModelRef): void => {
    void conversation.send(text, model);
    setActive("Chat");
  };

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        background: depth.floor,
        color: typography.color.primary,
        fontFamily: typography.family,
      }}
    >
      <Rail
        active={active}
        onSelect={(item) => {
          if (item !== "Vault") {
            setHandoff(undefined);
          }

          setActive(item);
        }}
      />

      {/* Command stays mounted while the Vault is showing, so returning to it
          finds the composition it had rather than a fresh one. */}
      <div style={{ display: active === "Command" ? "contents" : "none" }}>
        <Command
          transport={transport}
          identity={identity}
          conversation={conversation}
          onSend={sendAndShow}
          onOpenInVault={openInVault}
        />
      </div>

      {active === "Chat" && (
        <Chat
          identityId={identityId}
          conversation={conversation}
          connected={transport !== undefined}
        />
      )}

      {active === "Vault" && (
        <Vault
          transport={transport}
          {...(handoff === undefined ? {} : { focusId: handoff.entityId })}
          {...(handoff === undefined
            ? {}
            : {
                onReturn: () => {
                  setActive(handoff.returnTo);
                  setHandoff(undefined);
                },
              })}
        />
      )}

      {active === "Artifacts" && <Artifacts transport={transport} />}

      {active === "Settings" && <Settings transport={transport} />}

      {active !== "Command" &&
        active !== "Chat" &&
        active !== "Vault" &&
        active !== "Artifacts" &&
        active !== "Settings" && (
          <section
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {active} is not built yet — later phases add it behind this same rail.
          </section>
        )}
    </div>
  );
}

import {
  Rail,
  TAB_BAR_HEIGHT,
  TabBar,
  corner,
  depth,
  material,
  spacing,
  tabsFor,
  typography,
} from "@noctis/ui";
import type { RailItem } from "@noctis/ui";
import { useEffect, useMemo, useRef, useState } from "react";

import type { SendOptions } from "./conversation/useConversation.js";
import { useConversation } from "./conversation/useConversation.js";
import { coreBaseUrl, needsLogin, resolveCoreTransport } from "./core-client.js";
import { useIdentityRuntime } from "./identities/useIdentityRuntime.js";
import { useIsMobile } from "./layout/useIsMobile.js";
import { Artifacts } from "./pages/Artifacts.js";
import { Chat } from "./pages/Chat.js";
import { Command } from "./pages/Command.js";
import { Login } from "./pages/Login.js";
import { Missions } from "./pages/Missions.js";
import { Settings } from "./pages/Settings.js";
import { Vault } from "./pages/Vault.js";
import { resumeSession } from "./session/login.js";
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
  // "Log in once" is a promise about the cookie, not about this variable: the
  // cookie lasts thirty days and the CSRF value dies with the page. So every
  // boot asks the core to re-mint it before concluding anyone has to log in —
  // otherwise a reload, an evicted tab, a Home Screen cold start or a tapped
  // notification is a token prompt with a valid session already in hand.
  const [resuming, setResuming] = useState(needsLogin);

  useEffect(() => {
    if (!needsLogin()) {
      return;
    }

    let cancelled = false;

    void resumeSession(coreBaseUrl()).then((resumed) => {
      if (cancelled) {
        return;
      }

      if (resumed !== undefined) {
        setCsrf(resumed);
      }

      setResuming(false);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  // The transport's identity is load-bearing, not an optimisation: it is the
  // dependency of `useIdentityRuntime`'s effect and `useConversation`'s memo, so
  // a fresh object on every render tears down and reopens the SSE subscription
  // every time. It used to be a module-level `const`, which was maximally
  // stable; this keeps that, keyed on the only thing that can change it.
  const transport = useMemo(() => resolveCoreTransport(csrf), [csrf]);

  if (needsLogin() && csrf === undefined) {
    // Nothing but the floor while the core is asked. Drawing the login screen
    // first would flash a token prompt at an owner who does not need one.
    return resuming ? (
      <main style={{ height: "100vh", background: depth.floor }} aria-busy="true" />
    ) : (
      <Login baseUrl={coreBaseUrl()} onAuthenticated={setCsrf} />
    );
  }

  return (
    <Workbench
      transport={transport}
      {...(needsLogin()
        ? {
            onSignedOut: () => {
              setCsrf(undefined);
              setResuming(false);
            },
          }
        : {})}
    />
  );
}

function Workbench({
  transport,
  onSignedOut,
}: {
  transport: CoreTransport | undefined;
  /** Absent for the packaged shell and a token build, which have no session to end. */
  onSignedOut?: () => void;
}): JSX.Element {
  const [active, setActive] = useState<RailItem>("Command");
  const [handoff, setHandoff] = useState<VaultHandoff>();
  const isMobile = useIsMobile();
  // No `open` state beside it: a `<dialog>` already knows whether it is open,
  // and `showModal` gives the focus trap and Escape-to-close that a hand-rolled
  // sheet would otherwise need a library for.
  const moreRef = useRef<HTMLDialogElement>(null);
  const { overflow } = tabsFor(active);

  // Identity and conversation live here, above Command and Chat, so Presence's
  // prompt and Chat's history are one thread with one subscription (0.12).
  const identity = useIdentityRuntime(transport);
  const identityId = identity.activeIdentityId ?? "vesper";
  /**
   * Which of the identity's two threads is being talked on.
   *
   * Slice 1 left free chat unreachable: an active Objective made
   * `activeObjectiveId` the only thread anything could name, so a question that
   * had nothing to do with the work in progress had to be asked inside it — or
   * the Objective had to be paused first. The flag lives here rather than in
   * Chat because Presence sends on the same thread Chat shows (0.12), and two
   * copies of "which thread" could disagree.
   */
  const [freeThread, setFreeThread] = useState(false);
  const objectiveId = freeThread ? undefined : identity.activeObjectiveId;
  const conversation = useConversation(transport, identityId, objectiveId);

  const openInVault = (entityId: string): void => {
    setHandoff({ entityId, returnTo: active });
    setActive("Vault");
  };

  const sendAndShow = (text: string, options: SendOptions): void => {
    void conversation.send(text, options);
    setActive("Chat");
  };

  const select = (item: RailItem): void => {
    if (item !== "Vault") {
      setHandoff(undefined);
    }

    setActive(item);
  };

  return (
    <div
      style={{
        display: "flex",
        // Side by side where there is width for it, stacked where there is
        // not: the rail's 72px column is 18% of a 400px phone.
        flexDirection: isMobile ? "column" : "row",
        boxSizing: "border-box",
        height: "100vh",
        // The bar is fixed, so it is out of flow and would otherwise sit on top
        // of the last row of whatever page is showing. The inset is in the sum
        // because the bar pads by it too — without it a phone with a home
        // indicator covers the last 34px of content.
        ...(isMobile
          ? {
              paddingBottom: `calc(${String(TAB_BAR_HEIGHT)}px + env(safe-area-inset-bottom))`,
            }
          : {}),
        background: depth.floor,
        color: typography.color.primary,
        fontFamily: typography.family,
      }}
    >
      {!isMobile && <Rail active={active} onSelect={select} />}

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
          // Only offered when there is a second thread to go to. Without an
          // active Objective, free chat is the only thread there is.
          {...(identity.activeObjectiveId === undefined
            ? {}
            : { freeThread, onUseFreeThread: setFreeThread })}
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

      {active === "Missions" && (
        <Missions
          transport={transport}
          onOpenChat={(turn) => {
            // The thread the turn ran on, not merely the Chat page: a turn
            // under an Objective is invisible from the free thread and vice
            // versa, and arriving at the wrong one looks like lost history.
            if (turn.identityId !== identityId) {
              void identity.activate(turn.identityId);
            }

            setFreeThread(turn.objectiveId === undefined);
            setActive("Chat");
          }}
        />
      )}

      {active === "Artifacts" && <Artifacts transport={transport} />}

      {active === "Settings" && (
        <Settings transport={transport} {...(onSignedOut === undefined ? {} : { onSignedOut })} />
      )}

      {active !== "Command" &&
        active !== "Chat" &&
        active !== "Vault" &&
        active !== "Missions" &&
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
            {active} is not built yet — later phases add it behind this same navigation.
          </section>
        )}

      {/* After the pages in source order, never before them: a bottom bar that
          comes first is the first thing a screen reader announces on every
          page it visits. Fixed positioning puts it back at the bottom. */}
      {isMobile && (
        <>
          <TabBar
            active={active}
            onSelect={select}
            onMore={() => {
              moreRef.current?.showModal();
            }}
          />

          <dialog
            ref={moreRef}
            aria-label="More"
            style={{
              margin: "auto auto 0",
              width: "min(100%, 480px)",
              border: `1px solid ${material.border}`,
              borderRadius: `${String(corner.lg)}px ${String(corner.lg)}px 0 0`,
              background: depth.layers[1],
              color: typography.color.primary,
              fontFamily: typography.family,
              padding: spacing.md,
              paddingBottom: `calc(${String(spacing.md)}px + env(safe-area-inset-bottom))`,
            }}
          >
            <div style={{ display: "grid", gap: spacing.xs }}>
              {overflow.map((item) => (
                <button
                  key={item}
                  type="button"
                  onClick={() => {
                    select(item);
                    moreRef.current?.close();
                  }}
                  style={moreButtonStyle}
                >
                  {item}
                </button>
              ))}

              <button
                type="button"
                onClick={() => {
                  moreRef.current?.close();
                }}
                style={moreButtonStyle}
              >
                Close
              </button>
            </div>
          </dialog>
        </>
      )}
    </div>
  );
}

const moreButtonStyle = {
  minHeight: 44,
  font: `${String(typography.scale.sm)}px ${typography.family}`,
  textAlign: "left",
  color: "inherit",
  background: material.fill,
  border: `1px solid ${material.border}`,
  borderRadius: corner.md,
  padding: `${String(spacing.sm)}px ${String(spacing.md)}px`,
  cursor: "pointer",
} as const;

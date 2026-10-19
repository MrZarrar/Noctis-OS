import type { ConversationalIdentityId } from "@noctis/contracts";
import { ConversationThreadSchema } from "@noctis/contracts";
import { linkedThread } from "./navigation/thread-link.js";
import {
  HIDDEN_ITEMS,
  NAV_ITEMS,
  NavIcon,
  NoctisMark,
  Rail,
  TAB_BAR_HEIGHT,
  TabBar,
  corner,
  depth,
  elevation,
  identityAccent,
  material,
  spacing,
  typography,
} from "@noctis/ui";
import type { RailItem } from "@noctis/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CompanionCore, useComposerFocus } from "./companion/CompanionCore.js";
import { guardStrayFileDrops } from "./conversation/file-drops.js";
import type { RuntimeRootOption } from "./conversation/useConversation.js";
import { useConversation } from "./conversation/useConversation.js";
import { coreBaseUrl, needsLogin, resolveCoreTransport } from "./core-client.js";
import { useWaitingCount } from "./notify/useWaitingCount.js";
import { useIdentityRuntime } from "./identities/useIdentityRuntime.js";
import { useIsMobile } from "./layout/useIsMobile.js";
import type { HistoryEntry } from "./navigation/back.js";
import { entryPage, pushPage, useBackLayer } from "./navigation/back.js";
import { Productivity } from "./pages/Productivity.js";
import { Approvals } from "./pages/Approvals.js";
import { Health } from "./pages/Health.js";
import { useHealth } from "./health/useHealth.js";
import { Artifacts } from "./pages/Artifacts.js";
import { Files } from "./pages/Files.js";
import type { FileTarget } from "./pages/files-view.js";
import { Login } from "./pages/Login.js";
import { Missions } from "./pages/Missions.js";
import { Nodes } from "./pages/Nodes.js";
import { Presence } from "./pages/Presence.js";
import { Settings } from "./pages/Settings.js";
import { Threads } from "./pages/Threads.js";
import { Vault } from "./pages/Vault.js";
import { resumeSession } from "./session/login.js";
import { useShowAllPages } from "./pages/CoreSettings.js";
import type { CoreTransport } from "./transport/CoreTransport.js";
import type { SurfaceContext } from "./surfaces/renderers.js";

/**
 * Where the workbench came from when it jumped to the Vault.
 *
 * Section 7 asks for "Open in Vault and return-to-objective preserve selection
 * and composition context". Keeping the return destination and the focused
 * entity here — above both pages — makes the jump a round trip. The core
 * retains the owner's composition when the conversation returns.
 */
interface VaultHandoff {
  entityId: string;
  returnTo: RailItem;
}

/**
 * Missions, Artifacts and Automations predate v1's narrower product.
 * They stay built and working, and a build with this flag offers them again.
 */
/** The build-time switch, used until the core says what the owner chose in Settings. */
const ALL_PAGES_AT_BUILD = import.meta.env.VITE_NOCTIS_ALL_PAGES === "1";

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

  useEffect(() => guardStrayFileDrops(window), []);

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
  const [productivityFocus, setProductivityFocus] = useState<{ id: string; task: boolean }>();
  const [active, setActive] = useState<RailItem>("Presence");
  const initialThreadLink = useRef(linkedThread(window.location.href));
  const [linkError, setLinkError] = useState<string>();
  const [handoff, setHandoff] = useState<VaultHandoff>();
  /** A file a thread offered, for Files to open when it next mounts. */
  const [fileTarget, setFileTarget] = useState<FileTarget<RuntimeRootOption>>();
  const isMobile = useIsMobile();
  // No `open` state beside it: a `<dialog>` already knows whether it is open,
  // and `showModal` gives the focus trap and Escape-to-close that a hand-rolled
  // sheet would otherwise need a library for.
  const moreRef = useRef<HTMLDialogElement>(null);

  // Identity and conversation live here, above Presence and Threads, so
  // Presence's prompt and the thread's history are one thread with one
  // subscription (0.12).
  const identity = useIdentityRuntime(transport);
  const identityId = identity.activeIdentityId ?? "vesper";
  /**
   * Which of the identity's two threads is being talked on.
   *
   * Slice 1 left free chat unreachable: an active Objective made
   * `activeObjectiveId` the only thread anything could name, so a question that
   * had nothing to do with the work in progress had to be asked inside it — or
   * the Objective had to be paused first. The flag lives here rather than in
   * Threads because Presence sends on the same thread Threads shows (0.12),
   * and two copies of "which thread" could disagree.
   */
  const [freeThread, setFreeThread] = useState(true);
  const objectiveId = freeThread ? undefined : identity.activeObjectiveId;
  /** A delegated thread the owner opened; undefined is the identity's own thread. */
  const [openThreadId, setOpenThreadId] = useState<string | undefined>(undefined);
  const [threadsList, setThreadsList] = useState(false);
  const listOpened = useCallback(() => setThreadsList(false), []);
  // Unlike the layers inside a page, an open thread stays open across a page
  // change, so its history entry does too.
  const threadLayer = useBackLayer(
    "thread",
    openThreadId !== undefined,
    () => {
      setOpenThreadId(undefined);
    },
    true,
  );
  /** Opening a thread is something back undoes; going to the free thread is closing one. */
  const openThread = (threadId: string | undefined): void => {
    setOpenThreadId(threadId);
    if (threadId === undefined) {
      threadLayer.dismiss();
    } else {
      threadLayer.pushed();
    }
  };
  const conversation = useConversation(transport, identityId, objectiveId, openThreadId);
  const listening = useComposerFocus();
  /** An open conversation belongs to the identity it was opened under, so switching leaves it. */
  const switchIdentity = (next: ConversationalIdentityId): void => {
    threadLayer.dismiss();
    void identity.activate(next);
  };
  /** What waits on the owner, on the Approvals tab wherever they are, and new health suggestions. */
  const counts = {
    Approvals: useWaitingCount(transport),
    Health: useHealth(transport).status?.proposed ?? 0,
  };
  const allPages = useShowAllPages(transport) ?? ALL_PAGES_AT_BUILD;

  // Every move to another page is a history entry, so back lands on the page before.
  const show = (item: RailItem, replace = false): void => {
    if (item !== active) {
      pushPage(item, replace);
    }
    setActive(item);
  };

  /** What arriving on a page resets, whether by a tap or by going back to it. */
  const arrive = (item: RailItem): void => {
    if (item === "Presence") {
      setOpenThreadId(undefined);
      setFreeThread(true);
    }
    if (item !== "Vault") {
      setHandoff(undefined);
    }
  };

  // The first entry names the page the app opened on; back from any page
  // lands on the one before it.
  useEffect(() => {
    history.replaceState({ page: "Presence", depth: 0 } satisfies HistoryEntry, "");
    const onPop = (event: PopStateEvent): void => {
      const page = entryPage(event.state);
      if (page !== undefined) {
        arrive(page);
        setActive(page);
      }
    };
    addEventListener("popstate", onPop);
    return () => {
      removeEventListener("popstate", onPop);
    };
  }, []);

  const openInVault = (entityId: string): void => {
    setHandoff({ entityId, returnTo: active });
    show("Vault");
  };

  const openMissionChat = (turn: {
    identityId: ConversationalIdentityId;
    threadId: string;
    objectiveId?: string | undefined;
  }): void => {
    if (turn.identityId !== identityId) void identity.activate(turn.identityId);
    setFreeThread(turn.objectiveId === undefined);
    show("Threads");
    openThread(turn.threadId);
  };
  const openTaskThread = (id: string): void => {
    if (!transport) return;
    setLinkError(undefined);
    void transport
      .request("GET", `/threads/${id}`)
      .then(async (response) => {
        const parsed = ConversationThreadSchema.safeParse(response.body);
        if (response.status !== 200 || !parsed.success)
          throw new Error("This task thread could not be opened.");
        await identity.activate(parsed.data.identityId);
        setFreeThread(parsed.data.objectiveId === undefined);
        show("Threads");
        openThread(id);
      })
      .catch((error: unknown) =>
        setLinkError(
          error instanceof Error ? error.message : "This task thread could not be opened.",
        ),
      );
  };
  const renderPage: NonNullable<SurfaceContext["renderPage"]> = (payload) => {
    switch (payload.page) {
      case "Files": {
        const folder = payload.folder;
        const root = conversation.roots.find(
          (root) => root.nodeId === folder?.nodeId && root.grantId === folder.grantId,
        );
        return (
          <Files
            roots={conversation.roots}
            transport={transport}
            {...(root === undefined || folder === undefined
              ? {}
              : { contextFiles: { root, relativePath: folder.relativePath } })}
          />
        );
      }
      case "Vault":
        return (
          <Vault
            transport={transport}
            {...(payload.focusId === undefined ? {} : { focusId: payload.focusId })}
          />
        );
      case "Health":
        return <Health transport={transport} />;
      case "Reminders":
      case "To-dos":
      case "Notes":
        return (
          <Productivity
            page={payload.page}
            transport={transport}
            roots={conversation.roots}
            models={conversation.models}
            onOpenThread={openTaskThread}
          />
        );
      case "Approvals":
        return <Approvals transport={transport} />;
      case "Nodes":
        return <Nodes transport={transport} />;
      case "Missions":
        return <Missions transport={transport} onOpenChat={openMissionChat} />;
      case "Artifacts":
        return <Artifacts transport={transport} />;
      case "Settings":
        return (
          <Settings transport={transport} {...(onSignedOut === undefined ? {} : { onSignedOut })} />
        );
    }
  };

  useEffect(() => {
    const id = initialThreadLink.current;
    if (!transport || !id) return;
    initialThreadLink.current = undefined;
    const url = new URL(window.location.href);
    url.searchParams.delete("thread");
    history.replaceState(history.state, "", url);
    openTaskThread(id);
  }, [transport]);

  /** `list` false is the core's way in: it means "the chat I am in", not "my chats". */
  const select = (item: RailItem, list = true): void => {
    setProductivityFocus(undefined);
    if (item === "Threads" && list) {
      setThreadsList(true);
    }
    if (item === "Presence" && openThreadId !== undefined) {
      void threadLayer.closed().then(() => {
        arrive(item);
        show(item);
      });
      return;
    }
    arrive(item);
    show(item);
  };

  return (
    <div
      style={{
        display: "flex",
        // Side by side where there is width for it, stacked where there is
        // not: a rail column is a fifth of a 400px phone.
        flexDirection: isMobile ? "column" : "row",
        boxSizing: "border-box",
        // The dynamic height, so a phone's collapsing address bar does not
        // leave the tab bar sitting below the fold.
        height: "100dvh",
        // The bar is fixed, so it is out of flow and would otherwise sit on top
        // of the last row of whatever page is showing. The inset is in the sum
        // because the bar pads by it too — without it a phone with a home
        // indicator covers the last 34px of content.
        ...(isMobile
          ? {
              paddingBottom: `calc(${String(TAB_BAR_HEIGHT)}px + env(safe-area-inset-bottom))`,
            }
          : {}),
        // The room the pages sit in. Darkened over the image so every ground
        // stays at the floor's depth and text keeps its contrast; the image
        // only shows through as light at the edges.
        background: `linear-gradient(180deg, rgba(5, 4, 9, 0.55), rgba(5, 4, 9, 0.78)), url(${isMobile ? BACKDROP_PORTRAIT : BACKDROP_LANDSCAPE}) center / cover no-repeat, ${depth.floor}`,
        color: typography.color.primary,
        fontFamily: typography.family,
      }}
    >
      {!isMobile && <Rail active={active} onSelect={select} allPages={allPages} counts={counts} />}

      {isMobile && (
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: spacing.sm,
            flexShrink: 0,
            padding: `calc(${String(spacing.xs)}px + env(safe-area-inset-top)) ${String(spacing.sm)}px ${String(spacing.xs)}px ${String(spacing.lg)}px`,
            borderBottom: `1px solid ${material.border}`,
            background: "rgba(5, 4, 9, 0.6)",
            backdropFilter: `blur(${String(material.blurPx)}px)`,
            WebkitBackdropFilter: `blur(${String(material.blurPx)}px)`,
            zIndex: elevation.rail,
          }}
        >
          <NoctisMark size={24} />
          <span
            style={{
              font: `600 ${String(typography.scale.xs)}px ${typography.family}`,
              letterSpacing: "0.32em",
            }}
          >
            NOCTIS
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            aria-label="Settings"
            aria-current={active === "Settings" ? "page" : undefined}
            onClick={() => {
              select("Settings");
            }}
            style={{
              display: "grid",
              placeItems: "center",
              width: 44,
              height: 44,
              color: active === "Settings" ? identityAccent.vesper.primary : typography.color.muted,
              background: "transparent",
              border: "none",
              borderRadius: corner.md,
              cursor: "pointer",
            }}
          >
            <NavIcon item="Settings" />
          </button>
        </header>
      )}

      <main style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex" }}>
        {linkError && <p role="alert">{linkError}</p>}
        {active === "Presence" && (
          <Presence
            onOpenTaskThread={openTaskThread}
            onOpenReminders={() => show("Reminders")}
            renderPage={renderPage}
            identity={identity}
            transport={transport}
            conversation={conversation}
            listening={listening}
            // Stays on Presence, where the core shows the turn (owner, 2026-10-09).
            onSend={(text, options) => {
              void conversation.send(text, options);
            }}
            onReview={() => show("Threads")}
            onOpenThread={() => show("Threads")}
            onSwitchIdentity={switchIdentity}
          />
        )}
        {active === "Threads" && (
          <Threads
            onOpenProductivity={(page, id, task) => {
              setProductivityFocus({ id, task: task ?? false });
              show(page);
            }}
            renderPage={renderPage}
            onOpenInVault={openInVault}
            identityId={identityId}
            conversation={conversation}
            connected={transport !== undefined}
            // Only offered when there is a second thread to go to. Without an
            // active Objective, free chat is the only thread there is.
            {...(identity.activeObjectiveId === undefined
              ? {}
              : { freeThread, onUseFreeThread: setFreeThread })}
            onOpenThread={openThread}
            openList={threadsList}
            onListOpened={listOpened}
            onSwitchIdentity={switchIdentity}
            transport={transport}
            onOpenFile={(target) => {
              setFileTarget(target);
              show("Files");
            }}
          />
        )}

        {active === "Files" && (
          <Files
            roots={conversation.roots}
            transport={transport}
            target={fileTarget}
            onTargetOpened={() => setFileTarget(undefined)}
          />
        )}

        {(active === "Reminders" || active === "To-dos" || active === "Notes") && (
          <Productivity
            key={productivityFocus?.id ?? active}
            {...(productivityFocus
              ? { focusId: productivityFocus.id, task: productivityFocus.task }
              : {})}
            page={active}
            transport={transport}
            roots={conversation.roots}
            models={conversation.models}
            onOpenThread={openTaskThread}
          />
        )}

        {active === "Approvals" && <Approvals transport={transport} />}

        {active === "Health" && <Health transport={transport} />}

        {active === "Vault" && (
          <Vault
            transport={transport}
            {...(handoff === undefined ? {} : { focusId: handoff.entityId })}
            {...(handoff === undefined
              ? {}
              : {
                  onReturn: () => {
                    show(handoff.returnTo);
                    setHandoff(undefined);
                  },
                })}
          />
        )}

        {active === "Missions" && <Missions transport={transport} onOpenChat={openMissionChat} />}

        {active === "Artifacts" && <Artifacts transport={transport} />}

        {active === "Nodes" && <Nodes transport={transport} />}

        {active === "Settings" && (
          <Settings transport={transport} {...(onSignedOut === undefined ? {} : { onSignedOut })} />
        )}

        {active === "Automations" && (
          <section
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            Automations is not built yet — later phases add it behind this same navigation.
          </section>
        )}
      </main>

      <CompanionCore
        page={active}
        identityId={identityId}
        protocolIds={identity.protocolIds}
        conversation={conversation}
        listening={listening}
        mobile={isMobile}
        onOpenThreads={() => {
          if (active === "Threads") {
            history.back();
          } else {
            select("Threads", false);
          }
        }}
      />

      {/* After the pages in source order, never before them: a bottom bar that
          comes first is the first thing a screen reader announces on every
          page it visits. Fixed positioning puts it back at the bottom. */}
      {isMobile && (
        <>
          <TabBar
            active={active}
            onSelect={select}
            counts={counts}
            onMore={() => moreRef.current?.showModal()}
          />

          {
            <dialog
              ref={moreRef}
              className="noctis-sheet"
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
                {[...NAV_ITEMS.slice(4), ...(allPages ? HIDDEN_ITEMS : [])].map((item) => (
                  <button
                    key={item}
                    type="button"
                    aria-current={item === active ? "page" : undefined}
                    onClick={() => {
                      select(item);
                      moreRef.current?.close();
                    }}
                    style={moreButtonStyle}
                  >
                    <NavIcon item={item} />
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
          }
        </>
      )}
    </div>
  );
}

const BACKDROP_PORTRAIT = "/assets/generated/backdrop-portrait.webp";
const BACKDROP_LANDSCAPE = "/assets/generated/backdrop-landscape.webp";

const moreButtonStyle = {
  display: "flex",
  alignItems: "center",
  gap: spacing.md,
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

import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../App.js";
import { installEditorTransport } from "../core-client.js";
import { MotionPolicy } from "../layout/motion.js";
import { PopoutProvider } from "../workbench/PopoutProvider.js";
import { SessionTransport } from "../transport/SessionTransport.js";
import { openEditorSession, setEditorSession, type EditorSession } from "./editor-session.js";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "../index.css";

const config = (window as unknown as { __NOCTIS_EDITOR_CHAT__?: { csrf: string } })
  .__NOCTIS_EDITOR_CHAT__;

function EditorApp(): JSX.Element {
  const [session, setSession] = useState<EditorSession>();
  const [failure, setFailure] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (config === undefined) {
      setFailure("Open this chat from Noctis Editor.");
      return;
    }
    let closed = false;
    let opening = false;
    let currentPath: string | undefined;
    installEditorTransport(new SessionTransport({ baseUrl: location.origin, csrf: config.csrf }));
    const open = async (): Promise<void> => {
      if (opening) return;
      opening = true;
      try {
        const next = await openEditorSession(config.csrf);
        if (closed) return;
        const url = new URL(location.href);
        url.searchParams.set("screen", "Threads");
        url.searchParams.set("thread", next.threadId);
        history.replaceState(null, "", url);
        currentPath = next.projectPath;
        setEditorSession(next);
        setSession(next);
        setFailure(undefined);
      } catch (error) {
        if (!closed) setFailure(error instanceof Error ? error.message : "Noctis is unavailable.");
      } finally {
        opening = false;
      }
    };
    void open();
    const timer = setInterval(() => {
      void fetch("/editor/session")
        .then(async (r) => {
          if (!r.ok || closed || currentPath === undefined) return;
          const next = (await r.json()) as { projectPath?: string };
          if (next.projectPath !== currentPath) await open();
        })
        .catch(() => {
          /* The normal Noctis transport reports a disconnected relay. */
        });
    }, 2000);
    return () => {
      closed = true;
      clearInterval(timer);
    };
  }, [attempt]);

  if (session === undefined || failure !== undefined) {
    return (
      <main style={{ padding: 20, color: "#e9e7ef" }}>
        <p role={failure === undefined ? "status" : "alert"}>
          {failure ?? "Connecting to Noctis..."}
        </p>
        {failure !== undefined && (
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </button>
        )}
      </main>
    );
  }
  return <App key={session.threadId} />;
}

const root = document.getElementById("root");
if (root !== null)
  createRoot(root).render(
    <StrictMode>
      <MotionPolicy>
        <PopoutProvider>
          <EditorApp />
        </PopoutProvider>
      </MotionPolicy>
    </StrictMode>,
  );

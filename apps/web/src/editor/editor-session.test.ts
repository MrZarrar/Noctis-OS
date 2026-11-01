import { describe, expect, it } from "vitest";
import {
  openEditorSession,
  setEditorSession,
  editorRootLabel,
  visibleEditorMessage,
} from "./editor-session.js";

describe("Editor chat session", () => {
  it("shows the enforced Editor folder and keeps machine context out of the displayed user text", () => {
    setEditorSession({
      threadId: "thread",
      rootGrantId: "editor",
      nodeId: "home",
      projectName: "Project",
      projectPath: "C:/Editor/project.ecproj",
    });
    expect(editorRootLabel([{ grantId: "editor", nodeId: "home", hostId: "home" }])).toBe(
      "NoctisEditor on home",
    );
    expect(
      visibleEditorMessage(
        "Make this larger\n\n<noctis-editor-context>\nThis message is from the side chat in Noctis Editor. Live context.\n</noctis-editor-context>",
      ),
    ).toBe("Make this larger");
    expect(visibleEditorMessage("Explain <noctis-editor-context> as text")).toBe(
      "Explain <noctis-editor-context> as text",
    );
    setEditorSession(undefined);
    expect(editorRootLabel([])).toBeUndefined();
  });
  it("opens the project's named thread using the local CSRF proof", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const session = await openEditorSession("local-csrf", async (url, init) => {
      requests.push({ url: String(url), ...(init === undefined ? {} : { init }) });
      return new Response(
        JSON.stringify({
          threadId: "project-thread",
          rootGrantId: "editor",
          nodeId: "home",
          projectPath: "C:/Editor/project.ecproj",
          projectName: "Project",
        }),
      );
    });
    expect(session.threadId).toBe("project-thread");
    expect(requests).toEqual([
      {
        url: "/editor/thread",
        init: {
          method: "POST",
          credentials: "same-origin",
          headers: { "x-noctis-csrf": "local-csrf", "content-type": "application/json" },
          body: "{}",
        },
      },
    ]);
  });

  it("shows a refused connection instead of starting an unrelated free thread", async () => {
    await expect(
      openEditorSession(
        "csrf",
        async () =>
          new Response(JSON.stringify({ error: { message: "Editor is closed" } }), { status: 503 }),
      ),
    ).rejects.toThrow("Editor is closed");
  });
});

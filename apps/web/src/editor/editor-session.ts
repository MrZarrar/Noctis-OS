import { z } from "zod";

const EditorSessionSchema = z.object({
  threadId: z.string().min(1),
  rootGrantId: z.string().min(1),
  nodeId: z.string().min(1).optional(),
  projectPath: z.string().min(1),
  projectName: z.string().min(1),
});
export type EditorSession = z.infer<typeof EditorSessionSchema>;
let current: EditorSession | undefined;
export function setEditorSession(session: EditorSession | undefined): void {
  current = session;
}
export function editorRootLabel(
  roots: readonly { grantId: string; nodeId: string; hostId: string }[],
): string | undefined {
  if (current === undefined) return undefined;
  const session = current;
  const root = roots.find(
    (candidate) =>
      candidate.grantId === session.rootGrantId &&
      (session.nodeId === undefined || candidate.nodeId === session.nodeId),
  );
  return root === undefined ? "NoctisEditor" : `NoctisEditor on ${root.hostId}`;
}
/** The relay appends live context for the runtime; the owner sees the message they wrote. */
export function visibleEditorMessage(body: string): string {
  const marker =
    "\n\n<noctis-editor-context>\nThis message is from the side chat in Noctis Editor.";
  const at = body.lastIndexOf(marker);
  return at >= 0 && body.endsWith("</noctis-editor-context>") ? body.slice(0, at) : body;
}

export async function openEditorSession(
  csrf: string,
  send: typeof fetch = fetch,
): Promise<EditorSession> {
  const response = await send("/editor/thread", {
    method: "POST",
    credentials: "same-origin",
    headers: { "x-noctis-csrf": csrf, "content-type": "application/json" },
    body: "{}",
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const failure = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
    throw new Error(
      failure.success ? failure.data.error.message : "Could not connect the Editor to Noctis.",
    );
  }
  return EditorSessionSchema.parse(body);
}

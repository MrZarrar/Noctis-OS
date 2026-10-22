import { FileRelativePathSchema } from "@noctis/contracts";
import type { LarpArea } from "./area.js";
import { ok, parsePath, rebase } from "./area.js";
import fixture from "./fixtures/files.json" with { type: "json" };

const data = rebase(fixture);
const size = (content: string) => new TextEncoder().encode(content).length;
const refused = (status: number, message: string) => ({ status, body: { error: { message } } });

function location(path: string) {
  const { segments, query } = parsePath(path);
  const root = data.roots.find(
    (root) => root.nodeId === query.get("node") && root.grantId === query.get("root"),
  );
  const relativePath = query.get("path") ?? "";
  return { segments, query, root, relativePath };
}

export const files: LarpArea = {
  request(method, path) {
    const { segments, query, root, relativePath } = location(path);
    if (segments[0] !== "files") return undefined;
    if (method !== "GET") return refused(403, "These files are read only.");
    if (segments.length !== 2 || !["list", "content"].includes(segments[1] ?? "")) return undefined;
    if (!FileRelativePathSchema.safeParse(relativePath).success)
      return refused(400, "Choose a path inside the shared folder.");
    if (!root) return refused(404, "This shared folder is unavailable.");
    if (segments[1] === "list") {
      const prefix = relativePath === "" ? "" : `${relativePath}/`;
      const entries = new Map<
        string,
        { name: string; kind: "file" | "directory"; sizeBytes: number; modifiedAt: string }
      >();
      for (const file of root.files) {
        if (!file.path.startsWith(prefix)) continue;
        const suffix = file.path.slice(prefix.length);
        const name = suffix.split("/")[0]!;
        const directory = suffix.includes("/");
        entries.set(name, {
          name,
          kind: directory ? "directory" : "file",
          sizeBytes: directory ? 0 : size(file.content),
          modifiedAt: file.modifiedAt,
        });
      }
      if (!entries.size && relativePath !== "") return refused(404, "No such folder.");
      return ok({
        entries: [...entries.values()].sort(
          (a, b) =>
            Number(b.kind === "directory") - Number(a.kind === "directory") ||
            a.name.localeCompare(b.name),
        ),
        truncated: false,
      });
    }
    const file = root.files.find((file) => file.path === relativePath);
    if (!file) return refused(404, "No such file.");
    if (query.has("preview")) {
      if (
        query.get("preview") !== "1" ||
        query.has("download") ||
        !file.contentType.startsWith("text/")
      )
        return refused(400, "Choose a text file for this preview.");
      return ok({ text: file.content, truncated: false });
    }
    return ok(file.content);
  },
  contentUrl(path) {
    const { segments, root, relativePath } = location(path);
    if (segments.length !== 2 || segments[0] !== "files" || segments[1] !== "content")
      return undefined;
    const file = root?.files.find((file) => file.path === relativePath);
    if (!file) return undefined;
    // Existing download links append &download=1. A fragment keeps it out of the file bytes.
    return `data:${file.contentType};charset=utf-8,${encodeURIComponent(file.content)}#`;
  },
};

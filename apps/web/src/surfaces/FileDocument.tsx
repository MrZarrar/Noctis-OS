import type { DocumentPayload } from "@noctis/contracts";
import { typography } from "@noctis/ui";
import { useContext } from "react";
import { useFileText } from "../pages/useFileText.js";
import { filesQuery } from "../pages/files-view.js";
import { Skeleton, buttonStyle } from "../layout/Page.js";
import { Markdown } from "../conversation/Markdown.js";
import { MarkdownFiles, type MarkdownImageUrl } from "../conversation/MarkdownFiles.js";
import type { SurfaceContext } from "./renderers.js";

function relativeImagePath(document: string, src: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(src).replaceAll("\\", "/");
  } catch {
    return undefined;
  }
  const slashed = document.replaceAll("\\", "/");
  if (decoded.startsWith("/") || /^[a-z]:\//i.test(decoded) || slashed.startsWith("/")) {
    return undefined;
  }

  const folder = slashed.slice(0, slashed.lastIndexOf("/") + 1);
  const parts: string[] = [];
  for (const part of `${folder}${decoded}`.split("/")) {
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else if (part !== "" && part !== ".") {
      parts.push(part);
    }
  }
  return parts.length === 0 ? undefined : parts.join("/");
}

export function FileDocument({
  payload,
  context,
}: {
  payload: DocumentPayload;
  context: SurfaceContext;
}): JSX.Element | null {
  const outerImageUrl = useContext(MarkdownFiles);
  const source = payload.content;
  const path =
    source.from === "file"
      ? `/files/content?${filesQuery(source, source.relativePath)}`
      : undefined;
  const file = useFileText(
    context.fileTransport,
    path,
    context.contentRevision,
    JSON.stringify(context.panelOwner),
    context.fileText,
  );
  if (source.from !== "file" || path === undefined) return null;
  const imageUrl: MarkdownImageUrl = (src) => {
    if (/^(?:[a-z]:[\\/]|\/|\\\\)/i.test(src)) return outerImageUrl?.(src);
    const joined = relativeImagePath(source.relativePath, src);
    return joined === undefined
      ? undefined
      : context.fileTransport?.contentUrl?.(`/files/content?${filesQuery(source, joined)}`);
  };
  const url = context.fileTransport?.contentUrl?.(path);
  return (
    <div>
      {file.loading && <Skeleton label="Opening…" lines={6} />}
      {file.error !== undefined && (
        <p role="alert">
          {file.error}{" "}
          <button type="button" style={buttonStyle} onClick={file.retry}>
            Retry file
          </button>
        </p>
      )}
      {file.truncated && <p>Preview limited to 2 MiB.</p>}
      {context.onOpenFile !== undefined && (
        <button type="button" style={buttonStyle} onClick={() => context.onOpenFile?.(source)}>
          Open in Files
        </button>
      )}
      {url !== undefined && (
        <a
          href={`${url}&download=1`}
          target="_blank"
          rel="noopener"
          download={payload.title}
          style={{
            ...buttonStyle,
            display: "inline-flex",
            alignItems: "center",
            textDecoration: "none",
          }}
        >
          Download full file
        </a>
      )}
      {file.text !== undefined &&
        (payload.format === "markdown" ? (
          <MarkdownFiles.Provider value={imageUrl}>
            <Markdown text={file.text} readOnlyTasks />
          </MarkdownFiles.Provider>
        ) : (
          <pre
            style={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              font: `${String(typography.scale.sm)}px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`,
            }}
          >
            {file.text}
          </pre>
        ))}
    </div>
  );
}

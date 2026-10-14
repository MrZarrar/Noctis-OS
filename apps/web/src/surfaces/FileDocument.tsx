import type { DocumentPayload } from "@noctis/contracts";
import { typography } from "@noctis/ui";
import { useFileText } from "../pages/useFileText.js";
import { filesQuery } from "../pages/files-view.js";
import { buttonStyle } from "../layout/Page.js";
import { Markdown } from "../conversation/Markdown.js";
import type { SurfaceContext } from "./renderers.js";

export function FileDocument({
  payload,
  context,
}: {
  payload: DocumentPayload;
  context: SurfaceContext;
}): JSX.Element | null {
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
  const url = context.fileTransport?.contentUrl?.(path);
  return (
    <div>
      {file.loading && <p role="status">Opening…</p>}
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
          <Markdown text={file.text} readOnlyTasks />
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

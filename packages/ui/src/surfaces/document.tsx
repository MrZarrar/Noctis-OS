import type { ReactNode } from "react";
import type { DocumentPayload } from "@noctis/contracts";
import { typography } from "../tokens/index.js";

/** The host supplies its installed Markdown renderer; UI also works as plain text. */
export function DocumentSurface({
  content,
  body,
}: DocumentPayload & { body?: ReactNode }): JSX.Element {
  return (
    <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
      {body ??
        (content.from === "inline" ? (
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: typography.family }}>
            {content.text}
          </pre>
        ) : (
          <p style={{ margin: 0 }}>This document opens from Files.</p>
        ))}
    </div>
  );
}

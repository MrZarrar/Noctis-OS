import { corner, material, typography } from "@noctis/ui";

import type { ExchangeOutput } from "../conversation/last-exchange.js";

/** What a turn made, under its reply: an image as a thumbnail, anything else as a link. */
export function ExchangeOutputs({
  outputs,
  outputUrl,
  mobile,
}: {
  outputs: readonly ExchangeOutput[];
  outputUrl: ((attachmentId: string) => string) | undefined;
  mobile: boolean;
}): JSX.Element {
  return (
    <>
      {outputs.map((output) => {
        const url = outputUrl?.(output.attachmentId);
        const label = output.path ?? output.mediaType;

        if (url === undefined) {
          return (
            <p key={output.attachmentId} style={{ margin: 0 }}>
              {label}
            </p>
          );
        }

        return (
          <a
            key={output.attachmentId}
            href={url}
            target="_blank"
            rel="noreferrer"
            style={{ justifySelf: "start", color: typography.color.muted }}
          >
            {output.mediaType.startsWith("image/") ? (
              <img
                src={url}
                alt={output.path ?? "Generated image"}
                loading="lazy"
                style={{
                  display: "block",
                  maxWidth: "100%",
                  // Small enough to sit under the reply inside the exchange box's own height.
                  maxHeight: mobile ? "14vh" : "17vh",
                  borderRadius: corner.md,
                  border: `1px solid ${material.border}`,
                }}
              />
            ) : (
              `Open ${label}`
            )}
          </a>
        );
      })}
    </>
  );
}

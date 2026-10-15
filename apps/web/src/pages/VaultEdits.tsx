import { spacing, typography } from "@noctis/ui";
import { z } from "zod";

import { Markdown } from "../conversation/Markdown.js";
import { buttonStyle, glass } from "../layout/Page.js";

export const VaultEditSchema = z.object({
  id: z.string(),
  kind: z.enum(["fact", "note", "revision"]),
  path: z.string(),
  source: z.string(),
  text: z.string(),
  replaceText: z.string().optional(),
  status: z.enum(["applied", "undone", "pending", "declined", "refused"]),
  reason: z.string().optional(),
  turnId: z.string().optional(),
  createdAt: z.string(),
  decidedAt: z.string().optional(),
});

export type VaultEdit = z.infer<typeof VaultEditSchema>;

const muted = { margin: 0, color: typography.color.muted } as const;

export function VaultEdits({
  edits,
  onUndo,
  onApply,
  onDecline,
}: {
  edits: readonly VaultEdit[];
  onUndo: (editId: string) => void;
  onApply: (editId: string) => void;
  onDecline: (editId: string) => void;
}): JSX.Element {
  return (
    <section
      aria-label="From the inbox"
      style={{ ...glass, padding: spacing.lg, minWidth: 0, display: "grid", gap: spacing.lg }}
    >
      <h2 style={{ margin: 0, fontSize: typography.scale.md }}>From the inbox</h2>
      {edits.length === 0 && <p style={muted}>Nothing has been filed from the inbox yet.</p>}
      {edits.slice(0, 50).map((edit) => (
        <article
          key={edit.id}
          style={{ display: "grid", gap: spacing.sm, overflowWrap: "anywhere" }}
        >
          <h3 style={{ margin: 0, fontSize: typography.scale.md }}>{edit.path}</h3>
          <div style={{ maxWidth: typography.measurePx, lineHeight: 1.55 }}>
            {edit.kind === "revision" && edit.status === "pending" && <p style={muted}>Find</p>}
            <Markdown text={edit.text} />
            {edit.kind === "revision" && edit.status === "pending" && (
              <>
                <p style={muted}>Replace with</p>
                <Markdown text={edit.replaceText ?? ""} />
              </>
            )}
          </div>
          <p style={muted}>Source: {edit.source}</p>
          {edit.status === "applied" ? (
            <div>
              <button type="button" onClick={() => onUndo(edit.id)} style={buttonStyle}>
                Undo
              </button>
            </div>
          ) : edit.status === "pending" ? (
            <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap" }}>
              <button type="button" onClick={() => onApply(edit.id)} style={buttonStyle}>
                Apply
              </button>
              <button type="button" onClick={() => onDecline(edit.id)} style={buttonStyle}>
                Decline
              </button>
            </div>
          ) : (
            <p style={muted}>{edit.status}</p>
          )}
          {edit.reason !== undefined && <p style={muted}>{edit.reason}</p>}
        </article>
      ))}
    </section>
  );
}

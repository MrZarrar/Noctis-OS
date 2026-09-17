import type { ObjectiveRecord } from "@noctis/contracts";
import { corner, material, spacing, typography } from "@noctis/ui";

/**
 * Presence's list of Objectives: propose one, accept a suggestion, activate it.
 *
 * Split out of `Command.tsx` when task 2.7 moved Surface policy into the core
 * (`objectives/proposed-surfaces.ts`). What is left in Command is the canvas;
 * this is the thing shown when there is no canvas yet.
 */
export const buttonStyle = {
  background: material.fill,
  color: "inherit",
  border: `1px solid ${material.border}`,
  borderRadius: corner.sm,
  padding: `${String(spacing.xs)}px ${String(spacing.md)}px`,
  cursor: "pointer",
} as const;

export interface ObjectiveListProps {
  objectives: readonly ObjectiveRecord[];
  title: string;
  onTitleChange: (title: string) => void;
  onPropose: () => void;
  onChangeStatus: (objective: ObjectiveRecord, status: string) => void;
}

/** A suggested Objective becomes draft, then active. Never a shortcut between them. */
function nextStatus(objective: ObjectiveRecord): string | undefined {
  if (objective.status === "suggested") {
    return "draft";
  }

  return objective.status === "draft" || objective.status === "paused" ? "active" : undefined;
}

export function ObjectiveList({
  objectives,
  title,
  onTitleChange,
  onPropose,
  onChangeStatus,
}: ObjectiveListProps): JSX.Element {
  return (
    <div style={{ padding: spacing.xl, display: "grid", gap: spacing.md, justifyItems: "center" }}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onPropose();
        }}
        style={{ display: "flex", gap: spacing.sm }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: spacing.sm }}>
          <span>New Objective</span>
          <input
            value={title}
            onChange={(event) => {
              onTitleChange(event.target.value);
            }}
            style={{
              width: 320,
              background: material.fill,
              border: `1px solid ${material.border}`,
              borderRadius: corner.sm,
              color: "inherit",
              padding: spacing.sm,
            }}
          />
        </label>
        <button type="submit" style={buttonStyle}>
          Propose
        </button>
      </form>

      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: spacing.xs }}>
        {objectives.map((objective) => {
          const next = nextStatus(objective);

          return (
            <li
              key={objective.id}
              style={{ display: "flex", gap: spacing.sm, alignItems: "center" }}
            >
              <span style={{ minWidth: 320 }}>{objective.title}</span>
              <span style={{ color: typography.color.muted, minWidth: 80 }}>
                {objective.status}
              </span>
              {next !== undefined && (
                <button
                  type="button"
                  onClick={() => {
                    onChangeStatus(objective, next);
                  }}
                  style={buttonStyle}
                >
                  {next === "draft" ? "Accept" : "Activate"}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

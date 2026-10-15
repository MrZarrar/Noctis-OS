import { fieldStyle } from "../layout/Page.js";
import { snoozeUntil } from "./productivity-view.js";
export function SnoozeChoices({
  disabled,
  onSnooze,
  onPc,
  nodes = [],
}: {
  disabled: boolean;
  onSnooze: (until: string) => void;
  onPc: (nodeId: string) => void;
  nodes?: readonly { id: string; hostId: string }[];
}) {
  return (
    <select
      aria-label="Other snooze times"
      style={{ ...fieldStyle, width: "auto", maxWidth: "100%" }}
      disabled={disabled}
      value=""
      onChange={(e) => {
        const v = e.target.value;
        if (v.startsWith("pc:")) onPc(v.slice(3));
        else if (v) onSnooze(snoozeUntil(v as "evening" | "tomorrow"));
      }}
    >
      <option value="">More snooze times</option>
      <option value="evening">Next evening (18:00)</option>
      <option value="tomorrow">Tomorrow (09:00)</option>
      {nodes.map((n) => (
        <option key={n.id} value={`pc:${n.id}`}>
          Next time at {n.hostId}
        </option>
      ))}
    </select>
  );
}

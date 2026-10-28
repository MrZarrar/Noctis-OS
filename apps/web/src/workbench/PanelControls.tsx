import type { SurfaceSize } from "@noctis/contracts";
import { PanelIcon, spacing } from "@noctis/ui";
import { buttonStyle } from "../layout/Page.js";
import { Picker } from "../layout/Picker.js";
import { ActionButton } from "../layout/ActionButton.js";

export interface PanelControlsProps {
  title: string;
  size: SurfaceSize;
  pinned: boolean;
  focused: boolean;
  onFocus: () => void;
  onPin: () => void;
  onSize: (size: SurfaceSize) => void;
  onClose: () => void | Promise<void>;
  onHide: () => Promise<void>;
  onPopout?: (() => void) | undefined;
  popped?: boolean;
}

export function PanelControls({
  title,
  size,
  pinned,
  focused,
  onFocus,
  onPin,
  onSize,
  onClose,
  onHide,
  onPopout,
  popped = false,
}: PanelControlsProps): JSX.Element {
  const iconStyle = {
    ...buttonStyle,
    minWidth: 44,
    width: 44,
    padding: 0,
    display: "grid",
    placeItems: "center",
  } as const;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: spacing.xs, minWidth: 0 }}>
      <button
        type="button"
        aria-label={focused ? "Leave focus" : `Focus ${title}`}
        aria-pressed={focused}
        onClick={onFocus}
        style={iconStyle}
      >
        <PanelIcon glyph="focus" />
      </button>
      <button
        type="button"
        aria-label={`${pinned ? "Unpin" : "Pin"} ${title}`}
        aria-pressed={pinned}
        onClick={onPin}
        style={iconStyle}
      >
        <PanelIcon glyph="pin" />
      </button>
      <Picker
        label={`Size ${title}`}
        value={size === "stage" ? "wide" : size}
        options={[
          { value: "compact", label: "Small" },
          { value: "standard", label: "Medium" },
          { value: "wide", label: "Large" },
        ]}
        onChange={onSize}
        style={{ width: "auto", minWidth: 88, flex: "0 1 auto" }}
      />
      <ActionButton aria-label={`Hide ${title}`} onAction={onHide} pendingLabel="Hiding...">
        Hide
      </ActionButton>
      <ActionButton
        aria-label={`Close ${title}`}
        onAction={onClose}
        style={iconStyle}
        pendingLabel="..."
      >
        <PanelIcon glyph="close" />
      </ActionButton>
      {onPopout !== undefined && (
        <button
          type="button"
          aria-label={`${popped ? "Return" : "Pop out"} ${title}`}
          onClick={onPopout}
          style={buttonStyle}
        >
          {popped ? "Return" : "Pop out"}
        </button>
      )}
    </div>
  );
}

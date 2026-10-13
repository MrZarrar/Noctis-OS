import type { SurfaceRegion, SurfacePlacementRegion, SurfaceSize } from "@noctis/contracts";
import { PanelIcon, spacing } from "@noctis/ui";
import { buttonStyle } from "../layout/Page.js";
import { Picker } from "../layout/Picker.js";

export function controlsFor(display: SurfaceSize): string[] {
  return display === "compact"
    ? ["focus", "pin", "size", "close"]
    : ["focus", "pin", "place", "size", "close"];
}

export interface PanelControlsProps {
  title: string;
  region: SurfaceRegion;
  size: SurfaceSize;
  display: SurfaceSize;
  pinned: boolean;
  focused: boolean;
  regions: readonly SurfacePlacementRegion[];
  onFocus: () => void;
  onPin: () => void;
  onPlace: (region: SurfacePlacementRegion) => void;
  onSize: (size: SurfaceSize) => void;
  onClose: () => void;
  onPopout?: (() => void) | undefined;
  popped?: boolean;
}

export function PanelControls({
  title,
  region,
  size,
  display,
  pinned,
  focused,
  regions,
  onFocus,
  onPin,
  onPlace,
  onSize,
  onClose,
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
      {controlsFor(display).includes("place") && (
        <Picker
          label={`Place ${title}`}
          value={region}
          options={regions.map((value) => ({
            value,
            label: value[0]!.toUpperCase() + value.slice(1),
          }))}
          onChange={onPlace}
          style={{ width: "auto", minWidth: 88, flex: "0 1 auto" }}
        />
      )}
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
      <button type="button" aria-label={`Close ${title}`} onClick={onClose} style={iconStyle}>
        <PanelIcon glyph="close" />
      </button>
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

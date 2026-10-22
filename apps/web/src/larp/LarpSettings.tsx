import { identityAccent, semantic, spacing, typography } from "@noctis/ui";
import { useState } from "react";

import { SectionHeading, buttonStyle, glass } from "../layout/Page.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { hardwareBusy, setHardwareLoad } from "./hardware.js";
import { larpEnabled, setLarpEnabled } from "./mode.js";

/** What `DemoTransport` offers the filming controls, without importing its fixtures here. */
interface LarpControls {
  larp: { raiseApprovalIn: (ms: number) => void };
}

const hasControls = (
  transport: CoreTransport | undefined,
): transport is CoreTransport & LarpControls => transport !== undefined && "larp" in transport;

/**
 * The LARP mode card in Settings. Switching reloads the page so the real core
 * and the fictional one never share a page's state.
 */
export function LarpSettings({ transport }: { transport: CoreTransport | undefined }): JSX.Element {
  const on = larpEnabled();
  const [busy, setBusy] = useState(hardwareBusy);
  const [queued, setQueued] = useState(false);

  const toggle = (): void => {
    setLarpEnabled(!on);
    window.location.assign("/");
  };

  return (
    <section
      aria-label="LARP mode"
      style={{
        ...glass,
        padding: spacing.lg,
        display: "grid",
        gap: spacing.md,
        ...(on ? { borderColor: semantic.warning } : {}),
      }}
    >
      <SectionHeading>LARP mode</SectionHeading>
      <p style={{ margin: 0, maxWidth: typography.measurePx, color: typography.color.muted }}>
        {on
          ? "On for this device. Every page shows fictional data and scripted replies, and nothing reaches the core. Real data on the core is untouched."
          : "A demo mode for filming. Every page shows fictional data and Vesper and Jester follow a script, on this device only. Nothing reaches the core while it is on."}
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: spacing.sm }}>
        <button
          type="button"
          aria-pressed={on}
          onClick={toggle}
          style={{
            ...buttonStyle,
            ...(on ? { color: semantic.warning, borderColor: semantic.warning } : {}),
          }}
        >
          {on ? "Turn LARP mode off" : "Turn LARP mode on"}
        </button>
        {on && hasControls(transport) && (
          <>
            <button
              type="button"
              disabled={queued}
              onClick={() => {
                transport.larp.raiseApprovalIn(10_000);
                setQueued(true);
              }}
              style={buttonStyle}
            >
              {queued ? "Approval arrives in 10 s" : "Send the demo approval in 10 s"}
            </button>
            <button
              type="button"
              aria-pressed={busy}
              onClick={() => {
                setHardwareLoad(!busy);
                setBusy(!busy);
              }}
              style={{
                ...buttonStyle,
                ...(busy ? { color: identityAccent.vesper.primary } : {}),
              }}
            >
              {busy ? "Hardware: under load" : "Hardware: idle"}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

import { Rail, depth, typography } from "@noctis/ui";
import type { RailItem } from "@noctis/ui";
import { useState } from "react";

import { resolveCoreTransport } from "./core-client.js";
import { Presence } from "./pages/Presence.js";

const transport = resolveCoreTransport();

export function App(): JSX.Element {
  const [active, setActive] = useState<RailItem>("Command");

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        background: depth.floor,
        color: "#E7E6EE",
        fontFamily: typography.family,
      }}
    >
      <Rail active={active} onSelect={setActive} />
      {active === "Command" ? (
        <Presence transport={transport} />
      ) : (
        <section
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {active} is not built yet — later phases add it behind this same rail.
        </section>
      )}
    </div>
  );
}

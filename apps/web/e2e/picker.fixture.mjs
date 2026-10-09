import { depth, spacing } from "@noctis/ui";
import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";

import { Picker } from "../src/layout/Picker.tsx";

function Fixture() {
  const [value, setValue] = useState("documents");
  return createElement(
    "section",
    {
      "aria-label": "Picker fixture",
      style: {
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: depth.floor,
        padding: spacing.lg,
      },
    },
    createElement(
      "div",
      {
        "aria-label": "Scrollable page",
        style: { height: 200, overflowY: "auto" },
      },
      createElement(
        "div",
        { style: { height: 600 } },
        createElement(Picker, {
          label: "PC and folder",
          value,
          onChange: setValue,
          options: [
            { value: "documents", label: "Documents on home", detail: "offline" },
            { value: "disabled", label: "Unavailable folder", disabled: true },
            { value: "projects", label: "Projects on home" },
            ...Array.from({ length: 15 }, (_, index) => ({
              value: `folder-${String(index)}`,
              label: `Folder ${String(index)} on home`,
            })),
          ],
        }),
      ),
    ),
    createElement(
      "div",
      { "aria-label": "Other scroller", style: { height: 100, overflowY: "auto" } },
      createElement("div", { style: { height: 600 } }),
    ),
  );
}

const container = document.createElement("div");
document.body.append(container);
createRoot(container).render(createElement(Fixture));

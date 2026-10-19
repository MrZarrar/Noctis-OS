import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { glass, spacing, typography } from "@noctis/ui";
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import { resolveSurface } from "../src/surfaces/registry.js";
import { renderSurface } from "../src/surfaces/renderers.js";

const source = (relativePath) => ({
  from: "file",
  nodeId: "work",
  grantId: "screens",
  relativePath,
});
const payload = {
  title: "Three cables under £10",
  options: [
    {
      id: "anker",
      title: "Anker USB-C cable",
      price: "£8.99",
      detail: "60W charging, 1 metre. A compact everyday choice for your MacBook.",
      image: source("anker.svg"),
      url: "https://amazon.co.uk/cable?colour=black",
      action: { label: "Add Anker", message: "Add option anker to my basket" },
    },
    {
      id: "belkin",
      title: "Belkin braided cable",
      price: "£9.49",
      detail: "100W charging, 2 metres. Braided finish with extra reach.",
      image: source("missing.png"),
      action: { label: "Add Belkin", message: "Add option belkin to my basket" },
    },
    {
      id: "ugreen",
      title: "UGREEN USB-C cable",
      price: "£6.99",
      detail: "60W charging, 1 metre. The lowest price of the shortlist.",
      action: { label: "Add UGREEN", message: "Add option ugreen to my basket" },
    },
  ],
  actions: [{ label: "Find more", message: "Find more cables" }],
};

function Preview() {
  const cache = useMemo(() => new Map(), []);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState();
  return (
    <main style={{ padding: spacing.lg, fontFamily: typography.family }}>
      <section aria-label={payload.title} style={{ ...glass, padding: spacing.lg }}>
        <h1 style={{ fontSize: typography.scale.lg, margin: "0 0 16px" }}>{payload.title}</h1>
        {renderSurface(resolveSurface("options", 1, payload, "wide"), {
          fileMedia: { cache, surfaceId: "options-panel" },
          panelOwner: { threadId: "owning-thread" },
          panelActionsDisabled: disabled,
          panelActionsError: error,
          contentRevision: "v1",
          mediaUrl: (image, revision) =>
            `/e2e/option-images/${image.relativePath}?revision=${revision}`,
          onPanelAction: async (message, owner) => {
            window.__choices = [...(window.__choices ?? []), { message, owner }];
            await new Promise((resolve) => {
              window.__finishChoice = resolve;
            });
            if (message === "Add option belkin to my basket")
              throw new Error("Choice failed. Try again.");
          },
        })}
      </section>
      <button onClick={() => setDisabled((value) => !value)}>Toggle busy</button>
      <button onClick={() => setError("Conversation is unavailable")}>
        Show conversation error
      </button>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<Preview />);

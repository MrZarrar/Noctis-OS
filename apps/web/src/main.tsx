import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { MotionPolicy } from "./layout/motion.js";
import { larpEnabled } from "./larp/mode.js";
import { PopoutProvider } from "./workbench/PopoutProvider.js";

import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "./index.css";

const container = document.getElementById("root");

if (container === null) {
  throw new Error("#root is missing from index.html");
}

async function boot(root: HTMLElement): Promise<void> {
  // LARP mode loads only when this device turned it on in Settings.
  if (larpEnabled()) {
    await (await import("./larp/install.js")).installLarp();
  }

  createRoot(root).render(
    <StrictMode>
      <MotionPolicy>
        <PopoutProvider>
          <App />
        </PopoutProvider>
      </MotionPolicy>
    </StrictMode>,
  );
}

void boot(container);

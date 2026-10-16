import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { MotionPolicy } from "./layout/motion.js";
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

createRoot(container).render(
  <StrictMode>
    <MotionPolicy>
      <PopoutProvider>
        <App />
      </PopoutProvider>
    </MotionPolicy>
  </StrictMode>,
);

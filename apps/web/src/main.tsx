import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { PopoutProvider } from "./workbench/PopoutProvider.js";

import "./index.css";

const container = document.getElementById("root");

if (container === null) {
  throw new Error("#root is missing from index.html");
}

createRoot(container).render(
  <StrictMode>
    <PopoutProvider>
      <App />
    </PopoutProvider>
  </StrictMode>,
);

import { createRoot } from "react-dom/client";
import { Vault } from "../src/pages/Vault.js";
import { CoreSettingsView } from "../src/pages/CoreSettings.js";
import "../src/index.css";

const pending = new Map();
globalThis.__requests = [];
globalThis.__finish = (path, body = {}, status = 200) => {
  pending.get(path).resolve({ status, body });
  pending.delete(path);
};
globalThis.__fail = (path) => {
  pending.get(path).reject(new Error("Connection lost"));
  pending.delete(path);
};

const edits = [
  {
    id: "fact",
    kind: "fact",
    path: "people/tolga.md",
    source: "inbox/t.md",
    text: "Moved to Istanbul.",
    status: "applied",
    createdAt: "2026-10-23T10:00:00Z",
  },
  {
    id: "revision",
    kind: "revision",
    path: "people/tolga.md",
    source: "inbox/t.md",
    text: "London",
    replaceText: "Istanbul",
    status: "pending",
    createdAt: "2026-10-23T10:00:00Z",
  },
];
const transport = {
  request(method, path, body) {
    if (method === "POST" || path.startsWith("/vault/recall?")) {
      globalThis.__requests.push({ method, path, body });
      return new Promise((resolve, reject) => pending.set(path, { resolve, reject }));
    }
    const responses = {
      "/vault": { configured: true, live: false, writesEnabled: false },
      "/vault/graph": { nodes: [], edges: [], total: 0, truncated: false },
      "/vault/edits": { edits },
      "/passcode": { configured: true, unlocked: false, timeoutMinutes: 10, lockoutSeconds: 0 },
    };
    return Promise.resolve({ status: 200, body: responses[path] });
  },
};

createRoot(document.getElementById("root")).render(
  <>
    <Vault transport={transport} />
    <CoreSettingsView
      settings={[
        {
          key: "places",
          label: "Places",
          help: "Places",
          kind: "places",
          value: ["home"],
          source: "ui",
        },
      ]}
      startUp={[]}
      onSet={() => transport.request("POST", "/settings").then(() => undefined)}
      onReset={() => transport.request("POST", "/reset").then(() => undefined)}
    />
  </>,
);

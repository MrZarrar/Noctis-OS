import { loadCoreConfig } from "./config/server.js";
import { startCore } from "./server.js";

/**
 * Process entry point. Configuration errors surface here, before a listener
 * exists, so a misconfigured core never accepts a single request.
 */
const running = await startCore({ config: loadCoreConfig(process.env) });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void running.close().then(() => {
      process.exit(0);
    });
  });
}

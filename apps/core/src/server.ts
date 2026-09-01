import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";

import type { Clock } from "@noctis/domain";
import { createIdFactory, systemClock } from "@noctis/domain";

import type { ApiDeps } from "./api/http.js";
import { handleRequest } from "./api/http.js";
import { attachClientSocket } from "./api/ws.js";
import type { CoreConfig } from "./config/server.js";
import type { NoctisDatabase } from "./db/connection.js";
import { openDatabase } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { createEventBroker } from "./events/broker.js";
import type { Kernel } from "./kernel.js";
import type { Logger } from "./logging.js";
import { createLogger } from "./logging.js";

/**
 * Resolves the same directory whether this module is running from `src` under
 * vitest or from `dist` after a build, because `migrations/` sits beside both.
 */
export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../migrations/", import.meta.url));

export interface StartCoreOptions {
  config: CoreConfig;
  clock?: Clock;
  logger?: Logger;
  migrationsDirectory?: string;
}

export interface RunningCore {
  address: string;
  port: number;
  kernel: Kernel;
  schemaVersion: number;
  close: () => Promise<void>;
}

function currentSchemaVersion(db: NoctisDatabase): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get() as { version: number };

  return row.version;
}

export async function startCore(options: StartCoreOptions): Promise<RunningCore> {
  const { config } = options;
  const clock = options.clock ?? systemClock;
  const logger =
    options.logger ?? createLogger({ level: config.logLevel, clock, base: { component: "core" } });

  const db = openDatabase(config.databasePath);

  try {
    migrate(db, { directory: options.migrationsDirectory ?? MIGRATIONS_DIRECTORY, clock });
  } catch (error) {
    db.close();
    throw error;
  }

  const kernel: Kernel = {
    db,
    clock,
    ids: createIdFactory(clock),
    broker: createEventBroker({
      onListenerError: (error) => {
        logger.log("error", "event listener threw", {
          reason: error instanceof Error ? error.message : "unknown",
        });
      },
    }),
    logger,
  };

  const deps: ApiDeps = {
    kernel,
    config,
    schemaVersion: currentSchemaVersion(db),
    startedAt: clock.now(),
  };

  const server: Server = createServer((req, res) => {
    void handleRequest(deps, req, res);
  });

  const sockets = attachClientSocket(server, deps);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.bindAddress, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const listening = server.address();

  if (listening === null || typeof listening === "string") {
    throw new Error("Core server did not bind a TCP port");
  }

  logger.log("info", "core listening", {
    address: listening.address,
    port: listening.port,
    schemaVersion: deps.schemaVersion,
  });

  return {
    address: listening.address,
    port: listening.port,
    kernel,
    schemaVersion: deps.schemaVersion,
    async close() {
      for (const client of sockets.clients) {
        client.terminate();
      }

      sockets.close();
      server.closeAllConnections();

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });

      db.close();
    },
  };
}

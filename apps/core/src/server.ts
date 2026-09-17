import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";

import type { Clock } from "@noctis/domain";
import { createIdFactory, systemClock } from "@noctis/domain";
import webpush from "web-push";

import type { ApiDeps } from "./api/http.js";
import { handleRequest } from "./api/http.js";
import { attachClientSocket, refuseUpgrade } from "./api/ws.js";
import type { CoreConfig } from "./config/server.js";
import type { ConversationService } from "./conversation/service.js";
import { createConversationService } from "./conversation/service.js";
import type { NoctisDatabase } from "./db/connection.js";
import { openDatabase } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { createEventBroker } from "./events/broker.js";
import type { LiveBroker } from "./events/live.js";
import { createLiveBroker } from "./events/live.js";
import type { Dispatcher } from "./nodes/dispatch.js";
import { createDispatcher } from "./nodes/dispatch.js";
import type { RuntimeFrameHub } from "./nodes/runtime-frames.js";
import { createRuntimeFrameHub } from "./nodes/runtime-frames.js";
import { attachNodeSocket } from "./nodes/ws.js";
import type { Kernel } from "./kernel.js";
import type { Logger } from "./logging.js";
import { createLogger } from "./logging.js";
import type { SendPush, VapidKeys } from "./notify/push.js";
import { createNotifier } from "./notify/push.js";
import { resolveVaultRoot } from "./vault/root.js";

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
  /** Overridden by tests that would rather call `dispatcher.pass()` themselves. */
  dispatchIntervalMs?: number;
  /**
   * Where the Vault environment is read from. Defaults to the real process
   * environment; a test passes its own so it can never pick up a developer's
   * `NOCTIS_VAULT_ROOT` and index real notes.
   */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface RunningCore {
  address: string;
  port: number;
  kernel: Kernel;
  schemaVersion: number;
  /** Exposed so a test can drive a sweep instead of waiting for the interval. */
  dispatcher: Dispatcher;
  /** Where stream, delta and ask frames from nodes fan out. */
  runtimeFrames: RuntimeFrameHub;
  /** Token deltas on their way to clients. Ephemeral. */
  live: LiveBroker;
  conversation: ConversationService;
  close: () => Promise<void>;
}

/**
 * The one place `web-push` is called, and the one place the VAPID private key
 * is handed to anything.
 *
 * It returns a status code rather than throwing one: `web-push` rejects with a
 * `WebPushError` carrying `statusCode` for every answer the push service gave,
 * which is a delivery *result*, not a failure of ours. Anything without a
 * status code is a real transport failure and stays a rejection, so the
 * notifier keeps the subscription instead of pruning a phone over a flaky
 * network.
 */
function webPushSender(vapid: VapidKeys): SendPush {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);

  return async (subscription, payload) => {
    try {
      const result = await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        payload,
      );

      return { statusCode: result.statusCode };
    } catch (error) {
      const status: unknown = (error as { statusCode?: unknown }).statusCode;

      if (typeof status === "number") {
        return { statusCode: status };
      }

      throw error;
    }
  };
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

  const dispatcher = createDispatcher({
    kernel,
    ...(options.dispatchIntervalMs === undefined ? {} : { intervalMs: options.dispatchIntervalMs }),
  });

  // Resolved once at startup and refused loudly: a core that would have indexed
  // a live Vault must not get as far as listening.
  const env = options.env ?? process.env;
  const vaultRoot = resolveVaultRoot(env);

  if (vaultRoot !== undefined) {
    logger.log("info", "vault root resolved", { live: vaultRoot.live });
  }

  const runtimeFrames = createRuntimeFrameHub((error) => {
    logger.log("error", "runtime frame subscriber threw", {
      reason: error instanceof Error ? error.message : "unknown",
    });
  });
  const live = createLiveBroker((error) => {
    logger.log("error", "live listener threw", {
      reason: error instanceof Error ? error.message : "unknown",
    });
  });
  const conversation = createConversationService({ kernel, dispatcher, live, runtimeFrames });

  const notifier = createNotifier({
    db,
    clock,
    ids: kernel.ids,
    vapid: config.vapid,
    // A core with no keys never sends, so it never needs a sender. Building one
    // anyway would call `setVapidDetails` with nothing to set.
    send:
      config.vapid === undefined
        ? () => Promise.resolve({ statusCode: 0 })
        : webPushSender(config.vapid),
    logger,
  });

  // After the commit, never inside it: `kernel.broker` publishes only committed
  // events, so a push can never describe state a rollback erased.
  kernel.broker.subscribe((events) => {
    void notifier.notify(events).catch((error: unknown) => {
      logger.log("warn", "push delivery failed", {
        reason: error instanceof Error ? error.message : "unknown",
      });
    });
  });

  const deps: ApiDeps = {
    kernel,
    config,
    schemaVersion: currentSchemaVersion(db),
    startedAt: clock.now(),
    dispatcher,
    conversation,
    live,
    notifier,
    ...(vaultRoot === undefined ? {} : { vaultRoot }),
    vaultEnv: env,
  };

  const server: Server = createServer((req, res) => {
    void handleRequest(deps, req, res);
  });

  const clients = attachClientSocket(deps);
  const nodes = attachNodeSocket({ kernel, config, dispatcher, runtime: runtimeFrames });

  // One listener, offering the request to each realm in turn. Two listeners each
  // writing their own 404 would race to answer the other realm's paths.
  server.on("upgrade", (req, socket, head) => {
    if (clients.tryUpgrade(req, socket, head) || nodes.tryUpgrade(req, socket, head)) {
      return;
    }

    refuseUpgrade(socket, 404, "Not Found");
  });

  dispatcher.start();

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
    dispatcher,
    runtimeFrames,
    live,
    conversation,
    async close() {
      conversation.close();
      dispatcher.stop();

      for (const realm of [clients, nodes]) {
        for (const socket of realm.sockets.clients) {
          socket.terminate();
        }

        realm.sockets.close();
      }

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

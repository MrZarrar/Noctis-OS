import { RemoteDesktopSessionSchema } from "@noctis/contracts";

import { nextKey } from "../idempotency.js";
import type { CoreTransport } from "../transport/CoreTransport.js";

/**
 * The embedded remote desktop's session logic (Task 3.9, ADR-0035), kept apart
 * from the web component so it can be tested without a browser.
 *
 * The password is a parameter of `connectRemote` and nothing else: it is never
 * sent to the core, never put in state, and never stored. It goes to the
 * component, which carries it to the Gateway and on to RDP. The panel clears
 * its own field the moment it calls this.
 */

/** `IronErrorKind` from `@devolutions/iron-remote-desktop`, read from its `index.d.ts`. */
export const IronErrorKind = {
  General: 0,
  WrongPassword: 1,
  LogonFailure: 2,
  AccessDenied: 3,
  RDCleanPath: 4,
  ProxyConnect: 5,
  NegotiationFailure: 6,
} as const;

/**
 * The slice of the component's `UserInteraction` the panel uses. Method
 * signatures on purpose: they are checked bivariantly, so the component's own
 * `UserInteraction` (whose `connect` takes its `Config`) satisfies this.
 */
export interface RemoteUserInteraction {
  configBuilder(): RemoteConfigBuilder;
  connect(config: never): Promise<{
    initialDesktopSize: { width: number; height: number };
    run(): Promise<{ reason(): string }>;
  }>;
  shutdown(): void;
  ctrlAltDel(): void;
  setVisibility(visible: boolean): void;
}

export interface RemoteConfigBuilder {
  withUsername: (value: string) => RemoteConfigBuilder;
  withPassword: (value: string) => RemoteConfigBuilder;
  withDestination: (value: string) => RemoteConfigBuilder;
  withProxyAddress: (value: string) => RemoteConfigBuilder;
  withAuthToken: (value: string) => RemoteConfigBuilder;
  withServerDomain: (value: string) => RemoteConfigBuilder;
  withExtension: (value: unknown) => RemoteConfigBuilder;
  build: () => unknown;
}

/** The two extension factories from `@devolutions/iron-remote-desktop-rdp`. */
export interface RemoteBackend {
  enableCredssp: (enable: boolean) => unknown;
  displayControl: (enable: boolean) => unknown;
}

export type RemoteState =
  | { phase: "idle" }
  | { phase: "requesting" }
  | { phase: "connecting" }
  | { phase: "connected"; host: string; width: number; height: number }
  | { phase: "ended"; reason: string }
  | { phase: "failed"; message: string };

export interface ConnectRemoteOptions {
  transport: CoreTransport;
  ui: RemoteUserInteraction;
  backend: RemoteBackend;
  host: string;
  username: string;
  password: string;
  onState: (state: RemoteState) => void;
}

export interface RemoteHandle {
  /** Settles once the session is connected or has failed to be. Never rejects. */
  started: Promise<void>;
  disconnect: () => void;
}

class CoreRefusal extends Error {}

function coreRefusal(status: number): string {
  switch (status) {
    case 404:
      return "That host is not set up on this core for remote desktop.";
    case 401:
    case 403:
      return "This browser is signed out of Noctis. Sign in again, then connect.";
    default:
      return `The core could not issue a session (HTTP ${String(status)}).`;
  }
}

interface IronErrorLike {
  kind: () => number;
  backtrace: () => string;
  rdcleanpathDetails?: () => { httpStatusCode?: number } | undefined;
}

function isIronError(error: unknown): error is IronErrorLike {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { kind?: unknown }).kind === "function" &&
    typeof (error as { backtrace?: unknown }).backtrace === "function"
  );
}

/**
 * What went wrong, in terms the owner can act on — and no more than the error
 * actually says. Kinds and their meanings come from the component's typings;
 * `ProxyConnect` was observed for real against an unreachable Gateway
 * (remote-access.md §9.1).
 */
export function describeFailure(error: unknown, gatewayUrl: string): string {
  if (error instanceof CoreRefusal) {
    return error.message;
  }

  if (!isIronError(error)) {
    return `The remote session failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  switch (error.kind()) {
    case IronErrorKind.WrongPassword:
    case IronErrorKind.LogonFailure:
      return "Windows refused that user name or password. Nothing was saved; type it again.";
    case IronErrorKind.AccessDenied:
      return "Windows accepted the account, but it is not allowed to sign in remotely on that host.";
    case IronErrorKind.ProxyConnect:
      return `Could not reach the Gateway at ${gatewayUrl}. Is the host awake, and is the Gateway running?`;
    case IronErrorKind.RDCleanPath: {
      const status = error.rdcleanpathDetails?.()?.httpStatusCode;

      return status === 401 || status === 403
        ? "The Gateway refused the session token. It may have expired; connect again for a new one."
        : `The Gateway could not reach the desktop${status === undefined ? "" : ` (HTTP ${String(status)})`}. Is Remote Desktop enabled on that host?`;
    }
    case IronErrorKind.NegotiationFailure:
      return "The desktop and the panel could not agree on a secure connection.";
    default:
      return `The remote session failed: ${error.backtrace()}`;
  }
}

/**
 * Token, then component, then run until the session ends.
 *
 * The core is asked first and a refusal stops everything: no socket is opened
 * without a token the core chose to issue. A fresh idempotency key per attempt,
 * because the core never replays a token (a reused key is a 409).
 */
export function connectRemote(options: ConnectRemoteOptions): RemoteHandle {
  const { transport, ui, backend, host, onState } = options;
  let disconnectedByOwner = false;
  let live = false;
  let gatewayUrl = "the Gateway";

  const started = (async () => {
    try {
      onState({ phase: "requesting" });

      const response = await transport
        .request("POST", "/commands/remote.open_session", {
          idempotencyKey: nextKey("remote"),
          host,
        })
        .catch(() => {
          throw new CoreRefusal("Noctis could not reach the core to ask for a session.");
        });

      if (response.status !== 200) {
        throw new CoreRefusal(coreRefusal(response.status));
      }

      const session = RemoteDesktopSessionSchema.parse(response.body);
      gatewayUrl = session.gatewayUrl;

      onState({ phase: "connecting" });

      const config = ui
        .configBuilder()
        .withUsername(options.username)
        .withPassword(options.password)
        .withDestination(session.destination)
        .withProxyAddress(session.gatewayUrl)
        .withAuthToken(session.token)
        .withServerDomain("")
        .withExtension(backend.enableCredssp(true))
        .withExtension(backend.displayControl(true))
        .build();

      const connected = await ui.connect(config as never);
      live = true;
      // The component mounts its canvas hidden and never unhides it itself;
      // without this a connected session is a black rectangle.
      ui.setVisibility(true);

      onState({
        phase: "connected",
        host: session.host,
        width: connected.initialDesktopSize.width,
        height: connected.initialDesktopSize.height,
      });

      void connected.run().then(
        (termination) => {
          live = false;
          onState({
            phase: "ended",
            reason: disconnectedByOwner ? "You disconnected." : termination.reason(),
          });
        },
        (error: unknown) => {
          live = false;
          onState(
            disconnectedByOwner
              ? { phase: "ended", reason: "You disconnected." }
              : { phase: "failed", message: describeFailure(error, gatewayUrl) },
          );
        },
      );
    } catch (error) {
      onState({ phase: "failed", message: describeFailure(error, gatewayUrl) });
    }
  })();

  return {
    started,
    disconnect: () => {
      if (!live) {
        return;
      }

      disconnectedByOwner = true;
      ui.shutdown();
    },
  };
}

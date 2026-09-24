import { describe, expect, it } from "vitest";

import type { CoreMethod, CoreResponse, CoreTransport } from "../transport/CoreTransport.js";

import type { RemoteBackend, RemoteState, RemoteUserInteraction } from "./session.js";
import { connectRemote, describeFailure, IronErrorKind } from "./session.js";

const SESSION = {
  host: "zarrarpc",
  gatewayUrl: "wss://zarrarpc.tail9594ed.ts.net/jet/rdp",
  destination: "zarrarpc.tail9594ed.ts.net:3389",
  token: "header.payload.signature",
  associationId: "0190f5a0-0000-7000-8000-000000000001",
  expiresAt: "2026-09-22T22:02:00.000Z",
};

const PASSWORD = "correct horse battery staple";

interface Call {
  method: CoreMethod;
  path: string;
  body?: unknown;
}

function core(response: CoreResponse | Error = { status: 200, body: SESSION }): {
  transport: CoreTransport;
  calls: Call[];
} {
  const calls: Call[] = [];

  return {
    calls,
    transport: {
      request: (method, path, body) => {
        calls.push({ method, path, body });
        return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
      },
      subscribe: () => Promise.reject(new Error("not used")),
    },
  };
}

/** An Error-shaped IronError, as the WASM throws it: methods, not fields. */
function ironError(kind: number, http?: number): unknown {
  return {
    kind: () => kind,
    backtrace: () => `kind ${String(kind)}`,
    rdcleanpathDetails: () => (http === undefined ? undefined : { httpStatusCode: http }),
  };
}

interface FakeComponent {
  ui: RemoteUserInteraction;
  config: Record<string, unknown>;
  extensions: unknown[];
  connects: number;
  shutdowns: number;
  visibility: boolean[];
  end: (reason: string) => void;
}

function component(connect: "ok" | { reject: unknown } = "ok"): FakeComponent {
  let end: (reason: string) => void = () => undefined;
  const fake: FakeComponent = {
    config: {},
    extensions: [],
    connects: 0,
    shutdowns: 0,
    visibility: [],
    end: (reason) => {
      end(reason);
    },
    ui: {
      configBuilder() {
        const builder = {
          withUsername: (v: string) => ((fake.config.username = v), builder),
          withPassword: (v: string) => ((fake.config.password = v), builder),
          withDestination: (v: string) => ((fake.config.destination = v), builder),
          withProxyAddress: (v: string) => ((fake.config.proxyAddress = v), builder),
          withAuthToken: (v: string) => ((fake.config.authToken = v), builder),
          withServerDomain: (v: string) => ((fake.config.serverDomain = v), builder),
          withExtension: (v: unknown) => (fake.extensions.push(v), builder),
          build: () => fake.config,
        };
        return builder;
      },
      connect() {
        fake.connects += 1;

        if (connect !== "ok") {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the WASM rejects with an IronError, which is not an Error
          return Promise.reject(connect.reject);
        }

        return Promise.resolve({
          initialDesktopSize: { width: 2560, height: 1440 },
          run: () =>
            new Promise((resolve) => {
              end = (reason) => {
                resolve({ reason: () => reason });
              };
            }),
        });
      },
      shutdown() {
        fake.shutdowns += 1;
        end("shut down by the client");
      },
      ctrlAltDel: () => undefined,
      setVisibility: (visible: boolean) => {
        fake.visibility.push(visible);
      },
    },
  };

  return fake;
}

const BACKEND: RemoteBackend = {
  enableCredssp: (enable) => ({ ext: "credssp", enable }),
  displayControl: (enable) => ({ ext: "display", enable }),
};

async function run(
  transport: CoreTransport,
  fake: FakeComponent,
): Promise<{ states: RemoteState[]; disconnect: () => void }> {
  const states: RemoteState[] = [];
  const handle = connectRemote({
    transport,
    ui: fake.ui,
    backend: BACKEND,
    host: "zarrarpc",
    username: "owner@example.com",
    password: PASSWORD,
    onState: (state) => states.push(state),
  });

  await handle.started;

  return { states, disconnect: handle.disconnect };
}

describe("connectRemote (Task 3.9)", () => {
  it("asks the core for a token by host name and never sends it the password", async () => {
    const { transport, calls } = core();

    await run(transport, component());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.path).toBe("/commands/remote.open_session");
    expect(Object.keys(calls[0]?.body as object).sort()).toEqual(["host", "idempotencyKey"]);
    expect(JSON.stringify(calls)).not.toContain(PASSWORD);
  });

  it("hands the password to the component, with the Gateway and destination the core chose", async () => {
    const fake = component();

    await run(core().transport, fake);

    expect(fake.config).toEqual({
      username: "owner@example.com",
      password: PASSWORD,
      destination: SESSION.destination,
      proxyAddress: SESSION.gatewayUrl,
      authToken: SESSION.token,
      serverDomain: "",
    });
    // NLA is what the host requires; dynamic resize is what makes the panel usable.
    expect(fake.extensions).toEqual([
      { ext: "credssp", enable: true },
      { ext: "display", enable: true },
    ]);
  });

  it("shows the canvas once connected, which the component leaves hidden until told", async () => {
    // Measured on the route: without this the session connected, authenticated
    // and showed nothing but black (remote-access.md §9.8).
    const fake = component();

    await run(core().transport, fake);

    expect(fake.visibility).toEqual([true]);
  });

  it("does not show the canvas for a session that never connected", async () => {
    const fake = component({ reject: ironError(IronErrorKind.LogonFailure) });

    await run(core().transport, fake);

    expect(fake.visibility).toEqual([]);
  });

  it("reports each step, then the session's own reason when it ends", async () => {
    const fake = component();
    const { states } = await run(core().transport, fake);

    fake.end("server closed the connection");
    await Promise.resolve();
    await Promise.resolve();

    expect(states.map((state) => state.phase)).toEqual([
      "requesting",
      "connecting",
      "connected",
      "ended",
    ]);
    expect(states[2]).toEqual({ phase: "connected", host: "zarrarpc", width: 2560, height: 1440 });
    expect(states[3]).toEqual({ phase: "ended", reason: "server closed the connection" });
  });

  it("disconnects cleanly: the component is shut down and the panel says who ended it", async () => {
    const fake = component();
    const { states, disconnect } = await run(core().transport, fake);

    disconnect();
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.shutdowns).toBe(1);
    expect(states.at(-1)).toEqual({ phase: "ended", reason: "You disconnected." });
  });

  it("does not open a socket when the core refuses, and says why", async () => {
    for (const [response, message] of [
      [{ status: 404, body: {} }, /not set up on this core/],
      [{ status: 401, body: {} }, /signed out/],
      [{ status: 503, body: {} }, /core could not/],
      [new Error("offline"), /could not reach the core/],
    ] as const) {
      const fake = component();
      const { states } = await run(core(response).transport, fake);

      expect(fake.connects).toBe(0);
      expect(states.at(-1)?.phase).toBe("failed");
      expect(states.at(-1)).toMatchObject({ message: expect.stringMatching(message) as unknown });
    }
  });

  it("turns the component's refusal into what actually went wrong", async () => {
    const fake = component({ reject: ironError(IronErrorKind.WrongPassword) });
    const { states } = await run(core().transport, fake);

    expect(states.at(-1)).toEqual({
      phase: "failed",
      message: "Windows refused that user name or password. Nothing was saved; type it again.",
    });
  });
});

describe("describeFailure", () => {
  const gateway = SESSION.gatewayUrl;

  it("names the Gateway when it cannot be reached", () => {
    expect(describeFailure(ironError(IronErrorKind.ProxyConnect), gateway)).toContain(gateway);
  });

  it("says the Gateway refused the token, which is what an expired or forged one looks like", () => {
    expect(describeFailure(ironError(IronErrorKind.RDCleanPath, 403), gateway)).toMatch(
      /Gateway refused/,
    );
    expect(describeFailure(ironError(IronErrorKind.RDCleanPath, 401), gateway)).toMatch(
      /Gateway refused/,
    );
  });

  it("separates a refused logon from a refused account", () => {
    expect(describeFailure(ironError(IronErrorKind.LogonFailure), gateway)).toMatch(/password/);
    expect(describeFailure(ironError(IronErrorKind.AccessDenied), gateway)).toMatch(
      /not allowed to sign in remotely/,
    );
  });

  it("never pretends to know more than the error says", () => {
    expect(describeFailure(new Error("boom"), gateway)).toBe("The remote session failed: boom");
    expect(describeFailure(ironError(IronErrorKind.General), gateway)).toMatch(
      /The remote session failed/,
    );
  });
});

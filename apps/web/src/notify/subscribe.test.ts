import { describe, expect, it } from "vitest";

import type { CoreMethod, CoreResponse, CoreTransport } from "../transport/CoreTransport.js";

import type { PushScope } from "./subscribe.js";
import { enablePush, initialPushState } from "./subscribe.js";

const PUBLIC_KEY = "BNc-Hw_9aBc-Dd_0";

interface Call {
  method: CoreMethod;
  path: string;
  body?: unknown;
}

function transport(keyStatus = 200): { transport: CoreTransport; calls: Call[] } {
  const calls: Call[] = [];

  return {
    calls,
    transport: {
      request: (method, path, body): Promise<CoreResponse> => {
        calls.push({ method, path, body });

        if (path === "/push/key") {
          return Promise.resolve({
            status: keyStatus,
            body: keyStatus === 200 ? { publicKey: PUBLIC_KEY } : { error: { code: "x" } },
          });
        }

        return Promise.resolve({ status: 200, body: { status: "subscribed" } });
      },
      subscribe: () => Promise.reject(new Error("not used")),
    },
  };
}

const SUBSCRIPTION = {
  endpoint: "https://push.example/endpoint-1",
  keys: { p256dh: "p256dh-value", auth: "auth-value" },
};

function scope(overrides: Partial<PushScope> = {}): PushScope {
  return {
    navigator: {
      serviceWorker: {
        register: () =>
          Promise.resolve({
            pushManager: { subscribe: () => Promise.resolve({ toJSON: () => SUBSCRIPTION }) },
          }),
      },
    },
    Notification: { permission: "default", requestPermission: () => Promise.resolve("granted") },
    ...overrides,
  };
}

describe("enablePush", () => {
  it("posts the subscription the browser produced, and reports it enabled", async () => {
    const core = transport();

    await expect(enablePush(core.transport, scope())).resolves.toBe("enabled");

    expect(core.calls).toEqual([
      { method: "GET", path: "/push/key", body: undefined },
      { method: "POST", path: "/push/subscribe", body: SUBSCRIPTION },
    ]);
  });

  it("re-registers a device that already has permission, which is how a swept session is repaired", async () => {
    const core = transport();

    // Permission already granted, so no prompt happens — and the endpoint the
    // browser hands back is the one it already had. The point is that it is
    // posted again: the core may have lost the row when the session it hung
    // off expired, and `ON CONFLICT (endpoint) DO UPDATE` rebinds it.
    const result = await enablePush(
      core.transport,
      scope({
        Notification: {
          permission: "granted",
          requestPermission: () => Promise.resolve("granted"),
        },
      }),
    );

    expect(result).toBe("enabled");
    expect(core.calls.at(-1)).toEqual({
      method: "POST",
      path: "/push/subscribe",
      body: SUBSCRIPTION,
    });
  });

  it("is unsupported in a browser with no service worker", async () => {
    const core = transport();

    await expect(enablePush(core.transport, scope({ navigator: {} }))).resolves.toBe("unsupported");
    // Nothing is asked of the core: there is nothing it could answer that helps.
    expect(core.calls).toEqual([]);
  });

  it("is unsupported where Notification does not exist at all — iOS Safari outside the Home Screen", async () => {
    const core = transport();
    const withoutNotification = scope();
    delete withoutNotification.Notification;

    await expect(enablePush(core.transport, withoutNotification)).resolves.toBe("unsupported");
  });

  it("reports a failure, not an unsupported browser, when the core has no VAPID keys", async () => {
    const core = transport(404);
    let asked = false;

    const result = await enablePush(
      core.transport,
      scope({
        Notification: {
          permission: "default",
          requestPermission: () => {
            asked = true;
            return Promise.resolve("granted");
          },
        },
      }),
    );

    expect(result).toBe("failed");
    expect(asked).toBe(false);
    expect(core.calls.map((call) => call.path)).toEqual(["/push/key"]);
  });

  it("is denied when the person says no, and posts nothing", async () => {
    const core = transport();

    const result = await enablePush(
      core.transport,
      scope({
        Notification: { permission: "default", requestPermission: () => Promise.resolve("denied") },
      }),
    );

    expect(result).toBe("denied");
    expect(core.calls.map((call) => call.path)).toEqual(["/push/key"]);
  });

  it("reports a failure rather than throwing when the browser refuses to register the worker", async () => {
    const core = transport();

    const result = await enablePush(
      core.transport,
      scope({
        navigator: {
          serviceWorker: { register: () => Promise.reject(new Error("no worker for you")) },
        },
      }),
    );

    expect(result).toBe("failed");
  });

  it("reports a failure when the core refuses the subscription it was posted", async () => {
    const calls: Call[] = [];
    const refusing: CoreTransport = {
      request: (method, path, body) => {
        calls.push({ method, path, body });

        return Promise.resolve(
          path === "/push/key"
            ? { status: 200, body: { publicKey: PUBLIC_KEY } }
            : { status: 403, body: { error: { code: "csrf_required" } } },
        );
      },
      subscribe: () => Promise.reject(new Error("not used")),
    };

    // The browser did everything right — worker registered, permission granted,
    // endpoint issued — and the core said no. Calling that "unsupported" told
    // the owner their browser could not do the thing it had just done.
    await expect(enablePush(refusing, scope())).resolves.toBe("failed");
    expect(calls.map((call) => call.path)).toEqual(["/push/key", "/push/subscribe"]);
  });
});

describe("initialPushState", () => {
  it("says nothing when push is available but not yet turned on", () => {
    expect(initialPushState(scope())).toBeUndefined();
  });

  it("says denied when the browser already holds a refusal", () => {
    expect(
      initialPushState(
        scope({
          Notification: {
            permission: "denied",
            requestPermission: () => Promise.resolve("denied"),
          },
        }),
      ),
    ).toBe("denied");
  });

  it("says enabled when permission was already granted on this device", () => {
    expect(
      initialPushState(
        scope({
          Notification: {
            permission: "granted",
            requestPermission: () => Promise.resolve("granted"),
          },
        }),
      ),
    ).toBe("enabled");
  });

  it("says unsupported where there is no service worker", () => {
    expect(initialPushState(scope({ navigator: {} }))).toBe("unsupported");
  });
});

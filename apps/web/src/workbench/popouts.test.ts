import { describe, expect, it } from "vitest";
import { PanelPopouts } from "./popouts.js";

// Browser resources are faked here; portal rendering is exercised in Edge E2E.
function childWindow() {
  const events = new EventTarget();
  let closed = false;
  const element = () => ({ style: {}, append: () => {}, remove: () => {} });
  const child = {
    document: {
      title: "",
      head: element(),
      body: element(),
      documentElement: { lang: "en", style: {} },
      createElement: element,
    },
    get closed() {
      return closed;
    },
    close() {
      closed = true;
      events.dispatchEvent(new Event("pagehide"));
    },
    closeSilently() {
      closed = true;
    },
    focus() {},
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  } as unknown as Window & { closeSilently: () => void };
  return child;
}
function host(open: () => Window | null, requestWindow?: () => Promise<Window>) {
  const checks = new Map<number, () => void>();
  let timer = 0;
  const events = new EventTarget();
  const documentEvents = new EventTarget();
  return {
    isSecureContext: true,
    open,
    setInterval: (callback: () => void) => {
      checks.set(++timer, callback);
      return timer;
    },
    clearInterval: (id: number) => {
      checks.delete(id);
    },
    tick: () => {
      for (const check of [...checks.values()]) check();
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    document: {
      querySelectorAll: () => [],
      documentElement: { lang: "en" },
      addEventListener: documentEvents.addEventListener.bind(documentEvents),
      removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
    },
    ...(requestWindow === undefined ? {} : { documentPictureInPicture: { requestWindow } }),
  } as unknown as Window & { tick: () => void };
}
describe("one panel pop-out coordinator per browser tab", () => {
  it("keeps a replacement window when the previous child closes before its observer runs", async () => {
    const first = childWindow();
    const second = childWindow();
    let opens = 0;
    const parent = host(() => (++opens === 1 ? first : second));
    const popouts = new PanelPopouts(parent);
    await popouts.open("thread", "a");
    first.closeSilently();
    await popouts.open("thread", "a");
    parent.tick();
    expect(second.closed).toBe(false);
    expect(popouts.snapshot().entries).toHaveLength(1);
  });
  it("checks closure immediately when the parent regains focus", async () => {
    const child = childWindow();
    const parent = host(() => child);
    const popouts = new PanelPopouts(parent);
    await popouts.open("thread", "a");
    child.closeSilently();
    parent.dispatchEvent(new Event("focus"));
    expect(popouts.snapshot().entries).toEqual([]);
  });
  it("restores panels when the window manager closes a child without pagehide", async () => {
    const child = childWindow();
    const parent = host(() => child);
    const popouts = new PanelPopouts(parent);
    await popouts.open("thread", "a");
    child.closeSilently();
    parent.tick();
    expect(popouts.snapshot().entries).toEqual([]);
  });
  it("keeps blocked panels on the parent and explains the retry", async () => {
    const popouts = new PanelPopouts(host(() => null));
    await popouts.open("thread", "a");
    expect(popouts.snapshot().entries).toEqual([]);
    expect(popouts.snapshot().error).toMatch(/blocked/i);
  });
  it("shares one normal window across owners and returns all panels on window close", async () => {
    const child = childWindow();
    let opens = 0;
    const popouts = new PanelPopouts(
      host(() => {
        opens++;
        return child;
      }),
    );
    await popouts.open("thread", "a");
    await popouts.open("objective", "b");
    expect(opens).toBe(1);
    expect(popouts.snapshot().entries.map((entry) => entry.surfaceId)).toEqual(["a", "b"]);
    expect(popouts.snapshot().mode).toBe("window");
    child.close();
    expect(popouts.snapshot().entries).toEqual([]);
  });
  it("removes only the unmounted owner's panels and closes the last window", async () => {
    const child = childWindow();
    const popouts = new PanelPopouts(host(() => child));
    await popouts.open("thread", "a");
    await popouts.open("objective", "b");
    popouts.releaseOwner("thread");
    expect(popouts.snapshot().entries.map((entry) => entry.surfaceId)).toEqual(["b"]);
    expect(child.closed).toBe(false);
    popouts.releaseOwner("objective");
    expect(child.closed).toBe(true);
  });
  it("returns a dismissed panel without disturbing another live owner", async () => {
    const child = childWindow();
    const popouts = new PanelPopouts(host(() => child));
    await popouts.open("thread", "a");
    await popouts.open("thread", "b");
    popouts.retain("thread", ["b"]);
    expect(popouts.snapshot().entries.map((entry) => entry.surfaceId)).toEqual(["b"]);
  });
  it("cancels a pending PiP panel on owner change and closes the late window", async () => {
    let resolve!: (value: Window) => void;
    const child = childWindow();
    const popouts = new PanelPopouts(
      host(
        () => null,
        () =>
          new Promise((value) => {
            resolve = value;
          }),
      ),
    );
    const opened = popouts.open("thread", "a");
    popouts.releaseOwner("thread");
    resolve(child);
    await opened;
    expect(child.closed).toBe(true);
    expect(popouts.snapshot().entries).toEqual([]);
  });
  it("joins a pending PiP request, without creating a second window", async () => {
    let resolve!: (value: Window) => void;
    let requests = 0;
    const popouts = new PanelPopouts(
      host(
        () => null,
        () => {
          requests++;
          return new Promise((value) => {
            resolve = value;
          });
        },
      ),
    );
    const a = popouts.open("thread", "a");
    const b = popouts.open("objective", "b");
    resolve(childWindow());
    await Promise.all([a, b]);
    expect(requests).toBe(1);
    expect(popouts.snapshot().entries).toHaveLength(2);
  });
  it("uses the next click for fallback after PiP rejects, keeping the gesture", async () => {
    const child = childWindow();
    let opens = 0;
    const popouts = new PanelPopouts(
      host(
        () => {
          opens++;
          return child;
        },
        () => Promise.reject(new Error("denied")),
      ),
    );
    await popouts.open("thread", "a");
    expect(popouts.snapshot().entries).toEqual([]);
    expect(popouts.snapshot().error).toMatch(/try again.*separate window/i);
    expect(opens).toBe(0);
    const retry = popouts.open("thread", "a");
    expect(opens).toBe(1);
    await retry;
    expect(popouts.snapshot().mode).toBe("window");
  });
  it("keeps panels available when PiP throws before returning a promise", async () => {
    const popouts = new PanelPopouts(
      host(
        () => childWindow(),
        () => {
          throw new Error("policy");
        },
      ),
    );
    await expect(popouts.open("thread", "a")).resolves.toBeUndefined();
    expect(popouts.snapshot().error).toMatch(/try again/i);
    await popouts.open("thread", "a");
    expect(popouts.snapshot().entries).toHaveLength(1);
  });
  it("invalidates pending windows and removes listeners on provider disposal", async () => {
    let resolve!: (value: Window) => void;
    const child = childWindow();
    const popouts = new PanelPopouts(
      host(
        () => null,
        () =>
          new Promise((value) => {
            resolve = value;
          }),
      ),
    );
    const opened = popouts.open("presence", "a");
    popouts.dispose();
    resolve(child);
    await opened;
    expect(child.closed).toBe(true);
    expect(popouts.snapshot().entries).toEqual([]);
  });
  it("uses different fallback window names for different parent tabs", async () => {
    const names: unknown[] = [];
    const opener = (_url?: string | URL, name?: string) => {
      names.push(name);
      return childWindow();
    };
    await new PanelPopouts(host(opener)).open("thread", "a");
    await new PanelPopouts(host(opener)).open("thread", "b");
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
  });
});

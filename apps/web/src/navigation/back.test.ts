import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLayer, entryPage, pushPage } from "./back.js";

describe("entryPage", () => {
  it("reads the page a history entry was made on", () => {
    expect(entryPage({ page: "Files", layer: "file" })).toBe("Files");
  });

  it("ignores anything that is not one of the app's pages", () => {
    expect(entryPage(null)).toBeUndefined();
    expect(entryPage({ page: "Nowhere" })).toBeUndefined();
    expect(entryPage("Files")).toBeUndefined();
  });
});

/** A session history in memory, with a back that fires popstate to whoever listens. */
function installHistory(onPop: (state: unknown) => void): {
  length(): number;
} {
  const entries: unknown[] = [{ page: "Presence", depth: 0 }];
  let index = 0;

  vi.stubGlobal("history", {
    get state() {
      return entries[index];
    },
    pushState(state: unknown) {
      entries.length = index + 1;
      entries.push(state);
      index += 1;
    },
    replaceState(state: unknown) {
      entries[index] = state;
    },
    back() {
      index -= 1;
      onPop(entries[index]);
    },
  });

  return { length: () => entries.length };
}

/** What a mounted component does: a layer open or not, wired to the browser's popstate. */
function openable(
  name: string,
  outlivesPage = false,
): { layer: ReturnType<typeof createLayer>; open: boolean } {
  const holder = { open: false } as { layer: ReturnType<typeof createLayer>; open: boolean };

  holder.layer = createLayer(
    name,
    () => {
      holder.open = false;
    },
    outlivesPage,
  );

  return holder;
}

describe("back layers", () => {
  let browser: ReturnType<typeof installHistory>;
  const mounted: ReturnType<typeof openable>[] = [];

  function layerOf(name: string, outlivesPage = false): ReturnType<typeof openable> {
    const made = openable(name, outlivesPage);

    mounted.push(made);

    return made;
  }

  /** Back, as the phone does it: every layer that is open hears the pop. */
  function goBack(): void {
    history.back();
  }

  beforeEach(() => {
    browser = installHistory((state) => {
      for (const made of mounted) {
        made.layer.popped(state);
      }
    });
    mounted.length = 0;
    pushPage("Threads");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("closes a thread picked from the list in one back, then leaves the page", () => {
    const list = layerOf("conversations");
    const thread = layerOf("thread", true);

    list.layer.pushed();
    list.open = true;
    thread.layer.pushed();
    thread.open = true;
    list.layer.dismiss();

    expect(list.open).toBe(false);
    expect(thread.open).toBe(true);
    expect(browser.length()).toBe(3);

    goBack();
    expect(thread.open).toBe(false);
    expect((history.state as { page: string }).page).toBe("Threads");

    goBack();
    expect((history.state as { page: string }).page).toBe("Presence");
  });

  it("closing the file viewer by hand costs no extra back", () => {
    const viewer = layerOf("file");

    pushPage("Files");
    viewer.layer.pushed();
    viewer.open = true;
    viewer.layer.dismiss();

    expect(viewer.open).toBe(false);
    expect(browser.length()).toBe(4);
    expect((history.state as { page: string }).page).toBe("Files");

    goBack();
    expect((history.state as { page: string }).page).toBe("Threads");
  });

  it("never leaves a back press that changes nothing after a page switch with a layer open", () => {
    const viewer = layerOf("file");

    pushPage("Files");
    viewer.layer.pushed();
    viewer.open = true;
    pushPage("Nodes");

    const seen: string[] = [(history.state as { page: string }).page];

    while ((history.state as { depth: number }).depth > 0) {
      goBack();
      seen.push((history.state as { page: string }).page);
    }

    expect(seen).toEqual(["Nodes", "Files", "Threads", "Presence"]);
  });

  it("keeps a delegated thread open under a file viewer opened from it", () => {
    const thread = layerOf("thread", true);
    const viewer = layerOf("file");

    thread.layer.pushed();
    thread.open = true;
    pushPage("Files");
    viewer.layer.pushed();
    viewer.open = true;

    goBack();
    expect(viewer.open).toBe(false);
    expect(thread.open).toBe(true);

    goBack();
    expect((history.state as { page: string }).page).toBe("Threads");
    expect(thread.open).toBe(true);

    goBack();
    expect(thread.open).toBe(false);
  });

  it("keeps a delegated thread open when the conversation list closes over it", () => {
    const thread = layerOf("thread", true);
    const list = layerOf("conversations");

    thread.layer.pushed();
    thread.open = true;
    list.layer.pushed();
    list.open = true;
    list.layer.dismiss();

    expect(list.open).toBe(false);
    expect(thread.open).toBe(true);
  });

  it("lets the thread's own entry be replaced when leaving for Presence", () => {
    const thread = layerOf("thread", true);

    thread.layer.pushed();
    thread.open = true;

    expect(thread.layer.owns()).toBe(true);

    pushPage("Presence", true);
    goBack();

    expect((history.state as { page: string }).page).toBe("Threads");
  });
});

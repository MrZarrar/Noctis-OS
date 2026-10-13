import { HIDDEN_ITEMS, NAV_ITEMS, type RailItem } from "@noctis/ui";
import { useEffect, useRef } from "react";

/**
 * What one history entry remembers: the page, how deep in the app's own stack
 * it sits, and the layer open over it, if any. A layer that survives a page
 * change keeps its entry, with the layer name dropped, when the page moves on.
 */
export interface HistoryEntry {
  page: RailItem;
  depth: number;
  layer?: string;
  outlivesPage?: true;
}

const PAGES: readonly string[] = [...NAV_ITEMS, ...HIDDEN_ITEMS, "Settings"];

export function entryPage(state: unknown): RailItem | undefined {
  const page = (state as { page?: unknown } | null)?.page;
  if (page === "Command") return "Threads";
  return typeof page === "string" && PAGES.includes(page) ? (page as RailItem) : undefined;
}

function depthOf(state: unknown): number {
  const depth = (state as { depth?: unknown } | null)?.depth;
  return typeof depth === "number" ? depth : -1;
}

/**
 * Records a move to another page. A layer open on the page being left belongs
 * to it and goes with it, so its entry becomes the new page's rather than
 * leaving one behind that back would land on and show nothing new. `replace`
 * is for when the caller is itself closing the layer on top.
 */
export function pushPage(page: RailItem, replace = false): void {
  const top = history.state as HistoryEntry | null;
  const depth = Math.max(depthOf(top), 0);

  if (replace || (top?.layer !== undefined && top.outlivesPage !== true)) {
    history.replaceState({ page, depth } satisfies HistoryEntry, "");
    return;
  }
  if (top?.layer !== undefined) {
    history.replaceState({ page: top.page, depth } satisfies HistoryEntry, "");
  }
  history.pushState({ page, depth: depth + 1 } satisfies HistoryEntry, "");
}

export interface BackLayer {
  /** Call right after opening the layer. */
  pushed: () => void;
  /** Closes the layer and returns below its entry. */
  dismiss: () => void;
  /** Whether the layer's entry is the one on top. */
  owns: () => boolean;
  /** Feed it every popstate: it closes only when its own entry was left. */
  popped: (state: unknown) => void;
  /** Spends the entry when another route closes the layer. */
  closed: () => Promise<void>;
}

/**
 * The history logic behind `useBackLayer`, apart from React so it can be run
 * against a stand-in for `history`.
 *
 * A layer remembers the depth of the entry it pushed and closes only when a
 * pop lands below it, so a pop that belongs to another layer, or to a page
 * opened on top, leaves it alone.
 */
export function createLayer(layer: string, onBack: () => void, outlivesPage = false): BackLayer {
  let owner: number | undefined;

  const goTo = (depth: number, onArrival?: () => void): Promise<void> =>
    new Promise((resolve) => {
      const arrived = (): void => {
        removeEventListener("popstate", arrived);
        onArrival?.();
        resolve();
      };
      addEventListener("popstate", arrived);
      history.go(depth - depthOf(history.state));
    });

  const topIsMine = (): boolean => {
    const top = history.state as HistoryEntry | null;
    return owner !== undefined && depthOf(top) === owner;
  };

  const close = (): Promise<void> => {
    const top = history.state as HistoryEntry | null;
    const depth = owner;
    const mustPop =
      depth !== undefined &&
      (depth < depthOf(top) || (topIsMine() && (top?.layer === layer || top?.layer === undefined)));
    owner = undefined;
    onBack();
    if (mustPop) {
      // A list closing in the same click must not schedule a second back.
      history.replaceState({ ...top, layer }, "");
      return goTo(depth - 1);
    }
    return Promise.resolve();
  };

  return {
    pushed() {
      const top = history.state as HistoryEntry | null;
      const depth = Math.max(depthOf(top), 0);
      if (owner !== undefined && owner < depth) {
        const entry: HistoryEntry = {
          page: entryPage(top) ?? "Presence",
          depth: owner,
          layer,
          ...(outlivesPage ? { outlivesPage: true as const } : {}),
        };
        history.replaceState({ ...entry, depth }, "");
        void goTo(owner, () => {
          history.replaceState(entry, "");
        });
        return;
      }
      // The layer reopening over its own entry (a thread opened from a thread),
      // or taking over the entry of a layer that closes with its page (a thread
      // picked from the list), reuses the entry; anything else stacks.
      const takesOver = topIsMine() || (top?.layer !== undefined && top.outlivesPage !== true);
      const entry: HistoryEntry = {
        page: entryPage(top) ?? "Presence",
        depth: takesOver ? depth : depth + 1,
        layer,
        ...(outlivesPage ? { outlivesPage: true as const } : {}),
      };

      if (takesOver) {
        history.replaceState(entry, "");
      } else {
        history.pushState(entry, "");
      }
      owner = entry.depth;
    },
    dismiss() {
      void close();
    },
    owns: topIsMine,
    popped(state) {
      if (owner !== undefined && depthOf(state) < owner) {
        owner = undefined;
        onBack();
      }
    },
    closed() {
      return owner === undefined ? Promise.resolve() : close();
    },
  };
}

/**
 * Lets the phone's back gesture close something opened over a page.
 *
 * Call `pushed()` right after opening it and `dismiss()` instead of closing it
 * by hand. Back closes it through `onBack`.
 */
export function useBackLayer(
  layer: string,
  isOpen: boolean,
  onBack: () => void,
  outlivesPage = false,
): BackLayer {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  const ref = useRef<BackLayer>();
  ref.current ??= createLayer(
    layer,
    () => {
      onBackRef.current();
    },
    outlivesPage,
  );
  const current = ref.current;

  useEffect(() => {
    if (!isOpen) {
      void current.closed();
      return undefined;
    }
    const onPop = (event: PopStateEvent): void => {
      current.popped(event.state);
    };
    addEventListener("popstate", onPop);
    return () => {
      removeEventListener("popstate", onPop);
    };
  }, [current, isOpen]);

  return current;
}

import { typography } from "@noctis/ui";

export interface PopoutEntry {
  owner: string;
  surfaceId: string;
  container: HTMLElement;
}
interface PendingPanel {
  owner: string;
  surfaceId: string;
}
interface PopoutSnapshot {
  entries: readonly PopoutEntry[];
  window?: Window;
  header?: HTMLElement;
  mode?: "pip" | "window";
  error?: string;
}
type PopoutHost = Window & {
  documentPictureInPicture?: {
    requestWindow: (options: { width: number; height: number }) => Promise<Window>;
  };
};

/** One browser resource; the owning Workbenches keep their live React trees. */
export class PanelPopouts {
  private state: PopoutSnapshot = { entries: [] };
  private listeners = new Set<() => void>();
  private pending: PendingPanel[] = [];
  private opening: Promise<void> | undefined;
  private generation = 0;
  private fallback = false;
  private closedCheck: number | undefined;
  private readonly name = `noctis-panels-${crypto.getRandomValues(new Uint32Array(4)).join("-")}`;
  private checkClosed = (): void => {
    if (this.state.window?.closed === true) this.returnAll();
  };
  constructor(private readonly host: PopoutHost) {}
  snapshot = (): PopoutSnapshot => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private publish(state: PopoutSnapshot): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  private add(panel: PendingPanel): void {
    const child = this.state.window;
    if (child === undefined || child.closed) return;
    if (
      this.state.entries.some(
        (entry) => entry.owner === panel.owner && entry.surfaceId === panel.surfaceId,
      )
    )
      return;
    const container = child.document.createElement("div");
    container.style.minWidth = "0";
    container.style.margin = "16px";
    child.document.body.append(container);
    this.publish({ ...this.state, entries: [...this.state.entries, { ...panel, container }] });
  }
  private attach(child: Window, mode: "pip" | "window"): void {
    child.document.title = "Noctis panels";
    child.document.documentElement.lang = this.host.document.documentElement.lang;
    child.document.documentElement.style.overflow = "auto";
    for (const stylesheet of this.host.document.querySelectorAll('style, link[rel="stylesheet"]'))
      child.document.head.append(stylesheet.cloneNode(true));
    child.document.body.style.margin = "0";
    child.document.body.style.overflow = "auto";
    child.document.body.style.height = "auto";
    child.document.body.style.fontFamily = typography.family;
    const header = child.document.createElement("div");
    child.document.body.append(header);
    child.addEventListener("pagehide", this.returnAll);
    // Window-manager closure does not always deliver pagehide (including CDP close).
    this.closedCheck = this.host.setInterval(() => {
      if (child.closed) this.returnAll();
    }, 250);
    this.host.addEventListener("focus", this.checkClosed);
    this.host.document.addEventListener("visibilitychange", this.checkClosed);
    this.publish({ entries: [], window: child, header, mode });
  }
  open = async (owner: string, surfaceId: string): Promise<void> => {
    const panel = { owner, surfaceId };
    if (this.state.window?.closed === true) this.returnAll();
    if (this.state.window !== undefined && !this.state.window.closed) {
      this.add(panel);
      this.state.window.focus();
      return;
    }
    this.pending = [
      ...this.pending.filter((entry) => entry.owner !== owner || entry.surfaceId !== surfaceId),
      panel,
    ];
    if (this.opening !== undefined) return this.opening;
    const generation = this.generation;
    const pip =
      this.host.isSecureContext && !this.fallback ? this.host.documentPictureInPicture : undefined;
    if (pip === undefined) {
      // Open synchronously: awaiting a rejected PiP request consumes the gesture.
      let child: Window | null = null;
      try {
        child = this.host.open("about:blank", this.name, "popup,width=640,height=720");
      } catch {
        /* Browser policy can reject open. */
      }
      if (child === null) {
        this.pending = [];
        this.publish({
          entries: [],
          error: "Pop-out was blocked. Allow pop-ups for Noctis and try again.",
        });
        return;
      }
      this.finishOpen(child, "window", generation);
      return;
    }
    let request: Promise<Window>;
    try {
      request = pip.requestWindow({ width: 640, height: 720 });
    } catch {
      request = Promise.reject(new Error("PiP request refused"));
    }
    this.opening = request
      .then(
        (child) => this.finishOpen(child, "pip", generation),
        () => {
          if (generation !== this.generation) return;
          const hadPanels = this.pending.length > 0;
          this.pending = [];
          this.fallback = true;
          this.publish({
            entries: [],
            ...(hadPanels
              ? {
                  error:
                    "Could not open the always-on-top window. Try again to open a separate window (not always on top).",
                }
              : {}),
          });
        },
      )
      .finally(() => {
        if (generation === this.generation) this.opening = undefined;
      });
    return this.opening;
  };
  private finishOpen(child: Window, mode: "pip" | "window", generation: number): void {
    if (generation !== this.generation || this.pending.length === 0 || child.closed) {
      child.close();
      return;
    }
    try {
      this.attach(child, mode);
      const panels = this.pending;
      this.pending = [];
      for (const panel of panels) this.add(panel);
    } catch {
      child.close();
      this.pending = [];
      this.publish({
        entries: [],
        error: "Could not prepare the panel window. Your panels are still here; try again.",
      });
    }
  }
  returnAll = (): void => {
    this.host.clearInterval(this.closedCheck);
    this.closedCheck = undefined;
    this.host.removeEventListener("focus", this.checkClosed);
    this.host.document.removeEventListener("visibilitychange", this.checkClosed);
    const child = this.state.window;
    child?.removeEventListener("pagehide", this.returnAll);
    this.publish({ entries: [] });
    if (child !== undefined && !child.closed) child.close();
  };
  retain(owner: string, surfaceIds: readonly string[]): void {
    this.pending = this.pending.filter(
      (entry) => entry.owner !== owner || surfaceIds.includes(entry.surfaceId),
    );
    const removed = this.state.entries.filter(
      (entry) => entry.owner === owner && !surfaceIds.includes(entry.surfaceId),
    );
    if (removed.length === 0) return;
    for (const entry of removed) entry.container.remove();
    const entries = this.state.entries.filter((entry) => !removed.includes(entry));
    if (entries.length === 0) this.returnAll();
    else this.publish({ ...this.state, entries });
  }
  returnPanel(owner: string, surfaceId: string): void {
    this.retain(
      owner,
      this.state.entries
        .filter((entry) => entry.owner === owner && entry.surfaceId !== surfaceId)
        .map((entry) => entry.surfaceId),
    );
  }
  releaseOwner(owner: string): void {
    this.retain(owner, []);
  }
  dispose = (): void => {
    this.generation++;
    this.pending = [];
    this.opening = undefined;
    this.returnAll();
  };
}

import type { RemoteBackend, RemoteUserInteraction } from "./session.js";

export interface MountedRemoteDesktop {
  ui: RemoteUserInteraction;
  backend: RemoteBackend;
}

let initialised: Promise<void> | undefined;

/**
 * Loads the IronRDP web component and puts a fresh `<iron-remote-desktop>` in
 * `container`, resolving once it is ready to connect.
 *
 * Both packages are dynamic imports so the 6 MB backend (the WASM is inlined
 * as a data: URL) is its own chunk, fetched the first time someone connects
 * and never by a page that does not.
 *
 * Order is load-bearing (remote-access.md §9.1): the element captures `module`
 * when it mounts, so it is created, given the backend, and only then attached.
 * An element already in the DOM when the definition arrives would mount with
 * no backend and fail its first connect.
 */
export async function mountRemoteDesktop(container: HTMLElement): Promise<MountedRemoteDesktop> {
  const rdp = await import("@devolutions/iron-remote-desktop-rdp");

  initialised ??= rdp.init("INFO");
  await initialised;
  await import("@devolutions/iron-remote-desktop");

  const element = document.createElement("iron-remote-desktop") as HTMLElement & {
    module: unknown;
  };
  element.module = rdp.Backend;
  element.setAttribute("scale", "fit");
  element.setAttribute("flexcenter", "true");

  const ready = new Promise<RemoteUserInteraction>((resolve) => {
    element.addEventListener(
      "ready",
      (event) => {
        resolve(
          (event as CustomEvent<{ irgUserInteraction: RemoteUserInteraction }>).detail
            .irgUserInteraction,
        );
      },
      { once: true },
    );
  });

  container.replaceChildren(element);

  return {
    ui: await ready,
    backend: { enableCredssp: rdp.enableCredssp, displayControl: rdp.displayControl },
  };
}

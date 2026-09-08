import type { MonitorRole, NativeApplicationState, RegionName } from "@noctis/contracts";
import { NativeApplicationStateSchema } from "@noctis/contracts";
import { z } from "zod";

import type { Invoke } from "./TauriTransport.js";

/**
 * The page's route to native window placement.
 *
 * Separate from `CoreTransport` on purpose. `CoreTransport` names a method and a
 * path and the shell signs it; these are shell commands with no core path at
 * all, because the shell is the only process that can touch a window and it asks
 * the core itself rather than being told an answer by the page.
 *
 * Every response is parsed through its contract schema before it is returned. A
 * drift between the Rust enum and `NativeApplicationStateSchema` then fails
 * loudly at this boundary rather than becoming a Surface that renders a fallback
 * for reasons nobody can find.
 */
export interface NativeWindowBridge {
  /**
   * `window.discover`, reported per granted application rather than as a raw
   * window list — the grant list lives in the shell, and a page that had to know
   * which executables count as the editor is a page that can disagree with it.
   */
  survey(): Promise<SurveyedApplication[]>;
  place(request: NativePlaceRequest): Promise<NativeApplicationState>;
  restore(applicationId: string): Promise<NativeApplicationState>;
}

export interface SurveyedApplication {
  applicationId: string;
  displayName: string;
  state: NativeApplicationState;
}

export interface NativePlaceRequest {
  applicationId: string;
  monitor: MonitorRole;
  region: RegionName;
  /**
   * An approval the user has already confirmed. Absent on the first attempt: the
   * shell asks the core, and answers `needsApproval` if a person has to decide.
   */
  approvalId?: string;
  /**
   * Something from the work in hand that distinguishes one of several matching
   * windows — an Objective's workspace name, typically. A hint, never authority:
   * the shell only uses it to choose among windows its grant list already
   * admitted.
   */
  titleHint?: string;
}

const SurveySchema = z.array(
  z
    .object({
      applicationId: z.string().min(1),
      displayName: z.string().min(1),
      state: NativeApplicationStateSchema,
    })
    .strict(),
);

class TauriNativeWindowBridge implements NativeWindowBridge {
  readonly #invoke: Invoke;

  constructor(invoke: Invoke) {
    this.#invoke = invoke;
  }

  async survey(): Promise<SurveyedApplication[]> {
    return SurveySchema.parse(await this.#invoke("window_survey"));
  }

  async place(request: NativePlaceRequest): Promise<NativeApplicationState> {
    const { applicationId, monitor, region, approvalId, titleHint } = request;

    return NativeApplicationStateSchema.parse(
      await this.#invoke("window_place", {
        // The shell's `PlaceIntent`. It has nowhere to put a coordinate, which
        // is the point — see Section 11.2.
        intent: { applicationId, monitor, region },
        approvalId: approvalId ?? null,
        titleHint: titleHint ?? null,
      }),
    );
  }

  async restore(applicationId: string): Promise<NativeApplicationState> {
    return NativeApplicationStateSchema.parse(
      await this.#invoke("window_restore", { applicationId }),
    );
  }
}

interface TauriGlobal {
  core: { invoke: Invoke };
}

/**
 * The bridge, or nothing.
 *
 * `undefined` in a browser, and that is a first-class answer rather than a
 * failure: a page served outside the desktop shell has no Win32 behind it, so
 * the honest thing is for focus mode not to appear at all rather than to appear
 * and refuse. It is also why the E2E suite, which runs in a real browser, does
 * not have to pretend a shell is there.
 */
export function nativeWindowBridgeFrom(scope: unknown): NativeWindowBridge | undefined {
  const bridge = (scope as { __TAURI__?: TauriGlobal } | undefined)?.__TAURI__;

  return bridge === undefined ? undefined : new TauriNativeWindowBridge(bridge.core.invoke);
}

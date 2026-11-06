import { useEffect } from "react";
import type { CoreTransport } from "../transport/CoreTransport.js";
import { createPalaceApi, palaceDraftScope, PalaceRequestError } from "./api.js";
import { clearSensitiveDrafts, hasSensitiveDrafts } from "./drafts.js";

export function usePalaceSession(transport: CoreTransport | undefined): void {
  useEffect(() => {
    const scope = palaceDraftScope();
    const api = createPalaceApi(transport);
    const check = async () => {
      if (!hasSensitiveDrafts(scope)) return;
      try {
        if (!(await api.passcode()).unlocked) clearSensitiveDrafts(scope);
      } catch (error) {
        if (error instanceof PalaceRequestError && [401, 403].includes(error.status))
          clearSensitiveDrafts(scope);
      }
    };
    const timer = setInterval(() => {
      void check();
    }, 15_000);
    const onFocus = () => {
      void check();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [transport]);
}

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { spacing, typography } from "@noctis/ui";
import { buttonStyle } from "../layout/Page.js";
import { PanelPopouts } from "./popouts.js";
const PopoutContext = createContext<PanelPopouts | undefined>(undefined);
export function PopoutProvider({ children }: { children: ReactNode }): JSX.Element {
  const [coordinator] = useState(() => new PanelPopouts(window));
  const state = useSyncExternalStore(coordinator.subscribe, coordinator.snapshot);
  useEffect(() => {
    window.addEventListener("pagehide", coordinator.dispose);
    return () => {
      window.removeEventListener("pagehide", coordinator.dispose);
      coordinator.dispose();
    };
  }, [coordinator]);
  return (
    <PopoutContext.Provider value={coordinator}>
      {state.error !== undefined && (
        <p role="alert" style={{ color: typography.color.primary, padding: spacing.md }}>
          {state.error}
        </p>
      )}
      {children}
      {state.header !== undefined &&
        createPortal(
          <header
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: spacing.md,
              alignItems: "center",
              padding: spacing.md,
              color: typography.color.primary,
            }}
          >
            <span>
              {state.mode === "pip"
                ? "Always-on-top panels"
                : "Separate window (not always on top)"}
            </span>
            <button type="button" style={buttonStyle} onClick={coordinator.returnAll}>
              Return all panels
            </button>
          </header>,
          state.header,
        )}
    </PopoutContext.Provider>
  );
}
const EMPTY = { entries: [] };
export function usePopouts(): {
  coordinator: PanelPopouts | undefined;
  state: ReturnType<PanelPopouts["snapshot"]>;
} {
  const coordinator = useContext(PopoutContext);
  const state = useSyncExternalStore(
    coordinator?.subscribe ?? (() => () => {}),
    coordinator?.snapshot ?? (() => EMPTY),
  );
  return { coordinator, state };
}

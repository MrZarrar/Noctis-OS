/**
 * LARP mode's switch: one local setting per device, off unless set. It is the
 * only thing LARP mode ever stores.
 */
const KEY = "noctis.larp";

export function larpEnabled(
  storage: Pick<Storage, "getItem"> | undefined = safeStorage(),
): boolean {
  try {
    return storage?.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setLarpEnabled(
  on: boolean,
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined = safeStorage(),
): void {
  try {
    if (on) storage?.setItem(KEY, "1");
    else storage?.removeItem(KEY);
  } catch {
    /* a private window without storage simply stays in real mode */
  }
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Wakes a sleeping agent once as the owner starts typing to it, not on every
 * key: a wake is cheap, but a keystroke each is noise. Armed again when the
 * agent falls asleep.
 */
export interface WakeGuard {
  /** Call on each change to the text; true means wake now. */
  typed(state: { asleep: boolean; enabled: boolean }): boolean;
}

export function createWakeGuard(): WakeGuard {
  let fired = false;

  return {
    typed({ asleep, enabled }) {
      if (!asleep) {
        fired = false;
        return false;
      }

      if (!enabled || fired) {
        return false;
      }

      fired = true;
      return true;
    },
  };
}

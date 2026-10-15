import { msUntilNext } from "./digest.js";

/**
 * Something that runs once a day at a time the owner sets on the Settings page.
 * `at` is read each time the timer schedules, so a changed setting takes effect
 * on `restart()`, which clears the pending run first: two schedules would send
 * the same digest twice.
 */
export interface DailyTimer {
  start(): void;
  restart(): void;
  stop(): void;
}

export function createDailyTimer(options: {
  clock: { now(): number };
  /** `HH:MM`, or empty for off. */
  at: () => string;
  run: () => void;
}): DailyTimer {
  let pending: ReturnType<typeof setTimeout> | undefined;

  const stop = (): void => {
    if (pending !== undefined) {
      clearTimeout(pending);
      pending = undefined;
    }
  };

  const schedule = (): void => {
    stop();
    const wait = msUntilNext(new Date(options.clock.now()), options.at());

    if (wait === undefined) {
      return;
    }

    pending = setTimeout(() => {
      pending = undefined;
      options.run();
      schedule();
    }, wait);
    pending.unref?.();
  };

  return { start: schedule, restart: schedule, stop };
}

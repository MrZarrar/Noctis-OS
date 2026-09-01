/** Injected time source. Never call Date.now() directly in domain or core code. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export function fixedClock(milliseconds: number): Clock {
  return { now: () => milliseconds };
}

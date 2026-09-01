import { v7 as uuidv7 } from "uuid";

import type { Clock } from "./clock.js";

export interface IdFactory {
  nextId(): string;
}

export interface IdFactoryOptions {
  /** Fixed bytes for deterministic tests. Omit in production to use the default CSPRNG. */
  random?: Uint8Array;
}

/** uuid's v7 accepts a 31-bit sequence and stays monotonic across its whole range. */
const MAX_SEQUENCE = 0x7fffffff;

export function createIdFactory(clock: Clock, options: IdFactoryOptions = {}): IdFactory {
  let lastMilliseconds = -1;
  let sequence = 0;

  return {
    nextId(): string {
      const milliseconds = clock.now();

      if (milliseconds === lastMilliseconds) {
        if (sequence >= MAX_SEQUENCE) {
          throw new Error(`Exhausted UUIDv7 sequence space within millisecond ${milliseconds}`);
        }
        sequence += 1;
      } else {
        lastMilliseconds = milliseconds;
        sequence = 0;
      }

      return options.random === undefined
        ? uuidv7({ msecs: milliseconds, seq: sequence })
        : uuidv7({ msecs: milliseconds, seq: sequence, random: options.random });
    },
  };
}

import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";

import { fixedClock } from "./clock.js";
import { createIdFactory } from "./ids.js";

const FIXED_RANDOM = new Uint8Array(16).fill(0);

describe("createIdFactory", () => {
  it("uses the injected clock for timestamps", () => {
    const T = 1_735_689_600_000;
    const factory = createIdFactory(fixedClock(T), { random: FIXED_RANDOM });
    const id = factory.nextId();

    const expected = uuidv7({ msecs: T, seq: 0, random: FIXED_RANDOM });
    expect(id).toBe(expected);
  });

  it("increments sequence within one millisecond", () => {
    const T = 1_735_689_600_000;
    const factory = createIdFactory(fixedClock(T), { random: FIXED_RANDOM });

    const id0 = factory.nextId();
    const id1 = factory.nextId();
    const id2 = factory.nextId();

    const expected0 = uuidv7({ msecs: T, seq: 0, random: FIXED_RANDOM });
    const expected1 = uuidv7({ msecs: T, seq: 1, random: FIXED_RANDOM });
    const expected2 = uuidv7({ msecs: T, seq: 2, random: FIXED_RANDOM });

    expect(id0).toBe(expected0);
    expect(id1).toBe(expected1);
    expect(id2).toBe(expected2);
  });

  it("resets the sequence counter when the clock advances", () => {
    let current = 1_735_689_600_000;
    const factory = createIdFactory({ now: () => current }, { random: FIXED_RANDOM });

    factory.nextId();
    factory.nextId();
    current += 1;
    const afterAdvance = factory.nextId();

    const expected = uuidv7({ msecs: current, seq: 0, random: FIXED_RANDOM });
    expect(afterAdvance).toBe(expected);
  });

  it("produces strictly ascending ids within one millisecond", () => {
    const factory = createIdFactory(fixedClock(1_735_689_600_000), { random: FIXED_RANDOM });
    const ids = [factory.nextId(), factory.nextId(), factory.nextId()] as [string, string, string];

    expect(ids[0] < ids[1]).toBe(true);
    expect(ids[1] < ids[2]).toBe(true);
  });

  it("is deterministic for the same clock and random source", () => {
    const a = createIdFactory(fixedClock(1_735_689_600_000), { random: FIXED_RANDOM }).nextId();
    const b = createIdFactory(fixedClock(1_735_689_600_000), { random: FIXED_RANDOM }).nextId();

    expect(a).toBe(b);
  });
});

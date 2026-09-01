import { describe, expect, it } from "vitest";

import { fixedClock } from "./clock.js";
import { createIdFactory } from "./ids.js";

const FIXED_RANDOM = new Uint8Array(16).fill(0);

describe("createIdFactory", () => {
  it("produces strictly ascending ids within one millisecond", () => {
    const factory = createIdFactory(fixedClock(1_735_689_600_000), { random: FIXED_RANDOM });
    const ids = [factory.nextId(), factory.nextId(), factory.nextId()] as [string, string, string];

    expect(ids[0] < ids[1]).toBe(true);
    expect(ids[1] < ids[2]).toBe(true);
  });

  it("produces ascending ids across a millisecond boundary", () => {
    let current = 1_735_689_600_000;
    const factory = createIdFactory({ now: () => current }, { random: FIXED_RANDOM });

    const first = factory.nextId();
    current += 1;
    const second = factory.nextId();

    expect(first < second).toBe(true);
  });

  it("is deterministic for the same clock and random source", () => {
    const a = createIdFactory(fixedClock(1_735_689_600_000), { random: FIXED_RANDOM }).nextId();
    const b = createIdFactory(fixedClock(1_735_689_600_000), { random: FIXED_RANDOM }).nextId();

    expect(a).toBe(b);
  });

  it("emits version 7 identifiers", () => {
    const id = createIdFactory(fixedClock(1_735_689_600_000), { random: FIXED_RANDOM }).nextId();

    expect(id[14]).toBe("7");
  });

  it("resets the counter when the clock advances", () => {
    let current = 1_735_689_600_000;
    const factory = createIdFactory({ now: () => current }, { random: FIXED_RANDOM });

    factory.nextId();
    factory.nextId();
    current += 1;
    const afterAdvance = factory.nextId();
    const sameMillisecond = factory.nextId();

    expect(afterAdvance < sameMillisecond).toBe(true);
  });
});

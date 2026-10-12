import type { SurfaceIntent, SurfaceOverride } from "@noctis/contracts";
import { CompositionPlanSchema } from "@noctis/contracts";
import { describe, expect, it } from "vitest";

import type { CompositionInput } from "./compose.js";
import { compose, compositionSignature } from "./compose.js";
import { LAYOUTS, attentionStateForLayout, displayClass } from "./layouts.js";

const OBJECTIVE = "01941f29-7c00-7000-8000-0000000000a0";
const AT = "2026-09-06T12:00:00.000Z";

function id(n: number): string {
  return `01941f29-7c00-7000-8000-${String(n).padStart(12, "0")}`;
}

function intent(overrides: Partial<SurfaceIntent> & { id: string }): SurfaceIntent {
  return {
    objectiveId: OBJECTIVE,
    kind: "detail",
    role: "primary",
    persistence: "objective",
    lifecycle: "active",
    priority: 0,
    minSize: "compact",
    sourceIds: [],
    artifactIds: [],
    payloadVersion: 1,
    payload: {},
    requestedAt: AT,
    ...overrides,
  };
}

function input(partial: Partial<CompositionInput> = {}): CompositionInput {
  return {
    owner: { objectiveId: OBJECTIVE },
    intents: [],
    overrides: [],
    display: { fingerprint: "fp-1", widthPx: 2560 },
    attentionState: "active_canvas",
    generatedAt: AT,
    ...partial,
  };
}

/** Deterministic PRNG so a failing randomized run is reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROLES = ["primary", "supporting", "context", "control", "attention"] as const;
const PERSISTENCE = ["ephemeral", "objective", "pinned", "restorable"] as const;
const LIFECYCLES = [
  "proposed",
  "entering",
  "active",
  "background",
  "exiting",
  "dismissed",
] as const;
const SIZES = ["compact", "standard", "wide", "stage"] as const;
const REGIONS = ["left", "centre", "right", "bottom", "overlay"] as const;
const STATES = ["presence", "active_canvas", "focus", "attention_required"] as const;

function randomInput(random: () => number, seq: number): CompositionInput {
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;
  const count = 1 + Math.floor(random() * 8);
  const intents = Array.from({ length: count }, (_unused, index) =>
    intent({
      id: id(seq * 100 + index),
      kind: pick(["detail", "list", "conversation", "evidence", "attention"]),
      role: pick(ROLES),
      persistence: pick(PERSISTENCE),
      lifecycle: pick(LIFECYCLES),
      priority: Math.floor(random() * 5),
      minSize: pick(SIZES),
      // Sometimes a genuine duplicate of a sibling, sometimes its own identity:
      // the randomized runs need both the dedupe path and the placement path.
      ...(random() < 0.7 ? { sourceIds: [id(seq * 100 + index)] } : {}),
      ...(random() < 0.4 ? { preferredRegion: pick(REGIONS) } : {}),
    }),
  );

  return input({
    intents,
    attentionState: pick(STATES),
    display: { fingerprint: "fp-1", widthPx: pick([1024, 1440, 2560]) },
  });
}

describe("compose", () => {
  it("produces a contract-valid plan", () => {
    const outcome = compose(input({ intents: [intent({ id: id(1) })] }));

    expect(CompositionPlanSchema.safeParse(outcome.plan).success).toBe(true);
    expect(outcome.plan.slots).toEqual([
      { surfaceId: id(1), region: "centre", order: 0, size: "wide", layer: 0 },
    ]);
  });

  it("names one layout per attention state and can read the state back", () => {
    for (const state of STATES) {
      expect(attentionStateForLayout(LAYOUTS[state].id)).toBe(state);
    }
  });

  it("THE GATE: identical inputs yield identical compositions across 1,000 randomized runs", () => {
    const random = mulberry32(20260906);

    for (let run = 0; run < 1000; run += 1) {
      const candidate = randomInput(random, run);
      const first = compose(candidate);
      const second = compose(candidate);

      expect(second.signature).toBe(first.signature);
      expect(second.plan).toEqual(first.plan);

      // Input order is not part of the input's meaning. A plan that changed
      // when the same set arrived in a different order would still pass a
      // naive repeat-the-call check, so shuffle and compare as well.
      const shuffled = compose({ ...candidate, intents: [...candidate.intents].reverse() });

      expect(shuffled.signature).toBe(first.signature);
    }
  });

  it("THE GATE: invalid Surface payloads fall back safely instead of failing the plan", () => {
    const outcome = compose(
      input({
        intents: [
          null,
          "not an intent",
          { id: id(2) },
          intent({ id: id(3), payload: { rows: [] } }),
        ],
      }),
    );

    expect(outcome.plan.slots.map((slot) => slot.surfaceId)).toEqual([id(3)]);
    expect(outcome.plan.reasonCodes).toContain("intent.rejected_invalid");
  });

  it("THE GATE: an intent carrying geometry is rejected, not stripped and honoured", () => {
    const geometry = { ...intent({ id: id(4) }), x: 10, y: 20, width: 800, zIndex: 99 };
    const outcome = compose(input({ intents: [geometry] }));

    expect(outcome.plan.slots).toEqual([]);
    expect(outcome.plan.overflowSurfaceIds).toEqual([]);
    expect(JSON.stringify(outcome.plan)).not.toContain("zIndex");
  });

  it("excludes exiting and dismissed Surfaces", () => {
    const outcome = compose(
      input({
        intents: [
          intent({ id: id(5), lifecycle: "exiting" }),
          intent({ id: id(6), lifecycle: "dismissed" }),
        ],
      }),
    );

    expect(outcome.plan.slots).toEqual([]);
    expect(outcome.plan.reasonCodes).toContain("lifecycle.excluded");
  });

  it("collapses duplicate intents by objective, kind, and source identity", () => {
    const source = id(7);
    const outcome = compose(
      input({
        intents: [
          intent({ id: id(8), kind: "list", sourceIds: [source], priority: 1 }),
          intent({ id: id(9), kind: "list", sourceIds: [source], priority: 5 }),
        ],
      }),
    );

    expect(outcome.plan.slots.map((slot) => slot.surfaceId)).toEqual([id(9)]);
    expect(outcome.plan.reasonCodes).toContain("intent.deduplicated");
  });

  it("honours a user override for this display and ignores one for another", () => {
    const override: SurfaceOverride = {
      id: id(10),
      surfaceId: id(11),
      clientId: "client-1",
      displayFingerprint: "fp-1",
      region: "left",
      size: "standard",
      createdAt: AT,
    };
    const elsewhere: SurfaceOverride = { ...override, id: id(12), displayFingerprint: "fp-2" };

    const outcome = compose(
      input({ intents: [intent({ id: id(11) })], overrides: [override, elsewhere] }),
    );

    expect(outcome.plan.slots[0]?.region).toBe("left");
    expect(outcome.plan.reasonCodes).toContain("override.honoured");
  });

  it("releases an override once releasedAt is set", () => {
    const released: SurfaceOverride = {
      id: id(13),
      surfaceId: id(14),
      clientId: "client-1",
      displayFingerprint: "fp-1",
      region: "left",
      size: "standard",
      createdAt: AT,
      releasedAt: AT,
    };

    const outcome = compose(input({ intents: [intent({ id: id(14) })], overrides: [released] }));

    expect(outcome.plan.slots[0]?.region).toBe("centre");
  });

  it("sends excess Surfaces to overflow rather than overlapping them", () => {
    const outcome = compose(
      input({
        display: { fingerprint: "fp-1", widthPx: 1024 },
        intents: [
          intent({ id: id(15), kind: "plan", role: "primary", priority: 9 }),
          intent({ id: id(16), kind: "notes", role: "primary", priority: 1 }),
        ],
      }),
    );

    expect(displayClass(1024)).toBe("compact");
    expect(outcome.plan.slots.map((slot) => slot.surfaceId)).toEqual([id(15)]);
    expect(outcome.plan.overflowSurfaceIds).toEqual([id(16)]);
    expect(outcome.plan.reasonCodes).toContain("overflow.capacity");
  });

  it("overflows a Surface whose minimum size the region cannot give it", () => {
    const outcome = compose(input({ intents: [intent({ id: id(17), minSize: "stage" })] }));

    expect(outcome.plan.overflowSurfaceIds).toEqual([id(17)]);
    expect(outcome.plan.reasonCodes).toContain("overflow.size_unsupported");
  });

  it("keeps a pinned Surface placed when an unpinned rival outranks it", () => {
    const outcome = compose(
      input({
        display: { fingerprint: "fp-1", widthPx: 1024 },
        intents: [
          intent({ id: id(18), kind: "plan", role: "primary", persistence: "pinned", priority: 0 }),
          intent({
            id: id(19),
            kind: "notes",
            role: "primary",
            persistence: "ephemeral",
            priority: 9,
          }),
        ],
      }),
    );

    expect(outcome.plan.slots.map((slot) => slot.surfaceId)).toEqual([id(18)]);
  });

  it("gives explicit user focus the primary slot over everything else", () => {
    const outcome = compose(
      input({
        display: { fingerprint: "fp-1", widthPx: 1024 },
        focusedSurfaceId: id(21),
        intents: [
          intent({ id: id(20), kind: "plan", role: "primary", persistence: "pinned", priority: 9 }),
          intent({ id: id(21), kind: "notes", role: "supporting", priority: 0 }),
        ],
      }),
    );

    expect(outcome.plan.slots.map((slot) => slot.surfaceId)).toEqual([id(21)]);
    expect(outcome.plan.reasonCodes).toContain("focus.applied");
  });

  it("escalates to attention_required when an attention Surface is present", () => {
    const outcome = compose(
      input({
        intents: [
          intent({ id: id(22), kind: "plan" }),
          intent({ id: id(23), kind: "blocker", role: "attention" }),
        ],
      }),
    );

    expect(outcome.plan.layoutId).toBe(LAYOUTS.attention_required.id);
    expect(outcome.plan.reasonCodes).toContain("attention.escalated");
    // Elevated without hiding current work: the primary keeps its slot.
    expect(outcome.plan.slots.map((slot) => slot.surfaceId)).toContain(id(22));
  });

  it("does not escalate out of presence", () => {
    const outcome = compose(
      input({ attentionState: "presence", intents: [intent({ id: id(24), role: "attention" })] }),
    );

    expect(outcome.plan.layoutId).toBe(LAYOUTS.presence.id);
    expect(outcome.plan.slots).toEqual([]);
    expect(outcome.plan.overflowSurfaceIds).toEqual([id(24)]);
  });

  it("signs a plan by its content, not by when it was generated", () => {
    const noon = compose(input({ intents: [intent({ id: id(25) })] }));
    const later = compose(
      input({ intents: [intent({ id: id(25) })], generatedAt: "2026-09-06T23:00:00.000Z" }),
    );

    expect(later.signature).toBe(noon.signature);
    expect(compositionSignature(later.plan)).toBe(noon.signature);
  });
});

describe("composition ownership", () => {
  const owners = [{ objectiveId: OBJECTIVE }, { threadId: OBJECTIVE }, { presence: true }] as const;
  it.each(owners)("composes and stamps each owner: %j", (owner) => {
    const base = { ...intent({ id: id(90) }), objectiveId: undefined };
    const outcome = compose(input({ owner, intents: [{ ...base, ...owner }] }));
    expect(outcome.plan).toMatchObject(owner);
    expect(outcome.plan.slots).toHaveLength(1);
  });
  it("isolates all owner kinds with identical UUIDs", () => {
    const base = { ...intent({ id: id(91) }), objectiveId: undefined };
    expect(
      new Set(
        owners.map(
          (owner) => compose(input({ owner, intents: [{ ...base, ...owner }] })).signature,
        ),
      ).size,
    ).toBe(3);
    for (const owner of owners)
      for (const foreign of owners.filter((value) => value !== owner)) {
        const outcome = compose(input({ owner, intents: [{ ...base, ...foreign }] }));
        expect(outcome.plan.slots).toHaveLength(0);
        expect(outcome.plan.reasonCodes).toContain("intent.foreign_objective");
      }
  });
  it("rejects another thread", () => {
    const base = { ...intent({ id: id(92) }), objectiveId: undefined };
    expect(
      compose(input({ owner: { threadId: OBJECTIVE }, intents: [{ ...base, threadId: id(93) }] }))
        .plan.reasonCodes,
    ).toContain("intent.foreign_objective");
  });
});

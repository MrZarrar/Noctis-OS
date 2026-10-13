import type {
  AttentionState,
  CompositionPlan,
  SurfaceIntent,
  SurfaceOwner,
  SurfaceOverride,
  SurfaceRegion,
  SurfaceRole,
  SurfaceSize,
} from "@noctis/contracts";
import {
  CompositionPlanSchema,
  SurfaceOwnerSchema,
  ownerIdOf,
  SurfaceIntentSchema,
  SurfaceOverrideSchema,
} from "@noctis/contracts";

import type { DisplayClass, LayoutTemplate } from "./layouts.js";
import { LAYOUTS, ROLE_REGION, displayClass } from "./layouts.js";

/**
 * Everything the compositor is allowed to know about the display: which one it
 * is, and how wide. No monitor rectangle, no device pixel ratio, no origin.
 */
export interface DisplayFacts {
  fingerprint: string;
  widthPx: number;
}

export interface CompositionInput {
  owner: SurfaceOwner;
  /**
   * Untrusted on purpose. Intents reach here from the database, from a client,
   * and eventually from a model; the compositor parses every one of them rather
   * than trusting whichever caller happened to hand them over.
   */
  intents: readonly unknown[];
  overrides: readonly unknown[];
  display: DisplayFacts;
  attentionState: AttentionState;
  focusedSurfaceId?: string;
  /** Supplied by the caller. The compositor never reads a clock — that is what makes it pure. */
  generatedAt: string;
}

export interface CompositionOutcome {
  plan: CompositionPlan;
  /** Identity of the plan's content, ignoring when it was generated. */
  signature: string;
}

const REGION_ORDER: readonly SurfaceRegion[] = ["left", "centre", "right", "bottom", "overlay"];
const SIZE_RANK: Readonly<Record<SurfaceSize, number>> = {
  compact: 0,
  standard: 1,
  wide: 2,
  stage: 3,
};
const ROLE_RANK: Readonly<Record<SurfaceRole, number>> = {
  primary: 0,
  attention: 1,
  supporting: 2,
  context: 3,
  control: 4,
};

/**
 * The canonical serialization of a plan's content. Used to answer "is this the
 * same composition as the one already committed", which is the only question a
 * hash would have been asked; comparing the canonical form answers it exactly
 * rather than probably, and needs no crypto primitive in a package that must
 * also run in a browser.
 */
export function compositionSignature(plan: CompositionPlan): string {
  return JSON.stringify([
    ownerIdOf(plan),
    plan.layoutId,
    plan.displayFingerprint,
    plan.slots.map((slot) => [slot.surfaceId, slot.region, slot.order, slot.size, slot.layer]),
    plan.overflowSurfaceIds,
    plan.reasonCodes,
  ]);
}

/** Deterministic tie-break between two intents that mean the same thing. */
function preferIntent(a: SurfaceIntent, b: SurfaceIntent): SurfaceIntent {
  if (a.priority !== b.priority) {
    return a.priority > b.priority ? a : b;
  }

  if (a.requestedAt !== b.requestedAt) {
    return a.requestedAt > b.requestedAt ? a : b;
  }

  return a.id < b.id ? a : b;
}

function preferOverride(a: SurfaceOverride, b: SurfaceOverride): SurfaceOverride {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt > b.createdAt ? a : b;
  }

  return a.id < b.id ? a : b;
}

function dedupeKey(intent: SurfaceIntent): string {
  return `${intent.kind}\u0000${[...intent.sourceIds].sort().join(",")}`;
}

interface Ranked {
  intent: SurfaceIntent;
  role: SurfaceRole;
  focused: boolean;
  pinned: boolean;
}

/**
 * A total order. Every comparison ends at the id, which is unique, so no two
 * distinct Surfaces can compare equal and no sort can depend on input order.
 */
function compareRanked(a: Ranked, b: Ranked): number {
  if (a.focused !== b.focused) {
    return a.focused ? -1 : 1;
  }

  if (a.pinned !== b.pinned) {
    return a.pinned ? -1 : 1;
  }

  if (a.role !== b.role) {
    return ROLE_RANK[a.role] - ROLE_RANK[b.role];
  }

  if (a.intent.priority !== b.intent.priority) {
    return b.intent.priority - a.intent.priority;
  }

  if (a.intent.requestedAt !== b.intent.requestedAt) {
    return a.intent.requestedAt > b.intent.requestedAt ? -1 : 1;
  }

  return a.intent.id < b.intent.id ? -1 : 1;
}

function capacityOf(layout: LayoutTemplate, display: DisplayClass): Map<SurfaceRegion, number> {
  const entries = Object.entries(layout.capacity[display]) as Array<[SurfaceRegion, number]>;

  return new Map(entries);
}

export function compose(input: CompositionInput): CompositionOutcome {
  const owner = SurfaceOwnerSchema.parse(input.owner);
  const ownerId = ownerIdOf(owner);
  const reasons = new Set<string>();

  // 1. Reject invalid or unsupported intents.
  const valid: SurfaceIntent[] = [];

  for (const raw of input.intents) {
    const parsed = SurfaceIntentSchema.safeParse(raw);

    if (!parsed.success) {
      reasons.add("intent.rejected_invalid");
      continue;
    }

    if (ownerIdOf(parsed.data) !== ownerId) {
      reasons.add("intent.foreign_objective");
      continue;
    }

    if (parsed.data.lifecycle === "exiting" || parsed.data.lifecycle === "dismissed") {
      reasons.add("lifecycle.excluded");
      continue;
    }

    valid.push(parsed.data);
  }

  // 2. Collapse duplicate intents by objective, kind, and source identity.
  const unique = new Map<string, SurfaceIntent>();

  for (const intent of valid) {
    const key = dedupeKey(intent);
    const existing = unique.get(key);

    if (existing === undefined) {
      unique.set(key, intent);
      continue;
    }

    reasons.add("intent.deduplicated");
    unique.set(key, preferIntent(existing, intent));
  }

  // 3. Keep the user's overrides for this display, and only for this display.
  const overrides = new Map<string, SurfaceOverride>();

  for (const raw of input.overrides) {
    const parsed = SurfaceOverrideSchema.safeParse(raw);

    if (!parsed.success) {
      reasons.add("override.rejected_invalid");
      continue;
    }

    if (parsed.data.releasedAt !== undefined) {
      continue;
    }

    if (parsed.data.displayFingerprint !== input.display.fingerprint) {
      reasons.add("override.other_display");
      continue;
    }

    const existing = overrides.get(parsed.data.surfaceId);

    overrides.set(
      parsed.data.surfaceId,
      existing === undefined ? parsed.data : preferOverride(existing, parsed.data),
    );
  }

  // 4. Rank. Explicit user focus outranks everything, then pinned placement,
  //    then role, objective priority, and recency.
  const ranked: Ranked[] = [...unique.values()]
    .map((intent) => {
      const focused = intent.id === input.focusedSurfaceId;

      return {
        intent,
        // A focused Surface is the primary one for as long as it is focused,
        // whatever role proposed it.
        role: focused ? "primary" : intent.role,
        focused,
        pinned: intent.persistence === "pinned" || overrides.has(intent.id),
      };
    })
    .sort(compareRanked);

  if (ranked.some((entry) => entry.focused)) {
    reasons.add("focus.applied");
  }

  // 5. Select the layout. Presence has no workspace to elevate into, so an
  //    attention Surface arriving there does not drag the user out of it.
  const escalate =
    input.attentionState !== "presence" &&
    ranked.some((entry) => entry.intent.role === "attention");
  const state: AttentionState = escalate ? "attention_required" : input.attentionState;

  if (escalate && input.attentionState !== "attention_required") {
    reasons.add("attention.escalated");
  }

  const layout = LAYOUTS[state];
  const display = displayClass(input.display.widthPx);
  const remaining = capacityOf(layout, display);
  const used = new Map<SurfaceRegion, number>();

  reasons.add(`layout.${layout.id}`);
  reasons.add(`display.${display}`);
  reasons.add(`attention.${state}`);

  // 6-7. Place in rank order; anything that does not fit goes to the overflow
  //      stack, which is a list the user can reach — never a hidden overlap.
  const slots: CompositionPlan["slots"] = [];
  const overflow: string[] = [];

  for (const entry of ranked) {
    const override = overrides.get(entry.intent.id);
    if (override?.region === "overflow") {
      overflow.push(entry.intent.id);
      reasons.add("override.overflow");
      continue;
    }
    const candidates: SurfaceRegion[] = [];

    if (override !== undefined) {
      candidates.push(override.region);
    }

    if (entry.intent.preferredRegion !== undefined) {
      candidates.push(entry.intent.preferredRegion);
    }

    candidates.push(ROLE_REGION[entry.role]);

    let placed = false;
    let sizeBlocked = false;

    for (const region of candidates) {
      if (placed) {
        break;
      }

      const space = remaining.get(region);

      if (space === undefined || space <= 0) {
        if (override !== undefined && region === override.region) {
          reasons.add(space === undefined ? "override.invalid_region" : "override.no_capacity");
        }
        continue;
      }

      const isOverrideRegion = override !== undefined && region === override.region;
      const regionSize = layout.regionSize[region] ?? "compact";
      const size = isOverrideRegion ? override.size : regionSize;

      if (SIZE_RANK[size] < SIZE_RANK[entry.intent.minSize]) {
        sizeBlocked = true;

        if (isOverrideRegion) {
          reasons.add("override.invalid_size");
        }
        continue;
      }

      const order = used.get(region) ?? 0;

      slots.push({
        surfaceId: entry.intent.id,
        region,
        order,
        size,
        // The one layering decision, and it is a constant of the region rather
        // than a number any caller supplied.
        layer: region === "overlay" ? 1 : 0,
      });
      remaining.set(region, space - 1);
      used.set(region, order + 1);
      placed = true;

      if (isOverrideRegion) {
        reasons.add("override.honoured");
      }
    }

    if (!placed) {
      overflow.push(entry.intent.id);
      reasons.add(sizeBlocked ? "overflow.size_unsupported" : "overflow.capacity");
    }
  }

  slots.sort((a, b) => {
    const byRegion = REGION_ORDER.indexOf(a.region) - REGION_ORDER.indexOf(b.region);

    return byRegion === 0
      ? (overrides.get(a.surfaceId)?.order ?? a.order) -
          (overrides.get(b.surfaceId)?.order ?? b.order) || a.order - b.order
      : byRegion;
  });
  const orders = new Map<SurfaceRegion, number>();
  for (const slot of slots) {
    slot.order = orders.get(slot.region) ?? 0;
    orders.set(slot.region, slot.order + 1);
  }

  // 8. Stable reason codes, and a plan that is valid by the contract or not
  //    produced at all.
  const plan = CompositionPlanSchema.parse({
    ...owner,
    layoutId: layout.id,
    displayFingerprint: input.display.fingerprint,
    slots,
    overflowSurfaceIds: overflow,
    reasonCodes: [...reasons].sort(),
    generatedAt: input.generatedAt,
  });

  return { plan, signature: compositionSignature(plan) };
}

import { describe, expect, it } from "vitest";
import type { SurfaceIntent } from "@noctis/contracts";
import { reconcileIntents } from "./reconcile.js";
const intent = (
  id: string,
  role: SurfaceIntent["role"],
  payload: unknown,
  threadId = "0199a000-0000-7000-8000-0000000000f1",
) => ({ id, role, payload, payloadVersion: 1, kind: "detail", threadId }) as SurfaceIntent;
describe("reconcileIntents", () => {
  it("holds an existing primary payload, updates supporting and admits new panels", () => {
    const old = intent("a", "primary", { title: "old" });
    const changed = intent("a", "primary", { title: "new" });
    const support = intent("b", "supporting", { title: "new" });
    const result = reconcileIntents(
      [old, intent("b", "supporting", {})],
      [changed, support, intent("c", "primary", {})],
    );
    expect(result.intents[0]?.payload).toEqual(old.payload);
    expect(result.pending.a).toEqual(changed);
    expect(result.intents[1]).toEqual(support);
    expect(result.intents).toHaveLength(3);
  });
  it("does not retain another owner's payload and removes obsolete pending versions", () => {
    const old = intent("a", "primary", { title: "old" });
    const next = intent("a", "primary", { title: "new" }, "0199a000-0000-7000-8000-0000000000f2");
    expect(reconcileIntents([old], [next])).toEqual({ intents: [next], pending: {} });
    expect(reconcileIntents([old], [])).toEqual({ intents: [], pending: {} });
  });
});

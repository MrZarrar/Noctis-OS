import { ownerIdOf, type SurfaceIntent } from "@noctis/contracts";
export function reconcileIntents(
  previous: readonly SurfaceIntent[],
  incoming: readonly SurfaceIntent[],
): { intents: SurfaceIntent[]; pending: Record<string, SurfaceIntent> } {
  const pending: Record<string, SurfaceIntent> = {};
  const intents = incoming.map((next) => {
    const old = previous.find(
      (value) => value.id === next.id && ownerIdOf(value) === ownerIdOf(next),
    );
    if (
      old !== undefined &&
      next.role === "primary" &&
      (old.kind !== next.kind ||
        old.payloadVersion !== next.payloadVersion ||
        JSON.stringify(old.payload) !== JSON.stringify(next.payload))
    ) {
      pending[next.id] = next;
      return { ...next, kind: old.kind, payloadVersion: old.payloadVersion, payload: old.payload };
    }
    return next;
  });
  return { intents, pending };
}

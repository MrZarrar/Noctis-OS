let sequence = 0;

/**
 * An idempotency key for one command from this page.
 *
 * Unique per call rather than per intent, which is the honest shape for a
 * button: pressing Propose twice means two Objectives, and a key that
 * deduplicated them would be deciding for the owner. Retry-safety comes from
 * the core replaying a key it has already seen, and nothing here retries.
 *
 * The counter makes two keys minted in the same millisecond differ; the
 * timestamp makes two page loads differ. One module, so the counter is one
 * counter — three copies of this existed, and three counters starting at zero
 * in the same millisecond is exactly the collision it exists to prevent.
 */
export function nextKey(scope: string): string {
  sequence += 1;

  return `web-${scope}-${String(sequence)}-${String(Date.now())}`;
}

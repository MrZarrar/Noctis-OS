/** As much of an approval as deciding whether it is still the owner's move needs. */
export interface ApprovalState {
  outcome: string;
  confirmedAt?: string | undefined;
  executedAt?: string | undefined;
  declinedAt?: string | undefined;
  nodeJobId?: string | undefined;
}

const ASKS: ReadonlySet<string> = new Set(["require_confirmation", "require_typed_confirmation"]);

/**
 * Whether an approval belongs on the Approvals page.
 *
 * An agent's ask (it has a `nodeJobId`) is finished once confirmed, because the
 * turn that was waiting carries on by itself. Any other confirmed step still
 * needs the owner to execute it, so it stays until it has been.
 */
export function isWaiting(approval: ApprovalState): boolean {
  if (!ASKS.has(approval.outcome)) {
    return false;
  }

  if (approval.declinedAt !== undefined || approval.executedAt !== undefined) {
    return false;
  }

  return approval.confirmedAt === undefined || approval.nodeJobId === undefined;
}

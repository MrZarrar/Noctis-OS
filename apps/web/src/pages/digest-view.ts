import { z } from "zod";

/** The part of `GET /digest` Presence shows. The core's digest has more. */
export const DigestSchema = z.object({
  turns: z.object({ total: z.number() }).passthrough(),
  files: z.number(),
  outputs: z.number(),
  approvals: z.object({ asked: z.number() }).passthrough(),
});

export type DigestView = z.infer<typeof DigestSchema>;

function count(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? "" : "s"}`;
}

/** "Today · 6 turns · 2 files · 1 approval", or nothing on a quiet day. */
export function todayLine(digest: DigestView | undefined): string | undefined {
  if (digest === undefined) {
    return undefined;
  }

  const parts = [
    digest.turns.total > 0 ? count(digest.turns.total, "turn") : "",
    digest.files > 0 ? count(digest.files, "file") : "",
    digest.outputs > 0 ? count(digest.outputs, "output") : "",
    digest.approvals.asked > 0 ? count(digest.approvals.asked, "approval") : "",
  ].filter((part) => part !== "");

  return parts.length === 0 ? undefined : ["Today", ...parts].join(" · ");
}

export function localMidnight(now: Date): Date {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return midnight;
}

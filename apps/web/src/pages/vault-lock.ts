import { z } from "zod";

export const PasscodeStatusSchema = z.object({
  configured: z.boolean(),
  unlocked: z.boolean(),
  timeoutMinutes: z.number(),
  lockoutSeconds: z.number(),
});

export type PasscodeStatus = z.infer<typeof PasscodeStatusSchema>;

const RefusalSchema = z.object({
  error: z.object({
    code: z.string(),
    details: z
      .object({ attemptsRemaining: z.number(), retryAfterSeconds: z.number() })
      .partial()
      .optional(),
  }),
});

/** What the core's refusal of a passcode means, for the owner. */
export function passcodeRefusal(body: unknown): string {
  const parsed = RefusalSchema.safeParse(body);

  if (!parsed.success) {
    return "The core did not accept that.";
  }

  const { code, details } = parsed.data.error;

  switch (code) {
    case "wrong_passcode":
      return `That passcode is wrong. ${String(details?.attemptsRemaining ?? 0)} tries left before a 15-minute lockout.`;
    case "locked_out":
      return `Too many wrong tries. Try again in ${String(Math.ceil((details?.retryAfterSeconds ?? 0) / 60))} minutes.`;
    case "bad_passcode":
      return "A passcode is 4 to 8 digits.";
    case "already_configured":
      return "A passcode is already set.";
    default:
      return "The core did not accept that.";
  }
}

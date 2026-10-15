import { UuidSchema } from "@noctis/contracts";
export function linkedThread(url: string): string | undefined {
  const parsed = UuidSchema.safeParse(new URL(url).searchParams.get("thread"));
  return parsed.success ? parsed.data : undefined;
}

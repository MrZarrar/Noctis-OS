import { UuidSchema } from "@noctis/contracts";
import type { RailItem } from "@noctis/ui";

import { entryPage } from "./back.js";

export function linkedThread(url: string): string | undefined {
  const parsed = UuidSchema.safeParse(new URL(url).searchParams.get("thread"));
  return parsed.success ? parsed.data : undefined;
}

/** The page a window was opened on, such as the Vault on the clap's second monitor. */
export function linkedScreen(url: string): RailItem | undefined {
  return entryPage({ page: new URL(url).searchParams.get("screen") });
}

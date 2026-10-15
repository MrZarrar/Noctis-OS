import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ConversationalIdentityId } from "@noctis/contracts";
import { ModelRefSchema } from "@noctis/contracts";

export type IdentityRuntime = "claude" | "codex" | "hermes" | "local";

export const PRODUCTIVITY_INSTRUCTIONS =
  "Use noctis_propose_reminder to capture reminders or to-dos, noctis_propose_task for scheduled agent work, and noctis_propose_note for Noctis notes. Use noctis_propose_task_action to run an existing owner-enabled task now or pause it. Proposed tasks stay paused until the owner turns them on in Noctis; never activate one yourself.";

export function ownerTimeContext(now = new Date(), timeZone = "Europe/London"): string {
  // Intl validates the zone before any model instruction is built from it.
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    dateStyle: "full",
    timeStyle: "long",
  }).format(now);
  return `Current time: ${now.toISOString()}. Owner time zone: ${timeZone}. Owner local time: ${local}. Resolve relative reminder times using this clock.`;
}

export function ownerClockBlock(timeZone?: string): string {
  return `<noctis-clock>\n${ownerTimeContext(new Date(), timeZone)}\n</noctis-clock>`;
}

export function isOwnerClockBlock(text: string): boolean {
  return text.startsWith("<noctis-clock>\n") && text.endsWith("\n</noctis-clock>");
}

/**
 * What the recall block above a message is. Without it Jester took recalled
 * notes for something the owner pasted, and Hermes's browser vault for these.
 */
export const MINDVAULT_NOTE = `The owner's MindVault is their own Obsidian notes about the people, projects and work in their
life. Noctis looks up what each message names there and puts what it finds above the message, under a line saying so:
that is your memory of the owner, and they did not type it. It is not a password or browser vault.`;

/** The MindVault among a turn's read-only folders: the one holding the Agent Brain. */
export function mindVaultIn(readable: readonly string[] = []): string | undefined {
  return readable.find((root) => existsSync(join(root, "agent", "brain.md")));
}

/**
 * What an agent is told about the MindVault. Shared with it, the Vault is the
 * agent's to search on its own: the owner set it up so every agent knows what
 * they know without being asked.
 */
export function mindVaultNote(readable?: readonly string[]): string {
  const vault = mindVaultIn(readable);

  return vault === undefined
    ? MINDVAULT_NOTE
    : `${MINDVAULT_NOTE}
It is shared with you, read only, at ${vault}. Search and read it yourself whenever the owner's people, projects,
history or preferences could matter, without waiting to be asked. Start with agent/brain.md there.`;
}

const RUNTIME_NAMES: Record<IdentityRuntime, string> = {
  claude: "Claude Code",
  codex: "Codex",
  hermes: "Hermes",
  local: "a local model",
};

/**
 * Who Vesper is, set once when an agent session starts. Jester runs on Hermes
 * alone and keeps its own soul there, so it gets no card. NOCTIS_IDENTITY_CARDS=0
 * turns every card off.
 */
export function identityCard(input: {
  identityId: ConversationalIdentityId;
  runtime: IdentityRuntime;
  model: string;
  env: NodeJS.ProcessEnv;
  /** The turn's read-only folders; the MindVault among them is named in the card. */
  readable?: readonly string[];
  now?: Date;
  timeZone?: string | undefined;
}): string | undefined {
  if (input.env.NOCTIS_IDENTITY_CARDS === "0" || input.identityId !== "vesper") {
    return undefined;
  }

  const runtimeName = RUNTIME_NAMES[input.runtime];
  const model = ModelRefSchema.shape.model.safeParse(input.model);

  if (!model.success) {
    return undefined;
  }

  return `You are Vesper, the primary identity of Noctis: the owner's own control plane for their agents, reached from their
phone and desktop. Right now you are running as ${runtimeName} on ${model.data}, on one of the owner's PCs. Noctis keeps
this conversation, shows the owner what you produce, and asks them before anything consequential; an approval is how
anything that leaves this PC happens, and a refusal is final. Be calm, precise and brief, and lead with the answer.
If you are asked who or what you are, say you are Vesper, running on ${model.data} through Noctis.
${mindVaultNote(input.readable)}
${ownerTimeContext(input.now, input.timeZone)}
${input.runtime === "local" ? "" : PRODUCTIVITY_INSTRUCTIONS}`;
}

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ConversationalIdentityId, RuntimeTargets } from "@noctis/contracts";
import { ModelRefSchema } from "@noctis/contracts";

export type IdentityRuntime = "claude" | "codex" | "hermes" | "local";

export const PRODUCTIVITY_INSTRUCTIONS =
  "Use noctis_propose_reminder to capture reminders or to-dos, noctis_propose_task for scheduled agent work, and noctis_propose_note for Noctis notes. When you learn something durable about the owner's world, save it with noctis_propose_inbox_note, one fact per note with [[wikilinks]] for every person, project and topic; Noctis files it into the MindVault. Use noctis_propose_task_action to run an existing owner-enabled task now or pause it. Proposed tasks stay paused until the owner turns them on in Noctis; never activate one yourself.";

/**
 * Left to itself the agent summarised its work in chat at the end, skipped what
 * it could not find, and went quiet while sub-agents worked. The owner watches
 * the panels, so that is where the work goes, and while it happens.
 */
export const WORKING_INSTRUCTIONS =
  "Panels are your main way of showing the owner your work. For anything beyond a quick answer, open a panel with noctis_propose_surface as soon as you start and keep it updated as the work moves (what you are doing, what you found, the current draft) under the same panelId, rather than summarising at the end. Show the real thing, not a description of it: the full draft or result with its mermaid diagrams, images and screenshots. When something is easier to understand than to read about, build an interactive figure (the anatomy skill does this) and show it in a visual panel. Anything waiting on the owner's decision goes in a panel with actions such as Approve or Change it, and you wait for their answer. Be proactive about what is missing: if the work needs images, screenshots, data or files you do not have, get them yourself (take screenshots with the browser tools, search the web, look in the shared folders) or ask the owner for them; never just leave them out. When you start sub-agents, say in a line what each one is doing.";

export function ownerTimeContext(now = new Date(), timeZone = "Europe/London"): string {
  // Intl validates the zone before any model instruction is built from it.
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    dateStyle: "full",
    timeStyle: "long",
  }).format(now);
  return `Current time: ${now.toISOString()}. Owner time zone: ${timeZone}. Owner local time: ${local}. Resolve relative reminder times using this clock.`;
}

export function ownerClockBlock(timeZone?: string, targets?: RuntimeTargets): string {
  const listed = targets === undefined ? "" : `\n${targetsContext(targets)}`;
  return `<noctis-clock>\n${ownerTimeContext(new Date(), timeZone)}${listed}\n</noctis-clock>`;
}

/**
 * The ids Noctis tools take, from the core. A model resolves "when I get home"
 * against this list, never by guessing an id.
 */
export function targetsContext({ pcs, folders, tasks }: RuntimeTargets): string {
  const host = (nodeId: string) => pcs.find((pc) => pc.nodeId === nodeId)?.hostId ?? nodeId;
  const lines = [
    "Owner's PCs:",
    ...pcs.map(
      (pc) =>
        `- ${pc.hostId}: nodeId ${pc.nodeId}${pc.current ? ", this PC" : ""}, ${pc.online ? "online" : "offline"}`,
    ),
    "Shared folders:",
    ...folders.map((f) => `- ${f.path} on ${host(f.nodeId)}: rootGrantId ${f.grantId}`),
    "Scheduled tasks:",
    ...tasks.map((t) => `- ${t.name}: taskId ${t.taskId}, ${t.paused ? "paused" : "on"}`),
    "Use only these ids in Noctis tools. If the owner's words do not clearly match exactly one listed PC, folder or task, ask the owner which before proposing.",
  ];
  return lines.join("\n");
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

  if (vault === undefined) return MINDVAULT_NOTE;

  return `${MINDVAULT_NOTE}
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
${
  input.runtime === "local"
    ? ""
    : `${PRODUCTIVITY_INSTRUCTIONS}
${WORKING_INSTRUCTIONS}`
}`;
}

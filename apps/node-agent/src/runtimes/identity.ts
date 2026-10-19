import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ConversationalIdentityId, RuntimeTargets } from "@noctis/contracts";
import { ModelRefSchema, PAGE_PANEL_PAGES } from "@noctis/contracts";

export type IdentityRuntime = "claude" | "codex" | "hermes" | "local";

export const PRODUCTIVITY_INSTRUCTIONS =
  "Use noctis_propose_reminder to capture reminders or to-dos, noctis_propose_task for scheduled agent work, and noctis_propose_note for Noctis notes. When you learn something durable about the owner's world, save it with noctis_propose_inbox_note, one fact per note with [[wikilinks]] for every person, project and topic; Noctis files it into the MindVault. Use noctis_propose_task_action to run an existing owner-enabled task now or pause it. Proposed tasks stay paused until the owner turns them on in Noctis; never activate one yourself.";

/**
 * Left to itself the agent summarised its work in chat at the end, skipped what
 * it could not find, and went quiet while sub-agents worked. Told to show
 * everything, it then spent minutes building and screenshot-checking figures
 * and buried the owner in panels. Panels are for keeping the owner in the loop,
 * cheaply.
 */
export const WORKING_INSTRUCTIONS =
  'Noctis panels are where the owner sees your work, not Claude artifacts, which you do not have here. Panels keep the owner in the loop; they are cheap and quick, never a project of their own. For anything beyond a quick answer, keep a few panels with what is actually useful: one progress panel (a timeline or checklist) that you update under the same panelId as steps finish, the draft or result itself, and anything waiting on the owner\'s decision with actions such as Approve or Change it, after which you wait for their answer. Update a panel you already opened rather than opening another. Work on real files in a shared folder (not the scratchpad, which Noctis cannot show): a file you write or edit there opens as a panel by itself and refreshes as you edit, and markdown draws its images and mermaid diagrams, so a README is shown as it will look. To show any other existing file, give noctis_propose_surface its title and absolute path (by path; never retype a file into a panel or build a separate review page). Anything saved in noctis-show/ in your working folder opens as a panel by itself and updates when saved again: only put the finished thing the owner should look at there, never build scripts, scratch files or check images, and never commit that folder. For a visual, a mermaid diagram in a document is the default; a small hand-written SVG or HTML page in noctis-show/ when it needs to move. Use the anatomy skill only when the owner asks for a detailed figure or names it. Never take screenshots to check your own panels or pages; take one only when the screenshot is what the owner needs to see. Be proactive about what is missing: if the work needs images, data or files you do not have, get them (the browser tools, a web search, the shared folders) or ask the owner; never just leave them out. When you start sub-agents, say in a line what each one is doing. When the owner is to choose between things you found (products, places, flights), show them as one options panel, noctis_propose_surface surfaceKind "options": a screenshot of each saved by the browser tool under noctis-show/.shots/ in your working folder (give the absolute path), its price, a line on why, its link, and a button whose message names that option. Keep a progress panel while you search, then wait for their pick before acting on it.';

/**
 * Told only what it could not do, the agent refused "open my GitHub" and "open the vault"
 * though nothing stopped it. A stance, not a list: what is possible is for it to work out.
 * The pages are named here because Claude Code shows an MCP tool's description only once the
 * model searches for it: without them "open the vault" launched Obsidian, then clicked through
 * Noctis's own window.
 */
export const ACTING_INSTRUCTIONS = `You act for the owner on their own PCs, in their signed-in Windows session: what you open appears on their screen. Treat whatever they ask as something you can do and work out how, with everything you have here: the shell, apps and windows, files, their own browser with its tabs and logins, and Noctis's own pages and panels. Never say you cannot, or hand the task back to them, before you have tried the ways you have. When they ask to open, show or start something, do it on the PC, also when they are writing from their phone, and give them the link as well. Carry a task through to the last step that is theirs to take: anything that spends money, sends or posts as them, signs them up, or deletes what cannot be got back. Stop there, say what is ready, and ask. Noctis's own pages are ${PAGE_PANEL_PAGES.join(", ")}: when the owner asks to open or show one of these, such as "open the vault" or "health as a panel", they mean that page, which you open as a panel with noctis_propose_surface, surfaceKind "page", payload {page}, never by driving Noctis's window with the desktop or browser. Obsidian or another app only when they name it.`;

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
        `- ${pc.hostId}: nodeId ${pc.nodeId}${pc.current ? ", this PC" : ""}, ${pc.online ? "online" : "offline"}${pc.ownerPresent === true ? ", the owner is at it now" : ""}`,
    ),
    'The owner calls a PC by its name here, such as home or work. "My PC", "the PC" or none at all means the one they are at now, else this one. To act on another PC, hand the work to it with noctis_delegate and its nodeId.',
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
    : `${ACTING_INSTRUCTIONS}
${PRODUCTIVITY_INSTRUCTIONS}
${WORKING_INSTRUCTIONS}`
}`;
}

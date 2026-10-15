import { RuntimeProposalSchema } from "@noctis/contracts";

export const PRODUCTIVITY_TOOLS = [
  {
    kind: "reminder",
    inputSchema: proposalSchema("reminder").omit({ kind: true }),
    description:
      "Record a reminder or to-do for the owner. The core validates its wording and trigger; this tool never starts work.",
  },
  {
    kind: "task",
    inputSchema: proposalSchema("task").omit({ kind: true }),
    description:
      "Propose scheduled agent work with a PC, folder, model and trigger. The task is born paused; only the owner can turn it on in Noctis.",
  },
  {
    kind: "note",
    inputSchema: proposalSchema("note").omit({ kind: true }),
    description: "Record a note in the owner's Noctis notebook, independent of the Vault.",
  },
  {
    kind: "task_action",
    inputSchema: proposalSchema("task_action").omit({ kind: true }),
    description:
      "Request Run now for an existing owner-enabled scheduled task, or pause an existing task. The core enforces the task's existing authority and run limits; this never activates a task or widens what it may do.",
  },
  {
    kind: "vault_fact",
    inputSchema: proposalSchema("vault_fact").omit({ kind: true }),
    description:
      "Add one fact to a MindVault note under people/, reference/ or projects/, with [[wikilinks]] for every name. Noctis adds it to the note's Noctis block and the owner can undo it. Name the inbox note it came from.",
  },
  {
    kind: "vault_note",
    inputSchema: proposalSchema("vault_note").omit({ kind: true }),
    description:
      "Create a MindVault note that does not exist yet, under people/, reference/ or projects/, named in kebab-case. Refused if the note exists: add a fact to it instead.",
  },
  {
    kind: "vault_revision",
    inputSchema: proposalSchema("vault_revision").omit({ kind: true }),
    description:
      "Propose changing text the owner wrote in a MindVault note: quote it exactly in `find`. Nothing changes until the owner approves it.",
  },
] as const;

export function proposalSchema<
  K extends (typeof RuntimeProposalSchema.options)[number]["shape"]["kind"]["value"],
>(kind: K) {
  return RuntimeProposalSchema.options.find(
    (schema) => schema.shape.kind.value === kind,
  )! as Extract<(typeof RuntimeProposalSchema.options)[number], { shape: { kind: { value: K } } }>;
}

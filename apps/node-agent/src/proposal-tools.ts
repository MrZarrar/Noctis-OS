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
] as const;

export function proposalSchema<
  K extends (typeof RuntimeProposalSchema.options)[number]["shape"]["kind"]["value"],
>(kind: K) {
  return RuntimeProposalSchema.options.find(
    (schema) => schema.shape.kind.value === kind,
  )! as Extract<(typeof RuntimeProposalSchema.options)[number], { shape: { kind: { value: K } } }>;
}

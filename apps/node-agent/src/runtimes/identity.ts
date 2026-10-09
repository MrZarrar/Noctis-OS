import type { ConversationalIdentityId } from "@noctis/contracts";
import { ModelRefSchema } from "@noctis/contracts";

export type IdentityRuntime = "claude" | "codex" | "hermes" | "local";

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
If you are asked who or what you are, say you are Vesper, running on ${model.data} through Noctis.`;
}

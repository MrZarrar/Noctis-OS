import { appendFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RuntimeProposal } from "@noctis/contracts";
import { RuntimeProposalSchema } from "@noctis/contracts";

import { AGENT_VERSION } from "./agent.js";
import { createLightsTool, LIGHTS_TOOL_DESCRIPTION, LightsToolInputSchema } from "./lights/tool.js";
import { PANEL_TOOL_DESCRIPTION, surfaceProblem } from "./panel-tool.js";
import { PRODUCTIVITY_TOOLS, proposalSchema } from "./proposal-tools.js";

/**
 * The Noctis tools a spawned runtime can call. Codex starts this as a stdio
 * child; proposal calls are validated and land as one JSON line in the file
 * the node agent tails (ADR-0024). The owner-enabled lights tool calls this
 * PC's lights service directly.
 */

const flag = process.argv.indexOf("--proposals");
const target = process.argv[flag + 1];

if (flag === -1 || target === undefined) {
  process.stderr.write("usage: noctis-mcp --proposals <file>\n");
  process.exit(2);
}

// Narrowed here; a closure below would not see the guard.
const file: string = target;
const surface = proposalSchema("surface");
const objective = proposalSchema("objective");
const preference = proposalSchema("preference");

function record(proposal: RuntimeProposal): { content: Array<{ type: "text"; text: string }> } {
  appendFileSync(file, `${JSON.stringify(proposal)}\n`);

  return { content: [{ type: "text", text: "recorded" }] };
}

const server = new McpServer({ name: "noctis", version: AGENT_VERSION });
const lights = createLightsTool();

if (lights !== undefined) {
  server.registerTool(
    "noctis_lights",
    { description: LIGHTS_TOOL_DESCRIPTION, inputSchema: LightsToolInputSchema },
    (args) => lights.call(args),
  );
}

server.registerTool(
  "noctis_propose_surface",
  {
    description: PANEL_TOOL_DESCRIPTION,
    inputSchema: surface.omit({ kind: true }),
  },
  (args) => {
    const problem = surfaceProblem(args);

    return problem === undefined
      ? record(RuntimeProposalSchema.parse({ kind: "surface", ...args }))
      : { content: [{ type: "text" as const, text: problem }], isError: true };
  },
);

server.registerTool(
  "noctis_propose_objective",
  {
    description:
      "Propose an objective for the operator to consider. It is recorded as a suggestion, never started.",
    inputSchema: objective.omit({ kind: true }),
  },
  (args) => record(RuntimeProposalSchema.parse({ kind: "objective", ...args })),
);

server.registerTool(
  "noctis_remember_preference",
  {
    description:
      "Record one durable thing learned about how to work with the owner. Noctis applies its own rules to the Agent Brain and may refuse; nothing is written by this call.",
    inputSchema: preference.omit({ kind: true }),
  },
  (args) => record(RuntimeProposalSchema.parse({ kind: "preference", ...args })),
);

for (const { kind, description, inputSchema } of PRODUCTIVITY_TOOLS) {
  server.registerTool(
    `noctis_propose_${kind}`,
    {
      description,
      inputSchema,
    },
    (args: unknown) => record(RuntimeProposalSchema.parse({ kind, ...(args as object) })),
  );
}

await server.connect(new StdioServerTransport());

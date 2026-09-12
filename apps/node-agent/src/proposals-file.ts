import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RuntimeProposal } from "@noctis/contracts";
import { RuntimeProposalSchema } from "@noctis/contracts";

/**
 * The proposal channel: a JSON-lines file the model's MCP tools append to and
 * the node tails. A file, not a socket, because the node opens no listener.
 */

export interface ProposalChannel {
  path: string;
  /** Begins tailing; returns `stop`, which drains one last time. */
  start(
    onProposal: (proposal: RuntimeProposal, line: number) => void,
    onWarning?: (message: string) => void,
  ): () => void;
}

// ponytail: polling, because fs.watch is unreliable on Windows; 250 ms is
// invisible next to a model turn.
export const PROPOSAL_POLL_MS = 250;

export function createProposalChannel(dir: string, name: string): ProposalChannel {
  const path = join(dir, `${name}.jsonl`);

  return {
    path,
    start(onProposal, onWarning = () => undefined) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, "");

      let offset = 0;
      let partial = "";
      let lineNumber = 0;

      function poll(): void {
        let size: number;

        try {
          size = statSync(path).size;
        } catch {
          return;
        }

        if (size <= offset) {
          return;
        }

        const fd = openSync(path, "r");
        const chunk = Buffer.alloc(size - offset);

        try {
          readSync(fd, chunk, 0, chunk.length, offset);
        } finally {
          closeSync(fd);
        }

        offset = size;

        const lines = (partial + chunk.toString("utf8")).split("\n");

        partial = lines.pop() ?? "";

        for (const line of lines) {
          lineNumber += 1;

          if (line.trim() === "") {
            continue;
          }

          try {
            const parsed = RuntimeProposalSchema.safeParse(JSON.parse(line));

            if (parsed.success) {
              onProposal(parsed.data, lineNumber);
            } else {
              onWarning(
                `proposal line ${String(lineNumber)} is off-schema: ${parsed.error.message}`,
              );
            }
          } catch {
            onWarning(`proposal line ${String(lineNumber)} is not JSON`);
          }
        }
      }

      const timer = setInterval(poll, PROPOSAL_POLL_MS);

      timer.unref();

      return () => {
        clearInterval(timer);
        poll();
      };
    },
  };
}

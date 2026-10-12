import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { NodeCredential } from "@noctis/contracts";
import { NodeCredentialSchema } from "@noctis/contracts";

/** Overridable so a test never writes to the real home directory. */
export function credentialPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.NOCTIS_NODE_HOME?.trim();

  return join(home === undefined || home === "" ? join(homedir(), ".noctis") : home, "node.json");
}

export function readCredential(env: NodeJS.ProcessEnv = process.env): NodeCredential {
  const path = credentialPath(env);

  try {
    return NodeCredentialSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new Error(
      `No usable node credential at ${path}. Run: node-agent pair --core <url> --code <code>`,
    );
  }
}

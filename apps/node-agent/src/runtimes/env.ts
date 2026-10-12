/** Never inherited by a spawned runtime: a metered key in the environment is a metered bill. */
export const BILLING_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CODEX_API_KEY"] as const;

/**
 * Set on every runtime Noctis starts. The owner's own agent hooks load in those
 * sessions too, and this is how the live bridge tells them apart: a session
 * Noctis runs is already a Noctis thread.
 */
export const NOCTIS_SESSION_MARKER = "NOCTIS_RUNTIME_SESSION";

/** A copy of `base` without the billing keys. Case-insensitive: Windows treats `Openai_Api_Key` as the same variable. */
export function childEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const forbidden = new Set<string>(BILLING_KEYS);
  const out: NodeJS.ProcessEnv = { [NOCTIS_SESSION_MARKER]: "1" };

  for (const [key, value] of Object.entries(base)) {
    if (!forbidden.has(key.toUpperCase())) {
      out[key] = value;
    }
  }

  return out;
}

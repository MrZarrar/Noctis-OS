/** Never inherited by a spawned runtime: a metered key in the environment is a metered bill. */
export const BILLING_KEYS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CODEX_API_KEY"] as const;

/** A copy of `base` without the billing keys. Case-insensitive: Windows treats `Openai_Api_Key` as the same variable. */
export function childEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const forbidden = new Set<string>(BILLING_KEYS);
  const out: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(base)) {
    if (!forbidden.has(key.toUpperCase())) {
      out[key] = value;
    }
  }

  return out;
}

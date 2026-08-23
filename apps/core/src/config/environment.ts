export interface LegacyEnvironmentOptions {
  allowLegacyImport?: boolean;
}

export function assertNoLegacyJarvisVariables(
  values: Readonly<Record<string, string | undefined>>,
  options: LegacyEnvironmentOptions = {},
): void {
  const rejected = Object.keys(values)
    .filter((key) => key.startsWith("JARVIS_"))
    .filter((key) => !(options.allowLegacyImport === true && key === "JARVIS_IMPORT_SOURCE"))
    .sort();

  if (rejected.length > 0) {
    throw new Error(
      `Legacy Jarvis environment variables are not valid Noctis configuration: ${rejected.join(
        ", ",
      )}`,
    );
  }
}

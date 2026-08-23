import { describe, expect, it } from "vitest";

import * as environment from "./environment.js";

describe("assertNoLegacyJarvisVariables", () => {
  it("allows Noctis and ordinary operating-system variables", () => {
    expect(() =>
      environment.assertNoLegacyJarvisVariables?.({
        NOCTIS_CORE_HOST: "127.0.0.1",
        PATH: "C:\\Windows\\System32",
      }),
    ).not.toThrow();
  });

  it("rejects legacy Jarvis runtime variables", () => {
    expect(() =>
      environment.assertNoLegacyJarvisVariables?.({
        JARVIS_CORE_PORT: "3030",
        JARVIS_ALLOW_METERED_PROVIDERS: "0",
      }),
    ).toThrow(
      "Legacy Jarvis environment variables are not valid Noctis configuration: " +
        "JARVIS_ALLOW_METERED_PROVIDERS, JARVIS_CORE_PORT",
    );
  });

  it("allows an import source only in an explicit import process", () => {
    expect(() =>
      environment.assertNoLegacyJarvisVariables?.(
        { JARVIS_IMPORT_SOURCE: "C:\\archive" },
        { allowLegacyImport: true },
      ),
    ).not.toThrow();
  });

  it("rejects the import variable in a normal runtime", () => {
    expect(() =>
      environment.assertNoLegacyJarvisVariables?.({ JARVIS_IMPORT_SOURCE: "C:\\archive" }),
    ).toThrow(/JARVIS_IMPORT_SOURCE/);
  });
});

import { describe, expect, it } from "vitest";

import { ConfigurationError, loadCoreConfig } from "./server.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

function env(extra: Record<string, string>): Record<string, string> {
  return { NOCTIS_CORE_TOKEN: TOKEN, NOCTIS_DATABASE_PATH: ":memory:", ...extra };
}

describe("loadCoreConfig: video editor origin", () => {
  it("is absent unless it is configured, like every production capability", () => {
    expect(loadCoreConfig(env({})).videoEditorOrigin).toBeUndefined();
  });

  it("accepts a bare http origin, since the editor server is a plain local Node process", () => {
    const config = loadCoreConfig(
      env({ NOCTIS_VIDEO_EDITOR_ORIGIN: "http://100.70.27.11:7700" }),
    );

    expect(config.videoEditorOrigin).toBe("http://100.70.27.11:7700");
  });

  it("refuses a value that is not a bare origin", () => {
    expect(() =>
      loadCoreConfig(env({ NOCTIS_VIDEO_EDITOR_ORIGIN: "http://100.70.27.11:7700/editor" })),
    ).toThrow(ConfigurationError);
  });

  it("refuses an unparseable URL", () => {
    expect(() => loadCoreConfig(env({ NOCTIS_VIDEO_EDITOR_ORIGIN: "not a url" }))).toThrow(
      ConfigurationError,
    );
  });

  it("accepts https too, for an editor server reached over TLS", () => {
    const config = loadCoreConfig(env({ NOCTIS_VIDEO_EDITOR_ORIGIN: "https://editor.example" }));

    expect(config.videoEditorOrigin).toBe("https://editor.example");
  });

  it("refuses a non-http(s) scheme rather than silently storing \"null\"", () => {
    // `URL.origin` is the literal string "null" for opaque-origin schemes like
    // javascript:/data:/file:, which would otherwise sail through this check
    // (no path, no query, no fragment) and land in the CSP header verbatim.
    for (const value of ["javascript:alert(1)", "data:text/html,x", "file:///", "ws://x:1"]) {
      expect(() => loadCoreConfig(env({ NOCTIS_VIDEO_EDITOR_ORIGIN: value }))).toThrow(
        ConfigurationError,
      );
    }
  });
});

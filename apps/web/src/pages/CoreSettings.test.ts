import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SettingView } from "./CoreSettings.js";
import { CoreSettingsView, allPagesChoice } from "./CoreSettings.js";

const settings: SettingView[] = [
  {
    key: "digestAt",
    label: "Daily digest",
    help: "When.",
    kind: "time",
    value: "21:30",
    source: "ui",
  },
  {
    key: "promoterAt",
    label: "File the inbox nightly",
    help: "When.",
    kind: "time",
    value: "",
    source: "default",
    ignoredStartUp: "noon",
  },
  {
    key: "vaultWrites",
    label: "Let Noctis write to the Vault",
    help: "Brain.",
    kind: "boolean",
    value: true,
    source: "start-up",
  },
  {
    key: "sessionTtlHours",
    label: "Stay logged in for (hours)",
    help: "Next login.",
    kind: "integer",
    value: 720,
    source: "default",
  },
  {
    key: "logLevel",
    label: "Core log detail",
    help: "How much.",
    kind: "choice",
    choices: ["debug", "info", "warn", "error"],
    value: "info",
    source: "default",
  },
  {
    key: "remoteDesktops",
    label: "Remote desktops",
    help: "Hosts.",
    kind: "list",
    value: [
      {
        host: "zarrarpc",
        gatewayUrl: "wss://zarrarpc.example/jet/rdp",
        destination: "zarrarpc.example:3389",
      },
    ],
    source: "ui",
  },
];

const render = (): string =>
  renderToStaticMarkup(
    createElement(CoreSettingsView, {
      settings,
      startUp: [
        { name: "NOCTIS_CORE_PORT", value: "7717" },
        { name: "NOCTIS_CORE_TOKEN", value: "set" },
      ],
      onSet: () => undefined,
      onReset: () => undefined,
    }),
  );

describe("How Noctis runs", () => {
  it("draws each setting with a control of its own kind", () => {
    const markup = render();

    expect(markup).toMatch(/<input[^>]*type="time"[^>]*value="21:30"/);
    expect(markup).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""/);
    expect(markup).toMatch(/<input[^>]*type="number"[^>]*value="720"/);
    expect(markup).toMatch(/<select[^>]*>[^]*<option value="warn"/);
    expect(markup).toContain('value="zarrarpc"');
  });

  it("offers Reset only where the owner set the value", () => {
    const markup = render();

    expect(markup.match(/>Reset</g)).toHaveLength(2);
  });

  it("says where a value came from, and when a start-up value was ignored", () => {
    const markup = render();

    expect(markup).toContain("from start-up");
    expect(markup).toContain("noon was ignored");
  });

  it("lists the start-up settings read only, with secrets as set", () => {
    const markup = render();

    expect(markup).toContain("NOCTIS_CORE_PORT");
    expect(markup).toContain("7717");
    expect(markup).toMatch(/NOCTIS_CORE_TOKEN[^]*set/);
  });
});

describe("the rail's unfinished pages", () => {
  const view = (value: boolean, source: SettingView["source"]): SettingView[] => [
    {
      key: "showAllPages",
      label: "Show unfinished pages",
      help: "",
      kind: "boolean",
      value,
      source,
    },
  ];

  it("follows the owner's choice on the Settings page", () => {
    expect(allPagesChoice(view(true, "ui"))).toBe(true);
    expect(allPagesChoice(view(false, "ui"))).toBe(false);
  });

  it("leaves the build's own switch alone until the owner chooses", () => {
    expect(allPagesChoice(view(false, "default"))).toBeUndefined();
    expect(allPagesChoice(undefined)).toBeUndefined();
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AutomationsView } from "./AutomationSettings.js";
import type { SettingView } from "./CoreSettings.js";

const settings: SettingView[] = [
  {
    key: "places",
    label: "Places",
    help: "Where.",
    kind: "places",
    automation: true,
    value: ["home", "gym"],
    source: "ui",
  },
  {
    key: "placeVisitMinutes",
    label: "Count a visit after (minutes)",
    help: "Shorter.",
    kind: "integer",
    automation: true,
    value: 20,
    source: "default",
  },
  {
    key: "digestAt",
    label: "Daily digest",
    help: "When.",
    kind: "time",
    value: "21:30",
    source: "ui",
  },
];

const render = (props: Partial<Parameters<typeof AutomationsView>[0]> = {}): string =>
  renderToStaticMarkup(
    createElement(AutomationsView, {
      settings,
      origin: "https://work-pc.example.ts.net",
      onSet: () => undefined,
      onReset: () => undefined,
      onShowLink: () => undefined,
      onNewLink: () => undefined,
      ...props,
    }),
  );

describe("Automations", () => {
  it("edits the places and the visit length, and nothing else", () => {
    const markup = render();

    expect(markup).toContain('value="home"');
    expect(markup).toContain('value="gym"');
    expect(markup).toMatch(/<input[^>]*type="number"[^>]*value="20"/);
    expect(markup).not.toContain("Daily digest");
  });

  it("keeps the phone's link hidden until asked for", () => {
    expect(render()).not.toContain("Bearer");
    expect(render()).toContain("Show phone setup");
  });

  it("gives the Shortcuts steps for each place once the link is shown", () => {
    const markup = render({ link: "a".repeat(64) });

    expect(markup).toContain("https://work-pc.example.ts.net/places/events");
    expect(markup).toContain(`Bearer ${"a".repeat(64)}`);
    expect(markup).toMatch(/Arrive[^]*home/);
    expect(markup).toMatch(/Leave[^]*gym/);
  });

  it("lists recent visits, and one still going", () => {
    const markup = render({
      places: {
        events: [],
        visits: [
          { place: "gym", start: "2026-10-16T18:10:00.000Z", end: null, minutes: 12 },
          {
            place: "gym",
            start: "2026-10-15T18:10:00.000Z",
            end: "2026-10-15T19:40:00.000Z",
            minutes: 90,
          },
        ],
      },
    });

    expect(markup).toContain("90 min");
    expect(markup).toContain("there now");
  });
});

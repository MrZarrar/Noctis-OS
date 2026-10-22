import type { PlaceVisit } from "@noctis/contracts";
import { spacing, typography } from "@noctis/ui";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import { SectionHeading, buttonStyle, glass } from "../layout/Page.js";
import type { CoreTransport } from "../transport/CoreTransport.js";
import type { SettingView } from "./CoreSettings.js";
import { SettingRow } from "./CoreSettings.js";

/**
 * Automations: the owner's places, and how the phone reports arriving at them.
 * The geofence is set in the phone's Shortcuts app; Noctis only hears the name.
 */

export const PlacesViewSchema = z.object({
  events: z.array(z.object({ place: z.string(), transition: z.string(), at: z.string() })),
  visits: z.array(
    z.object({
      place: z.string(),
      start: z.string(),
      end: z.string().nullable(),
      minutes: z.number(),
    }),
  ),
});

type PlacesView = z.infer<typeof PlacesViewSchema>;

const muted = { margin: 0, color: typography.color.muted, fontSize: typography.scale.sm } as const;
const mono = { fontFamily: typography.monoFamily, overflowWrap: "anywhere" } as const;

const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" });
const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

function visitLine(visit: PlaceVisit): string {
  const start = new Date(visit.start);
  const span =
    visit.end === null
      ? `from ${time.format(start)}, there now`
      : `${time.format(start)}–${time.format(new Date(visit.end))}`;

  return `${visit.place} · ${day.format(start)}, ${span} · ${String(visit.minutes)} min`;
}

function PhoneSetup({
  places,
  origin,
  link,
}: {
  places: readonly string[];
  origin: string;
  link: string;
}): JSX.Element {
  const steps = (place: string, trigger: "Arrive" | "Leave") => (
    <li key={`${place}-${trigger}`}>
      Automation → New → <strong>{trigger}</strong> → pick where <strong>{place}</strong> is → Run
      Immediately. Action: <em>Get Contents of URL</em>, method POST, header{" "}
      <code style={mono}>Authorization</code>, request body JSON with{" "}
      <code style={mono}>place</code> = <code style={mono}>{place}</code> and{" "}
      <code style={mono}>transition</code> = <code style={mono}>{trigger.toLowerCase()}</code>.
    </li>
  );

  return (
    <div style={{ display: "grid", gap: spacing.sm, minWidth: 0 }}>
      <p style={{ margin: 0 }}>In the Shortcuts app on your phone, for each place:</p>
      <dl style={{ margin: 0, display: "grid", gap: 4, fontSize: typography.scale.sm }}>
        <dt>URL</dt>
        <dd style={{ margin: 0, ...mono }}>{`${origin}/places/events`}</dd>
        <dt>Authorization</dt>
        <dd style={{ margin: 0, ...mono }}>{`Bearer ${link}`}</dd>
      </dl>
      {places.length === 0 ? (
        <p style={muted}>Add a place above first.</p>
      ) : (
        <ol style={{ margin: 0, paddingLeft: spacing.lg, display: "grid", gap: spacing.sm }}>
          {places.flatMap((place) => [steps(place, "Arrive"), steps(place, "Leave")])}
        </ol>
      )}
      <p style={muted}>
        Tailscale has to be on for the phone to reach Noctis. This link can only report arrivals.
      </p>
    </div>
  );
}

export function AutomationsView({
  settings,
  origin,
  link,
  places,
  onSet,
  onReset,
  onShowLink,
  onNewLink,
}: {
  settings: readonly SettingView[];
  origin: string;
  link?: string;
  places?: PlacesView;
  onSet: (key: string, value: unknown) => void;
  onReset: (key: string) => void;
  onShowLink: () => void;
  onNewLink: () => void;
}): JSX.Element {
  const automations = settings.filter((setting) => setting.automation === true);
  const named = z
    .array(z.string())
    .safeParse(automations.find((setting) => setting.key === "places")?.value);

  return (
    <section style={{ ...glass, padding: spacing.lg, display: "grid", gap: spacing.md }}>
      <SectionHeading>Automations</SectionHeading>
      <p style={{ ...muted, maxWidth: typography.measurePx }}>
        Your phone tells Noctis when you arrive at or leave a place, so it knows when you were at
        the gym.
      </p>
      {automations.map((setting) => (
        <SettingRow key={setting.key} setting={setting} onSet={onSet} onReset={onReset} />
      ))}

      <SectionHeading>Phone</SectionHeading>
      {link === undefined ? (
        <div>
          <button type="button" onClick={onShowLink} style={buttonStyle}>
            Show phone setup
          </button>
        </div>
      ) : (
        <>
          <PhoneSetup places={named.data ?? []} origin={origin} link={link} />
          <div>
            <button type="button" onClick={onNewLink} style={buttonStyle}>
              New link (the old one stops working)
            </button>
          </div>
        </>
      )}

      <SectionHeading>Recent visits</SectionHeading>
      {places === undefined || places.visits.length === 0 ? (
        <p style={muted}>None yet.</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: spacing.lg, display: "grid", gap: 4 }}>
          {places.visits.slice(0, 10).map((visit) => (
            <li key={`${visit.place}-${visit.start}`}>{visitLine(visit)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AutomationSettings({
  transport,
  settings,
  onSet,
  onReset,
}: {
  transport: CoreTransport | undefined;
  settings: readonly SettingView[];
  onSet: (key: string, value: unknown) => void;
  onReset: (key: string) => void;
}): JSX.Element {
  const [link, setLink] = useState<string>();
  const [places, setPlaces] = useState<PlacesView>();

  useEffect(() => {
    let live = true;

    void transport
      ?.request("GET", "/places")
      .then((response) => {
        const parsed = PlacesViewSchema.safeParse(response.body);

        if (live && parsed.success) setPlaces(parsed.data);
      })
      .catch(() => undefined);

    return () => {
      live = false;
    };
  }, [transport]);

  const fetchLink = useCallback(
    (method: "GET" | "POST") => {
      void transport
        ?.request(method, "/places/link")
        .then((response) => {
          const parsed = z.object({ token: z.string() }).safeParse(response.body);

          if (parsed.success) setLink(parsed.data.token);
        })
        .catch(() => undefined);
    },
    [transport],
  );

  return (
    <AutomationsView
      settings={settings}
      origin={window.location.origin}
      {...(link === undefined ? {} : { link })}
      {...(places === undefined ? {} : { places })}
      onSet={onSet}
      onReset={onReset}
      onShowLink={() => {
        fetchLink("GET");
      }}
      onNewLink={() => {
        fetchLink("POST");
      }}
    />
  );
}

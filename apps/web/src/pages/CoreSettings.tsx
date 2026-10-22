import { semantic, spacing, typography } from "@noctis/ui";
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

import { SectionHeading, buttonStyle, fieldStyle, glass } from "../layout/Page.js";
import { AutomationSettings } from "./AutomationSettings.js";
import type { CoreTransport } from "../transport/CoreTransport.js";

/**
 * How Noctis runs: the settings the core reads live (`GET /configuration`),
 * and below them the start-up values it cannot change while running, shown so
 * the owner knows they exist. Secrets arrive only as "set" or "not set".
 */

const SettingViewSchema = z.object({
  key: z.string(),
  label: z.string(),
  help: z.string(),
  kind: z.enum(["time", "boolean", "integer", "choice", "list", "places"]),
  automation: z.literal(true).optional(),
  choices: z.array(z.string()).optional(),
  value: z.unknown(),
  source: z.enum(["ui", "start-up", "default"]),
  ignoredStartUp: z.string().optional(),
});

export const ConfigurationSchema = z.object({
  settings: z.array(SettingViewSchema),
  startUp: z.array(z.object({ name: z.string(), value: z.string() })),
});

export type SettingView = z.infer<typeof SettingViewSchema>;

interface RemoteHost {
  host: string;
  gatewayUrl: string;
  destination: string;
}

const RemoteHostsSchema = z.array(
  z.object({ host: z.string(), gatewayUrl: z.string(), destination: z.string() }),
);

const SOURCE: Record<SettingView["source"], string> = {
  ui: "set here",
  "start-up": "from start-up",
  default: "default",
};

const muted = { margin: 0, color: typography.color.muted, fontSize: typography.scale.sm } as const;

export function Control({
  setting,
  onSet,
}: {
  setting: SettingView;
  onSet: (key: string, value: unknown) => void;
}): JSX.Element {
  const id = `setting-${setting.key}`;
  // Keyed by the value, so a re-read after a save redraws the field.
  const key = JSON.stringify(setting.value);

  switch (setting.kind) {
    case "time":
      return (
        <input
          key={key}
          id={id}
          type="time"
          defaultValue={typeof setting.value === "string" ? setting.value : ""}
          onBlur={(event) => {
            if (event.target.value !== setting.value) onSet(setting.key, event.target.value);
          }}
          style={fieldStyle}
        />
      );
    case "boolean":
      return (
        <input
          key={key}
          id={id}
          type="checkbox"
          defaultChecked={setting.value === true}
          onChange={(event) => {
            onSet(setting.key, event.target.checked);
          }}
          // The touch floor: a bare checkbox is 13px.
          style={{ width: 44, height: 44, margin: 0 }}
        />
      );
    case "integer":
      return (
        <input
          key={key}
          id={id}
          type="number"
          min={1}
          defaultValue={typeof setting.value === "number" ? setting.value : ""}
          onBlur={(event) => {
            const value = Number(event.target.value);
            if (value !== setting.value) onSet(setting.key, value);
          }}
          style={{ ...fieldStyle, maxWidth: 140 }}
        />
      );
    case "choice":
      return (
        <select
          key={key}
          id={id}
          defaultValue={typeof setting.value === "string" ? setting.value : undefined}
          onChange={(event) => {
            onSet(setting.key, event.target.value);
          }}
          style={{ ...fieldStyle, maxWidth: 160 }}
        >
          {(setting.choices ?? []).map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      );
    case "places":
      return (
        <Places
          key={key}
          places={z.array(z.string()).safeParse(setting.value).data ?? []}
          onSave={(places) => {
            onSet(setting.key, places);
          }}
        />
      );
    case "list":
      return (
        <RemoteHosts
          key={key}
          hosts={RemoteHostsSchema.safeParse(setting.value).data ?? []}
          onSave={(hosts) => {
            onSet(setting.key, hosts);
          }}
        />
      );
  }
}

/** The owner's places: one name a row, saved together. Lowercase, as the core wants them. */
function Places({
  places,
  onSave,
}: {
  places: readonly string[];
  onSave: (places: string[]) => void;
}): JSX.Element {
  const [rows, setRows] = useState<string[]>([...places]);

  return (
    <div style={{ display: "grid", gap: spacing.sm }}>
      {rows.map((place, index) => (
        <div key={index} style={{ display: "flex", gap: spacing.sm, minWidth: 0 }}>
          <input
            aria-label={`Place ${String(index + 1)}`}
            placeholder="gym"
            value={place}
            onChange={(event) => {
              const value = event.target.value.toLowerCase().replace(/\s+/g, "-");
              setRows((current) => current.map((row, at) => (at === index ? value : row)));
            }}
            style={{ ...fieldStyle, minWidth: 0, flex: 1 }}
          />
          <button
            type="button"
            onClick={() => {
              setRows((current) => current.filter((__, at) => at !== index));
            }}
            style={buttonStyle}
          >
            Remove
          </button>
        </div>
      ))}
      <div style={{ display: "flex", gap: spacing.sm }}>
        <button
          type="button"
          onClick={() => {
            setRows((current) => [...current, ""]);
          }}
          style={buttonStyle}
        >
          Add a place
        </button>
        <button
          type="button"
          onClick={() => {
            onSave(rows.filter((row) => row !== ""));
          }}
          style={buttonStyle}
        >
          Save places
        </button>
      </div>
    </div>
  );
}

/** The remote-desktop hosts: three fields a row, saved together. */
function RemoteHosts({
  hosts,
  onSave,
}: {
  hosts: readonly RemoteHost[];
  onSave: (hosts: RemoteHost[]) => void;
}): JSX.Element {
  const [rows, setRows] = useState<RemoteHost[]>([...hosts]);
  const field = (index: number, name: keyof RemoteHost, label: string): JSX.Element => (
    <input
      aria-label={`${label} ${String(index + 1)}`}
      placeholder={label}
      value={rows[index]?.[name] ?? ""}
      onChange={(event) => {
        setRows((current) =>
          current.map((row, at) => (at === index ? { ...row, [name]: event.target.value } : row)),
        );
      }}
      style={{ ...fieldStyle, minWidth: 0 }}
    />
  );

  return (
    <div style={{ display: "grid", gap: spacing.sm }}>
      {rows.map((_, index) => (
        <div
          key={index}
          style={{
            display: "grid",
            // Side by side on a desktop, one under another on a phone.
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: spacing.sm,
            minWidth: 0,
          }}
        >
          {field(index, "host", "Host")}
          {field(index, "gatewayUrl", "Gateway (wss://…/jet/rdp)")}
          {field(index, "destination", "Destination (host:3389)")}
          <button
            type="button"
            onClick={() => {
              setRows((current) => current.filter((__, at) => at !== index));
            }}
            style={buttonStyle}
          >
            Remove
          </button>
        </div>
      ))}
      <div style={{ display: "flex", gap: spacing.sm }}>
        <button
          type="button"
          onClick={() => {
            setRows((current) => [...current, { host: "", gatewayUrl: "", destination: "" }]);
          }}
          style={buttonStyle}
        >
          Add a host
        </button>
        <button
          type="button"
          onClick={() => {
            onSave(rows);
          }}
          style={buttonStyle}
        >
          Save hosts
        </button>
      </div>
    </div>
  );
}

export function SettingRow({
  setting,
  onSet,
  onReset,
}: {
  setting: SettingView;
  onSet: (key: string, value: unknown) => void;
  onReset: (key: string) => void;
}): JSX.Element {
  return (
    <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
      <label htmlFor={`setting-${setting.key}`}>{setting.label}</label>
      <Control setting={setting} onSet={onSet} />
      <p style={muted}>
        {setting.help} · {SOURCE[setting.source]}
        {setting.ignoredStartUp !== undefined &&
          ` · the start-up value ${setting.ignoredStartUp} was ignored, it is not a valid value`}
      </p>
      {setting.source === "ui" && (
        <div>
          <button
            type="button"
            onClick={() => {
              onReset(setting.key);
            }}
            style={buttonStyle}
          >
            Reset
          </button>
        </div>
      )}
    </div>
  );
}

export function CoreSettingsView({
  settings,
  startUp,
  onSet,
  onReset,
  error,
}: {
  settings: readonly SettingView[];
  startUp: ReadonlyArray<{ name: string; value: string }>;
  onSet: (key: string, value: unknown) => void;
  onReset: (key: string) => void;
  error?: string;
}): JSX.Element {
  return (
    <section style={{ ...glass, padding: spacing.lg, display: "grid", gap: spacing.md }}>
      <SectionHeading>How Noctis runs</SectionHeading>
      <p style={{ ...muted, maxWidth: typography.measurePx }}>
        These take effect straight away. Reset goes back to the start-up value, or the default.
      </p>
      {settings
        .filter((setting) => setting.automation !== true)
        .map((setting) => (
          <SettingRow key={setting.key} setting={setting} onSet={onSet} onReset={onReset} />
        ))}
      {error !== undefined && <p style={{ margin: 0, color: semantic.error }}>{error}</p>}

      <SectionHeading>Set at start-up</SectionHeading>
      <p style={{ ...muted, maxWidth: typography.measurePx }}>
        The core reads these before it can serve this page, so they change in the deploy script, not
        here.
      </p>
      <dl
        style={{
          margin: 0,
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          gap: `4px ${String(spacing.md)}px`,
          fontFamily: typography.monoFamily,
          fontSize: typography.scale.sm,
          minWidth: 0,
        }}
      >
        {startUp.map((item) => (
          <div key={item.name} style={{ display: "contents" }}>
            <dt>{item.name}</dt>
            <dd style={{ margin: 0, color: typography.color.muted, overflowWrap: "anywhere" }}>
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

let keySequence = 0;

function nextKey(): string {
  keySequence += 1;

  return `web-configuration-${String(keySequence)}-${String(Date.now())}`;
}

function useConfiguration(
  transport: CoreTransport | undefined,
): [z.infer<typeof ConfigurationSchema> | undefined, () => void] {
  const [configuration, setConfiguration] = useState<z.infer<typeof ConfigurationSchema>>();
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (transport === undefined) {
      return;
    }

    let live = true;

    void transport
      .request("GET", "/configuration")
      .then((response) => {
        const parsed = ConfigurationSchema.safeParse(response.body);

        if (live && parsed.success) {
          setConfiguration(parsed.data);
        }
      })
      .catch(() => undefined);

    return () => {
      live = false;
    };
  }, [transport, revision]);

  return [configuration, () => setRevision((current) => current + 1)];
}

export function CoreSettings({ transport }: { transport: CoreTransport | undefined }): JSX.Element {
  const [configuration, reread] = useConfiguration(transport);
  const [error, setError] = useState<string>();

  const send = useCallback(
    async (name: "settings.set" | "settings.reset", body: Record<string, unknown>) => {
      if (transport === undefined) {
        return;
      }

      const response = await transport.request("POST", `/commands/${name}`, {
        idempotencyKey: nextKey(),
        ...body,
      });

      setError(
        response.status === 200
          ? undefined
          : response.status === 400
            ? "That is not a valid value for this setting. Nothing was changed."
            : "The core did not save that.",
      );
      reread();
    },
    [transport, reread],
  );

  if (configuration === undefined) {
    return (
      <section style={{ ...glass, padding: spacing.lg }}>
        <SectionHeading>How Noctis runs</SectionHeading>
        <p style={muted}>Reading…</p>
      </section>
    );
  }

  const onSet = (key: string, value: unknown) => void send("settings.set", { key, value });
  const onReset = (key: string) => void send("settings.reset", { key });

  return (
    <>
      <AutomationSettings
        transport={transport}
        settings={configuration.settings}
        onSet={onSet}
        onReset={onReset}
      />
      <CoreSettingsView
        settings={configuration.settings}
        startUp={configuration.startUp}
        onSet={onSet}
        onReset={onReset}
        {...(error === undefined ? {} : { error })}
      />
    </>
  );
}

/**
 * The rail's "Show unfinished pages", once the owner has chosen on the Settings
 * page. Until then, undefined: the build's own VITE_NOCTIS_ALL_PAGES answers, and
 * the core's default never hides pages a build was made to show.
 */
export function allPagesChoice(settings: readonly SettingView[] | undefined): boolean | undefined {
  const setting = settings?.find((candidate) => candidate.key === "showAllPages");

  return setting?.source === "ui" ? setting.value === true : undefined;
}

/** The Settings toggle for waking an agent as the owner types; on until the core says otherwise. */
export function useWakeWhileTyping(transport: CoreTransport | undefined): boolean {
  const [configuration] = useConfiguration(transport);

  return (
    configuration?.settings.find((setting) => setting.key === "wakeWhileTyping")?.value !== false
  );
}

export function useShowAllPages(transport: CoreTransport | undefined): boolean | undefined {
  const [configuration] = useConfiguration(transport);

  return allPagesChoice(configuration?.settings);
}

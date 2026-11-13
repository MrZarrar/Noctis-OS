import type { LightChange, LightState, LightsStatus } from "@noctis/contracts";
import { LightsEvidenceSchema, LightsStatusSchema } from "@noctis/contracts";
import { corner, material, semantic, spacing, typography } from "@noctis/ui";
import { Power, RefreshCw } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { Page, SectionHeading, buttonStyle } from "../layout/Page.js";
import { lightColour, sceneLabel } from "../lights/lights-view.js";
import type { CoreTransport } from "../transport/CoreTransport.js";

const NodesSchema = z
  .object({
    nodes: z.array(
      z.object({ id: z.string(), hostId: z.string(), connected: z.boolean() }).loose(),
    ),
  })
  .loose();

/** How long a slider rests before its value goes to the bulb. */
const SETTLE_MS = 350;

/** The Lights page: every light the lights PC drives, with full control of each. */
export function Lights({ transport }: { transport: CoreTransport | undefined }): JSX.Element {
  const [status, setStatus] = useState<LightsStatus>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [nodes, setNodes] = useState<z.infer<typeof NodesSchema>["nodes"]>([]);

  const read = useCallback(async () => {
    if (transport === undefined) return;
    const response = await transport.request("GET", "/lights").catch(() => undefined);
    const parsed = LightsStatusSchema.safeParse(response?.body);
    if (parsed.success) setStatus(parsed.data);
    else setProblem("Noctis could not reach the core.");
  }, [transport]);

  useEffect(() => {
    void read();
  }, [read]);

  useEffect(() => {
    if (transport === undefined || status?.granted !== false) return;
    void transport.request("GET", "/nodes").then(
      (response) => {
        const parsed = NodesSchema.safeParse(response.body);
        if (parsed.success) setNodes(parsed.data.nodes.filter((node) => node.connected));
      },
      () => undefined,
    );
  }, [transport, status?.granted]);

  const apply = useCallback(
    async (body: { changes: LightChange[] } | { scene: string }) => {
      if (transport === undefined) return;
      setProblem(undefined);
      if ("changes" in body) {
        // Shown at once; the PC's answer below confirms it or puts the truth back.
        setStatus((current) =>
          current?.lights === undefined
            ? current
            : {
                ...current,
                lights: {
                  ...current.lights,
                  lights: current.lights.lights.map((light) => {
                    const change = body.changes.find((c) => c.light === light.name);
                    if (change === undefined) return light;
                    const { light: _name, ...fields } = change;
                    void _name;
                    return {
                      ...light,
                      ...fields,
                      ...(fields.hue !== undefined ? { mode: "colour" as const } : {}),
                      ...(fields.colorTempK !== undefined ? { mode: "white" as const } : {}),
                    };
                  }),
                },
              },
        );
      } else setBusy(true);
      const response = await transport
        .request("POST", "/lights/set", { idempotencyKey: crypto.randomUUID(), ...body })
        .catch(() => undefined);
      setBusy(false);
      const evidence = LightsEvidenceSchema.safeParse(response?.body);
      if (response?.status === 200 && evidence.success) {
        setStatus((current) =>
          current === undefined ? current : { ...current, lights: evidence.data },
        );
      } else {
        const message = (response?.body as { error?: { message?: string } } | undefined)?.error
          ?.message;
        setProblem(message ?? "The lights did not answer.");
      }
    },
    [transport],
  );

  const allow = async (nodeId: string) => {
    if (transport === undefined) return;
    const response = await transport
      .request("POST", "/commands/lights.allow", { idempotencyKey: crypto.randomUUID(), nodeId })
      .catch(() => undefined);
    if (response?.status !== 200) setProblem("The core refused.");
    await read();
  };

  const lights = status?.lights?.lights ?? [];
  const scenes = status?.lights?.scenes ?? [];
  const anyOn = lights.some((light) => light.on === true);

  return (
    <Page
      title="Lights"
      subtitle={subtitle(status)}
      actions={
        <button
          type="button"
          style={buttonStyle}
          onClick={() => void read()}
          aria-label="Read the lights again"
        >
          <RefreshCw size={16} aria-hidden="true" />
        </button>
      }
    >
      {problem !== undefined && (
        <p
          role="alert"
          style={{
            margin: 0,
            color: semantic.warning,
            font: `400 ${String(typography.scale.sm)}px ${typography.family}`,
          }}
        >
          {problem}
        </p>
      )}

      {status?.granted === false && (
        <section style={{ display: "grid", gap: spacing.md }}>
          <p style={muted}>
            Lights are driven by the PC that can reach them. Choose it once; that PC needs a
            lights.json and the saved logins.
          </p>
          <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap" }}>
            {nodes.map((node) => (
              <button
                key={node.id}
                type="button"
                style={buttonStyle}
                onClick={() => void allow(node.id)}
              >
                Drive lights from {node.hostId}
              </button>
            ))}
            {nodes.length === 0 && <p style={muted}>No PC is connected.</p>}
          </div>
        </section>
      )}

      {lights.length > 0 && (
        <div style={{ display: "flex", gap: spacing.sm, flexWrap: "wrap", alignItems: "center" }}>
          {scenes.map((scene) => (
            <button
              key={scene}
              type="button"
              disabled={busy}
              style={sceneButton}
              onClick={() => void apply({ scene })}
            >
              {sceneLabel(scene)}
            </button>
          ))}
          <button
            type="button"
            disabled={busy || !anyOn}
            style={buttonStyle}
            onClick={() =>
              void apply({
                changes: lights
                  .filter((l) => l.on === true)
                  .map((l) => ({ light: l.name, on: false })),
              })
            }
          >
            All off
          </button>
        </div>
      )}

      {lights.length > 0 && (
        <section style={{ display: "grid", gap: spacing.md }}>
          <SectionHeading>{`${String(lights.filter((l) => l.on === true).length)} of ${String(lights.length)} on`}</SectionHeading>
          <div
            style={{
              display: "grid",
              gap: spacing.md,
              gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))",
            }}
          >
            {lights.map((light) => (
              <LightCard
                key={light.name}
                light={light}
                disabled={busy}
                onChange={(change) => void apply({ changes: [change] })}
              />
            ))}
          </div>
        </section>
      )}
    </Page>
  );
}

function subtitle(status: LightsStatus | undefined): string | undefined {
  if (status === undefined) return undefined;
  if (!status.granted) return "Not set up yet";
  if (!status.nodeOnline) return "The lights PC is offline";
  if (status.error !== undefined) return status.error;
  return undefined;
}

function LightCard({
  light,
  disabled,
  onChange,
}: {
  light: LightState;
  disabled: boolean;
  onChange: (change: LightChange) => void;
}): JSX.Element {
  const reduce = useReducedMotion();
  const colour = lightColour(light);
  const [draft, setDraft] = useState(light);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => setDraft(light), [light]);
  useEffect(() => () => clearTimeout(timer.current), []);

  // A slider sends once it rests, so dragging is one change to the bulb, not fifty.
  const settle = (change: Omit<LightChange, "light">) => {
    setDraft((current) => ({
      ...current,
      ...change,
      ...(change.hue === undefined ? {} : { mode: "colour" as const }),
    }));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange({ light: light.name, ...change }), SETTLE_MS);
  };
  const usable = light.online && !disabled;
  const on = light.on === true;

  return (
    <motion.article
      layout={!reduce}
      style={{
        position: "relative",
        overflow: "hidden",
        display: "grid",
        gap: spacing.md,
        padding: spacing.lg,
        borderRadius: corner.lg,
        border: `1px solid ${material.border}`,
        background: material.fill,
      }}
    >
      <motion.div
        aria-hidden="true"
        animate={{ opacity: colour === undefined ? 0 : 0.22 }}
        transition={{ duration: reduce ? 0 : 0.6 }}
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          background: `radial-gradient(120% 90% at 0% 0%, ${colour ?? "transparent"}, transparent 70%)`,
        }}
      />
      <header
        style={{ position: "relative", display: "flex", alignItems: "center", gap: spacing.md }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: colour ?? material.fillElevated,
            boxShadow: colour === undefined ? "none" : `0 0 14px ${colour}`,
            border: `1px solid ${material.border}`,
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              font: `600 ${String(typography.scale.base)}px ${typography.family}`,
              color: typography.color.primary,
            }}
          >
            {light.name}
          </div>
          <div style={{ ...muted, fontSize: typography.scale.xs }}>
            {light.error ??
              (!light.online ? "Unreachable" : on ? `${String(light.brightness ?? 100)}%` : "Off")}
            {" · "}
            {light.kind === "tapo" ? "Tapo" : "Smart Life"}
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={`${light.name} ${on ? "on" : "off"}`}
          disabled={!usable}
          onClick={() => onChange({ light: light.name, on: !on })}
          style={{
            ...buttonStyle,
            padding: 0,
            width: 44,
            display: "grid",
            placeItems: "center",
            color: on ? "#15131f" : typography.color.primary,
            background: on ? (colour ?? typography.color.primary) : material.fillElevated,
            opacity: usable ? 1 : 0.5,
          }}
        >
          <Power size={18} aria-hidden="true" />
        </button>
      </header>

      {light.online && (
        <div style={{ position: "relative", display: "grid", gap: spacing.sm }}>
          <Slider
            label="Brightness"
            min={1}
            max={100}
            value={draft.brightness ?? 100}
            disabled={!usable}
            track={`linear-gradient(90deg, ${material.fillElevated}, ${typography.color.primary})`}
            onInput={(brightness) => settle({ brightness })}
          />
          <Slider
            label="White"
            min={2500}
            max={6500}
            step={100}
            value={draft.colorTempK ?? 2700}
            disabled={!usable}
            track="linear-gradient(90deg, rgb(255 180 107), rgb(255 244 229), rgb(219 232 255))"
            onInput={(colorTempK) => settle({ colorTempK })}
          />
          <Slider
            label="Colour"
            min={0}
            max={360}
            value={draft.hue ?? 0}
            disabled={!usable}
            track="linear-gradient(90deg, hsl(0 90% 55%), hsl(60 90% 55%), hsl(120 90% 55%), hsl(180 90% 55%), hsl(240 90% 55%), hsl(300 90% 55%), hsl(360 90% 55%))"
            onInput={(hue) =>
              settle({
                hue,
                saturation: draft.saturation && draft.saturation > 0 ? draft.saturation : 100,
              })
            }
          />
          {draft.mode === "colour" && (
            <Slider
              label="Saturation"
              min={0}
              max={100}
              value={draft.saturation ?? 100}
              disabled={!usable}
              track={`linear-gradient(90deg, rgb(240 240 240), hsl(${String(draft.hue ?? 0)} 100% 55%))`}
              onInput={(saturation) => settle({ hue: draft.hue ?? 0, saturation })}
            />
          )}
        </div>
      )}
    </motion.article>
  );
}

function Slider({
  label,
  min,
  max,
  step = 1,
  value,
  disabled,
  track,
  onInput,
}: {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  disabled: boolean;
  track: string;
  onInput: (value: number) => void;
}): JSX.Element {
  return (
    <label
      style={{
        display: "grid",
        gridTemplateColumns: "88px 1fr",
        alignItems: "center",
        gap: spacing.sm,
      }}
    >
      <span style={{ ...muted, fontSize: typography.scale.xs }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        className="noctis-range"
        onChange={(event) => onInput(Number(event.currentTarget.value))}
        style={{
          width: "100%",
          height: 6,
          borderRadius: corner.sm,
          appearance: "none",
          WebkitAppearance: "none",
          background: track,
          accentColor: typography.color.primary,
          opacity: disabled ? 0.4 : 1,
          cursor: disabled ? "default" : "pointer",
        }}
      />
    </label>
  );
}

const muted: CSSProperties = {
  margin: 0,
  color: typography.color.muted,
  font: `400 ${String(typography.scale.sm)}px ${typography.family}`,
};

const sceneButton: CSSProperties = {
  ...buttonStyle,
  background: "linear-gradient(180deg, rgba(255, 196, 120, 0.16), rgba(255, 196, 120, 0.06))",
  borderColor: "rgba(255, 196, 120, 0.35)",
};

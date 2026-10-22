import { identityAccent, material, semantic, spacing, typography, corner } from "@noctis/ui";
import { area, curveCatmullRom, line } from "d3-shape";
import { animate, motion, useMotionValue, useReducedMotion, useTransform } from "motion/react";
import { useEffect, useRef, useState } from "react";

import {
  MACHINES,
  useHardwareSamples,
  type HardwareMachine,
  type HardwareSample,
} from "./hardware.js";

/**
 * LARP mode's Hardware panel: a card per PC with CPU, RAM, GPU and VRAM as
 * live meters. The readings are fictional (`hardware.ts`); everything else is
 * the panel the real feature would draw.
 */
export function HardwarePanel(): JSX.Element {
  const samples = useHardwareSamples();

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
        gap: spacing.md,
      }}
    >
      {MACHINES.map((machine) => (
        <MachineCard key={machine.id} machine={machine} sample={samples[machine.id]} />
      ))}
    </div>
  );
}

const HISTORY = 48;

function MachineCard({
  machine,
  sample,
}: {
  machine: HardwareMachine;
  sample: HardwareSample | undefined;
}): JSX.Element {
  const cpu = sample?.cpu ?? 0;
  // Seeded with a quiet past, so the line is already moving when the panel arrives.
  const [history, setHistory] = useState<number[]>(() =>
    Array.from(
      { length: HISTORY },
      (_, index) => cpu + Math.sin(index * 1.7) * 3 + Math.random() * 3,
    ),
  );

  useEffect(() => {
    setHistory((current) => [...current, cpu].slice(-HISTORY));
  }, [cpu]);

  return (
    <article
      data-hardware={machine.id}
      style={{
        position: "relative",
        overflow: "hidden",
        display: "grid",
        gap: spacing.sm,
        padding: spacing.md,
        borderRadius: corner.md,
        border: `1px solid ${material.border}`,
        background: `radial-gradient(120% 90% at 100% 0%, rgba(139, 124, 246, 0.16), transparent 60%), ${material.fill}`,
      }}
    >
      <header style={{ display: "flex", alignItems: "center", gap: spacing.sm }}>
        <motion.span
          aria-hidden="true"
          animate={{ opacity: [1, 0.35, 1] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: semantic.success,
            boxShadow: `0 0 10px ${semantic.success}`,
          }}
        />
        <strong style={{ fontSize: typography.scale.base }}>{machine.name}</strong>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: typography.scale.xs, color: typography.color.muted }}>Online</span>
      </header>
      <p style={{ margin: 0, fontSize: typography.scale.xs, color: typography.color.muted }}>
        {machine.cpuName} · {machine.gpuName}
      </p>
      <Sparkline values={history} />
      <Meter label="CPU" value={cpu} detail={`${(3.4 + cpu * 0.018).toFixed(1)} GHz`} />
      <Meter
        label="RAM"
        value={sample?.ram ?? 0}
        detail={`${(((sample?.ram ?? 0) / 100) * machine.ramGb).toFixed(1)} / ${String(machine.ramGb)} GB`}
      />
      <Meter
        label="GPU"
        value={sample?.gpu ?? 0}
        detail={`${String(Math.round(34 + (sample?.gpu ?? 0) * 0.42))}°C`}
      />
      <Meter
        label="VRAM"
        value={sample?.vram ?? 0}
        detail={`${(((sample?.vram ?? 0) / 100) * machine.vramGb).toFixed(1)} / ${String(machine.vramGb)} GB`}
      />
    </article>
  );
}

/** Violet at rest, warming to amber and then red as a part runs hot. */
function heat(value: number): string {
  if (value > 85) return semantic.error;
  if (value > 65) return semantic.warning;
  return identityAccent.vesper.primary;
}

function Meter({
  label,
  value,
  detail,
}: {
  label: string;
  value: number;
  detail: string;
}): JSX.Element {
  const reduced = useReducedMotion();
  const shown = useMotionValue(value);
  const text = useTransform(shown, (current) => String(Math.round(current)));

  useEffect(() => {
    const controls = animate(shown, value, { duration: reduced ? 0 : 0.8, ease: "easeOut" });
    return () => controls.stop();
  }, [value, reduced, shown]);

  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: spacing.xs,
          fontSize: typography.scale.xs,
        }}
      >
        <span style={{ color: typography.color.muted, letterSpacing: "0.08em" }}>{label}</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: typography.color.muted, fontVariantNumeric: "tabular-nums" }}>
          {detail}
        </span>
        <motion.b
          style={{
            minWidth: 30,
            textAlign: "right",
            fontVariantNumeric: "tabular-nums",
            fontSize: typography.scale.sm,
          }}
        >
          {text}
        </motion.b>
        <span style={{ color: typography.color.muted, marginLeft: -2 }}>%</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value)}
        style={{
          height: 6,
          borderRadius: 999,
          background: "rgba(255, 255, 255, 0.07)",
          overflow: "hidden",
        }}
      >
        <motion.div
          initial={false}
          animate={{ width: `${String(value)}%`, backgroundColor: heat(value) }}
          transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 70, damping: 18 }}
          style={{
            height: "100%",
            borderRadius: 999,
            backgroundImage: "linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,0.35))",
            boxShadow: `0 0 12px ${heat(value)}`,
          }}
        />
      </div>
    </div>
  );
}

const SPARK_W = 240;
const SPARK_H = 40;

function Sparkline({ values }: { values: readonly number[] }): JSX.Element {
  const id = useRef(`spark-${Math.random().toString(36).slice(2)}`).current;
  const x = (index: number): number => (index / (HISTORY - 1)) * SPARK_W;
  const y = (value: number): number => SPARK_H - (value / 100) * (SPARK_H - 4) - 2;
  const offset = HISTORY - values.length;
  const points = values.map((value, index) => [x(index + offset), y(value)] as [number, number]);
  const fill = area<[number, number]>()
    .x((point) => point[0])
    .y0(SPARK_H)
    .y1((point) => point[1])
    .curve(curveCatmullRom)(points);
  const stroke = line<[number, number]>()
    .x((point) => point[0])
    .y((point) => point[1])
    .curve(curveCatmullRom)(points);

  return (
    <svg
      viewBox={`0 0 ${String(SPARK_W)} ${String(SPARK_H)}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ width: "100%", height: SPARK_H, display: "block" }}
    >
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={identityAccent.vesper.primary} stopOpacity={0.45} />
          <stop offset="100%" stopColor={identityAccent.vesper.primary} stopOpacity={0} />
        </linearGradient>
      </defs>
      {fill !== null && <path d={fill} fill={`url(#${id})`} />}
      {stroke !== null && (
        <path d={stroke} fill="none" stroke={identityAccent.vesper.primary} strokeWidth={1.5} />
      )}
    </svg>
  );
}

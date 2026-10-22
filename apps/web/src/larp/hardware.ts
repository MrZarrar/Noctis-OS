import { useEffect, useState } from "react";

/**
 * The fictional hardware readings LARP mode's Hardware panel draws.
 *
 * Each value drifts toward a target with a little noise, the way a real
 * sampler's numbers wander. "Under load" raises the targets, so the bars
 * climb over a few seconds instead of jumping.
 */

export interface HardwareSample {
  cpu: number;
  ram: number;
  gpu: number;
  vram: number;
}

export interface HardwareMachine {
  id: string;
  name: string;
  cpuName: string;
  gpuName: string;
  ramGb: number;
  vramGb: number;
  /** The clock the CPU row shows runs from base at idle to boost at full load. */
  baseGhz: number;
  boostGhz: number;
}

export const MACHINES: readonly HardwareMachine[] = [
  {
    id: "home",
    name: "Home PC",
    cpuName: "Ryzen 7 9700X",
    gpuName: "RTX 5070",
    ramGb: 32,
    vramGb: 12,
    baseGhz: 3.8,
    boostGhz: 5.5,
  },
  {
    id: "work",
    name: "Work PC",
    cpuName: "Core i7-14700K",
    gpuName: "RTX 4070 Ti",
    ramGb: 32,
    vramGb: 12,
    baseGhz: 3.4,
    boostGhz: 5.6,
  },
];

const IDLE: Record<string, HardwareSample> = {
  home: { cpu: 9, ram: 38, gpu: 6, vram: 21 },
  work: { cpu: 14, ram: 46, gpu: 4, vram: 17 },
};
const BUSY: Record<string, HardwareSample> = {
  home: { cpu: 91, ram: 72, gpu: 97, vram: 83 },
  work: { cpu: 84, ram: 66, gpu: 88, vram: 71 },
};

let busy = false;
const listeners = new Set<() => void>();

export function setHardwareLoad(next: boolean): void {
  busy = next;
  for (const listener of listeners) listener();
}

export function hardwareBusy(): boolean {
  return busy;
}

/** One step of the drift: a fifth of the way to the target, plus noise. */
export function drift(
  current: HardwareSample,
  target: HardwareSample,
  noise: () => number,
): HardwareSample {
  const step = (from: number, to: number): number =>
    Math.min(100, Math.max(0, from + (to - from) * 0.2 + (noise() - 0.5) * 6));

  return {
    cpu: step(current.cpu, target.cpu),
    ram: step(current.ram, target.ram),
    gpu: step(current.gpu, target.gpu),
    vram: step(current.vram, target.vram),
  };
}

export function useHardwareSamples(intervalMs = 900): Record<string, HardwareSample> {
  const [samples, setSamples] = useState<Record<string, HardwareSample>>(() => ({ ...IDLE }));
  const [load, setLoad] = useState(busy);

  useEffect(() => {
    const listener = (): void => setLoad(busy);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setSamples((current) =>
        Object.fromEntries(
          MACHINES.map((machine) => [
            machine.id,
            drift(
              current[machine.id] ?? IDLE[machine.id]!,
              (load ? BUSY : IDLE)[machine.id]!,
              Math.random,
            ),
          ]),
        ),
      );
    }, intervalMs);
    return () => clearInterval(timer);
  }, [load, intervalMs]);

  return samples;
}

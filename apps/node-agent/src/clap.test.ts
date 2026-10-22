import { describe, expect, it } from "vitest";

import {
  SAMPLE_RATE,
  createClapDetector,
  parseAudioDevices,
  parseScreens,
  windowLaunches,
} from "./clap.js";

/** A seeded generator, so a failing run fails the same way twice. */
function noise(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 1_073_741_824 - 1;
  };
}

/**
 * Room tone with sounds laid over it. A clap is a noise burst that dies away in
 * a few tens of milliseconds; `long` is a loud sound that does not.
 */
function audio(
  seconds: number,
  events: { at: number; peak: number; long?: boolean }[],
): Int16Array {
  const random = noise(7);
  const samples = new Int16Array(Math.round(seconds * SAMPLE_RATE));
  for (let index = 0; index < samples.length; index += 1) {
    let value = random() * 0.01;
    const time = index / SAMPLE_RATE;
    for (const event of events) {
      const since = time - event.at;
      if (since < 0) continue;
      const envelope = event.long ? (since < 0.4 ? 1 : 0) : Math.exp(-since / 0.008);
      value += random() * event.peak * envelope;
    }
    samples[index] = Math.max(-32_768, Math.min(32_767, Math.round(value * 32_767)));
  }
  return samples;
}

function doubles(samples: Int16Array, chunk = samples.length): number {
  const detector = createClapDetector({ threshold: 0.3 });
  let count = 0;
  for (let at = 0; at < samples.length; at += chunk) {
    if (detector.push(samples.subarray(at, at + chunk))) count += 1;
  }
  return count;
}

describe("the clap detector", () => {
  it("fires once for two claps close together", () => {
    expect(
      doubles(
        audio(2, [
          { at: 0.5, peak: 0.9 },
          { at: 0.9, peak: 0.9 },
        ]),
      ),
    ).toBe(1);
  });

  it("fires the same however the audio is chunked", () => {
    const pair = audio(2, [
      { at: 0.5, peak: 0.9 },
      { at: 0.9, peak: 0.9 },
    ]);
    expect(doubles(pair, 77)).toBe(1);
  });

  it("ignores a single clap", () => {
    expect(doubles(audio(2, [{ at: 0.5, peak: 0.9 }]))).toBe(0);
  });

  it("ignores two claps too far apart", () => {
    expect(
      doubles(
        audio(3, [
          { at: 0.5, peak: 0.9 },
          { at: 2, peak: 0.9 },
        ]),
      ),
    ).toBe(0);
  });

  it("ignores claps too quiet to reach the threshold", () => {
    expect(
      doubles(
        audio(2, [
          { at: 0.5, peak: 0.1 },
          { at: 0.9, peak: 0.1 },
        ]),
      ),
    ).toBe(0);
  });

  it("ignores loud sounds that do not die away like a clap", () => {
    expect(
      doubles(
        audio(2, [
          { at: 0.3, peak: 0.9, long: true },
          { at: 1, peak: 0.9, long: true },
        ]),
      ),
    ).toBe(0);
  });

  it("ignores claps over loud steady sound such as music", () => {
    const random = noise(3);
    const claps = audio(3, [
      { at: 1, peak: 0.9 },
      { at: 1.4, peak: 0.9 },
    ]);
    const mixed = claps.map((clap) =>
      Math.max(-32_768, Math.min(32_767, clap + Math.round(random() * 0.5 * 32_767))),
    );
    expect(doubles(mixed)).toBe(0);
  });
});

describe("the ffmpeg device list", () => {
  it("names the audio devices only", () => {
    const listing = [
      '[in#0 @ 0000015d1e9f2f00] "AMD Privacy View camera" (video)',
      '[in#0 @ 0000015d1e9f2f00]   Alternative name "@device_sw_{860BB310}"',
      '[in#0 @ 0000015d1e9f2f00] "Microphone (G55)" (audio)',
      '[in#0 @ 0000015d1e9f2f00]   Alternative name "@device_cm_{33D9A762}"',
      "Error opening input file dummy.",
    ].join("\r\n");

    expect(parseAudioDevices(listing)).toEqual(["Microphone (G55)"]);
  });
});

describe("the two windows", () => {
  const screens = parseScreens("False 2560 252\r\nTrue 0 0\r\n");

  it("puts Presence on the primary monitor and the Vault on the other", () => {
    const [presence, vault] = windowLaunches(
      "https://noctis.example",
      screens,
      String.raw`C:\profiles`,
    );

    expect(presence).toContain("--app=https://noctis.example/?screen=Presence");
    expect(presence).toContain("--window-position=40,40");
    expect(presence).toContain(String.raw`--user-data-dir=C:\profiles\presence`);
    expect(vault).toContain("--app=https://noctis.example/?screen=Vault");
    expect(vault).toContain("--window-position=2600,292");
    expect(vault).toContain(String.raw`--user-data-dir=C:\profiles\vault`);
  });

  it("puts both on the one monitor when there is only one", () => {
    const [presence, vault] = windowLaunches(
      "https://noctis.example",
      parseScreens("True 0 0"),
      String.raw`C:\profiles`,
    );

    expect(presence).toContain("--window-position=40,40");
    expect(vault).toContain("--window-position=40,40");
  });
});

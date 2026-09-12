import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeProposal } from "@noctis/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PROPOSAL_POLL_MS, createProposalChannel } from "./proposals-file.js";

const OBJECTIVE = { kind: "objective", title: "Suggested", intent: "do the thing" };

let dir: string;
let seen: Array<[RuntimeProposal, number]>;
let warnings: string[];

beforeEach(() => {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), "noctis-proposals-"));
  seen = [];
  warnings = [];
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

function start(): { path: string; stop: () => void } {
  const channel = createProposalChannel(join(dir, "nested"), "turn-1");
  const stop = channel.start(
    (proposal, line) => seen.push([proposal, line]),
    (message) => warnings.push(message),
  );

  return { path: channel.path, stop };
}

describe("the proposals file channel", () => {
  it("creates an empty file under the directory and names it after the turn", () => {
    const { path, stop } = start();

    expect(path).toBe(join(dir, "nested", "turn-1.jsonl"));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("");
    stop();
  });

  it("delivers each appended line as a parsed proposal with its line number", () => {
    const { path, stop } = start();

    appendFileSync(path, `${JSON.stringify(OBJECTIVE)}\n`);
    vi.advanceTimersByTime(PROPOSAL_POLL_MS);
    appendFileSync(path, `${JSON.stringify(OBJECTIVE)}\n`);
    vi.advanceTimersByTime(PROPOSAL_POLL_MS);

    expect(seen).toEqual([
      [OBJECTIVE, 1],
      [OBJECTIVE, 2],
    ]);
    expect(warnings).toEqual([]);
    stop();
  });

  it("waits for the newline before it reads a line", () => {
    const { path, stop } = start();
    const line = JSON.stringify(OBJECTIVE);

    appendFileSync(path, line.slice(0, 10));
    vi.advanceTimersByTime(PROPOSAL_POLL_MS);
    expect(seen).toEqual([]);

    appendFileSync(path, `${line.slice(10)}\n`);
    vi.advanceTimersByTime(PROPOSAL_POLL_MS);
    expect(seen).toEqual([[OBJECTIVE, 1]]);
    stop();
  });

  it("warns about a malformed or off-schema line and delivers the good ones around it", () => {
    const { path, stop } = start();

    appendFileSync(
      path,
      `not json\n${JSON.stringify({ kind: "objective", title: "" })}\n${JSON.stringify(OBJECTIVE)}\n`,
    );
    vi.advanceTimersByTime(PROPOSAL_POLL_MS);

    expect(seen).toEqual([[OBJECTIVE, 3]]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/line 1/);
    expect(warnings[1]).toMatch(/line 2/);
    stop();
  });

  it("drains what was written just before stop, then reads nothing more", () => {
    const { path, stop } = start();

    appendFileSync(path, `${JSON.stringify(OBJECTIVE)}\n`);
    stop();
    expect(seen).toEqual([[OBJECTIVE, 1]]);

    appendFileSync(path, `${JSON.stringify(OBJECTIVE)}\n`);
    vi.advanceTimersByTime(PROPOSAL_POLL_MS * 4);
    expect(seen).toHaveLength(1);
  });
});

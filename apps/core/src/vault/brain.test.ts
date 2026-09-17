import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BRAIN_MAX_LINES, BRAIN_PATH, alreadyKnown, rememberPreference } from "./brain.js";
import type { VaultRoot } from "./root.js";

const WRITES = { NOCTIS_VAULT_ALLOW_WRITES: "true" };

let scratch: string | undefined;

afterEach(() => {
  if (scratch !== undefined) {
    rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  }
});

function vaultWithBrain(contents: string | undefined): VaultRoot {
  scratch = mkdtempSync(join(tmpdir(), "noctis-brain-"));
  mkdirSync(join(scratch, "agent"), { recursive: true });

  if (contents !== undefined) {
    writeFileSync(join(scratch, BRAIN_PATH), contents, "utf8");
  }

  return { path: scratch, live: false };
}

function brainText(root: VaultRoot): string {
  return readFileSync(join(root.path, BRAIN_PATH), "utf8");
}

describe("rememberPreference", () => {
  it("appends one bullet and leaves what was already there alone", () => {
    const root = vaultWithBrain("# Agent Brain\n\n- Prefers short answers\n");
    const outcome = rememberPreference({ root, env: WRITES }, "Hand over the test steps");

    expect(outcome.ok).toBe(true);
    expect(brainText(root)).toBe(
      "# Agent Brain\n\n- Prefers short answers\n- Hand over the test steps\n",
    );
  });

  it("refuses when the write switch is off, which is the default", () => {
    const root = vaultWithBrain("# Agent Brain\n");
    const outcome = rememberPreference({ root, env: {} }, "Hand over the test steps");

    expect(outcome).toEqual({ ok: false, refusal: "writes_disabled" });
    expect(brainText(root)).toBe("# Agent Brain\n");
  });

  it("refuses a lesson the brain already records", () => {
    const root = vaultWithBrain("# Agent Brain\n\n- Hand over the test steps\n");
    const outcome = rememberPreference({ root, env: WRITES }, "hand over the test steps");

    expect(outcome).toEqual({ ok: false, refusal: "already_known" });
  });

  it("refuses once the brain is at its line cap", () => {
    // The cap is what actually bounds the file: without it a runtime that
    // learns something every turn turns the brain into a log nobody reads.
    const root = vaultWithBrain(
      `${Array.from({ length: BRAIN_MAX_LINES }, (_, i) => `- line ${String(i)}`).join("\n")}\n`,
    );
    const outcome = rememberPreference({ root, env: WRITES }, "One more thing entirely");

    expect(outcome).toEqual({ ok: false, refusal: "brain_full" });
  });

  it("refuses to create a brain that does not exist", () => {
    // A runtime bringing a Vault structure into being that the owner never
    // made is worse than a refusal it can report.
    const root = vaultWithBrain(undefined);
    const outcome = rememberPreference({ root, env: WRITES }, "Hand over the test steps");

    expect(outcome).toEqual({ ok: false, refusal: "brain_missing" });
  });

  it("refuses when no Vault is configured at all", () => {
    expect(rememberPreference({ root: undefined, env: WRITES }, "Anything")).toEqual({
      ok: false,
      refusal: "no_vault",
    });
  });

  it("adds the newline a hand-edited brain may be missing", () => {
    const root = vaultWithBrain("# Agent Brain\n\n- Prefers short answers");
    const outcome = rememberPreference({ root, env: WRITES }, "Hand over the test steps");

    expect(outcome.ok).toBe(true);
    expect(brainText(root)).toContain("- Prefers short answers\n- Hand over the test steps\n");
  });
});

describe("alreadyKnown", () => {
  it("ignores case and whitespace", () => {
    expect(alreadyKnown("- Hand over the test steps\n", "hand   over the TEST steps")).toBe(true);
  });

  it("does not claim a different lesson is already there", () => {
    expect(alreadyKnown("- Hand over the test steps\n", "Prefers short answers")).toBe(false);
  });
});

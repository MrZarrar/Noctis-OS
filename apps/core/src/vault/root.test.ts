import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { VaultRootRefused, isLiveVaultPath, resolveVaultRoot } from "./root.js";

const directories: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "noctis-vault-root-"));
  directories.push(directory);

  return directory;
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();

    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe("resolving the Vault root", () => {
  it("is disabled when no root is configured", () => {
    expect(resolveVaultRoot({})).toBeUndefined();
  });

  it("accepts a plain directory", () => {
    const directory = scratch();

    expect(resolveVaultRoot({ NOCTIS_VAULT_ROOT: directory })?.path).toBeTypeOf("string");
  });

  it("refuses a root that does not exist", () => {
    expect(() => resolveVaultRoot({ NOCTIS_VAULT_ROOT: join(scratch(), "absent") })).toThrow(
      VaultRootRefused,
    );
  });

  it("refuses a root that is a file", () => {
    const directory = scratch();
    const file = join(directory, "note.md");

    writeFileSync(file, "# not a directory");

    expect(() => resolveVaultRoot({ NOCTIS_VAULT_ROOT: file })).toThrow(VaultRootRefused);
  });

  it("THE GATE: refuses a real Obsidian vault", () => {
    const directory = scratch();

    mkdirSync(join(directory, ".obsidian"));

    expect(() => resolveVaultRoot({ NOCTIS_VAULT_ROOT: directory })).toThrow(VaultRootRefused);
  });

  it("THE GATE: refuses a synced personal Vault by path shape", () => {
    for (const candidate of [
      "C:/Users/someone/OneDrive/MindVault",
      "C:\\Users\\someone\\OneDrive\\MindVault",
      "C:/Users/someone/OneDrive - Contoso/MindVault/projects",
      "/home/someone/OneDrive/MindVault",
      "C:/Users/someone/Documents/MindVault",
    ]) {
      expect(isLiveVaultPath(candidate), candidate).toBe(true);
    }
  });

  it("does not mistake an ordinary directory for a live Vault", () => {
    for (const candidate of [
      "C:/Users/someone/AppData/Local/Temp/noctis-vault-1",
      "/tmp/noctis-test-vault",
      "C:/repos/Noctis-OS/fixtures/vault",
      // "onedriveish" is not "OneDrive": the check is on whole path segments.
      "C:/Users/someone/onedriveish/notes",
    ]) {
      expect(isLiveVaultPath(candidate), candidate).toBe(false);
    }
  });

  it("THE GATE: only an explicit activation flag can unlock a live Vault", () => {
    const directory = scratch();

    mkdirSync(join(directory, ".obsidian"));

    expect(() => resolveVaultRoot({ NOCTIS_VAULT_ROOT: directory })).toThrow(VaultRootRefused);

    const activated = resolveVaultRoot({
      NOCTIS_VAULT_ROOT: directory,
      NOCTIS_VAULT_ALLOW_LIVE: "true",
    });

    expect(activated?.live).toBe(true);
  });

  it("reports a permitted root as not live", () => {
    expect(resolveVaultRoot({ NOCTIS_VAULT_ROOT: scratch() })?.live).toBe(false);
  });

  it("treats any value other than the exact activation string as off", () => {
    const directory = scratch();

    mkdirSync(join(directory, ".obsidian"));

    for (const value of ["TRUE", "1", "yes", "", " true "]) {
      expect(() =>
        resolveVaultRoot({ NOCTIS_VAULT_ROOT: directory, NOCTIS_VAULT_ALLOW_LIVE: value }),
      ).toThrow(VaultRootRefused);
    }
  });
});

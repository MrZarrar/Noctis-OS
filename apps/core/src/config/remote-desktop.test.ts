import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigurationError, loadCoreConfig } from "./server.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const directory = mkdtempSync(join(tmpdir(), "noctis-remote-config-"));

function keyFile(name: string, pem: string): string {
  const path = join(directory, name);
  writeFileSync(path, pem);
  return path;
}

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const RSA_KEY = keyFile(
  "provisioner.key",
  rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
);
const PUBLIC_ONLY = keyFile(
  "provisioner.pem",
  rsa.publicKey.export({ type: "spki", format: "pem" }).toString(),
);
const SMALL_KEY = keyFile(
  "small.key",
  generateKeyPairSync("rsa", { modulusLength: 1024 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
);
const EC_KEY = keyFile(
  "ec.key",
  generateKeyPairSync("ec", { namedCurve: "prime256v1" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString(),
);

const TARGETS = JSON.stringify([
  {
    host: "zarrarpc",
    gatewayUrl: "wss://zarrarpc.tail9594ed.ts.net/jet/rdp",
    destination: "zarrarpc.tail9594ed.ts.net:3389",
  },
]);

function env(extra: Record<string, string>): Record<string, string> {
  return { NOCTIS_CORE_TOKEN: TOKEN, NOCTIS_DATABASE_PATH: ":memory:", ...extra };
}

function load(targets: string, key: string) {
  return loadCoreConfig(
    env({ NOCTIS_REMOTE_DESKTOPS: targets, NOCTIS_GATEWAY_PROVISIONER_KEY_FILE: key }),
  );
}

describe("loadCoreConfig: remote desktop (Task 3.9)", () => {
  it("is off unless it is configured, like every production capability", () => {
    expect(loadCoreConfig(env({})).remoteDesktop).toBeUndefined();
  });

  it("reads the allowlist and the provisioner key together", () => {
    const remote = load(TARGETS, RSA_KEY).remoteDesktop;

    expect(remote?.targets).toEqual([
      {
        host: "zarrarpc",
        gatewayUrl: "wss://zarrarpc.tail9594ed.ts.net/jet/rdp",
        destination: "zarrarpc.tail9594ed.ts.net:3389",
      },
    ]);
    expect(remote?.privateKey.asymmetricKeyType).toBe("rsa");
  });

  it("refuses one half without the other", () => {
    expect(() => loadCoreConfig(env({ NOCTIS_REMOTE_DESKTOPS: TARGETS }))).toThrow(
      /NOCTIS_GATEWAY_PROVISIONER_KEY_FILE/,
    );
    expect(() => loadCoreConfig(env({ NOCTIS_GATEWAY_PROVISIONER_KEY_FILE: RSA_KEY }))).toThrow(
      /NOCTIS_REMOTE_DESKTOPS/,
    );
  });

  it("refuses a key that cannot sign the Gateway's RS256 token", () => {
    for (const bad of [PUBLIC_ONLY, SMALL_KEY, EC_KEY, join(directory, "missing.key")]) {
      expect(() => load(TARGETS, bad), bad).toThrow(ConfigurationError);
    }
  });

  it("refuses a target the page could be sent somewhere else by", () => {
    const one = (target: Record<string, string>) =>
      JSON.stringify([
        {
          host: "zarrarpc",
          gatewayUrl: "wss://zarrarpc.tail9594ed.ts.net/jet/rdp",
          destination: "zarrarpc.tail9594ed.ts.net:3389",
          ...target,
        },
      ]);

    for (const bad of [
      one({ gatewayUrl: "ws://zarrarpc.tail9594ed.ts.net/jet/rdp" }),
      one({ destination: "zarrarpc.tail9594ed.ts.net" }),
      one({ host: "zarrarpc.tail9594ed.ts.net" }),
      `[${one({}).slice(1, -1)},${one({}).slice(1, -1)}]`,
      "[]",
      "not json",
    ]) {
      expect(() => load(bad, RSA_KEY), bad).toThrow(ConfigurationError);
    }
  });

  it("names the variable and never the key", () => {
    const pem = rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    try {
      load("not json", RSA_KEY);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(String(error)).toContain("NOCTIS_REMOTE_DESKTOPS");
      expect(String(error)).not.toContain(pem.split("\n")[1]);
    }
  });
});

import { execFile } from "node:child_process";
import { join } from "node:path";

import type { LightsConfig } from "@noctis/contracts";

export class LightsAuthenticationError extends Error {}

export interface LightsCredentials {
  username: string;
  password: string;
}

export type SecretReader = (path: string) => Promise<LightsCredentials>;

const SCRIPT =
  "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $c = Import-Clixml -LiteralPath $env:NOCTIS_LIGHTS_SECRET_PATH; if ($c -isnot [System.Management.Automation.PSCredential]) { throw 'Expected PSCredential' }; @{username=$c.UserName;password=$c.GetNetworkCredential().Password} | ConvertTo-Json -Compress";

function protectedSecret(path: string, env: NodeJS.ProcessEnv): Promise<LightsCredentials> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", SCRIPT],
      {
        env: { ...env, NOCTIS_LIGHTS_SECRET_PATH: path },
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 64 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error("protected login unavailable"));
          return;
        }
        try {
          const value: unknown = JSON.parse(stdout.replace(/^\uFEFF/, ""));
          if (
            typeof value !== "object" ||
            value === null ||
            !("username" in value) ||
            !("password" in value) ||
            typeof value.username !== "string" ||
            !value.username ||
            typeof value.password !== "string" ||
            !value.password
          )
            throw new Error("invalid credential");
          resolve({ username: value.username, password: value.password });
        } catch {
          reject(new Error("protected login unavailable"));
        }
      },
    );
  });
}

export function createSecretsReader(
  options: { env?: NodeJS.ProcessEnv; read?: SecretReader } = {},
) {
  const env = options.env ?? process.env;
  const read = options.read ?? ((path: string) => protectedSecret(path, env));
  const cache = new Map<string, Promise<LightsCredentials>>();
  return (
    brand: "tuya" | "tapo",
    config: Pick<LightsConfig, "secrets">,
  ): Promise<LightsCredentials> => {
    const path =
      config.secrets[brand] ??
      (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "noctis-secrets", `${brand}.xml`) : undefined);
    if (!path) return Promise.reject(new Error(`could not read protected ${brand} login`));
    let pending = cache.get(path);
    if (!pending) {
      pending = read(path).catch(() => {
        throw new Error(`could not read protected ${brand} login`);
      });
      cache.set(path, pending);
    }
    return pending;
  };
}

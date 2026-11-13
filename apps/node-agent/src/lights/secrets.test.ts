import type * as ChildProcess from "node:child_process";
import type { ExecFileOptions } from "node:child_process";

import { expect, it, vi } from "vitest";

const run = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: run }));

import { createSecretsReader } from "./secrets.js";

it.skipIf(process.platform !== "win32")(
  "emits Unicode login JSON in UTF-8 and carries an unusual path only in the environment",
  async () => {
    const actual = await vi.importActual<typeof ChildProcess>("node:child_process");
    const path = "C:/owner's $env-Noctis;.xml";
    run.mockImplementation(
      (
        command: string,
        args: string[],
        options: ExecFileOptions,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        expect(args.join(" ")).not.toContain(path);
        expect(options.env?.NOCTIS_LIGHTS_SECRET_PATH).toBe(path);
        // Only Import-Clixml is replaced: DPAPI is unavailable in the sandbox's impersonated profile.
        const fixture =
          "[Console]::OutputEncoding = [Text.Encoding]::ASCII; function Import-Clixml { param($LiteralPath); if ($LiteralPath -ne $env:NOCTIS_LIGHTS_SECRET_PATH) { throw 'wrong path' }; $p = ConvertTo-SecureString $env:NOCTIS_TEST_PASSWORD -AsPlainText -Force; return [System.Management.Automation.PSCredential]::new($env:NOCTIS_TEST_USERNAME, $p) }; ";
        return actual.execFile(
          command,
          [...args.slice(0, -1), fixture + args.at(-1)!],
          options,
          (error, stdout) => callback(error, stdout.toString()),
        );
      },
    );
    const reader = createSecretsReader({
      env: {
        ...process.env,
        NOCTIS_TEST_USERNAME: "müshaf@example.invalid",
        NOCTIS_TEST_PASSWORD: "synthetic-päss-灯",
      },
    });
    expect(await reader("tapo", { secrets: { tapo: path } })).toEqual({
      username: "müshaf@example.invalid",
      password: "synthetic-päss-灯",
    });
  },
);

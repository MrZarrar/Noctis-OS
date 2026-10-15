import { describe, expect, it } from "vitest";

import { ResetSettingCommandSchema, SetSettingCommandSchema } from "./command.js";

const set = (key: string, value: unknown) =>
  SetSettingCommandSchema.safeParse({ idempotencyKey: "settings-1", key, value }).success;

describe("a setting the owner sets", () => {
  it("takes a value of the setting's own kind", () => {
    expect(set("digestAt", "21:30")).toBe(true);
    expect(set("digestAt", "")).toBe(true);
    expect(set("vaultWrites", true)).toBe(true);
    expect(set("sessionTtlHours", 48)).toBe(true);
    expect(set("logLevel", "warn")).toBe(true);
    expect(
      set("remoteDesktops", [
        {
          host: "zarrarpc",
          gatewayUrl: "wss://zarrarpc.tail9594ed.ts.net/jet/rdp",
          destination: "zarrarpc.tail9594ed.ts.net:3389",
        },
      ]),
    ).toBe(true);
    expect(set("remoteDesktops", [])).toBe(true);
  });

  it.each([
    ["digestAt", "25:00"],
    ["digestAt", "noon"],
    ["vaultWrites", "true"],
    ["sessionTtlHours", 0],
    ["sessionTtlHours", 1.5],
    ["logLevel", "loud"],
    ["remoteDesktops", [{ host: "Not A Host", gatewayUrl: "https://x", destination: "x" }]],
    ["nonsense", 1],
  ])("refuses %s = %j", (key, value) => {
    expect(set(key, value)).toBe(false);
  });

  it("resets by key alone", () => {
    expect(
      ResetSettingCommandSchema.safeParse({ idempotencyKey: "settings-2", key: "logLevel" })
        .success,
    ).toBe(true);
  });
});

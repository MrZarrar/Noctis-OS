import { describe, expect, it } from "vitest";

import { API_SEGMENTS } from "./api.js";
import { EventNameSchema, StreamTypeSchema } from "./events.js";
import {
  OpenRemoteDesktopCommandSchema,
  RemoteDesktopSessionSchema,
  RemoteHostNameSchema,
} from "./remote.js";

describe("remote desktop contracts (ADR-0035)", () => {
  it("names a host, never an address the page chose", () => {
    expect(RemoteHostNameSchema.safeParse("zarrarpc").success).toBe(true);

    for (const address of ["zarrarpc:3389", "10.0.0.1", "evil.example", "", "Zarrarpc", "a b"]) {
      expect(RemoteHostNameSchema.safeParse(address).success, address).toBe(false);
    }
  });

  it("refuses a command that carries a password", () => {
    expect(
      OpenRemoteDesktopCommandSchema.safeParse({ idempotencyKey: "k", host: "zarrarpc" }).success,
    ).toBe(true);

    // The Windows credential goes page -> Gateway -> RDP and never to the core.
    // A strict schema turns a page that tried into a 400, not a silently
    // ignored field sitting in a request log.
    expect(
      OpenRemoteDesktopCommandSchema.safeParse({
        idempotencyKey: "k",
        host: "zarrarpc",
        password: "hunter2",
      }).success,
    ).toBe(false);
  });

  it("only hands out a Gateway reached over wss", () => {
    const session = {
      host: "zarrarpc",
      gatewayUrl: "wss://zarrarpc.tail9594ed.ts.net/jet/rdp",
      destination: "zarrarpc.tail9594ed.ts.net:3389",
      token: "a.b.c",
      associationId: "0190f5a0-0000-7000-8000-000000000000",
      expiresAt: "2026-09-22T22:02:00.000Z",
    };

    expect(RemoteDesktopSessionSchema.safeParse(session).success).toBe(true);
    expect(
      RemoteDesktopSessionSchema.safeParse({
        ...session,
        gatewayUrl: "ws://zarrarpc.tail9594ed.ts.net/jet/rdp",
      }).success,
    ).toBe(false);
  });

  it("is registered as a route, an event and a stream", () => {
    expect(API_SEGMENTS).toContain("remote");
    expect(EventNameSchema.safeParse("remote.session_opened.v1").success).toBe(true);
    expect(StreamTypeSchema.safeParse("remote").success).toBe(true);
  });
});

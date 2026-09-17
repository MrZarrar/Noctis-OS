import { describe, expect, it } from "vitest";

import { authorize, isAuthorized, isOriginAllowed } from "./auth.js";
import { hashSecret } from "./session.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("isAuthorized", () => {
  it("accepts the exact bearer token", () => {
    expect(isAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it.each([
    ["a missing header", undefined],
    ["an empty header", ""],
    ["the bare token", TOKEN],
    ["a lowercase scheme", `bearer ${TOKEN}`],
    ["basic auth", `Basic ${TOKEN}`],
    ["a prefix of the token", `Bearer ${TOKEN.slice(0, 20)}`],
    ["the token plus one character", `Bearer ${TOKEN}x`],
    ["a token differing in the last character", `Bearer ${TOKEN.slice(0, -1)}0`],
    ["a much longer value", `Bearer ${"x".repeat(4096)}`],
    ["Bearer with no value", "Bearer "],
  ])("rejects %s", (_label, header) => {
    expect(isAuthorized(header, TOKEN)).toBe(false);
  });
});

describe("isOriginAllowed", () => {
  it("allows a request with no Origin, which is not a browser", () => {
    expect(isOriginAllowed(undefined, [])).toBe(true);
  });

  it("rejects any browser origin when nothing is allowlisted", () => {
    expect(isOriginAllowed("https://evil.example", [])).toBe(false);
    expect(isOriginAllowed("http://localhost:5173", [])).toBe(false);
  });

  it.each([
    ["an opaque origin", "null"],
    ["a different scheme", "http://a.example"],
    ["a different port", "https://a.example:8443"],
    ["a subdomain", "https://sub.a.example"],
    ["a prefix match", "https://a.example.evil.test"],
  ])("rejects %s against an allowlist of https://a.example", (_label, origin) => {
    expect(isOriginAllowed(origin, ["https://a.example"])).toBe(false);
  });

  it("allows an exact allowlisted origin", () => {
    expect(isOriginAllowed("https://a.example", ["https://a.example"])).toBe(true);
  });
});

describe("authorize", () => {
  const token = "a".repeat(32);
  const session = { id: "sess-1", csrfHash: "hash-of-csrf" };
  const found = () => session;
  const none = () => undefined;

  it("accepts the bearer token without asking for a session", () => {
    expect(
      authorize({
        method: "POST",
        authorization: `Bearer ${token}`,
        cookie: undefined,
        csrfHeader: undefined,
        token,
        session: none,
      }),
    ).toEqual({ kind: "bearer" });
  });

  it("accepts a session on a read without a csrf header", () => {
    expect(
      authorize({
        method: "GET",
        authorization: undefined,
        cookie: "noctis_session=v",
        csrfHeader: undefined,
        token,
        session: found,
      }),
    ).toEqual({ kind: "session", id: "sess-1" });
  });

  it("refuses a session mutation with no csrf header", () => {
    expect(
      authorize({
        method: "POST",
        authorization: undefined,
        cookie: "noctis_session=v",
        csrfHeader: undefined,
        token,
        session: found,
      }),
    ).toEqual({ kind: "denied", reason: "csrf" });
  });

  it("refuses a session mutation whose csrf header does not match", () => {
    expect(
      authorize({
        method: "POST",
        authorization: undefined,
        cookie: "noctis_session=v",
        csrfHeader: "wrong",
        token,
        session: found,
      }),
    ).toEqual({ kind: "denied", reason: "csrf" });
  });

  it("accepts a session mutation whose csrf header hashes to the stored digest", () => {
    const csrf = "the-real-csrf";

    expect(
      authorize({
        method: "POST",
        authorization: undefined,
        cookie: "noctis_session=v",
        csrfHeader: csrf,
        token,
        session: () => ({ id: "sess-1", csrfHash: hashSecret(csrf) }),
      }),
    ).toEqual({ kind: "session", id: "sess-1" });
  });

  it("refuses when neither credential is presented", () => {
    expect(
      authorize({
        method: "GET",
        authorization: undefined,
        cookie: undefined,
        csrfHeader: undefined,
        token,
        session: none,
      }),
    ).toEqual({ kind: "denied", reason: "unauthorized" });
  });

  it("refuses a wrong bearer token even when a valid session exists, rather than silently downgrading", () => {
    expect(
      authorize({
        method: "GET",
        authorization: "Bearer wrong",
        cookie: "noctis_session=v",
        csrfHeader: undefined,
        token,
        session: found,
      }),
    ).toEqual({ kind: "denied", reason: "unauthorized" });
  });
});

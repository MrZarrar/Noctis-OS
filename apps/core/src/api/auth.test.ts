import { describe, expect, it } from "vitest";

import { isAuthorized, isOriginAllowed } from "./auth.js";

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

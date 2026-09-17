import { describe, expect, it } from "vitest";

import { parseCookies, serializeCookie } from "./cookie.js";

describe("parseCookies", () => {
  it("reads a single pair", () => {
    expect(parseCookies("noctis_session=abc")).toEqual(new Map([["noctis_session", "abc"]]));
  });

  it("reads several pairs and trims the separator space", () => {
    expect(parseCookies("a=1; b=2")).toEqual(
      new Map([
        ["a", "1"],
        ["b", "2"],
      ]),
    );
  });

  it("keeps a value containing an equals sign intact", () => {
    expect(parseCookies("t=a=b=c").get("t")).toBe("a=b=c");
  });

  it("is empty for an absent or malformed header", () => {
    expect(parseCookies(undefined).size).toBe(0);
    expect(parseCookies("").size).toBe(0);
    expect(parseCookies("novalue").size).toBe(0);
  });

  it("drops a duplicated name entirely, because neither occurrence can be trusted", () => {
    // A cookie planted at a longer Path arrives first, so first-wins would hand
    // over the forgery and last-wins would lose to a shorter path.
    expect(parseCookies("s=forged; s=real").has("s")).toBe(false);
    expect(parseCookies("s=real; s=forged").has("s")).toBe(false);
    expect(parseCookies("s=a; s=b; s=c").has("s")).toBe(false);
  });

  it("keeps the other cookies when one name is duplicated", () => {
    const parsed = parseCookies("a=1; s=real; s=forged; b=2");

    expect(parsed.has("s")).toBe(false);
    expect(parsed.get("a")).toBe("1");
    expect(parsed.get("b")).toBe("2");
  });
});

describe("serializeCookie", () => {
  it("writes the attributes a session cookie needs", () => {
    expect(
      serializeCookie("noctis_session", "v", {
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
        path: "/",
        maxAgeSeconds: 60,
      }),
    ).toBe("noctis_session=v; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Strict");
  });

  it("writes Max-Age=0 for a cleared cookie rather than omitting it", () => {
    expect(
      serializeCookie("noctis_session", "", {
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
        path: "/",
        maxAgeSeconds: 0,
      }),
    ).toBe("noctis_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict");
  });
});

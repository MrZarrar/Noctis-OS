import { describe, expect, it } from "vitest";

import { fetchLatestReading, mgdlToMmol, trendArrow } from "./dexcom.js";

describe("mgdlToMmol", () => {
  it("converts and rounds to 1dp", () => {
    expect(mgdlToMmol(100)).toBeCloseTo(5.6, 1);
    expect(mgdlToMmol(70)).toBeCloseTo(3.9, 1);
    expect(mgdlToMmol(180)).toBeCloseTo(10.0, 1);
  });
});

describe("trendArrow", () => {
  it("maps every Dexcom trend code to an arrow", () => {
    expect(trendArrow("DoubleUp")).toBe("doubleUp");
    expect(trendArrow("SingleUp")).toBe("singleUp");
    expect(trendArrow("FortyFiveUp")).toBe("fortyFiveUp");
    expect(trendArrow("Flat")).toBe("flat");
    expect(trendArrow("FortyFiveDown")).toBe("fortyFiveDown");
    expect(trendArrow("SingleDown")).toBe("singleDown");
    expect(trendArrow("DoubleDown")).toBe("doubleDown");
    expect(trendArrow("NotComputable")).toBe("unknown");
    expect(trendArrow("RateOutOfRange")).toBe("unknown");
    expect(trendArrow("anything else")).toBe("unknown");
  });
});

describe("fetchLatestReading", () => {
  it("logs in then reads the latest glucose value", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchStub = (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (url.includes("LoginPublisherAccountById")) {
        return Promise.resolve(new Response(JSON.stringify("session-123"), { status: 200 }));
      }
      if (url.includes("ReadPublisherLatestGlucoseValues")) {
        return Promise.resolve(
          new Response(
            JSON.stringify([{ Value: 126, Trend: "Flat", WT: "/Date(1760000000000)/" }]),
            { status: 200 },
          ),
        );
      }
      throw new Error(`unexpected url ${url}`);
    };

    const reading = await fetchLatestReading(fetchStub, { username: "u", password: "p" });

    expect(reading).toEqual({ mmol: 7, trend: "flat", at: new Date(1760000000000).toISOString() });
    expect(calls[0]!.url).toContain("shareous1.dexcom.com");
    expect(calls[0]!.body).toMatchObject({ accountName: "u", password: "p" });
    expect(calls[1]!.url).toContain("sessionID=session-123");
  });

  it("throws when Dexcom returns no reading", async () => {
    const fetchStub = (url: string) =>
      Promise.resolve(
        url.includes("LoginPublisherAccountById")
          ? new Response(JSON.stringify("session-123"), { status: 200 })
          : new Response(JSON.stringify([]), { status: 200 }),
      );

    await expect(fetchLatestReading(fetchStub, { username: "u", password: "p" })).rejects.toThrow(
      "no reading",
    );
  });

  it("throws with Dexcom's own message on a login failure", async () => {
    const fetchStub = (url: string) => {
      if (url.includes("LoginPublisherAccountById")) {
        return Promise.resolve(
          new Response(JSON.stringify({ Message: "Password not valid." }), { status: 500 }),
        );
      }
      throw new Error(`unexpected url ${url}`);
    };

    await expect(fetchLatestReading(fetchStub, { username: "u", password: "p" })).rejects.toThrow(
      "Password not valid.",
    );
  });
});

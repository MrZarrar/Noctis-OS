import type { GlucoseTrend } from "@noctis/contracts";

/**
 * Dexcom Share (the Follow API), read-only. There is no public OAuth app for
 * this; every third-party Share client, open-source or not, logs in with the
 * mobile app's own applicationId, so that is what we send too.
 */
const BASE = "https://shareous1.dexcom.com/ShareWebServices/Services";
const APPLICATION_ID = "d89443d2-327c-4a6f-89e5-496bbb0317db";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface DexcomLogin {
  username: string;
  password: string;
}

export interface DexcomReading {
  mmol: number;
  trend: GlucoseTrend;
  at: string;
}

export function mgdlToMmol(valueMgdl: number): number {
  return Math.round((valueMgdl / 18.018) * 10) / 10;
}

const TRENDS: Record<string, GlucoseTrend> = {
  DoubleUp: "doubleUp",
  SingleUp: "singleUp",
  FortyFiveUp: "fortyFiveUp",
  Flat: "flat",
  FortyFiveDown: "fortyFiveDown",
  SingleDown: "singleDown",
  DoubleDown: "doubleDown",
};

export function trendArrow(code: string): GlucoseTrend {
  return TRENDS[code] ?? "unknown";
}

async function dexcomMessage(response: Response): Promise<string> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as { Message?: string };
    return parsed.Message ?? `Dexcom Share returned ${response.status}`;
  } catch {
    return `Dexcom Share returned ${response.status}`;
  }
}

async function login(fetchImpl: FetchLike, credentials: DexcomLogin): Promise<string> {
  const response = await fetchImpl(`${BASE}/General/LoginPublisherAccountById`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accountName: credentials.username,
      password: credentials.password,
      applicationId: APPLICATION_ID,
    }),
  });
  if (!response.ok) throw new Error(await dexcomMessage(response));
  const sessionId = (await response.json()) as string;
  if (sessionId === "" || sessionId === "00000000-0000-0000-0000-000000000000")
    throw new Error("Dexcom Share did not return a session");
  return sessionId;
}

/** `/Date(1700000000000)/`, Dexcom's .NET-ism for epoch milliseconds. */
function parseWt(wt: string): string {
  const ms = Number(/\d+/.exec(wt)?.[0] ?? NaN);
  return new Date(ms).toISOString();
}

export async function fetchLatestReading(
  fetchImpl: FetchLike,
  credentials: DexcomLogin,
): Promise<DexcomReading> {
  const sessionId = await login(fetchImpl, credentials);
  const response = await fetchImpl(
    `${BASE}/Publisher/ReadPublisherLatestGlucoseValues?sessionID=${sessionId}&minutes=10&maxCount=1`,
    { method: "POST", headers: { "content-type": "application/json" } },
  );
  if (!response.ok) throw new Error(await dexcomMessage(response));
  const readings = (await response.json()) as Array<{ Value: number; Trend: string; WT: string }>;
  const latest = readings[0];
  if (latest === undefined) throw new Error("Dexcom Share has no reading in the last 10 minutes");
  return { mmol: mgdlToMmol(latest.Value), trend: trendArrow(latest.Trend), at: parseWt(latest.WT) };
}

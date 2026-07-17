// Shared OHLCV loading logic used by BOTH /api/ohlcv and /api/analysis so the
// two routes never diverge on param parsing, KR suffix resolution, caching, or
// TTL policy. Yahoo serves both markets; KR bare 6-digit codes try .KS then .KQ.

import { cached, TTL, todayIso } from "@/lib/cache";
import { fetchYahooOhlcv, isBrokenName } from "@/lib/sources/yahoo";
import { resolveKoreanName } from "@/lib/sources/naver";
import type { Market, OhlcvResponse } from "@/lib/schema";

const PERIOD_DAYS: Record<string, number> = {
  "1mo": 31,
  "3mo": 92,
  "6mo": 183,
  "1y": 366,
  "2y": 731,
  "5y": 1827,
  "10y": 3653,
};

function isoNDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export interface OhlcvParams {
  symbol: string;
  market: Market;
  interval: string;
  period1: string;
  period2: string;
}

export type ParseResult =
  | { ok: true; params: OhlcvParams }
  | { ok: false; message: string };

/** Validate & normalize query params shared by the OHLCV and analysis routes. */
export function parseOhlcvParams(p: URLSearchParams): ParseResult {
  const symbol = p.get("symbol")?.trim() ?? "";
  const market = p.get("market")?.trim().toUpperCase() as Market | "";
  const interval = p.get("interval")?.trim() || "1d";
  const period = p.get("period")?.trim() || "1y";
  const from = p.get("from")?.trim();
  const to = p.get("to")?.trim();

  if (!symbol) return { ok: false, message: "query parameter `symbol` is required" };
  if (market !== "KR" && market !== "US") {
    return { ok: false, message: "query parameter `market` must be `KR` or `US`" };
  }
  const period2 = to ?? todayIso();
  const period1 = from ?? isoNDaysAgo(PERIOD_DAYS[period] ?? PERIOD_DAYS["1y"]);
  if (period1 >= period2) return { ok: false, message: "`from` must be earlier than `to`" };

  return { ok: true, params: { symbol, market, interval, period1, period2 } };
}

/**
 * For KR, ensure a Yahoo board suffix; for a bare 6-digit code try KOSPI (.KS)
 * then KOSDAQ (.KQ). A KOSDAQ code queried on .KS returns valid candles but a
 * broken alias `name`, so prefer whichever board returns a properly-named hit.
 * (Mirrors the logic in the ohlcv route, which is owned by stock-data-agent.)
 * Yahoo's `name` is English (e.g. "Samsung Electronics Co., Ltd.") — KR stocks
 * always display in Korean, so it's overridden with Naver's Hangul name
 * whenever Naver has a match (falls back to Yahoo's name otherwise).
 */
async function withKoreanName(res: OhlcvResponse | null, symbol: string): Promise<OhlcvResponse | null> {
  if (!res) return res;
  const koreanName = await resolveKoreanName(symbol);
  return koreanName ? { ...res, name: koreanName } : res;
}

async function fetchKrWithSuffix(
  symbol: string,
  range: { period1: string; period2: string; interval: string },
): Promise<OhlcvResponse | null> {
  if (/\.(KS|KQ)$/i.test(symbol)) return withKoreanName(await fetchYahooOhlcv(symbol, "KR", range), symbol);
  if (/^\d{6}$/.test(symbol)) {
    const ks = await fetchYahooOhlcv(`${symbol}.KS`, "KR", range);
    if (ks && !isBrokenName(ks.name)) return withKoreanName(ks, symbol);
    const kq = await fetchYahooOhlcv(`${symbol}.KQ`, "KR", range);
    if (kq && !isBrokenName(kq.name)) return withKoreanName(kq, symbol);
    return withKoreanName(ks ?? kq, symbol);
  }
  return fetchYahooOhlcv(symbol, "KR", range);
}

/**
 * Load normalized OHLCV (cached). Returns null when the symbol yields no data
 * (caller maps to NOT_FOUND). Throws on upstream failure (caller maps to
 * NOT_FOUND for delisted/unknown, else SOURCE_ERROR).
 */
export async function loadOhlcv(params: OhlcvParams): Promise<OhlcvResponse | null> {
  const { symbol, market, interval, period1, period2 } = params;
  const range = { period1, period2, interval };
  const includesToday = period2 >= todayIso();
  const ttl = includesToday ? TTL.INTRADAY : TTL.HISTORICAL;
  const key = `ohlcv:${market}:${symbol}:${period1}:${period2}:${interval}`;
  return cached(key, ttl, () =>
    market === "KR"
      ? fetchKrWithSuffix(symbol, range)
      : fetchYahooOhlcv(symbol, "US", range),
  );
}

/** True when an upstream error means "no such symbol" rather than an outage. */
export function isNotFoundError(msg: string): boolean {
  return /no data found|may be delisted|not found/i.test(msg);
}

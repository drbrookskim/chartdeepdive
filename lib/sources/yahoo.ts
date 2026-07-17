// Yahoo Finance adapter (yahoo-finance2 v4). Serves OHLCV for BOTH markets:
//   - US: symbol as-is (e.g. "AAPL")
//   - KR: Korea Exchange tickers via suffix — ".KS" = KOSPI, ".KQ" = KOSDAQ
//         (e.g. "005930.KS"), quoted in KRW.
// Also provides ticker/English-name search. It CANNOT search Hangul queries
// (Yahoo returns "Invalid Search Query"); Korean-name search lives in naver.ts.
//
// Field mapping (Yahoo chart quote -> common Candle), verified against a live
// response and documented in _workspace/01_stock-data-agent_api-spec.md:
//   date(Date, UTC)->date(local YYYY-MM-DD)  open->open  high->high
//   low->low  close->close  volume->volume  adjclose->adjclose
//   meta.currency->currency  meta.fullExchangeName->exchange label

import YahooFinance from "yahoo-finance2";
import type { Candle, Market, OhlcvResponse, SearchResult } from "../schema";
import { retryOnce } from "../retry";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });

/** Classify a Yahoo symbol into our two supported markets, or null if neither. */
export function marketOfYahooSymbol(symbol: string): Market | null {
  const s = symbol.toUpperCase();
  if (s.endsWith(".KS") || s.endsWith(".KQ")) return "KR";
  // Bare US listings carry no suffix. Any other exchange suffix is unsupported.
  if (!s.includes(".")) return "US";
  return null;
}

const KR_EXCHANGE_LABEL: Record<string, string> = {
  KSC: "KOSPI",
  KOE: "KOSDAQ",
};

function exchangeLabel(fullExchangeName?: string, exchange?: string): string | null {
  if (fullExchangeName) return fullExchangeName;
  if (exchange && KR_EXCHANGE_LABEL[exchange]) return KR_EXCHANGE_LABEL[exchange];
  return exchange ?? null;
}

const INTRADAY_INTERVALS = new Set(["1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h"]);

/**
 * Yahoo returns bar timestamps in UTC. For daily-or-coarser bars we convert
 * to the market-local trading day (one bar per calendar day is unambiguous
 * as a plain date). Intraday bars need the time-of-day too — otherwise every
 * bar in a day collapses onto the same date string and the chart library
 * (which requires unique, ascending `time` values) breaks — so those keep a
 * full UTC ISO timestamp instead.
 */
function toLocalIsoDate(date: Date, market: Market, interval: string): string {
  if (INTRADAY_INTERVALS.has(interval)) return date.toISOString();
  // KRW bars are stamped at UTC midnight of the KR trading day already; US bars
  // at 13:30Z (market open). Shifting to the exchange timezone yields the right
  // calendar date for both.
  const tz = market === "KR" ? "Asia/Seoul" : "America/New_York";
  // en-CA gives YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(date);
}

/**
 * Detect Yahoo's broken "alias" name returned for some KOSDAQ tickers when
 * queried on the wrong board (.KS). Example: "247540.KS,0P0001GZPV,623889".
 * A real company name never embeds its own exchange symbol or a comma-separated
 * list of all-caps identifier codes.
 */
export function isBrokenName(name: string | null): boolean {
  if (!name) return true;
  if (/\.K[SQ]\b/i.test(name)) return true; // embeds an exchange symbol
  if (/,\s*[0-9A-Z]{5,}/.test(name)) return true; // comma-separated ID codes
  return false;
}

export interface OhlcvRange {
  period1: string; // inclusive start, YYYY-MM-DD
  period2: string; // exclusive-ish end, YYYY-MM-DD (Yahoo convention)
  interval: string; // e.g. "1d"
}

/**
 * Fetch and normalize OHLCV. Returns null when the symbol yields no data
 * (caller maps that to NOT_FOUND). Throws on upstream/transport failure.
 */
export async function fetchYahooOhlcv(
  symbol: string,
  market: Market,
  range: OhlcvRange,
): Promise<OhlcvResponse | null> {
  const chart = await retryOnce(() =>
    yf.chart(symbol, {
      period1: range.period1,
      period2: range.period2,
      interval: range.interval as "1d",
    }),
  );

  const rows = chart.quotes ?? [];
  if (rows.length === 0) return null;

  const candles: Candle[] = rows
    .filter((q) => q.date && q.open != null && q.close != null)
    .map((q) => ({
      date: toLocalIsoDate(new Date(q.date as unknown as string), market, range.interval),
      open: q.open as number,
      high: q.high as number,
      low: q.low as number,
      close: q.close as number,
      volume: (q.volume ?? 0) as number,
      adjclose: (q.adjclose ?? null) as number | null,
    }));

  if (candles.length === 0) return null;

  const meta = chart.meta;
  const rawName = (meta?.longName || meta?.shortName || null) as string | null;
  return {
    symbol,
    market,
    currency: meta?.currency ?? (market === "KR" ? "KRW" : "USD"),
    source: "yahoo-finance2",
    interval: range.interval,
    name: isBrokenName(rawName) ? null : rawName,
    candles,
  };
}

/**
 * Search tickers / English names via Yahoo. Returns only EQUITY hits on our two
 * supported markets. Never throws for a "no results" case; on Yahoo's Hangul
 * rejection it throws and the route falls back to Naver-only results.
 */
export async function searchYahoo(query: string): Promise<SearchResult[]> {
  const res = await yf.search(query, { quotesCount: 15, newsCount: 0 });
  const out: SearchResult[] = [];
  for (const q of res.quotes ?? []) {
    const sym = (q as { symbol?: string }).symbol;
    const type = (q as { quoteType?: string }).quoteType;
    if (!sym || type !== "EQUITY") continue;
    const market = marketOfYahooSymbol(sym);
    if (!market) continue; // skip non-KR/US listings
    const item = q as {
      symbol: string;
      shortname?: string;
      longname?: string;
      exchDisp?: string;
    };
    out.push({
      symbol: sym,
      name: item.longname || item.shortname || sym,
      market,
      exchange: exchangeLabel(undefined, item.exchDisp) ?? item.exchDisp ?? null,
    });
  }
  return out;
}

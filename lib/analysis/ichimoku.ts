// Ichimoku Kinko Hyo — five-line system (ported from the `ichimoku` skill spec).
// Tenkan (9), Kijun (26), Senkou A/B (shifted +26), Chikou (shifted -26).
// Warm-up needs 52+26 = 78 candles. Series are aligned to the candles array;
// forward-shifted spans extend `displacement` bars past the last candle, so
// leadingSpanA/B carry `projectedDates` for those future plot positions.

import type { Candle } from "@/lib/schema";

export interface IchimokuResult {
  tenkanPeriod: number;
  kijunPeriod: number;
  senkouBPeriod: number;
  displacement: number;
  /** Aligned to candles (null during warm-up). */
  tenkan: (number | null)[];
  kijun: (number | null)[];
  /** Chikou = close shifted back `displacement` bars; last bars are null. */
  chikou: (number | null)[];
  /**
   * Leading spans are shifted FORWARD by `displacement`. Length =
   * candles.length + displacement. Indices [candles.length ..) map to
   * `projectedDates` (future plot slots with no candle yet).
   */
  leadingSpanA: (number | null)[];
  leadingSpanB: (number | null)[];
  projectedDates: string[];
  /** 1 = strong buy, -1 = strong sell, 0 = stand aside, at the last candle. */
  signal: 1 | -1 | 0;
  /** Signal's 3 components at the last candle, for transparency (null during warm-up). */
  checks: {
    tkCross: "bull" | "bear" | "none";
    priceVsCloud: "above" | "below" | "inside";
    cloudColor: "bullish" | "bearish";
  } | null;
}

const round = (v: number, dp = 4): number => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

/** Midpoint of the highest high and lowest low over the trailing `period`. */
function donchianMid(candles: Candle[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    out[i] = round((hi + lo) / 2);
  }
  return out;
}

/** Advance business-day-agnostic dates for the projected (future) cloud slots. */
function projectDates(lastDate: string, count: number): string[] {
  const dates: string[] = [];
  const d = new Date(lastDate + "T00:00:00Z");
  for (let i = 0; i < count; i++) {
    // Simple calendar-day step; skip weekends to approximate trading days.
    do {
      d.setUTCDate(d.getUTCDate() + 1);
    } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

export function ichimoku(
  candles: Candle[],
  tenkanPeriod = 9,
  kijunPeriod = 26,
  senkouBPeriod = 52,
  displacement = 26,
): IchimokuResult {
  const n = candles.length;
  const tenkan = donchianMid(candles, tenkanPeriod);
  const kijun = donchianMid(candles, kijunPeriod);
  const senkouBRaw = donchianMid(candles, senkouBPeriod);

  // Chikou: close shifted BACKWARD by displacement.
  const chikou: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const src = i + displacement;
    if (src < n) chikou[i] = candles[src].close;
  }

  // Leading spans shifted FORWARD by displacement -> extended array.
  const extLen = n + displacement;
  const leadingSpanA: (number | null)[] = new Array(extLen).fill(null);
  const leadingSpanB: (number | null)[] = new Array(extLen).fill(null);
  for (let i = 0; i < n; i++) {
    const target = i + displacement;
    if (tenkan[i] !== null && kijun[i] !== null) {
      leadingSpanA[target] = round(((tenkan[i] as number) + (kijun[i] as number)) / 2);
    }
    if (senkouBRaw[i] !== null) leadingSpanB[target] = senkouBRaw[i];
  }
  const projectedDates = n > 0 ? projectDates(candles[n - 1].date, displacement) : [];

  // Signal at the last candle: TK cross + cloud position + cloud color.
  let signal: 1 | -1 | 0 = 0;
  let checks: IchimokuResult["checks"] = null;
  if (n >= 2) {
    const i = n - 1;
    const tPrev = tenkan[i - 1];
    const kPrev = kijun[i - 1];
    const tNow = tenkan[i];
    const kNow = kijun[i];
    // Current cloud boundaries sit at index i of the extended spans.
    const spanA = leadingSpanA[i];
    const spanB = leadingSpanB[i];
    if (
      tPrev !== null && kPrev !== null && tNow !== null && kNow !== null &&
      spanA !== null && spanB !== null
    ) {
      const bullCross = tPrev <= kPrev && tNow > kNow;
      const bearCross = tPrev >= kPrev && tNow < kNow;
      const price = candles[i].close;
      const cloudTop = Math.max(spanA, spanB);
      const cloudBot = Math.min(spanA, spanB);
      if (bullCross && price > cloudTop && spanA > spanB) signal = 1;
      else if (bearCross && price < cloudBot && spanA < spanB) signal = -1;
      checks = {
        tkCross: bullCross ? "bull" : bearCross ? "bear" : "none",
        priceVsCloud: price > cloudTop ? "above" : price < cloudBot ? "below" : "inside",
        cloudColor: spanA >= spanB ? "bullish" : "bearish",
      };
    }
  }

  return {
    tenkanPeriod,
    kijunPeriod,
    senkouBPeriod,
    displacement,
    tenkan,
    kijun,
    chikou,
    leadingSpanA,
    leadingSpanB,
    projectedDates,
    signal,
    checks,
  };
}

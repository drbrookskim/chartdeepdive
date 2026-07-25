// Smart Money Concepts — market structure via BOS (Break of Structure) and
// ChoCH (Change of Character), per the `smc` skill spec. Deterministic,
// swing-based: a bar CLOSING beyond the most recent swing high/low breaks
// structure. Whether that break is a BOS (continuation) or a ChoCH (reversal)
// depends on the trend in force at the moment of the break — same direction
// as trend = BOS, opposite = ChoCH.
//
// Built specifically to confirm-or-reject `inflection-point-predictor`
// reversal calls (see ipp-chain.ts) — this module only answers "did
// structure actually break", never "should you trade this".

import type { Candle } from "@/lib/schema";

export interface SmcEvent {
  type: "BOS" | "ChoCH";
  direction: "up" | "down";
  date: string;
  price: number;
  /** The swing point this event broke. */
  brokenLevel: { date: string; price: number };
}

export interface SmcResult {
  /** Most recent structural event as of the end of the series, or null. */
  event: SmcEvent | null;
  /** Trend in force after `event` (or at series end if event is null). */
  trend: "up" | "down" | "range";
  reason: string | null;
}

interface Swing {
  index: number;
  date: string;
  price: number;
  type: "high" | "low";
}

/** Same swing-collapsing approach as elliott.ts's swings(). */
function swings(candles: Candle[], window: number): Swing[] {
  const raw: Swing[] = [];
  for (let i = window; i < candles.length - window; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) raw.push({ index: i, date: candles[i].date, price: candles[i].high, type: "high" });
    else if (isLow) raw.push({ index: i, date: candles[i].date, price: candles[i].low, type: "low" });
  }
  const cleaned: Swing[] = [];
  for (const s of raw) {
    const last = cleaned[cleaned.length - 1];
    if (last && last.type === s.type) {
      const keepNew = s.type === "high" ? s.price > last.price : s.price < last.price;
      if (keepNew) cleaned[cleaned.length - 1] = s;
    } else {
      cleaned.push(s);
    }
  }
  return cleaned;
}

export function smc(candles: Candle[], window = 5): SmcResult {
  const sw = swings(candles, window);
  if (sw.length < 2) {
    return {
      event: null,
      trend: "range",
      reason: `구조 판단에 필요한 전환점(swing)이 최소 2개 필요하나 ${sw.length}개만 발견됨`,
    };
  }

  let trend: "up" | "down" | "range" = "range";
  let refHigh: Swing | null = null;
  let refLow: Swing | null = null;
  let lastEvent: SmcEvent | null = null;
  let swIdx = 0;

  for (let i = 0; i < candles.length; i++) {
    // Bring in swings confirmed as of this bar (same centered-window
    // convention findPivots/elliott's swings() already use elsewhere).
    while (swIdx < sw.length && sw[swIdx].index === i) {
      const s = sw[swIdx];
      if (s.type === "high") refHigh = s;
      else refLow = s;
      swIdx++;
    }
    if (!refHigh || !refLow) continue;

    const close = candles[i].close;
    if (close > refHigh.price) {
      const isChoCH = trend === "down";
      lastEvent = {
        type: isChoCH ? "ChoCH" : "BOS",
        direction: "up",
        date: candles[i].date,
        price: close,
        brokenLevel: { date: refHigh.date, price: refHigh.price },
      };
      trend = "up";
      refHigh = null; // broken — wait for the next swing high to reference
    } else if (close < refLow.price) {
      const isChoCH = trend === "up";
      lastEvent = {
        type: isChoCH ? "ChoCH" : "BOS",
        direction: "down",
        date: candles[i].date,
        price: close,
        brokenLevel: { date: refLow.date, price: refLow.price },
      };
      trend = "down";
      refLow = null;
    }
  }

  if (!lastEvent) {
    return {
      event: null,
      trend,
      reason: "확인된 구조 이벤트(BOS/ChoCH) 없음 — 스윙 구간 내 뚜렷한 종가 돌파가 없었음",
    };
  }

  return { event: lastEvent, trend, reason: null };
}

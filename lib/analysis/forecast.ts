// Hypothetical N-day continuation scenario — NOT a prediction. Deterministic
// toy rule requested explicitly: find the most recent 장대양봉/장대음봉 (a
// candle whose body is unusually large vs recent bars) and use ITS body
// midpoint (open+close)/2 as the fixed 50% support/resistance reference —
// staying on that candle's side reads as continuation, breaking through it
// reads as trend reversal. Purely illustrative — see `ForecastResult.note`,
// which the UI must surface verbatim next to the drawing.

import type { Candle } from "@/lib/schema";

export interface ForecastResult {
  candles: Candle[];
  /** The 장대양봉/장대음봉 this scenario anchors off of. */
  anchor: Candle;
  note: string;
}

function nextTradingDate(lastDate: string): string {
  const d = new Date(lastDate + "T00:00:00Z");
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

function bodyMid(c: Candle): number {
  return (c.open + c.close) / 2;
}

const LOOKBACK = 20;
/** A candle counts as 장대(long-bodied) once its body is this many times
 * the recent average body size. */
const BIG_BODY_MULT = 1.5;

/** Most recent candle whose body stands out from its neighbors — scans
 * backward from the last bar; falls back to the last bar itself if nothing
 * in the lookback window qualifies (e.g. a very flat, choppy stretch). */
function findAnchorCandle(candles: Candle[]): Candle {
  const window = candles.slice(-LOOKBACK);
  const avgBody = window.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / window.length;
  for (let i = window.length - 1; i >= 0; i--) {
    if (Math.abs(window[i].close - window[i].open) > avgBody * BIG_BODY_MULT) return window[i];
  }
  return candles[candles.length - 1];
}

export function forecastCandles(candles: Candle[], days = 5): ForecastResult | null {
  if (candles.length < 6) return null;

  const last = candles[candles.length - 1];
  const anchor = findAnchorCandle(candles);
  const refLevel = bodyMid(anchor);
  let bias: "up" | "down" = anchor.close >= anchor.open ? "up" : "down";

  // Typical daily body size over the recent window — sizes the synthetic
  // candles so they look like this stock's actual daily moves, not an
  // arbitrary fixed step.
  const recent = candles.slice(-10);
  const avgBody = recent.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / recent.length || last.close * 0.005;

  const out: Candle[] = [];
  let prev = last;
  for (let i = 0; i < days; i++) {
    const open = prev.close;
    const close = bias === "up" ? open + avgBody * 0.6 : open - avgBody * 0.6;
    const high = Math.max(open, close) + avgBody * 0.2;
    const low = Math.min(open, close) - avgBody * 0.2;
    const date = nextTradingDate(prev.date);
    const candle: Candle = { date, open, high, low, close, volume: prev.volume, adjclose: null };
    out.push(candle);

    // Re-check the SAME anchor candle's 50% line for the next step (not a
    // rolling comparison against whichever bar came right before it).
    bias = bias === "up" ? (low > refLevel ? "up" : "down") : high < refLevel ? "down" : "up";
    prev = candle;
  }

  return {
    candles: out,
    anchor,
    note:
      `가상 시나리오입니다 — 실제 예측이 아닙니다. ${anchor.date}의 ` +
      `${anchor.close >= anchor.open ? "장대양봉" : "장대음봉"}(직전 구간에서 가장 몸통이 큰 캔들) 몸통 ` +
      "50% 지점을 지지/저항으로 보고, 이를 지키면 추세 지속, 깨면 추세 전환으로 가정해 " +
      `기계적으로 이어그린 ${days}거래일치 캔들일 뿐입니다.`,
  };
}

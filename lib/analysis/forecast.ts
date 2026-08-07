// Hypothetical N-day continuation scenario — NOT a prediction. Deterministic
// toy rule requested explicitly: extend the last real candle using the
// "50% rule" the user described — a candle's low breaking below the PRIOR
// candle's body midpoint (open+close)/2 reads as trend-breaking (flip to
// bearish); staying above it reads as continuation (stay/flip bullish),
// mirrored for downtrends. Purely illustrative — see `ForecastResult.note`,
// which the UI must surface verbatim next to the drawing.

import type { Candle } from "@/lib/schema";

export interface ForecastResult {
  candles: Candle[];
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

export function forecastCandles(candles: Candle[], days = 3): ForecastResult | null {
  if (candles.length < 6) return null;

  const last = candles[candles.length - 1];
  const prevOfLast = candles[candles.length - 2];
  let bias: "up" | "down" = last.low > bodyMid(prevOfLast) ? "up" : "down";

  // Typical daily body size over the recent window — sizes the synthetic
  // candles so they look like this stock's actual daily moves, not an
  // arbitrary fixed step.
  const recent = candles.slice(-10);
  const avgBody = recent.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / recent.length || last.close * 0.005;

  const out: Candle[] = [];
  let prev = last;
  for (let i = 0; i < days; i++) {
    const midOfPrev = bodyMid(prev);
    const open = prev.close;
    const close = bias === "up" ? open + avgBody * 0.6 : open - avgBody * 0.6;
    const high = Math.max(open, close) + avgBody * 0.2;
    const low = Math.min(open, close) - avgBody * 0.2;
    const date = nextTradingDate(prev.date);
    const candle: Candle = { date, open, high, low, close, volume: prev.volume, adjclose: null };
    out.push(candle);

    // Re-apply the same 50% rule against THIS candle for the next step.
    bias = bias === "up" ? (low > midOfPrev ? "up" : "down") : high < midOfPrev ? "down" : "up";
    prev = candle;
  }

  return {
    candles: out,
    note:
      "가상 시나리오입니다 — 실제 예측이 아닙니다. 직전 캔들 몸통의 50% 지점을 " +
      "지지/저항으로 보고, 이를 지키면 추세 지속, 깨면 추세 전환으로 가정해 " +
      "기계적으로 이어그린 3거래일치 캔들일 뿐입니다.",
  };
}

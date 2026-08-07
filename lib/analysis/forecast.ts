// Hypothetical N-day continuation scenario — NOT a prediction. The user
// draws ONE candle by hand (its body's open/close come straight from their
// drag); this module just continues from it. Deterministic toy rule:
// the drawn candle's body midpoint (open+close)/2 is treated as a fixed
// support/resistance line — staying on that candle's side reads as
// continuation, breaking through it reads as trend reversal. Purely
// illustrative — see `ForecastResult.note`, which the UI must surface
// verbatim next to the drawing.

import type { Candle } from "@/lib/schema";

export interface ForecastResult {
  /** Full scenario, in order — candles[0] is the user-drawn anchor. */
  candles: Candle[];
  anchor: Candle;
  note: string;
}

export function nextTradingDate(lastDate: string): string {
  const d = new Date(lastDate + "T00:00:00Z");
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

function bodyMid(c: Candle): number {
  return (c.open + c.close) / 2;
}

/** Typical daily body size over the recent real candles — sizes the
 * auto-continued candles so they look like this stock's actual daily
 * moves, not an arbitrary fixed step. */
export function typicalBodySize(candles: Candle[]): number {
  const recent = candles.slice(-10);
  if (!recent.length) return 0;
  const avg = recent.reduce((s, c) => s + Math.abs(c.close - c.open), 0) / recent.length;
  return avg || recent[recent.length - 1].close * 0.005;
}

/** Continues `days` more candles after `prev`, re-checking `refLevel` (a
 * fixed price, not recomputed per step) each time to decide whether the
 * scenario keeps going the same way or flips. */
function continueScenario(
  refLevel: number,
  initialBias: "up" | "down",
  prev: Candle,
  avgBody: number,
  days: number,
): Candle[] {
  let bias = initialBias;
  const out: Candle[] = [];
  for (let i = 0; i < days; i++) {
    const open = prev.close;
    const close = bias === "up" ? open + avgBody * 0.6 : open - avgBody * 0.6;
    const high = Math.max(open, close) + avgBody * 0.2;
    const low = Math.min(open, close) - avgBody * 0.2;
    const date = nextTradingDate(prev.date);
    const candle: Candle = { date, open, high, low, close, volume: prev.volume, adjclose: null };
    out.push(candle);
    bias = bias === "up" ? (low > refLevel ? "up" : "down") : high < refLevel ? "down" : "up";
    prev = candle;
  }
  return out;
}

/** User draws the first candle by hand (drag = open/close, small padding =
 * high/low); this auto-continues `moreDays` more after it using the SAME
 * 50%-of-the-drawn-candle rule the old auto-anchor version used, just with
 * the anchor now chosen by the user instead of detected automatically. */
export function forecastFromUserCandle(candles: Candle[], userCandle: Candle, moreDays: number): ForecastResult {
  const refLevel = bodyMid(userCandle);
  const bias: "up" | "down" = userCandle.close >= userCandle.open ? "up" : "down";
  const avgBody = typicalBodySize(candles);
  const rest = continueScenario(refLevel, bias, userCandle, avgBody, moreDays);
  return {
    candles: [userCandle, ...rest],
    anchor: userCandle,
    note:
      `가상 시나리오입니다 — 실제 예측이 아닙니다. 직접 그리신 ${userCandle.date} 캔들(` +
      `${bias === "up" ? "양봉" : "음봉"}) 몸통 50% 지점을 지지/저항으로 보고, 이를 지키면 추세 지속, ` +
      `깨면 추세 전환으로 가정해 기계적으로 이어그린 나머지 ${moreDays}거래일치 캔들입니다.`,
  };
}

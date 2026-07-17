// Rule-based subset of the `inflection-point-predictor` skill's ensemble
// (ML 50% + rules 35% + news 15%). The ML leg needs a trained model and the
// news leg needs a live feed — neither can run as deterministic server code,
// so only the rule leg runs here: volume anomaly, RSI divergence, OBV
// divergence, BB squeeze. A point is flagged where >=2 rules corroborate a
// past pivot as a trend turn; this is a backtest-style flag, not a live
// forecast (see `note` below).

import type { Candle } from "@/lib/schema";
import { rsi, bollinger, closes } from "@/lib/analysis/indicators";
import { findPivots } from "@/lib/analysis/patterns";

export interface InflectionSignal {
  rule: "volume-anomaly" | "rsi-divergence" | "obv-divergence" | "bb-squeeze";
  detail: string;
}

export interface InflectionPoint {
  date: string;
  price: number;
  /** Direction price turned toward at this pivot. */
  direction: "up" | "down";
  confidence: number;
  signals: InflectionSignal[];
}

export interface InflectionResult {
  points: InflectionPoint[];
  note: string;
}

const WEIGHTS = { volume: 0.25, rsiDiv: 0.3, obvDiv: 0.25, bbSqueeze: 0.2 };
const THRESHOLD = 0.5;
const VOLUME_WINDOW = 20;
const VOLUME_Z = 2;
const SQUEEZE_WINDOW = 60;
const SQUEEZE_PERCENTILE = 0.2;

function onBalanceVolume(candles: Candle[]): number[] {
  const out: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    const dir = Math.sign(candles[i].close - candles[i - 1].close);
    out.push(out[i - 1] + dir * candles[i].volume);
  }
  return out;
}

function rollingZ(values: number[], window: number): number[] {
  return values.map((v, i) => {
    const slice = values.slice(Math.max(0, i - window + 1), i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length) || 1;
    return (v - mean) / sd;
  });
}

/** True where the current BB width sits in the bottom `pct` of the trailing window. */
function squeezeFlags(widths: number[], window: number, pct: number): boolean[] {
  return widths.map((w, i) => {
    const slice = [...widths.slice(Math.max(0, i - window + 1), i + 1)].sort((a, b) => a - b);
    if (slice.length <= 4) return false;
    const rank = slice.findIndex((v) => v >= w);
    return rank / slice.length <= pct;
  });
}

export function inflectionPoints(candles: Candle[]): InflectionResult {
  const price = closes(candles);
  const rsiVals = rsi(price, 14);
  const obv = onBalanceVolume(candles);
  const bb = bollinger(price, 20, 2);
  const widths = bb.middle.map((m, i) =>
    m === null || bb.upper[i] === null || bb.lower[i] === null
      ? 0
      : (bb.upper[i]! - bb.lower[i]!) / m,
  );
  const volZ = rollingZ(
    candles.map((c) => c.volume),
    VOLUME_WINDOW,
  );
  const squeeze = squeezeFlags(widths, SQUEEZE_WINDOW, SQUEEZE_PERCENTILE);
  const pivots = findPivots(candles, 5);
  const points: InflectionPoint[] = [];

  for (let k = 0; k < pivots.length; k++) {
    const piv = pivots[k];
    const prevSame = [...pivots.slice(0, k)].reverse().find((p) => p.type === piv.type);
    if (!prevSame) continue;
    const i = piv.index;
    const j = prevSame.index;
    const priceUp = piv.price > prevSame.price;
    const signals: InflectionSignal[] = [];
    let score = 0;

    if (rsiVals[i] != null && rsiVals[j] != null) {
      const rsiUp = rsiVals[i]! > rsiVals[j]!;
      const divergent = piv.type === "peak" ? priceUp && !rsiUp : !priceUp && rsiUp;
      if (divergent) {
        score += WEIGHTS.rsiDiv;
        signals.push({
          rule: "rsi-divergence",
          detail: `price ${priceUp ? "higher" : "lower"} vs prior ${piv.type}, RSI ${rsiUp ? "higher" : "lower"}`,
        });
      }
    }

    const obvUp = obv[i] > obv[j];
    const obvDivergent = piv.type === "peak" ? priceUp && !obvUp : !priceUp && obvUp;
    if (obvDivergent) {
      score += WEIGHTS.obvDiv;
      signals.push({
        rule: "obv-divergence",
        detail: `price ${priceUp ? "up" : "down"} vs prior ${piv.type}, OBV ${obvUp ? "up" : "down"}`,
      });
    }

    if (Math.abs(volZ[i]) >= VOLUME_Z) {
      score += WEIGHTS.volume;
      signals.push({ rule: "volume-anomaly", detail: `volume z-score ${volZ[i].toFixed(2)}` });
    }

    if (squeeze.slice(Math.max(0, i - 5), i + 1).some(Boolean)) {
      score += WEIGHTS.bbSqueeze;
      signals.push({
        rule: "bb-squeeze",
        detail: `Bollinger band width in bottom ${SQUEEZE_PERCENTILE * 100}% of trailing ${SQUEEZE_WINDOW} bars`,
      });
    }

    if (signals.length < 2) continue; // need corroborating signals, not a single rule
    const confidence = Math.min(1, Math.round(score * 1000) / 1000);
    if (confidence < THRESHOLD) continue;

    points.push({
      date: piv.date,
      price: piv.price,
      direction: piv.type === "peak" ? "down" : "up",
      confidence,
      signals,
    });
  }

  return {
    points,
    note:
      "rule-based only (volume anomaly, RSI divergence, OBV divergence, BB squeeze); " +
      "the ML(50%) and news(15%) legs of the original ensemble are not implemented — " +
      "points mark past pivots where >=2 rules corroborated the turn, not a live forecast",
  };
}

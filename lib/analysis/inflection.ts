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
  /** rsi-divergence/obv-divergence only: the two points (prior same-type
   * pivot -> this pivot) on the INDICATOR's own scale, not price — lets the
   * UI draw the actual divergence line on the RSI/OBV sub-panel instead of
   * only describing it in text. */
  line?: { p1: { date: string; value: number }; p2: { date: string; value: number } };
}

export interface InflectionPoint {
  date: string;
  price: number;
  /** Direction price turned toward at this pivot. */
  direction: "up" | "down";
  confidence: number;
  signals: InflectionSignal[];
  /** The prior same-type pivot (peak-vs-peak/trough-vs-trough) this point
   * was compared against to detect divergence — lets the main candle chart
   * draw the price-side of the divergence (prior pivot -> this pivot),
   * matching the RSI/OBV-side lines already drawn on their sub-panels. */
  priorPivot: { date: string; price: number };
}

export interface InflectionResult {
  points: InflectionPoint[];
  note: string;
}

const WEIGHTS = { volume: 0.25, rsiDiv: 0.3, obvDiv: 0.25, bbSqueeze: 0.2 };

/** Same fixed weights, keyed by the `InflectionSignal.rule` id — for
 * displaying the confidence breakdown (e.g. "0.55 = RSI다이버전스 0.30 +
 * 거래량이상 0.25") without duplicating the numbers elsewhere. */
export const RULE_WEIGHTS: Record<InflectionSignal["rule"], number> = {
  "volume-anomaly": WEIGHTS.volume,
  "rsi-divergence": WEIGHTS.rsiDiv,
  "obv-divergence": WEIGHTS.obvDiv,
  "bb-squeeze": WEIGHTS.bbSqueeze,
};
const THRESHOLD = 0.5;
const VOLUME_WINDOW = 20;
const VOLUME_Z = 2;
const SQUEEZE_WINDOW = 60;
const SQUEEZE_PERCENTILE = 0.2;

/** Cumulative volume (+volume on an up close, -volume on a down close) —
 * exported so the OBV sub-panel (ChartStack.tsx) can plot the same series
 * this module already computes for obv-divergence, instead of recomputing. */
export function onBalanceVolume(candles: Candle[]): number[] {
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
          detail: `가격은 이전 ${piv.type === "peak" ? "고점" : "저점"}보다 ${priceUp ? "올랐는데" : "내렸는데"} RSI는 반대로 ${rsiUp ? "올라감" : "내려감"}`,
          line: {
            p1: { date: candles[j].date, value: rsiVals[j]! },
            p2: { date: candles[i].date, value: rsiVals[i]! },
          },
        });
      }
    }

    const obvUp = obv[i] > obv[j];
    const obvDivergent = piv.type === "peak" ? priceUp && !obvUp : !priceUp && obvUp;
    if (obvDivergent) {
      score += WEIGHTS.obvDiv;
      signals.push({
        rule: "obv-divergence",
        detail: `가격은 이전 ${piv.type === "peak" ? "고점" : "저점"}보다 ${priceUp ? "올랐는데" : "내렸는데"} 누적거래량(OBV)은 반대로 ${obvUp ? "올라감" : "내려감"}`,
        line: {
          p1: { date: candles[j].date, value: obv[j] },
          p2: { date: candles[i].date, value: obv[i] },
        },
      });
    }

    if (Math.abs(volZ[i]) >= VOLUME_Z) {
      score += WEIGHTS.volume;
      signals.push({
        rule: "volume-anomaly",
        detail: `평소 거래량과 비교했을 때 크게 벗어난 수준으로 급증함(이상치 점수 ${volZ[i].toFixed(2)})`,
      });
    }

    if (squeeze.slice(Math.max(0, i - 5), i + 1).some(Boolean)) {
      score += WEIGHTS.bbSqueeze;
      signals.push({
        rule: "bb-squeeze",
        detail: `최근 ${SQUEEZE_WINDOW}봉 중 가격 변동폭이 하위 ${SQUEEZE_PERCENTILE * 100}% 수준으로 크게 좁아짐(변동성 축소)`,
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
      priorPivot: { date: prevSame.date, price: prevSame.price },
    });
  }

  return {
    points,
    note:
      "규칙 기반만 적용됨(거래량이상·RSI다이버전스·OBV다이버전스·BB스퀴즈). " +
      "원 앙상블의 ML(50%)·뉴스(15%) 레그는 미구현 — 과거 전환점에서 규칙이 " +
      "2개 이상 부합한 지점만 표시하며, 실시간 예측이 아님. " +
      "confidence는 확률이 아니라 규칙별 고정 가중치 합산 점수(거래량이상 " +
      "0.25 · RSI다이버전스 0.3 · OBV다이버전스 0.25 · BB스퀴즈 0.2, 최대 1.0)로, " +
      "0.5~0.55대가 가장 흔함(2개 규칙만 부합하는 경우가 가장 자주 발생)",
  };
}

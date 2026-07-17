// Numeric technical indicators (deterministic formulas). Scope per the
// `technical-analysis-engine` skill: SMA/EMA, RSI (Wilder), MACD (12/26/9),
// Bollinger Bands (20, 2σ). Each indicator is computed independently and
// returns arrays aligned by index to the input `close` series (null during the
// warm-up window). If a series is too short to produce ANY value the caller
// receives null + a reason instead of failing the whole request.

import type { Candle } from "@/lib/schema";

/** A per-index series aligned to the candles array; null = warm-up / unavailable. */
export type Series = (number | null)[];

export interface MovingAverage {
  period: number;
  values: Series;
}

export interface SmaResult {
  /** One entry per requested period that had enough data. */
  byPeriod: MovingAverage[];
}

export interface RsiResult {
  period: number;
  values: Series;
}

export interface MacdResult {
  fastPeriod: number;
  slowPeriod: number;
  signalPeriod: number;
  macd: Series;
  signal: Series;
  histogram: Series;
}

export interface BollingerResult {
  period: number;
  stdDevMult: number;
  upper: Series;
  middle: Series;
  lower: Series;
}

const round = (v: number, dp = 4): number => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

/** Simple moving average aligned to `values`; index i null until i >= period-1. */
export function sma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = round(sum / period);
  }
  return out;
}

/** Exponential moving average; seeded with the SMA of the first `period` values. */
export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = round(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = round(prev);
  }
  return out;
}

/**
 * Wilder's RSI. First avgGain/avgLoss are simple averages of the first `period`
 * deltas; subsequent values use Wilder smoothing. First defined index is
 * `period` (needs `period+1` closes).
 */
export function rsi(values: number[], period = 14): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = round(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss), 2);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = round(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss), 2);
  }
  return out;
}

/** MACD line (EMAfast-EMAslow), signal (EMA of MACD), histogram. */
export function macd(
  values: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult {
  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);
  const macdLine: Series = values.map((_, i) =>
    fast[i] !== null && slow[i] !== null ? round((fast[i] as number) - (slow[i] as number)) : null,
  );
  // Signal = EMA(signalPeriod) over the defined portion of the MACD line.
  const firstIdx = macdLine.findIndex((v) => v !== null);
  const signal: Series = new Array(values.length).fill(null);
  if (firstIdx !== -1) {
    const defined = macdLine.slice(firstIdx).map((v) => v as number);
    const sig = ema(defined, signalPeriod);
    for (let i = 0; i < sig.length; i++) signal[firstIdx + i] = sig[i];
  }
  const histogram: Series = values.map((_, i) =>
    macdLine[i] !== null && signal[i] !== null
      ? round((macdLine[i] as number) - (signal[i] as number))
      : null,
  );
  return { fastPeriod, slowPeriod, signalPeriod, macd: macdLine, signal, histogram };
}

/** Bollinger Bands: SMA(period) middle band ± mult * population std-dev. */
export function bollinger(values: number[], period = 20, mult = 2): BollingerResult {
  const middle = sma(values, period);
  const upper: Series = new Array(values.length).fill(null);
  const lower: Series = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const m = middle[i];
    if (m === null) continue;
    let sq = 0;
    for (let j = i - period + 1; j <= i; j++) sq += (values[j] - m) ** 2;
    const sd = Math.sqrt(sq / period);
    upper[i] = round(m + mult * sd);
    lower[i] = round(m - mult * sd);
  }
  return { period, stdDevMult: mult, upper, middle, lower };
}

/** Default SMA/EMA presets. */
export const MA_PRESETS = [5, 10, 20, 60, 120] as const;

export function closes(candles: Candle[]): number[] {
  return candles.map((c) => c.close);
}

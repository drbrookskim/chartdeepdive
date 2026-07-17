// Analysis orchestrator. Assembles the three-layer result (indicators /
// patterns / advanced) from a normalized OHLCV series. Each indicator/technique
// is computed independently; if the series is too short for one of them, that
// field is returned as null with a reason in `unavailable` — the whole request
// never fails for a single under-length indicator.

import type { Candle } from "@/lib/schema";
import {
  sma,
  ema,
  rsi,
  macd,
  bollinger,
  closes,
  MA_PRESETS,
  type MovingAverage,
  type RsiResult,
  type MacdResult,
  type BollingerResult,
} from "@/lib/analysis/indicators";
import { detectPatterns, type Pattern, CONFIDENCE_THRESHOLD } from "@/lib/analysis/patterns";
import { detectHarmonic } from "@/lib/analysis/harmonic";
import { ichimoku, type IchimokuResult } from "@/lib/analysis/ichimoku";
import { elliottWave, type ElliottResult } from "@/lib/analysis/elliott";
import { inflectionPoints, type InflectionResult } from "@/lib/analysis/inflection";

export interface AnalysisResult {
  symbol: string;
  market: string;
  currency: string;
  name: string | null;
  interval: string;
  meta: {
    candleCount: number;
    from: string | null;
    to: string | null;
    patternConfidenceThreshold: number;
    /** field path -> reason it is null (e.g. "indicators.sma.120"). */
    unavailable: Record<string, string>;
  };
  /** Aligned x-axis for every indicator series (index == candle index). */
  dates: string[];
  indicators: {
    sma: { byPeriod: MovingAverage[] } | null;
    ema: { byPeriod: MovingAverage[] } | null;
    rsi: RsiResult | null;
    macd: MacdResult | null;
    bollinger: BollingerResult | null;
  };
  patterns: {
    structural: Pattern[];
    harmonic: Pattern[];
  };
  advanced: {
    ichimoku: IchimokuResult | null;
    elliottWave: ElliottResult | null;
    inflectionPoints: InflectionResult | null;
  };
}

interface AnalyzeInput {
  symbol: string;
  market: string;
  currency: string;
  name: string | null;
  interval: string;
  candles: Candle[];
}

/** Minimum bars each technique needs before it can produce any value. */
const MIN_BARS = {
  rsi: 15, // period 14 + 1
  macd: 26, // slow EMA
  bollinger: 20,
  ichimoku: 78, // 52 + 26
  elliott: 26, // enough for a few swing windows
  patterns: 25,
} as const;

export function analyze(input: AnalyzeInput): AnalysisResult {
  const { candles } = input;
  const n = candles.length;
  const dates = candles.map((c) => c.date);
  const price = closes(candles);
  const unavailable: Record<string, string> = {};

  // --- SMA / EMA: per-period, skip periods that lack enough bars ---
  const smaByPeriod: MovingAverage[] = [];
  const emaByPeriod: MovingAverage[] = [];
  for (const period of MA_PRESETS) {
    if (n >= period) {
      smaByPeriod.push({ period, values: sma(price, period) });
      emaByPeriod.push({ period, values: ema(price, period) });
    } else {
      unavailable[`indicators.sma.${period}`] =
        `need ${period} candles, have ${n}`;
      unavailable[`indicators.ema.${period}`] =
        `need ${period} candles, have ${n}`;
    }
  }
  const smaResult = smaByPeriod.length ? { byPeriod: smaByPeriod } : null;
  const emaResult = emaByPeriod.length ? { byPeriod: emaByPeriod } : null;
  if (!smaResult) unavailable["indicators.sma"] = `need >=${MA_PRESETS[0]} candles, have ${n}`;
  if (!emaResult) unavailable["indicators.ema"] = `need >=${MA_PRESETS[0]} candles, have ${n}`;

  // --- RSI ---
  let rsiResult: RsiResult | null = null;
  if (n >= MIN_BARS.rsi) rsiResult = { period: 14, values: rsi(price, 14) };
  else unavailable["indicators.rsi"] = `need ${MIN_BARS.rsi} candles, have ${n}`;

  // --- MACD ---
  let macdResult: MacdResult | null = null;
  if (n >= MIN_BARS.macd) macdResult = macd(price, 12, 26, 9);
  else unavailable["indicators.macd"] = `need ${MIN_BARS.macd} candles, have ${n}`;

  // --- Bollinger ---
  let bbResult: BollingerResult | null = null;
  if (n >= MIN_BARS.bollinger) bbResult = bollinger(price, 20, 2);
  else unavailable["indicators.bollinger"] = `need ${MIN_BARS.bollinger} candles, have ${n}`;

  // --- Patterns ---
  let structural: Pattern[] = [];
  let harmonic: Pattern[] = [];
  if (n >= MIN_BARS.patterns) {
    structural = detectPatterns(candles);
    harmonic = detectHarmonic(candles);
  } else {
    unavailable["patterns"] = `need ${MIN_BARS.patterns} candles for pivot detection, have ${n}`;
  }

  // --- Advanced ---
  let ichimokuResult: IchimokuResult | null = null;
  if (n >= MIN_BARS.ichimoku) ichimokuResult = ichimoku(candles);
  else unavailable["advanced.ichimoku"] = `need ${MIN_BARS.ichimoku} candles, have ${n}`;

  let elliottResult: ElliottResult | null = null;
  if (n >= MIN_BARS.elliott) elliottResult = elliottWave(candles);
  else unavailable["advanced.elliottWave"] = `need ${MIN_BARS.elliott} candles, have ${n}`;

  let inflectionResult: InflectionResult | null = null;
  if (n >= MIN_BARS.patterns) inflectionResult = inflectionPoints(candles);
  else unavailable["advanced.inflectionPoints"] = `need ${MIN_BARS.patterns} candles, have ${n}`;

  return {
    symbol: input.symbol,
    market: input.market,
    currency: input.currency,
    name: input.name,
    interval: input.interval,
    meta: {
      candleCount: n,
      from: n ? dates[0] : null,
      to: n ? dates[n - 1] : null,
      patternConfidenceThreshold: CONFIDENCE_THRESHOLD,
      unavailable,
    },
    dates,
    indicators: {
      sma: smaResult,
      ema: emaResult,
      rsi: rsiResult,
      macd: macdResult,
      bollinger: bbResult,
    },
    patterns: { structural, harmonic },
    advanced: {
      ichimoku: ichimokuResult,
      elliottWave: elliottResult,
      inflectionPoints: inflectionResult,
    },
  };
}

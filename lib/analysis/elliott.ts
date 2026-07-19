// Elliott Wave (ported from the `elliott-wave` skill spec). Deterministic,
// single "simplest effective interpretation" strategy: detect swing points,
// then scan 6-swing windows from most recent backward for the first one that
// validates as a 1-2-3-4-5 impulse against the three iron rules. Reports at
// most one impulse interpretation (the most recent valid one) and abstains
// rather than guessing when no window in the series validates.

import type { Candle } from "@/lib/schema";

export interface WaveLabel {
  label: string; // "1".."5"
  date: string;
  price: number;
}

export interface ElliottResult {
  /** Detected impulse wave, or null when no rule-compliant count exists. */
  impulse: {
    direction: "up" | "down";
    waves: WaveLabel[];
    /** Which fib relationships held, for transparency. */
    checks: { wave2Retrace: boolean; wave3NotShortest: boolean; wave4NoOverlap: boolean };
    completed: boolean; // 5-wave sequence fully formed at series end
  } | null;
  /** Non-null when impulse is null: why no count was produced. */
  reason: string | null;
  /** 1 buy / -1 sell / 0 stand aside, per skill signal logic. */
  signal: 1 | -1 | 0;
}

interface Swing {
  index: number;
  date: string;
  price: number;
  type: "high" | "low";
}

/** Swing points via a rolling window on highs/lows (skill default window 10). */
function swings(candles: Candle[], window = 10): Swing[] {
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
  // Collapse consecutive same-type swings, keeping the more extreme one.
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

/** Validate one 6-swing window (P0..P5) as a 1-2-3-4-5 impulse. */
function checkImpulse(pts: Swing[]) {
  const up = pts[1].price > pts[0].price;
  const p = pts.map((s) => s.price);
  const w1 = Math.abs(p[1] - p[0]);
  const w3 = Math.abs(p[3] - p[2]);
  const w5 = Math.abs(p[5] - p[4]);

  // Rule 1: wave 2 does not retrace beyond start of wave 1.
  const wave2Retrace = up ? p[2] > p[0] : p[2] < p[0];
  // Rule 2: wave 3 is not the shortest of {1,3,5}.
  const wave3NotShortest = !(w3 < w1 && w3 < w5);
  // Rule 3: wave 4 does not enter wave 1 territory.
  const wave4NoOverlap = up ? p[4] > p[1] : p[4] < p[1];

  return {
    up,
    valid: wave2Retrace && wave3NotShortest && wave4NoOverlap,
    checks: { wave2Retrace, wave3NotShortest, wave4NoOverlap },
    violated: !wave2Retrace
      ? "파동2가 파동1 시작점을 되돌림"
      : !wave3NotShortest
        ? "파동3이 1·3·5파 중 최단파"
        : "파동4가 파동1 가격대를 침범",
  };
}

export function elliottWave(candles: Candle[], window = 10): ElliottResult {
  const sw = swings(candles, window);
  if (sw.length < 6) {
    return {
      impulse: null,
      reason: `1~5파 카운트에 필요한 전환점(swing)이 최소 6개 필요하나 ${sw.length}개만 발견됨`,
      signal: 0,
    };
  }

  // Scan every 6-swing window from most recent backward; report the first
  // (i.e. most recent) one that validates as a clean impulse.
  let lastViolation = "";
  for (let end = sw.length; end >= 6; end--) {
    const pts = sw.slice(end - 6, end);
    const result = checkImpulse(pts);
    if (!result.valid) {
      if (end === sw.length) lastViolation = result.violated;
      continue;
    }

    const direction: "up" | "down" = result.up ? "up" : "down";
    const waves: WaveLabel[] = pts.slice(1).map((s, idx) => ({
      label: String(idx + 1),
      date: s.date,
      price: s.price,
    }));
    // "Completed" if the final swing (wave 5) is near the end of the series.
    const completed = pts[5].index >= candles.length - window - 1;
    // Signal: a completed 5-wave advance -> sell; completed 5-wave decline -> buy.
    let signal: 1 | -1 | 0 = 0;
    if (completed) signal = result.up ? -1 : 1;

    return {
      impulse: { direction, waves, checks: result.checks, completed },
      reason: null,
      signal,
    };
  }

  return {
    impulse: null,
    reason: `전체 구간(전환점 ${sw.length}개)에서 규칙을 만족하는 1~5파 임펄스를 찾지 못함(가장 최근 구간 위반 사유: ${lastViolation})`,
    signal: 0,
  };
}

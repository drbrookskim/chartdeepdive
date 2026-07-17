// Structural chart-pattern recognition (per the `chart-pattern-recognition`
// skill). All detectors share one primitive: local extrema (pivots). Each
// detector returns probabilistic matches (confidence 0..1); low-confidence
// candidates are filtered by CONFIDENCE_THRESHOLD.
//
// Implemented: head-and-shoulders, inverse H&S, double top, double bottom,
// triple top, triple bottom, ascending / descending / symmetric triangle,
// rectangle, rising / falling wedge, channel (up/down), broadening formation,
// diamond top/bottom, price gaps, island reversal (paired opposite gaps),
// rounding bottom / top (saucer, curvature-based), V-reversal (spike),
// flag / pennant (pole + consolidation), cup-and-handle (rounding cup + handle).

import type { Candle } from "@/lib/schema";
import { sma } from "./indicators";

export const CONFIDENCE_THRESHOLD = 0.5;

export interface KeyPoint {
  date: string;
  price: number;
  /** "peak" | "trough" for pivots; other labels for gap endpoints. */
  kind: string;
}

export interface Pattern {
  type: string;
  /** "reversal" | "continuation" | "gap". */
  category: string;
  confidence: number;
  range: { start: string; end: string };
  keyPoints: KeyPoint[];
  /** Extra human-readable context (neckline broken, gap filled, ...). */
  note?: string;
}

interface Pivot {
  index: number;
  date: string;
  price: number;
  type: "peak" | "trough";
}

/**
 * Local extrema: a bar is a peak if its high is the strict max within ±window
 * bars (troughs symmetric on low). `window` controls sensitivity.
 */
export function findPivots(candles: Candle[], window = 5): Pivot[] {
  const pivots: Pivot[] = [];
  for (let i = window; i < candles.length - window; i++) {
    const hi = candles[i].high;
    const lo = candles[i].low;
    let isPeak = true;
    let isTrough = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if (candles[j].high >= hi) isPeak = false;
      if (candles[j].low <= lo) isTrough = false;
    }
    if (isPeak) pivots.push({ index: i, date: candles[i].date, price: hi, type: "peak" });
    else if (isTrough) pivots.push({ index: i, date: candles[i].date, price: lo, type: "trough" });
  }
  return pivots;
}

const pct = (a: number, b: number): number => Math.abs(a - b) / ((a + b) / 2);
/** Map a relative deviation to a 0..1 score given a tolerance band. */
const scoreDev = (dev: number, tol: number): number => Math.max(0, 1 - dev / tol);

function peaks(pivots: Pivot[]): Pivot[] {
  return pivots.filter((p) => p.type === "peak");
}
function troughs(pivots: Pivot[]): Pivot[] {
  return pivots.filter((p) => p.type === "trough");
}

// ---------- Reversal: Head & Shoulders / Inverse ----------

function headAndShoulders(pivots: Pivot[], inverse: boolean): Pattern[] {
  const out: Pattern[] = [];
  const main = inverse ? troughs(pivots) : peaks(pivots);
  const label = inverse ? "inverse-head-and-shoulders" : "head-and-shoulders";
  const tol = 0.05; // shoulder-height similarity tolerance
  for (let i = 0; i + 2 < main.length; i++) {
    const [ls, head, rs] = [main[i], main[i + 1], main[i + 2]];
    // Head must be the extreme; shoulders roughly equal.
    const headIsExtreme = inverse
      ? head.price < ls.price && head.price < rs.price
      : head.price > ls.price && head.price > rs.price;
    if (!headIsExtreme) continue;
    const shoulderDev = pct(ls.price, rs.price);
    if (shoulderDev > tol) continue;
    // Prominence of the head above the shoulder line.
    const shoulderAvg = (ls.price + rs.price) / 2;
    const prominence = Math.abs(head.price - shoulderAvg) / shoulderAvg;
    if (prominence < 0.02) continue;
    const conf = round(0.5 * scoreDev(shoulderDev, tol) + 0.5 * Math.min(1, prominence / 0.1));
    if (conf < CONFIDENCE_THRESHOLD) continue;
    out.push({
      type: label,
      category: "reversal",
      confidence: conf,
      range: { start: ls.date, end: rs.date },
      keyPoints: [
        { date: ls.date, price: ls.price, kind: "left-shoulder" },
        { date: head.date, price: head.price, kind: "head" },
        { date: rs.date, price: rs.price, kind: "right-shoulder" },
      ],
    });
  }
  return out;
}

// ---------- Reversal: Double / Triple Top & Bottom ----------

function doubleTripleExtreme(
  pivots: Pivot[],
  isTop: boolean,
  count: 2 | 3,
): Pattern[] {
  const out: Pattern[] = [];
  const main = isTop ? peaks(pivots) : troughs(pivots);
  const tol = 0.03; // "similar height" tolerance
  const base = isTop
    ? count === 2
      ? "double-top"
      : "triple-top"
    : count === 2
      ? "double-bottom"
      : "triple-bottom";
  for (let i = 0; i + (count - 1) < main.length; i++) {
    const group = main.slice(i, i + count);
    // All extremes within tolerance of their mean.
    const mean = group.reduce((s, p) => s + p.price, 0) / count;
    let maxDev = 0;
    for (const p of group) maxDev = Math.max(maxDev, Math.abs(p.price - mean) / mean);
    if (maxDev > tol) continue;
    const conf = round(scoreDev(maxDev, tol));
    if (conf < CONFIDENCE_THRESHOLD) continue;
    out.push({
      type: base,
      category: "reversal",
      confidence: conf,
      range: { start: group[0].date, end: group[count - 1].date },
      keyPoints: group.map((p) => ({
        date: p.date,
        price: p.price,
        kind: isTop ? "top" : "bottom",
      })),
    });
  }
  return out;
}

// ---------- Continuation: trend-line convergence family ----------

/** Least-squares slope of price over index for a set of pivots. */
function lineFit(points: Pivot[]): { slope: number; intercept: number } {
  const n = points.length;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    sx += p.index;
    sy += p.price;
    sxy += p.index * p.price;
    sxx += p.index * p.index;
  }
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

/** Coefficient of determination for a pivot set against a fitted line. */
function rSquared(points: Pivot[], line: { slope: number; intercept: number }): number {
  const mean = points.reduce((s, p) => s + p.price, 0) / points.length;
  let ssRes = 0;
  let ssTot = 0;
  for (const p of points) {
    const pred = line.slope * p.index + line.intercept;
    ssRes += (p.price - pred) ** 2;
    ssTot += (p.price - mean) ** 2;
  }
  return ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);
}

/**
 * Fits an upper (peaks) and lower (troughs) trend line over the pivot window and
 * classifies the resulting shape: triangle / wedge / rectangle / broadening.
 * Uses the most recent `lookback` pivots.
 */
function trendLineShapes(pivots: Pivot[], candles: Candle[], lookback = 8): Pattern[] {
  const out: Pattern[] = [];
  const recent = pivots.slice(-lookback);
  const pk = peaks(recent);
  const tr = troughs(recent);
  if (pk.length < 2 || tr.length < 2) return out;

  const upper = lineFit(pk);
  const lower = lineFit(tr);
  const fitQuality = (rSquared(pk, upper) + rSquared(tr, lower)) / 2;
  if (fitQuality < 0.3) return out; // trend lines too noisy to be meaningful

  const start = candles[recent[0].index];
  const end = candles[recent[recent.length - 1].index];
  // Normalize slopes by price scale so thresholds are scale-free.
  const priceScale =
    recent.reduce((s, p) => s + p.price, 0) / recent.length / candles.length;
  const su = upper.slope / priceScale;
  const sl = lower.slope / priceScale;
  const flat = 0.15; // |normalized slope| below this counts as horizontal

  const range = { start: start.date, end: end.date };
  const keyPoints: KeyPoint[] = recent.map((p) => ({
    date: p.date,
    price: p.price,
    kind: p.type,
  }));
  const conf = round(0.4 + 0.6 * fitQuality);
  if (conf < CONFIDENCE_THRESHOLD) return out;

  const push = (type: string, category: string, note?: string) =>
    out.push({ type, category, confidence: conf, range, keyPoints, note });

  const upFlat = Math.abs(su) < flat;
  const lowFlat = Math.abs(sl) < flat;
  const converging = su < -flat && sl > flat; // lines closing in
  const diverging = su > flat && sl < -flat; // lines opening out
  const sameSign = su * sl > 0 && !upFlat && !lowFlat;

  if (upFlat && lowFlat) {
    push("rectangle", "continuation", "both trend lines near-horizontal");
  } else if (converging) {
    push("symmetric-triangle", "continuation", "peaks falling, troughs rising");
  } else if (upFlat && sl > flat) {
    push("ascending-triangle", "continuation", "flat top, rising bottoms");
  } else if (lowFlat && su < -flat) {
    push("descending-triangle", "continuation", "falling top, flat bottom");
  } else if (sameSign) {
    // Same-direction lines: parallel width => channel, narrowing width => wedge.
    const xStart = recent[0].index;
    const xEnd = recent[recent.length - 1].index;
    const wStart = upper.slope * xStart + upper.intercept - (lower.slope * xStart + lower.intercept);
    const wEnd = upper.slope * xEnd + upper.intercept - (lower.slope * xEnd + lower.intercept);
    const parallel = wStart > 0 && wEnd > 0 && wEnd / wStart > 0.75 && wEnd / wStart < 1.33;
    if (parallel) {
      push(
        su > 0 ? "channel-up" : "channel-down",
        "continuation",
        "trend lines slope together with stable channel width",
      );
    } else {
      push(
        su > 0 ? "rising-wedge" : "falling-wedge",
        "continuation",
        "both trend lines slope the same direction and converge",
      );
    }
  } else if (diverging) {
    push("broadening-formation", "other", "trend lines diverging (megaphone)");
  }
  return out;
}

// ---------- Gaps ----------

// Gap sub-type is judged by WHERE it sits in the trend, not by direction or
// fill status alone (per the chart-pattern-recognition skill): a gap breaking
// out of a flat consolidation is a breakaway-gap, one appearing mid-trend is a
// runaway-gap, and one appearing on a volume spike (candidate trend
// exhaustion) is an exhaustion-gap. Anything that fits none of those is a
// common-gap.
const GAP_TREND_LOOKBACK = 20; // bars examined before the gap for trend context
const GAP_MIN_CONTEXT_BARS = 8; // below this, there isn't enough history to judge trend
const GAP_CONSOLIDATION_MAX_RANGE = 0.08; // (high-low)/mean over lookback counts as "flat"
const GAP_TREND_MIN_SLOPE = 0.15; // normalized slope (same scale as trendLineShapes) counts as trending
const GAP_VOLUME_SPIKE = 1.8; // gap-day volume vs lookback average -> exhaustion candidate

/** Classifies a gap by the trend context in the `lookback` bars before it. */
function gapContext(
  candles: Candle[],
  i: number,
  up: boolean,
): "breakaway-gap" | "runaway-gap" | "exhaustion-gap" | "common-gap" {
  const lookback = Math.min(GAP_TREND_LOOKBACK, i);
  if (lookback < GAP_MIN_CONTEXT_BARS) return "common-gap"; // not enough history to judge trend
  const win = candles.slice(i - lookback, i);
  const closes = win.map((k) => k.close);
  const meanPrice = closes.reduce((s, v) => s + v, 0) / closes.length;
  const { slope } = linReg(closes);
  const normSlope = slope / (meanPrice / lookback);
  const hi = Math.max(...win.map((k) => k.high));
  const lo = Math.min(...win.map((k) => k.low));
  const range = (hi - lo) / meanPrice;

  if (range < GAP_CONSOLIDATION_MAX_RANGE && Math.abs(normSlope) < 0.05) {
    return "breakaway-gap";
  }
  const trendingWithGap = up
    ? normSlope > GAP_TREND_MIN_SLOPE
    : normSlope < -GAP_TREND_MIN_SLOPE;
  if (!trendingWithGap) return "common-gap";

  const avgVol = win.reduce((s, k) => s + k.volume, 0) / win.length;
  return avgVol > 0 && candles[i].volume > GAP_VOLUME_SPIKE * avgVol
    ? "exhaustion-gap"
    : "runaway-gap";
}

function gaps(candles: Candle[]): Pattern[] {
  const out: Pattern[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];
    const up = cur.low > prev.high;
    const down = cur.high < prev.low;
    if (!up && !down) continue;
    const gapSize = up
      ? (cur.low - prev.high) / prev.high
      : (prev.low - cur.high) / prev.low;
    if (gapSize < 0.02) continue; // ignore trivial gaps (common-gap noise)
    // Sub-type by whether it is later filled within 5 bars (feeds exhaustion
    // confidence only — a filled exhaustion gap reinforces the reversal read).
    let filled = false;
    const level = up ? prev.high : prev.low;
    for (let j = i + 1; j < Math.min(candles.length, i + 6); j++) {
      if (up && candles[j].low <= level) filled = true;
      if (down && candles[j].high >= level) filled = true;
    }
    const type = gapContext(candles, i, up);
    let conf = round(Math.min(1, 0.5 + gapSize * 5));
    if (type === "exhaustion-gap" && filled) conf = round(Math.min(1, conf + 0.15));
    const dir = up ? "상승" : "하락";
    const note =
      type === "breakaway-gap"
        ? `${dir} 돌파갭: 횡보 구간을 이탈하며 발생`
        : type === "runaway-gap"
          ? `${dir} 추세갭: 기존 추세 중간에 발생`
          : type === "exhaustion-gap"
            ? `${dir} 소멸갭: 거래량 급증과 함께 발생${filled ? ", 5봉 내 되메움(반전 가능성)" : ""}`
            : `${dir} 일반갭`;
    out.push({
      type,
      category: "gap",
      confidence: conf,
      range: { start: prev.date, end: cur.date },
      keyPoints: [
        { date: prev.date, price: level, kind: "gap-edge" },
        { date: cur.date, price: up ? cur.low : cur.high, kind: "gap-edge" },
      ],
      note,
    });
  }
  return out;
}

// ---------- Golden / Dead Cross (MA20 x MA60) ----------

// Deterministic, not probabilistic like the other detectors — a crossover
// either happened or didn't, so confidence is always 1. Uses the same 20/60
// pair already plotted as the chart's two named MA overlay lines, so the
// flagged point matches what's visibly crossing on the chart.
const CROSS_SHORT = 20;
const CROSS_LONG = 60;

function movingAverageCrosses(candles: Candle[]): Pattern[] {
  const out: Pattern[] = [];
  if (candles.length < CROSS_LONG + 1) return out;
  const closes = candles.map((c) => c.close);
  const short = sma(closes, CROSS_SHORT);
  const long = sma(closes, CROSS_LONG);
  for (let i = 1; i < candles.length; i++) {
    const s0 = short[i - 1];
    const s1 = short[i];
    const l0 = long[i - 1];
    const l1 = long[i];
    if (s0 == null || s1 == null || l0 == null || l1 == null) continue;
    const prevDiff = s0 - l0;
    const curDiff = s1 - l1;
    if (prevDiff === 0 || Math.sign(prevDiff) === Math.sign(curDiff)) continue;
    const golden = curDiff > 0;
    out.push({
      type: golden ? "golden-cross" : "dead-cross",
      category: "cross",
      confidence: 1,
      range: { start: candles[i - 1].date, end: candles[i].date },
      keyPoints: [
        { date: candles[i - 1].date, price: s0, kind: golden ? "golden-cross" : "dead-cross" },
        { date: candles[i].date, price: s1, kind: golden ? "golden-cross" : "dead-cross" },
      ],
      note: `${CROSS_SHORT}일선이 ${CROSS_LONG}일선을 ${golden ? "상향" : "하향"} 돌파`,
    });
  }
  return out;
}

// ---------- Reversal: Rounding Bottom / Top (saucer) ----------

// Saucers are judged by CURVATURE, not by matching individual peaks/troughs
// (per the chart-pattern-recognition skill): fit a quadratic to a smoothed
// close window — a>0 is a U (rounding bottom), a<0 an inverted-U (rounding
// top). The arms must be GENTLE; that gentleness is exactly what separates a
// saucer from a V-reversal (see V_REVERSAL_* below — the slope bands don't
// overlap).
const ROUNDING_WINDOWS = [30, 45, 60]; // candidate base lengths (bars)
const ROUNDING_MIN_FIT = 0.6; // quadratic R^2 floor — must be a clean curve
const ROUNDING_MIN_DEPTH = 0.03; // rim-to-vertex move must be >= 3% (meaningful)
const ROUNDING_MAX_ARM_SLOPE = 0.008; // gentle: each arm <= 0.8% price move / bar
const ROUNDING_VERTEX_MARGIN = 0.25; // vertex must sit inside the middle 50%

/** Centered SMA(±2) smoothing of closes to strip single-bar noise before fitting. */
function smoothCloses(candles: Candle[]): number[] {
  const c = candles.map((k) => k.close);
  const out: number[] = [];
  for (let i = 0; i < c.length; i++) {
    let sum = 0;
    let cnt = 0;
    for (let j = Math.max(0, i - 2); j <= Math.min(c.length - 1, i + 2); j++) {
      sum += c[j];
      cnt++;
    }
    out.push(sum / cnt);
  }
  return out;
}

/** Least-squares quadratic y = a·x² + b·x + c over x = 0..n-1, with R². */
function quadFit(y: number[]): { a: number; b: number; c: number; r2: number } {
  const n = y.length;
  let Sx = 0, Sx2 = 0, Sx3 = 0, Sx4 = 0, Sy = 0, Sxy = 0, Sx2y = 0;
  for (let i = 0; i < n; i++) {
    const x = i, x2 = x * x;
    Sx += x; Sx2 += x2; Sx3 += x2 * x; Sx4 += x2 * x2;
    Sy += y[i]; Sxy += x * y[i]; Sx2y += x2 * y[i];
  }
  // Solve the 3×3 normal-equation system by Cramer's rule.
  const m = [
    [n, Sx, Sx2],
    [Sx, Sx2, Sx3],
    [Sx2, Sx3, Sx4],
  ];
  const rhs = [Sy, Sxy, Sx2y];
  const det3 = (a: number[][]) =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const D = det3(m);
  if (D === 0) return { a: 0, b: 0, c: 0, r2: 0 };
  const col = (src: number[][], idx: number, v: number[]) =>
    src.map((row, r) => row.map((val, ci) => (ci === idx ? v[r] : val)));
  const c = det3(col(m, 0, rhs)) / D;
  const b = det3(col(m, 1, rhs)) / D;
  const a = det3(col(m, 2, rhs)) / D;
  const mean = Sy / n;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    const pred = a * i * i + b * i + c;
    ssRes += (y[i] - pred) ** 2;
    ssTot += (y[i] - mean) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);
  return { a, b, c, r2 };
}

function roundingPatterns(candles: Candle[]): Pattern[] {
  const n = candles.length;
  const smooth = smoothCloses(candles);
  const meanPrice = smooth.reduce((s, v) => s + v, 0) / n;
  const candidates: Pattern[] = [];

  for (const w of ROUNDING_WINDOWS) {
    if (w > n) continue;
    const step = Math.max(1, Math.floor(w / 4));
    for (let start = 0; start + w <= n; start += step) {
      const end = start + w - 1;
      const seg = smooth.slice(start, start + w);
      const { a, b, r2 } = quadFit(seg);
      if (a === 0 || r2 < ROUNDING_MIN_FIT) continue;

      const isBottom = a > 0; // U opens upward -> bottom
      // Vertex index (within segment) of the fitted parabola.
      const vertexX = -b / (2 * a);
      if (vertexX < ROUNDING_VERTEX_MARGIN * (w - 1)) continue;
      if (vertexX > (1 - ROUNDING_VERTEX_MARGIN) * (w - 1)) continue;
      const vIdx = Math.round(Math.min(w - 1, Math.max(0, vertexX)));

      // Depth: rim (segment endpoints) vs vertex, as a fraction of price.
      const rim = (seg[0] + seg[w - 1]) / 2;
      const depth = Math.abs(rim - seg[vIdx]) / meanPrice;
      if (depth < ROUNDING_MIN_DEPTH) continue;
      // Sanity: for a bottom the vertex is the low; for a top it's the high.
      if (isBottom && seg[vIdx] > rim) continue;
      if (!isBottom && seg[vIdx] < rim) continue;

      // Arm slopes (fractional price move per bar) must be gentle.
      const armL = Math.abs(seg[vIdx] - seg[0]) / Math.max(1, vIdx) / meanPrice;
      const armR = Math.abs(seg[w - 1] - seg[vIdx]) / Math.max(1, w - 1 - vIdx) / meanPrice;
      if (armL > ROUNDING_MAX_ARM_SLOPE || armR > ROUNDING_MAX_ARM_SLOPE) continue;

      const vertexNorm = vIdx / (w - 1);
      const centerScore = 1 - Math.abs(vertexNorm - 0.5) / 0.5;
      const conf = round(0.4 + 0.6 * (0.7 * r2 + 0.3 * centerScore));
      if (conf < CONFIDENCE_THRESHOLD) continue;

      candidates.push({
        type: isBottom ? "rounding-bottom" : "rounding-top",
        category: "reversal",
        confidence: conf,
        range: { start: candles[start].date, end: candles[end].date },
        keyPoints: [
          { date: candles[start].date, price: candles[start].close, kind: "rim" },
          {
            date: candles[start + vIdx].date,
            price: candles[start + vIdx].close,
            kind: isBottom ? "bottom" : "top",
          },
          { date: candles[end].date, price: candles[end].close, kind: "rim" },
        ],
        note: `quadratic fit R²=${round(r2, 2)}, gradual ${isBottom ? "U" : "inverted-U"} base`,
      });
    }
  }
  return dropOverlapping(candidates);
}

/** Keep highest-confidence, index-disjoint patterns (greedy). */
function dropOverlapping(patterns: Pattern[]): Pattern[] {
  const sorted = [...patterns].sort((a, b) => b.confidence - a.confidence);
  const kept: Pattern[] = [];
  const spans: Array<{ s: string; e: string }> = [];
  for (const p of sorted) {
    const overlaps = spans.some(
      (sp) => !(p.range.end < sp.s || p.range.start > sp.e),
    );
    if (overlaps) continue;
    kept.push(p);
    spans.push({ s: p.range.start, e: p.range.end });
  }
  return kept;
}

// ---------- Reversal: V-Reversal (spike) ----------

// A sharp, single-point reversal: the trend flips within a few bars. Detected
// from a pivot whose two legs have OPPOSITE-sign slopes that are BOTH steep.
// Steepness is what distinguishes it from a rounding bottom/top — the min
// floor here (1.5%/bar) sits well above the rounding arm ceiling (0.8%/bar).
const V_REVERSAL_LEG = 5; // bars measured on each side of the pivot
const V_REVERSAL_MIN_ARM_SLOPE = 0.015; // both legs >= 1.5% price move / bar

function vReversalPatterns(pivots: Pivot[], candles: Candle[]): Pattern[] {
  const out: Pattern[] = [];
  const n = candles.length;
  const meanPrice = candles.reduce((s, k) => s + k.close, 0) / n;

  for (const piv of pivots) {
    const i = piv.index;
    const lStart = i - V_REVERSAL_LEG;
    const rEnd = i + V_REVERSAL_LEG;
    if (lStart < 0 || rEnd >= n) continue;

    // Fractional price move per bar on each leg (signed).
    const before = (piv.price - candles[lStart].close) / V_REVERSAL_LEG / meanPrice;
    const after = (candles[rEnd].close - piv.price) / V_REVERSAL_LEG / meanPrice;

    const isBottom = piv.type === "trough";
    // Bottom: down into the pivot then up out of it; top is mirror-image.
    const validShape = isBottom ? before < 0 && after > 0 : before > 0 && after < 0;
    if (!validShape) continue;
    const magL = Math.abs(before);
    const magR = Math.abs(after);
    if (magL < V_REVERSAL_MIN_ARM_SLOPE || magR < V_REVERSAL_MIN_ARM_SLOPE) continue;

    const steepScore = Math.min(1, Math.min(magL, magR) / (2 * V_REVERSAL_MIN_ARM_SLOPE));
    const symmetry = 1 - Math.abs(magL - magR) / (magL + magR); // 1 = perfectly symmetric
    const conf = round(Math.min(1, 0.5 + 0.5 * (0.6 * steepScore + 0.4 * symmetry)));
    if (conf < CONFIDENCE_THRESHOLD) continue;

    out.push({
      type: "v-reversal",
      category: "reversal",
      confidence: conf,
      range: { start: candles[lStart].date, end: candles[rEnd].date },
      keyPoints: [
        { date: candles[lStart].date, price: candles[lStart].close, kind: "rim" },
        { date: piv.date, price: piv.price, kind: isBottom ? "bottom" : "top" },
        { date: candles[rEnd].date, price: candles[rEnd].close, kind: "rim" },
      ],
      note: `sharp ${isBottom ? "V" : "inverted-V"} spike reversal`,
    });
  }
  return dropOverlapping(out);
}

// ---------- Continuation: Flag / Pennant ----------

// A flag/pennant is a sharp trend leg (the "pole"/"flagpole") followed by a
// short, tight consolidation. The two share pole detection and differ only in
// the shape of the pull-back: a FLAG drifts in a roughly parallel channel
// (against or sideways to the pole), a PENNANT converges into a small triangle.
const FLAG_POLE_LENS = [5, 8, 12]; // candidate pole lengths (bars)
const FLAG_CONSOL_LENS = [5, 8, 12]; // candidate consolidation lengths (bars)
const FLAG_MIN_POLE_MOVE = 0.12; // pole must move >= 12% (sharp leg)
const FLAG_MAX_CONSOL_RANGE = 0.5; // consolidation height <= 50% of pole height
const FLAG_MAX_RETRACE = 0.5; // consolidation retraces <= 50% of the pole
const FLAG_CONVERGE_RATIO = 0.65; // widthEnd < 65% widthStart -> converging (pennant)
const FLAG_MAX_DRIFT = 0.01; // consolidation midline may not slope with the pole > 1%/bar

/** Least-squares line over y = f(x), x = 0..n-1. */
function linReg(ys: number[]): { slope: number; intercept: number } {
  const n = ys.length;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += ys[i];
    sxy += i * ys[i];
    sxx += i * i;
  }
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

function flagPennantPatterns(candles: Candle[]): Pattern[] {
  const out: Pattern[] = [];
  const n = candles.length;
  for (let i = 0; i < n; i++) {
    for (const p of FLAG_POLE_LENS) {
      const poleEnd = i + p - 1;
      if (poleEnd >= n) break;
      const startC = candles[i].close;
      const endC = candles[poleEnd].close;
      if (startC <= 0) continue;
      const move = (endC - startC) / startC;
      if (Math.abs(move) < FLAG_MIN_POLE_MOVE) continue;
      const up = move > 0;
      const poleHeight = Math.abs(endC - startC);

      for (const c of FLAG_CONSOL_LENS) {
        const consolEnd = poleEnd + c;
        if (consolEnd >= n) break;
        const seg = candles.slice(poleEnd + 1, consolEnd + 1); // c bars
        if (seg.length < 4) continue;
        const highs = seg.map((k) => k.high);
        const lows = seg.map((k) => k.low);
        const hi = Math.max(...highs);
        const lo = Math.min(...lows);
        const consolHeight = hi - lo;
        if (consolHeight > FLAG_MAX_CONSOL_RANGE * poleHeight) continue; // too loose

        // Consolidation must not undo more than half of the pole's advance.
        const retrace = up ? (endC - lo) / poleHeight : (hi - endC) / poleHeight;
        if (retrace > FLAG_MAX_RETRACE) continue;

        const upper = linReg(highs);
        const lower = linReg(lows);
        // Reject pull-backs that keep charging in the pole's direction.
        const midDrift = ((upper.slope + lower.slope) / 2) / startC;
        if (up && midDrift > FLAG_MAX_DRIFT) continue;
        if (!up && midDrift < -FLAG_MAX_DRIFT) continue;

        // Parallel vs converging: compare channel width at both ends.
        const lastX = highs.length - 1;
        const widthStart = upper.intercept - lower.intercept;
        const widthEnd =
          upper.intercept + upper.slope * lastX - (lower.intercept + lower.slope * lastX);
        if (widthStart <= 0) continue; // degenerate fit (lines already crossed)
        const converging = widthEnd < FLAG_CONVERGE_RATIO * widthStart;
        const type = converging ? "pennant" : "flag";

        const poleScore = Math.min(1, Math.abs(move) / (2 * FLAG_MIN_POLE_MOVE));
        const tightScore = Math.max(
          0,
          1 - consolHeight / (FLAG_MAX_CONSOL_RANGE * poleHeight),
        );
        const conf = round(0.45 + 0.55 * (0.6 * poleScore + 0.4 * tightScore));
        if (conf < CONFIDENCE_THRESHOLD) continue;

        out.push({
          type,
          category: "continuation",
          confidence: conf,
          range: { start: candles[i].date, end: candles[consolEnd].date },
          keyPoints: [
            { date: candles[i].date, price: startC, kind: "pole-start" },
            { date: candles[poleEnd].date, price: endC, kind: "pole-end" },
            {
              date: candles[consolEnd].date,
              price: candles[consolEnd].close,
              kind: "consolidation-end",
            },
          ],
          note: `${up ? "bull" : "bear"} ${type}: ${(move * 100).toFixed(1)}% pole then ${
            converging ? "converging" : "parallel"
          } consolidation`,
        });
      }
    }
  }
  return dropOverlapping(out);
}

// ---------- Continuation: Cup & Handle ----------

// A cup-and-handle is a rounding-bottom "cup" followed by a short, shallow
// pull-back ("handle") near the right rim. We reuse the curvature-based
// rounding-bottom detector for the cup, then require a brief dip that stays in
// the upper half of the cup and is shallower than the cup itself.
const CUP_HANDLE_LENS = [5, 8, 12]; // candidate handle lengths (bars)
const CUP_HANDLE_MAX_DEPTH = 0.5; // handle depth <= 50% of cup depth (shallow)
const CUP_HANDLE_MIN_DEPTH = 0.02; // handle must be a real dip (>= 2% of price)

function cupAndHandlePatterns(candles: Candle[]): Pattern[] {
  const out: Pattern[] = [];
  const cups = roundingPatterns(candles).filter((p) => p.type === "rounding-bottom");
  if (cups.length === 0) return out;

  const idxByDate = new Map<string, number>();
  candles.forEach((k, i) => idxByDate.set(k.date, i));
  const meanPrice = candles.reduce((s, k) => s + k.close, 0) / candles.length;

  for (const cup of cups) {
    const endIdx = idxByDate.get(cup.range.end);
    if (endIdx === undefined) continue;
    const rimPrice = candles[endIdx].close;
    const bottomPrice = cup.keyPoints[1].price;
    const cupDepth = rimPrice - bottomPrice;
    if (cupDepth <= 0) continue;

    let best: { conf: number; hEnd: number; hLowIdx: number; hDepth: number } | null = null;
    for (const h of CUP_HANDLE_LENS) {
      const hEnd = endIdx + h;
      if (hEnd >= candles.length) break;
      let minLow = Infinity;
      let minIdx = endIdx + 1;
      for (let j = endIdx + 1; j <= hEnd; j++) {
        if (candles[j].low < minLow) {
          minLow = candles[j].low;
          minIdx = j;
        }
      }
      const hDepth = rimPrice - minLow;
      if (hDepth <= 0) continue; // no pull-back
      if (hDepth < CUP_HANDLE_MIN_DEPTH * meanPrice) continue; // too trivial
      if (hDepth > CUP_HANDLE_MAX_DEPTH * cupDepth) continue; // too deep for a handle
      if (minLow < bottomPrice + 0.5 * cupDepth) continue; // must stay in upper half

      const shallowScore = 1 - hDepth / (CUP_HANDLE_MAX_DEPTH * cupDepth);
      const conf = round(0.5 * cup.confidence + 0.5 * (0.4 + 0.6 * shallowScore));
      if (best === null || conf > best.conf) {
        best = { conf, hEnd, hLowIdx: minIdx, hDepth };
      }
    }
    if (best === null || best.conf < CONFIDENCE_THRESHOLD) continue;

    out.push({
      type: "cup-and-handle",
      category: "continuation",
      confidence: best.conf,
      range: { start: cup.range.start, end: candles[best.hEnd].date },
      keyPoints: [
        cup.keyPoints[0], // left rim
        cup.keyPoints[1], // cup bottom
        cup.keyPoints[2], // right rim
        {
          date: candles[best.hLowIdx].date,
          price: candles[best.hLowIdx].low,
          kind: "handle",
        },
      ],
      note: `U-shaped cup then shallow handle (${((best.hDepth / cupDepth) * 100).toFixed(
        0,
      )}% of cup depth)`,
    });
  }
  return dropOverlapping(out);
}

// ---------- Other: Diamond Top/Bottom ----------

// A compound shape: a broadening formation (first half) that resolves into a
// converging triangle (second half). Reuses lineFit/rSquared on each half of
// the same recent-pivot window trendLineShapes already scans.
const DIAMOND_LOOKBACK = 14;
const DIAMOND_MIN_FIT = 0.3;
const DIAMOND_FLAT = 0.15;

function diamondPatterns(pivots: Pivot[], candles: Candle[]): Pattern[] {
  const recent = pivots.slice(-DIAMOND_LOOKBACK);
  if (recent.length < 8) return [];
  const midIdx = recent[Math.floor(recent.length / 2)].index;
  const firstHalf = recent.filter((p) => p.index <= midIdx);
  const secondHalf = recent.filter((p) => p.index >= midIdx);
  const pk1 = peaks(firstHalf);
  const tr1 = troughs(firstHalf);
  const pk2 = peaks(secondHalf);
  const tr2 = troughs(secondHalf);
  if (pk1.length < 2 || tr1.length < 2 || pk2.length < 2 || tr2.length < 2) return [];

  const upper1 = lineFit(pk1);
  const lower1 = lineFit(tr1);
  const upper2 = lineFit(pk2);
  const lower2 = lineFit(tr2);
  const fitQ =
    (rSquared(pk1, upper1) + rSquared(tr1, lower1) + rSquared(pk2, upper2) + rSquared(tr2, lower2)) / 4;
  if (fitQ < DIAMOND_MIN_FIT) return [];

  const priceScale = recent.reduce((s, p) => s + p.price, 0) / recent.length / candles.length;
  const su1 = upper1.slope / priceScale;
  const sl1 = lower1.slope / priceScale;
  const su2 = upper2.slope / priceScale;
  const sl2 = lower2.slope / priceScale;
  const diverging = su1 > DIAMOND_FLAT && sl1 < -DIAMOND_FLAT;
  const converging = su2 < -DIAMOND_FLAT && sl2 > DIAMOND_FLAT;
  if (!diverging || !converging) return [];

  const start = candles[recent[0].index];
  const end = candles[recent[recent.length - 1].index];
  const conf = round(0.4 + 0.6 * fitQ);
  if (conf < CONFIDENCE_THRESHOLD) return [];

  return [
    {
      type: end.close < start.close ? "diamond-top" : "diamond-bottom",
      category: "other",
      confidence: conf,
      range: { start: start.date, end: end.date },
      keyPoints: recent.map((p) => ({ date: p.date, price: p.price, kind: p.type })),
      note: "widens then narrows (broadening followed by converging triangle)",
    },
  ];
}

// ---------- Reversal: Island Reversal ----------

// An isolated cluster of bars sealed off by two opposite-direction gaps: a
// gap in, a few flat bars, a gap back out the other way. Reuses the same
// gap-detection threshold as `gaps()` but tracks bar index (needed to pair
// gaps within a short window) rather than only emitting per-gap patterns.
const ISLAND_MAX_GAP_BARS = 6;
const ISLAND_MIN_GAP_SIZE = 0.02;

interface GapEvent {
  index: number;
  date: string;
  up: boolean;
  level: number;
}

function scanGapEvents(candles: Candle[]): GapEvent[] {
  const out: GapEvent[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];
    const up = cur.low > prev.high;
    const down = cur.high < prev.low;
    if (!up && !down) continue;
    const gapSize = up ? (cur.low - prev.high) / prev.high : (prev.low - cur.high) / prev.low;
    if (gapSize < ISLAND_MIN_GAP_SIZE) continue;
    out.push({ index: i, date: cur.date, up, level: up ? prev.high : prev.low });
  }
  return out;
}

function islandReversals(candles: Candle[]): Pattern[] {
  const events = scanGapEvents(candles);
  const out: Pattern[] = [];
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i];
      const b = events[j];
      if (b.index - a.index > ISLAND_MAX_GAP_BARS) break; // events sorted by index
      if (a.up === b.up) continue; // must be opposite directions
      const island = candles.slice(a.index, b.index);
      if (island.length === 0) continue;
      const isTopIsland = a.up; // gapped up in, gapped down out -> sits above both sides
      const isolated = isTopIsland
        ? island.every((k) => k.low > a.level) && island.every((k) => k.high > b.level)
        : island.every((k) => k.high < a.level) && island.every((k) => k.low < b.level);
      if (!isolated) continue;
      const conf = round(Math.min(1, 0.5 + (Math.abs(a.level - b.level) / a.level) * 5));
      if (conf < CONFIDENCE_THRESHOLD) continue;
      out.push({
        type: "island-reversal",
        category: "reversal",
        confidence: conf,
        range: { start: a.date, end: b.date },
        keyPoints: [
          { date: a.date, price: a.level, kind: "gap-edge" },
          { date: b.date, price: b.level, kind: "gap-edge" },
        ],
        note: `${isTopIsland ? "top" : "bottom"} island: bars isolated between opposite-direction gaps`,
      });
    }
  }
  return dropOverlapping(out);
}

function round(v: number, dp = 3): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** Run every detector, filter by threshold, sort by confidence desc. */
export function detectPatterns(candles: Candle[], window = 5): Pattern[] {
  const pivots = findPivots(candles, window);
  const all: Pattern[] = [
    ...headAndShoulders(pivots, false),
    ...headAndShoulders(pivots, true),
    ...doubleTripleExtreme(pivots, true, 2),
    ...doubleTripleExtreme(pivots, false, 2),
    ...doubleTripleExtreme(pivots, true, 3),
    ...doubleTripleExtreme(pivots, false, 3),
    ...trendLineShapes(pivots, candles),
    ...roundingPatterns(candles),
    ...vReversalPatterns(pivots, candles),
    ...flagPennantPatterns(candles),
    ...cupAndHandlePatterns(candles),
    ...diamondPatterns(pivots, candles),
    ...islandReversals(candles),
    ...gaps(candles),
    ...movingAverageCrosses(candles),
  ];
  return all
    .filter((p) => p.confidence >= CONFIDENCE_THRESHOLD)
    .sort((a, b) => b.confidence - a.confidence);
}

export { findPivots as _findPivots };

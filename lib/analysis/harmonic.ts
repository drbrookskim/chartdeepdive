// Harmonic patterns (Gartley / Butterfly / Bat / Crab) per
// references/harmonic-patterns.md. Built on the same pivot primitive as the
// structural patterns: slide over 5 consecutive alternating pivots (X,A,B,C,D)
// and test the Fibonacci ratios AB/XA, BC/AB, CD/BC, AD/XA against each pattern.

import type { Candle } from "@/lib/schema";
import { findPivots } from "@/lib/analysis/patterns";
import type { Pattern, KeyPoint } from "@/lib/analysis/patterns";

interface Ratio {
  min: number;
  max: number;
}
interface HarmonicDef {
  type: string;
  abXa: Ratio;
  bcAb: Ratio;
  cdBc: Ratio;
  adXa: Ratio;
}

// ±5% tolerance is folded into the min/max bands below.
const DEFS: HarmonicDef[] = [
  {
    type: "gartley",
    abXa: { min: 0.588, max: 0.648 },
    bcAb: { min: 0.382, max: 0.886 },
    cdBc: { min: 1.13, max: 1.618 },
    adXa: { min: 0.747, max: 0.825 },
  },
  {
    type: "butterfly",
    abXa: { min: 0.747, max: 0.825 },
    bcAb: { min: 0.382, max: 0.886 },
    cdBc: { min: 1.618, max: 2.24 },
    adXa: { min: 1.27, max: 1.618 },
  },
  {
    type: "bat",
    abXa: { min: 0.382, max: 0.5 },
    bcAb: { min: 0.382, max: 0.886 },
    cdBc: { min: 1.618, max: 2.618 },
    adXa: { min: 0.841, max: 0.931 },
  },
  {
    type: "crab",
    abXa: { min: 0.382, max: 0.618 },
    bcAb: { min: 0.382, max: 0.886 },
    cdBc: { min: 2.24, max: 3.618 },
    adXa: { min: 1.538, max: 1.698 },
  },
];

const CONF_MIN = 0.5;

/** 1.0 at band center, decaying to 0 at the band edges (and beyond). */
function bandScore(v: number, r: Ratio): number {
  if (v < r.min || v > r.max) return 0;
  const center = (r.min + r.max) / 2;
  const half = (r.max - r.min) / 2 || 1e-9;
  return 1 - Math.abs(v - center) / half;
}

export function detectHarmonic(candles: Candle[], window = 5): Pattern[] {
  const pivots = findPivots(candles, window);
  const out: Pattern[] = [];
  for (let i = 0; i + 4 < pivots.length; i++) {
    const [X, A, B, C, D] = pivots.slice(i, i + 5);
    // XABCD must alternate peak/trough to be a valid harmonic leg sequence.
    if (
      X.type === A.type ||
      A.type === B.type ||
      B.type === C.type ||
      C.type === D.type
    )
      continue;
    const XA = Math.abs(A.price - X.price);
    const AB = Math.abs(B.price - A.price);
    const BC = Math.abs(C.price - B.price);
    const CD = Math.abs(D.price - C.price);
    const AD = Math.abs(D.price - A.price);
    if (XA === 0 || AB === 0 || BC === 0) continue;
    const rAbXa = AB / XA;
    const rBcAb = BC / AB;
    const rCdBc = CD / BC;
    const rAdXa = AD / XA;

    for (const def of DEFS) {
      const s1 = bandScore(rAbXa, def.abXa);
      const s2 = bandScore(rBcAb, def.bcAb);
      const s3 = bandScore(rCdBc, def.cdBc);
      const s4 = bandScore(rAdXa, def.adXa);
      // Any ratio outside its band disqualifies the pattern.
      if (s1 === 0 || s2 === 0 || s3 === 0 || s4 === 0) continue;
      const conf = Math.round(((s1 + s2 + s3 + s4) / 4) * 1000) / 1000;
      if (conf < CONF_MIN) continue;
      const kp: KeyPoint[] = [X, A, B, C, D].map((p, idx) => ({
        date: p.date,
        price: p.price,
        kind: ["X", "A", "B", "C", "D"][idx],
      }));
      out.push({
        type: `harmonic-${def.type}`,
        category: "harmonic",
        confidence: conf,
        range: { start: X.date, end: D.date },
        keyPoints: kp,
        note: "D is the potential reversal zone (PRZ)",
      });
    }
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

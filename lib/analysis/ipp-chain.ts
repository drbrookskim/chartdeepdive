// IPP-Continuation Chain (per the `ipp-continuation-chain` skill). Chains
// three independent modules — inflection-point-predictor (WHEN/WHICH WAY),
// smc (IS IT STRUCTURALLY REAL), elliott (HOW FAR/HOW LONG) — without ever
// merging their outputs into one score. Each stage can halt the chain; later
// stages are omitted (not guessed) when an earlier one doesn't clear.
//
// Deliberately does NOT: emit a combined score, attach a price target to an
// unconfirmed reversal, or decide buy/sell. See the skill's "하지 않는 것".

import type { Candle } from "@/lib/schema";
import type { InflectionPoint, InflectionResult } from "@/lib/analysis/inflection";
import type { SmcResult } from "@/lib/analysis/smc";
import type { ElliottResult } from "@/lib/analysis/elliott";

// An IPP point further back than this from the last candle isn't "the
// current signal" anymore — it's just backtest history. inflectionPoints()
// is explicitly backtest-style (see its own `note`), and its OWN pivot
// detection already has a built-in ~5-bar confirmation lag before a point
// can even be flagged, so "recent" has to be wider than it sounds — 30 bars
// (~6 weeks) rather than a tight 2-3 week window that would rarely ever
// find a current point to chain (checked empirically: real IPP hits
// commonly land 20-100+ bars back, since the >=2-corroborating-rule
// requirement makes them sparse events, not a handful of days old).
const STALE_BARS = 30;

export interface ChainStructure {
  status: "confirmed" | "unconfirmed" | "no-signal";
  label: string;
  detail: string;
}

export interface ChainSizing {
  available: boolean;
  label: string;
  /** Fibonacci retracement target range for the post-impulse correction, or
   * null when a count exists but isn't current, or no count exists at all. */
  targetRange: { low: number; high: number } | null;
  detail: string;
}

export interface IppChainResult {
  anchor: InflectionPoint | null;
  structure: ChainStructure | null;
  sizing: ChainSizing | null;
  /** The four-line, non-merged report per the skill's step-4 format. */
  summary: string;
}

function ippLine(anchor: InflectionPoint | null): string {
  if (!anchor) return "[반전 시점/방향] IPP: 추적할 변곡 신호 없음";
  const dir = anchor.direction === "up" ? "BULLISH_REVERSAL" : "BEARISH_REVERSAL";
  return `[반전 시점/방향] IPP: ${dir}, ${anchor.date} 확인, confidence ${anchor.confidence.toFixed(2)}`;
}

function structureLine(s: ChainStructure | null): string {
  if (!s) return "[구조 확인]      SMC: (평가 안 함 — 추적할 IPP 신호 없음)";
  return `[구조 확인]      SMC: ${s.label} — ${s.detail}`;
}

function sizingLine(s: ChainSizing | null): string {
  if (!s) return "[크기·기간]      Elliott: (평가 안 함 — 구조 미확인)";
  if (!s.available) return `[크기·기간]      Elliott: ${s.label} — ${s.detail}`;
  const r = s.targetRange!;
  return `[크기·기간]      Elliott: ${s.label}, 되돌림 목표가 범위 ${r.low.toFixed(2)}~${r.high.toFixed(2)}`;
}

export function ippContinuationChain(
  candles: Candle[],
  ipp: InflectionResult,
  smcResult: SmcResult,
  elliott: ElliottResult,
): IppChainResult {
  const last = ipp.points[ipp.points.length - 1] ?? null;
  const lastIdx = last ? candles.findIndex((c) => c.date === last.date) : -1;
  const isCurrent = last != null && lastIdx >= 0 && candles.length - 1 - lastIdx <= STALE_BARS;
  const anchor = isCurrent ? last : null;

  // Step 1 halt: no current reversal signal to chain.
  if (!anchor) {
    const summary = [
      ippLine(null),
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      "종합 해석: 지금은 추적할 변곡 신호 없음 — IPP가 최근 구간에서 반전을 찍지 않음.",
    ].join("\n");
    return { anchor: null, structure: null, sizing: null, summary };
  }

  // Step 2: structural confirmation via SMC.
  let structure: ChainStructure;
  if (!smcResult.event) {
    structure = { status: "no-signal", label: "판단 보류", detail: smcResult.reason ?? "구조적 확인 신호 없음" };
  } else if (smcResult.event.type === "ChoCH" && smcResult.event.direction === anchor.direction) {
    structure = {
      status: "confirmed",
      label: "구조 확인",
      detail: `ChoCH ${smcResult.event.direction === "up" ? "bullish" : "bearish"} (${smcResult.event.date}) — 종가 ${smcResult.event.price.toFixed(2)}가 스윙 ${smcResult.event.brokenLevel.price.toFixed(2)}(${smcResult.event.brokenLevel.date}) 돌파, IPP 방향과 일치`,
    };
  } else if (smcResult.event.type === "BOS" && smcResult.event.direction !== anchor.direction) {
    structure = {
      status: "unconfirmed",
      label: "미확인 — 페이크아웃 가능성",
      detail: `BOS ${smcResult.event.direction === "up" ? "bullish" : "bearish"} (${smcResult.event.date}) — 기존 추세 지속 중, IPP가 찍은 반전이 구조상 아직 안 깨짐`,
    };
  } else {
    structure = {
      status: "unconfirmed",
      label: "미확인",
      detail: `최근 구조 이벤트(${smcResult.event.type} ${smcResult.event.direction})가 IPP 방향과 정합적이지 않음`,
    };
  }

  if (structure.status !== "confirmed") {
    const summary = [
      ippLine(anchor),
      structureLine(structure),
      sizingLine(null),
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      `종합 해석: IPP가 ${anchor.date}에 ${anchor.direction === "up" ? "상승" : "하락"} 반전을 찍었으나, SMC 구조 확인이 "${structure.label}"이라 목표가 단계로 넘어가지 않음.`,
    ].join("\n");
    return { anchor, structure, sizing: null, summary };
  }

  // Step 3: sizing via Elliott — only reached when structure confirmed.
  let sizing: ChainSizing;
  if (!elliott.impulse) {
    sizing = {
      available: false,
      label: "파동 카운트 불확실, 미제공",
      targetRange: null,
      detail: elliott.reason ?? "유효한 임펄스 카운트 없음",
    };
  } else if (!elliott.impulse.completed) {
    sizing = {
      available: false,
      label: "파동 카운트 불확실, 미제공",
      targetRange: null,
      detail: "가장 최근 유효 임펄스가 현재 시점과 이어지지 않음(과거 구간에서 발견됨) — 현재 파동 위치를 단정할 수 없어 목표가 생략",
    };
  } else {
    const { direction, start, waves } = elliott.impulse;
    const wave5 = waves[waves.length - 1];
    const totalMove = wave5.price - start.price;
    const fib382 = wave5.price - totalMove * 0.382;
    const fib618 = wave5.price - totalMove * 0.618;
    const targetRange = { low: Math.min(fib382, fib618), high: Math.max(fib382, fib618) };
    const supportsAnchor = (direction === "up" && anchor.direction === "down") || (direction === "down" && anchor.direction === "up");
    sizing = {
      available: true,
      label:
        direction === "up"
          ? `5파 상승 완료, 되돌림 구간 진입 가능성${supportsAnchor ? " (IPP 하락반전과 부합)" : ""}`
          : `5파 하락 완료, 되돌림(반등) 구간 진입 가능성${supportsAnchor ? " (IPP 상승반전과 부합)" : ""}`,
      targetRange,
      detail: `임펄스 시작 ${start.date}(${start.price.toFixed(2)}) ~ 파동5 ${wave5.date}(${wave5.price.toFixed(2)}) 구간의 38.2%~61.8% 되돌림`,
    };
  }

  const summary = [
    ippLine(anchor),
    structureLine(structure),
    sizingLine(sizing),
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `종합 해석: IPP가 ${anchor.date}에 ${anchor.direction === "up" ? "상승" : "하락"} 반전을 찍었고, SMC가 구조적으로 확인했음. ` +
      (sizing.available
        ? `Elliott은 ${sizing.label} — 목표가 범위 ${sizing.targetRange!.low.toFixed(2)}~${sizing.targetRange!.high.toFixed(2)}.`
        : `Elliott은 파동 카운트가 불확실해 크기·기간은 제공하지 않음.`),
  ].join("\n");

  return { anchor, structure, sizing, summary };
}

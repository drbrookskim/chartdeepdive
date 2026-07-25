// IPP-Continuation Chain (per the `ipp-continuation-chain` skill). Chains
// three independent modules — inflection-point-predictor (WHEN/WHICH WAY),
// smc (IS IT STRUCTURALLY REAL), elliott (HOW FAR/HOW LONG) — without ever
// merging their outputs into one score. Each stage can halt the chain; later
// stages are omitted (not guessed) when an earlier one doesn't clear.
//
// All user-facing text below is plain Korean — no bare BOS/ChoCH/SMC/IPP
// acronyms — since these strings render directly in the inflection-point
// popup (see ChartStack.tsx's openInflectionPopup).
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

/** "종가 X가 Y(날짜)를 상향/하향 돌파" — the sentence shared by BOS/ChoCH detail text. */
function breakSentence(dirKr: string, event: NonNullable<SmcResult["event"]>): string {
  const verb = event.direction === "up" ? "상향" : "하향";
  return `${event.date} 종가 ${event.price.toFixed(2)}가 직전 전환점 ${event.brokenLevel.price.toFixed(2)}(${event.brokenLevel.date})를 ${verb} 돌파`;
}

function ippLine(anchor: InflectionPoint | null): string {
  if (!anchor) return "[반전 시점/방향] 변곡점 예측: 추적할 신호 없음";
  const dir = anchor.direction === "up" ? "상승 반전" : "하락 반전";
  return `[반전 시점/방향] 변곡점 예측: ${dir}, ${anchor.date} 확인, 신뢰점수 ${anchor.confidence.toFixed(2)}`;
}

function structureLine(s: ChainStructure | null): string {
  if (!s) return "[구조 확인]      시장 구조: (평가 안 함 — 추적할 변곡점 신호 없음)";
  return `[구조 확인]      시장 구조: ${s.label} — ${s.detail}`;
}

function sizingLine(s: ChainSizing | null): string {
  if (!s) return "[크기·기간]      엘리엇 파동: (평가 안 함 — 구조 미확인)";
  if (!s.available) return `[크기·기간]      엘리엇 파동: ${s.label} — ${s.detail}`;
  const r = s.targetRange!;
  return `[크기·기간]      엘리엇 파동: ${s.label}, 되돌림 목표가 범위 ${r.low.toFixed(2)}~${r.high.toFixed(2)}`;
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
      "종합 해석: 지금은 추적할 변곡 신호가 없습니다 — 최근 구간에서 변곡점 예측이 반전을 찍지 않았습니다.",
    ].join("\n");
    return { anchor: null, structure: null, sizing: null, summary };
  }

  // Step 2: structural confirmation — does the market's actual swing
  // structure back up the direction the inflection point called?
  const anchorDirKr = anchor.direction === "up" ? "상승" : "하락";
  let structure: ChainStructure;
  if (!smcResult.event) {
    structure = {
      status: "no-signal",
      label: "판단 보류",
      detail: smcResult.reason ?? "최근 구간에 뚜렷한 구조 전환·돌파가 없어 확인할 근거가 없음",
    };
  } else if (smcResult.event.type === "ChoCH" && smcResult.event.direction === anchor.direction) {
    structure = {
      status: "confirmed",
      label: "구조 확인",
      detail: `추세 방향이 실제로 ${anchorDirKr}으로 바뀌는 전환이 확인됨 — ${breakSentence(anchorDirKr, smcResult.event)}, 변곡점 예측과 같은 방향`,
    };
  } else if (smcResult.event.type === "BOS" && smcResult.event.direction !== anchor.direction) {
    structure = {
      status: "unconfirmed",
      label: "미확인 — 페이크아웃 가능성",
      detail: `기존 추세가 아직 이어지는 중(추세 지속 돌파) — ${breakSentence(anchorDirKr, smcResult.event)}, 변곡점 예측이 찍은 반전이 구조적으로는 아직 깨지지 않음`,
    };
  } else {
    const eventDirKr = smcResult.event.direction === "up" ? "상승" : "하락";
    structure = {
      status: "unconfirmed",
      label: "미확인",
      detail: `가장 최근 구조 변화가 ${eventDirKr} 방향이라 변곡점 예측의 ${anchorDirKr} 반전과 서로 맞지 않음`,
    };
  }

  if (structure.status !== "confirmed") {
    const summary = [
      ippLine(anchor),
      structureLine(structure),
      sizingLine(null),
      "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      `종합 해석: 변곡점 예측이 ${anchor.date}에 ${anchorDirKr} 반전을 찍었지만, 시장 구조 확인 결과가 "${structure.label}"이라 목표가 단계로는 넘어가지 않습니다.`,
    ].join("\n");
    return { anchor, structure, sizing: null, summary };
  }

  // Step 3: sizing via Elliott wave — only reached once structure is confirmed.
  let sizing: ChainSizing;
  if (!elliott.impulse) {
    sizing = {
      available: false,
      label: "파동 카운트 불확실, 목표가 미제공",
      targetRange: null,
      detail: elliott.reason ?? "규칙을 만족하는 엘리엇 파동 카운트가 없음",
    };
  } else if (!elliott.impulse.completed) {
    sizing = {
      available: false,
      label: "파동 카운트 불확실, 목표가 미제공",
      targetRange: null,
      detail: "가장 최근에 확인된 엘리엇 파동이 현재 시점과 이어지지 않고 과거 구간에서 끝나 있어, 지금 파동이 어디쯤인지 단정할 수 없음(목표가 생략)",
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
          ? `상승 5개 파동 완료, 하락 되돌림 구간 진입 가능성${supportsAnchor ? " (변곡점 예측의 하락 반전과 부합)" : ""}`
          : `하락 5개 파동 완료, 반등 되돌림 구간 진입 가능성${supportsAnchor ? " (변곡점 예측의 상승 반전과 부합)" : ""}`,
      targetRange,
      detail: `파동 시작점 ${start.date}(${start.price.toFixed(2)})부터 5번째 파동 ${wave5.date}(${wave5.price.toFixed(2)})까지 움직인 구간을 기준으로, 그중 38.2%~61.8%만큼 되돌아올 것으로 추정한 가격대`,
    };
  }

  const summary = [
    ippLine(anchor),
    structureLine(structure),
    sizingLine(sizing),
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    `종합 해석: 변곡점 예측이 ${anchor.date}에 ${anchorDirKr} 반전을 찍었고, 시장 구조로도 확인됐습니다. ` +
      (sizing.available
        ? `엘리엇 파동 분석 결과 ${sizing.label} — 목표가 범위는 ${sizing.targetRange!.low.toFixed(2)}~${sizing.targetRange!.high.toFixed(2)}입니다.`
        : `다만 엘리엇 파동 카운트가 불확실해 목표가·기간은 제공하지 않습니다.`),
  ].join("\n");

  return { anchor, structure, sizing, summary };
}

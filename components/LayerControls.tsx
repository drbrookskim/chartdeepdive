"use client";

import { useState } from "react";
import type { AnalysisResult } from "@/lib/api";
import type { Pattern } from "@/lib/analysis/patterns";
import type { LayerState } from "@/components/ChartStack";
import { patternLabel, categoryLabel, categoryColorVar } from "@/lib/format";

const SUPPORTED_PATTERNS =
  "지원 패턴: 헤드앤숄더/역H&S, 이중·삼중 천장/바닥, 원형바닥/천장, V자반전, 삼각수렴(상승·하락·대칭), 박스권, 쐐기(상승·하락), 채널(상승·하강), 깃발/페넌트, 컵앤핸들, 확산형, 다이아몬드, 갭(돌파·추세·소멸·일반), 섬반전, 하모닉(Gartley·Butterfly·Bat·Crab).";

interface Props {
  analysis: AnalysisResult | null;
  layers: LayerState;
  onLayer: (key: keyof LayerState) => void;
  showPatterns: boolean;
  onTogglePatterns: () => void;
  patternsWithKeys: { p: Pattern; key: string }[];
  selectedKeys: Set<string>;
  onTogglePatternKey: (key: string) => void;
  onSelectAllPatterns: () => void;
  onDeselectAllPatterns: () => void;
  /** Caps the pattern list's height to match the main candle chart's live
   * rendered height (px) and makes it scroll internally instead of pushing
   * the whole sidebar/page taller. Null until ChartStack reports a height. */
  patternListMaxHeight: number | null;
}

/** A checkbox row that greys out (with a reason tooltip) when unavailable. */
function CheckRow({
  label,
  sub,
  checked,
  disabled,
  reason,
  onClick,
}: {
  label: string;
  sub?: string;
  checked: boolean;
  disabled?: boolean;
  reason?: string;
  onClick: () => void;
}) {
  return (
    <div
      className={`rowitem ${disabled ? "disabled" : ""}`}
      title={disabled ? reason : undefined}
    >
      <button
        className="rowitem__toggle"
        onClick={disabled ? undefined : onClick}
        disabled={disabled}
        aria-pressed={checked}
      >
        <span className={`cb ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}`}>
          {disabled ? "⊘" : checked ? "✓" : ""}
        </span>
        <span>
          {label}
          {sub && <> <span className="sublabel">{sub}</span></>}
        </span>
      </button>
      {disabled && reason && <span className="tag">{shortReason(reason)}</span>}
    </div>
  );
}

/** Turn a backend reason ("need 120 candles, have 21") into a compact tag. */
function shortReason(reason: string): string {
  const m = reason.match(/need (\d+) candles?, have (\d+)/);
  if (m) return `캔들 ${m[1]}개 필요 (현재 ${m[2]})`;
  if (/not implemented/.test(reason)) return "이 빌드에서 미제공";
  return reason;
}

export default function LayerControls({
  analysis,
  layers,
  onLayer,
  showPatterns,
  onTogglePatterns,
  patternsWithKeys,
  selectedKeys,
  onTogglePatternKey,
  onSelectAllPatterns,
  onDeselectAllPatterns,
  patternListMaxHeight,
}: Props) {
  const ind = analysis?.indicators;
  const un = analysis?.meta.unavailable ?? {};

  const maPeriods = ind?.sma?.byPeriod.map((b) => b.period) ?? [];
  const missingMa = Object.keys(un)
    .filter((k) => /^indicators\.sma\.\d+$/.test(k))
    .map((k) => Number(k.split(".")[2]));

  const patternsUnavailable = "patterns" in un;

  // Section header click expands/collapses the checkbox list, same as ②
  // 패턴's header already does — it no longer doubles as a shortcut for
  // toggling the first checkbox (that's what the checkbox's own row is for).
  const [expandBasic, setExpandBasic] = useState(true);
  const [expandAdvanced, setExpandAdvanced] = useState(true);

  const BASIC_KEYS: (keyof LayerState)[] = ["ma", "ema", "bollinger", "volume", "volumeProfile", "rsi", "macd"];
  const ADVANCED_KEYS: (keyof LayerState)[] = ["ichimoku", "elliott", "inflection"];

  // The section-level switch is a master on/off: off -> on turns on just the
  // section's representative default (이동평균/일목균형표) and expands the
  // list so the result is visible; on -> off turns off whatever in the
  // section is currently on.
  function toggleSection(keys: (keyof LayerState)[], defaultKey: keyof LayerState, expand: (v: boolean) => void) {
    const anyOn = keys.some((k) => layers[k]);
    if (anyOn) {
      keys.forEach((k) => {
        if (layers[k]) onLayer(k);
      });
    } else {
      onLayer(defaultKey);
      expand(true);
    }
  }

  return (
    <div className="sidecol__inner">
      {/* ---- Layer 1: basic indicators ---- */}
      <div className="layer">
        <button className="layer__head" onClick={() => setExpandBasic((v) => !v)}>
          <strong>① 기본 지표</strong>
          <span
            className={`switch ${BASIC_KEYS.some((k) => layers[k]) ? "on" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              toggleSection(BASIC_KEYS, "ma", setExpandBasic);
            }}
          />
        </button>
        {expandBasic && (
        <div className="layer__body">
          <CheckRow
            label="이동평균(MA)"
            sub={maPeriods.length ? maPeriods.join("·") : undefined}
            checked={layers.ma}
            disabled={!ind?.sma}
            reason={un["indicators.sma"]}
            onClick={() => onLayer("ma")}
          />
          {missingMa.length > 0 && (
            <div className="rowitem disabled">
              <span className="rowitem__toggle" style={{ cursor: "default" }}>
                <span className="cb disabled">⊘</span>
                <span>MA {missingMa.join("·")}</span>
              </span>
              <span className="tag">{shortReason(un[`indicators.sma.${missingMa[0]}`])}</span>
            </div>
          )}
          <CheckRow
            label="지수이동평균(EMA)"
            sub={maPeriods.length ? maPeriods.join("·") : undefined}
            checked={layers.ema}
            disabled={!ind?.ema}
            reason={un["indicators.ema"]}
            onClick={() => onLayer("ema")}
          />
          <CheckRow
            label="볼린저밴드"
            checked={layers.bollinger}
            disabled={!ind?.bollinger}
            reason={un["indicators.bollinger"]}
            onClick={() => onLayer("bollinger")}
          />
          <CheckRow
            label="거래량"
            sub="서브패널"
            checked={layers.volume}
            onClick={() => onLayer("volume")}
          />
          <CheckRow
            label="매물대"
            sub="가격대별 거래량"
            checked={layers.volumeProfile}
            onClick={() => onLayer("volumeProfile")}
          />
          <CheckRow
            label="RSI"
            sub="서브패널"
            checked={layers.rsi}
            disabled={!ind?.rsi}
            reason={un["indicators.rsi"]}
            onClick={() => onLayer("rsi")}
          />
          <CheckRow
            label="MACD"
            sub="서브패널"
            checked={layers.macd}
            disabled={!ind?.macd}
            reason={un["indicators.macd"]}
            onClick={() => onLayer("macd")}
          />
        </div>
        )}
      </div>

      {/* ---- Layer 2: patterns ---- */}
      <div className="layer">
        <button className="layer__head" onClick={onTogglePatterns}>
          <strong>
            ② 패턴{" "}
            {!patternsUnavailable && (
              <span className="tag">탐지 {patternsWithKeys.length}건</span>
            )}
          </strong>
          <span className={`switch ${showPatterns ? "on" : ""}`} />
        </button>
        {showPatterns && (
          <div className="layer__body">
            {patternsUnavailable ? (
              <div className="note-line">{shortReason(un["patterns"])}</div>
            ) : patternsWithKeys.length === 0 ? (
              <div className="note-line">탐지된 패턴이 없습니다.</div>
            ) : (
              <>
                <div className="patternlist__selectall">
                  <span>{selectedKeys.size}/{patternsWithKeys.length}개 표시 중</span>
                  <button onClick={onSelectAllPatterns}>전체 선택</button>
                  <button onClick={onDeselectAllPatterns}>전체 해제</button>
                </div>
                <div
                  className="patternlist"
                  style={patternListMaxHeight ? { maxHeight: patternListMaxHeight, overflowY: "auto" } : undefined}
                >
                  {patternsWithKeys.map(({ p, key }) => {
                    const checked = selectedKeys.has(key);
                    return (
                      <button
                        key={key}
                        className={`patternitem ${checked ? "selected" : ""}`}
                        onClick={() => onTogglePatternKey(key)}
                        aria-pressed={checked}
                      >
                        <span className={`cb ${checked ? "checked" : ""}`}>
                          {checked ? "✓" : ""}
                        </span>
                        <span
                          className="dot"
                          style={{ background: `var(${categoryColorVar(p.category)})` }}
                        />
                        <span className="patternitem__name">
                          {patternLabel(p.type)}
                          <span className="patternitem__cat"> · {categoryLabel(p.category)}</span>
                        </span>
                        <span className="patternitem__conf">{p.confidence.toFixed(2)}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
            <div className="note-line" title={SUPPORTED_PATTERNS}>
              ⓘ 현재 탐지 범위 (마우스를 올려 확인)
            </div>
          </div>
        )}
      </div>

      {/* ---- Layer 3: advanced techniques ---- */}
      <div className="layer">
        <button className="layer__head" onClick={() => setExpandAdvanced((v) => !v)}>
          <strong>③ 고급 기법</strong>
          <span
            className={`switch ${ADVANCED_KEYS.some((k) => layers[k]) ? "on" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              toggleSection(ADVANCED_KEYS, "ichimoku", setExpandAdvanced);
            }}
          />
        </button>
        {expandAdvanced && (
        <div className="layer__body">
          <CheckRow
            label="일목균형표"
            checked={layers.ichimoku}
            disabled={!analysis?.advanced.ichimoku}
            reason={un["advanced.ichimoku"]}
            onClick={() => onLayer("ichimoku")}
          />
          <CheckRow
            label="엘리엇 파동"
            checked={layers.elliott}
            // The elliottWave object itself is always present — it's
            // .impulse that's null when the most recent swing sequence
            // doesn't satisfy the impulse rules, which used to leave the
            // checkbox checkable-but-silently-empty (nothing ever drew on
            // the chart, no indication why). .reason carries the specific
            // rule that failed for *this* symbol/period, dynamic per
            // analysis — not from the static `un` unavailable-reasons map.
            disabled={!analysis?.advanced.elliottWave?.impulse}
            reason={analysis?.advanced.elliottWave?.reason ?? un["advanced.elliottWave"]}
            onClick={() => onLayer("elliott")}
          />
          <CheckRow
            label="변곡점 예측"
            sub={
              analysis?.advanced.inflectionPoints
                ? `탐지 ${analysis.advanced.inflectionPoints.points.length}건`
                : undefined
            }
            checked={layers.inflection}
            disabled={!analysis?.advanced.inflectionPoints}
            reason={un["advanced.inflectionPoints"]}
            onClick={() => onLayer("inflection")}
          />
          {analysis?.advanced.inflectionPoints && (
            <div className="note-line" title={analysis.advanced.inflectionPoints.note}>
              ⓘ 규칙 기반(ML·뉴스 제외) — 마우스를 올려 확인
            </div>
          )}
          <div className="note-line">
            데이터 부족·미구현 지표는 숨기지 않고 항상 사유를 표시합니다. 고급 기법은
            한 번에 하나만 켜는 것을 권장합니다.
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

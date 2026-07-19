"use client";

import type { AnalysisResult } from "@/lib/api";
import type { Pattern } from "@/lib/analysis/patterns";
import { patternLabel, signalText } from "@/lib/format";

interface Props {
  analysis: AnalysisResult | null;
  topPattern: Pattern | null;
  onClose: () => void;
}

export default function SignalPopover({ analysis, topPattern, onClose }: Props) {
  const ich = analysis?.advanced.ichimoku;
  const ell = analysis?.advanced.elliottWave;
  const infl = analysis?.advanced.inflectionPoints;

  return (
    <div className="signalpop" role="dialog" aria-label="신호 요약">
      <div className="signalpop__head">신호 요약</div>
      <div className="signalpop__body">
        <SignalLine
          label="일목균형표"
          signal={ich ? ich.signal : null}
          reason={ich ? undefined : "데이터 부족"}
        />
        <SignalLine
          label="엘리엇 파동"
          signal={ell?.impulse ? ell.signal : null}
          reason={ell?.impulse ? undefined : ell?.reason ?? "미검출"}
        />
        <div className="signalrow">
          <span>상위 패턴</span>
          <span className="val neutral">
            {topPattern
              ? `${patternLabel(topPattern.type)} ${topPattern.confidence.toFixed(2)}`
              : "—"}
          </span>
        </div>
        <div className="signalrow">
          <span>변곡점 예측</span>
          <span className="val neutral">
            {infl ? `탐지 ${infl.points.length}건` : "미검출"}
          </span>
        </div>
        {infl && (
          <div className="disclaimer">
            변곡점 confidence는 확률이 아니라 규칙별 고정 가중치 합산 점수입니다
            (거래량이상 0.25 · RSI다이버전스 0.3 · OBV다이버전스 0.25 · BB스퀴즈
            0.2, 최대 1.0). 예: 0.55 = RSI다이버전스+거래량이상 두 규칙 부합.
          </div>
        )}
        <div className="disclaimer">참고용 탐지 요약이며 투자자문이 아닙니다.</div>
      </div>
      <button
        className="link-inline"
        style={{ padding: "0 14px 12px" }}
        onClick={onClose}
      >
        닫기
      </button>
    </div>
  );
}

function SignalLine({
  label,
  signal,
  reason,
}: {
  label: string;
  signal: 1 | -1 | 0 | null;
  reason?: string;
}) {
  if (signal == null) {
    return (
      <div className="signalrow">
        <span>{label}</span>
        <span className="val neutral">{reason ?? "—"}</span>
      </div>
    );
  }
  const s = signalText(signal);
  return (
    <div className="signalrow">
      <span>{label}</span>
      <span className={`val ${s.cls}`}>
        {s.arrow} {s.label}
      </span>
    </div>
  );
}

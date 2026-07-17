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

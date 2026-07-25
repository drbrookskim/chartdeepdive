// Small display helpers shared across chart UI.

/** KR won shows no decimals; other currencies show 2. */
export function formatPrice(value: number, currency: string): string {
  const digits = currency === "KRW" ? 0 : 2;
  const num = value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const symbol =
    currency === "KRW" ? "₩" : currency === "USD" ? "$" : "";
  return symbol ? `${symbol}${num}` : `${num} ${currency}`;
}

/** Main chart's price-axis labels: KRW shows the full won amount as a whole
 * integer (won has no subunit in practice), other currencies always show 2
 * decimal places (cents) — same rule as formatPrice above. */
export function formatAxisPrice(value: number, currency: string): string {
  if (currency === "KRW") return Math.round(value).toLocaleString("ko-KR");
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatSigned(value: number, digits = 2): string {
  const sign = value > 0 ? "+" : value < 0 ? "" : "";
  return `${sign}${value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

/** Korean labels for the machine pattern `type` values from the backend. */
const PATTERN_LABELS: Record<string, string> = {
  "head-and-shoulders": "헤드앤숄더",
  "inverse-head-and-shoulders": "역헤드앤숄더",
  "double-top": "이중천장",
  "double-bottom": "이중바닥",
  "triple-top": "삼중천장",
  "triple-bottom": "삼중바닥",
  "symmetric-triangle": "대칭삼각수렴",
  "ascending-triangle": "상승삼각수렴",
  "descending-triangle": "하락삼각수렴",
  rectangle: "박스권",
  "rising-wedge": "상승쐐기",
  "falling-wedge": "하락쐐기",
  "broadening-formation": "확산형",
  "breakaway-gap": "돌파갭",
  "runaway-gap": "추세갭",
  "exhaustion-gap": "소멸갭",
  "common-gap": "일반갭",
  "harmonic-gartley": "Gartley",
  "harmonic-butterfly": "Butterfly",
  "harmonic-bat": "Bat",
  "harmonic-crab": "Crab",
  "rounding-bottom": "원형바닥",
  "rounding-top": "원형천장",
  "v-reversal": "V자반전",
  flag: "깃발형",
  pennant: "페넌트형",
  "channel-up": "상승채널",
  "channel-down": "하강채널",
  "diamond-top": "다이아몬드천장",
  "diamond-bottom": "다이아몬드바닥",
  "island-reversal": "섬반전",
  "cup-and-handle": "컵앤핸들",
};

/** golden-cross-5-10 / dead-cross-20-60 -> "5·10 골든크로스" (dynamic MA pair). */
function crossLabel(type: string): string | null {
  const m = type.match(/^(golden|dead)-cross-(\d+)-(\d+)$/);
  if (!m) return null;
  const [, kind, shortPeriod, longPeriod] = m;
  return `${shortPeriod}·${longPeriod} ${kind === "golden" ? "골든크로스" : "데드크로스"}`;
}

export function patternLabel(type: string): string {
  return PATTERN_LABELS[type] ?? crossLabel(type) ?? type;
}

const CATEGORY_LABELS: Record<string, string> = {
  reversal: "반전형",
  continuation: "지속형",
  gap: "갭",
  harmonic: "하모닉",
  cross: "크로스",
  other: "기타",
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

/** Korean labels for pattern keyPoint `kind` values (chart marker text). */
const PATTERN_KIND_LABELS: Record<string, string> = {
  top: "고점",
  bottom: "저점",
  peak: "고점",
  trough: "저점",
  rim: "가장자리",
  head: "헤드",
  "left-shoulder": "좌측 어깨",
  "right-shoulder": "우측 어깨",
  "pole-start": "깃대 시작",
  "pole-end": "깃대 끝",
  "consolidation-end": "조정 종료",
  handle: "손잡이",
  "gap-edge": "갭 경계",
  "golden-cross": "골든크로스",
  "dead-cross": "데드크로스",
};

/** X/A/B/C/D (harmonic points) pass through unchanged — standard notation. */
export function patternKindLabel(kind: string): string {
  return PATTERN_KIND_LABELS[kind] ?? kind;
}

/** CSS variable name for a pattern category color. */
export function categoryColorVar(category: string): string {
  switch (category) {
    case "reversal":
      return "--reversal";
    case "continuation":
      return "--continuation";
    case "gap":
      return "--gapcat";
    case "harmonic":
      return "--harmonic";
    case "cross":
      return "--cross";
    default:
      return "--other";
  }
}

const INFLECTION_RULE_LABELS: Record<string, string> = {
  "volume-anomaly": "거래량이상",
  "rsi-divergence": "RSI다이버전스",
  "obv-divergence": "OBV다이버전스",
  "bb-squeeze": "BB스퀴즈",
};

export function inflectionRuleLabel(rule: string): string {
  return INFLECTION_RULE_LABELS[rule] ?? rule;
}

const INFLECTION_RULE_HINTS: Record<string, string> = {
  "volume-anomaly": "거래량이 평소보다 비정상적으로 급증",
  "rsi-divergence": "가격은 오르내리는데 RSI 지표는 반대로 움직이는 엇갈림",
  "obv-divergence": "가격은 오르내리는데 누적거래량(OBV)은 반대로 움직이는 엇갈림",
  "bb-squeeze": "볼린저밴드 폭이 좁아지며 변동성이 줄어든 상태",
};

/** Plain-language parenthetical for a rule label, for popups shown to non-expert users. */
export function inflectionRuleHint(rule: string): string | null {
  return INFLECTION_RULE_HINTS[rule] ?? null;
}

const DIVERGENCE_EXPLAIN: Record<string, string> = {
  "rsi-divergence":
    "다이버전스란 주가와 보조지표(RSI)의 움직임이 서로 반대로 어긋나는 현상으로, 추세가 힘을 잃고 조만간 방향이 바뀔 수 있다는 신호로 봅니다. 주가는 저점을 낮추는데 RSI는 저점을 높이면 상승 반전 신호(하락 에너지 소진), 주가는 고점을 높이는데 RSI는 고점을 낮추면 하락 반전 신호(상승 에너지 고갈)입니다.",
  "obv-divergence":
    "다이버전스란 주가와 보조지표(누적거래량 OBV)의 움직임이 서로 반대로 어긋나는 현상으로, 추세가 힘을 잃고 조만간 방향이 바뀔 수 있다는 신호로 봅니다. 주가는 저점을 낮추는데 OBV는 저점을 높이면 상승 반전 신호(하락 에너지 소진), 주가는 고점을 높이는데 OBV는 고점을 낮추면 하락 반전 신호(상승 에너지 고갈)입니다.",
};

/** Full divergence explanation for a hover tooltip; null for non-divergence rules. */
export function inflectionRuleExplain(rule: string): string | null {
  return DIVERGENCE_EXPLAIN[rule] ?? null;
}

export function signalText(signal: 1 | -1 | 0): {
  label: string;
  cls: "up" | "down" | "neutral";
  arrow: string;
} {
  if (signal === 1) return { label: "강세 (+1)", cls: "up", arrow: "▲" };
  if (signal === -1) return { label: "약세 (-1)", cls: "down", arrow: "▼" };
  return { label: "중립 (0)", cls: "neutral", arrow: "·" };
}

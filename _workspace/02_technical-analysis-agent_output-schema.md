# 02 · Technical Analysis Agent — 출력 스키마 & API 계약

> 이 문서는 기술적 분석 엔진의 **계약(contract)**이다. `frontend-chart-agent`가 렌더링
> 컴포넌트를 설계할 때, `qa-integration-agent`가 코드-문서 대조 검증할 때 참조한다.
> **필드명은 실제 코드(`lib/analysis/*.ts`)와 한 글자도 다르지 않다.** 스키마 변경 시
> 이 문서를 먼저 갱신하고 두 소비 에이전트에 알린다.

- 스택: Next.js 16 (App Router, TypeScript). 라우트 `app/api/analysis/route.ts`
- 계산 코드: `lib/analysis/` (indicators, patterns, harmonic, ichimoku, elliott, index)
- 입력: `stock-data-agent`의 공통 OHLCV 스키마(`_workspace/01_...`). `candles`는 오름차순(과거→현재).
- **모든 지표는 결정적(deterministic) 코드로 계산**한다. LLM 추론으로 수치를 추정하지 않는다.

---

## 1. 엔드포인트

### `GET /api/analysis`

`/api/ohlcv`와 **완전히 동일한 쿼리 파라미터**를 받는다(파싱/캐시/KR 접미사 로직을
`lib/sources/ohlcv.ts`로 공유 → 두 라우트가 절대 어긋나지 않음). 내부에서 OHLCV를
가져와 분석 결과를 반환한다.

| 파라미터 | 필수 | 기본 | 설명 |
|---------|------|------|------|
| `symbol` | ✅ | — | 예 `AAPL`, `005930.KS`, KR 6자리 코드 `035720` |
| `market` | ✅ | — | `KR` \| `US` |
| `period` | — | `1y` | `1mo,3mo,6mo,1y,2y,5y,10y` |
| `interval` | — | `1d` | 예 `1d` |
| `from`,`to` | — | — | `YYYY-MM-DD`. 주면 `period` 대신 이 구간 사용 |

**아키텍처 결정 — 왜 별도 라우트인가**: 기존 `/api/ohlcv` 응답에 얹지 않고 분리했다.
(1) 프론트가 원시 시세만 필요할 때 무거운 분석 계산을 강제당하지 않는다. (2) 분석 응답은
지표 시계열을 포함해 페이로드가 크다 — 관심사 분리. (3) OHLCV 로딩 로직은
`lib/sources/ohlcv.ts`로 추출해 공유하므로 데이터 계약은 단일 소스로 유지된다.

**에러 응답**: `/api/ohlcv`와 동일한 공통 봉투(`ApiError`, `lib/schema.ts`).

| 상황 | HTTP | code |
|------|------|------|
| `symbol` 누락 / `market`≠KR·US / `from`≥`to` | 400 | `BAD_REQUEST` |
| 종목을 못 찾음(미상장/오타/상장폐지) | 404 | `NOT_FOUND` |
| 외부 소스 재시도 후에도 실패 | 502 | `SOURCE_ERROR` (`cause` 포함) |

> **데이터 부족은 에러가 아니다.** 특정 지표를 계산할 캔들 수가 모자라면 그 필드만 `null`로
> 두고 `meta.unavailable`에 사유를 담아 **200으로 정상 반환**한다. 전체 요청을 실패시키지 않는다.

---

## 2. 성공 응답 (200) 전체 구조

정의: `AnalysisResult` (`lib/analysis/index.ts`). 아래 필드명·중첩은 코드와 1:1이다.

```jsonc
{
  "symbol": "AAPL",
  "market": "US",              // "KR" | "US"
  "currency": "USD",           // ISO 4217
  "name": "Apple Inc.",        // null 가능
  "interval": "1d",

  "meta": {
    "candleCount": 252,
    "from": "2025-07-12",      // 첫 캔들 날짜, 캔들 0개면 null
    "to": "2026-07-11",        // 마지막 캔들 날짜, 0개면 null
    "patternConfidenceThreshold": 0.5,   // 이 값 미만 패턴은 결과에서 제외됨
    "unavailable": {           // 계산 불가한 필드경로 -> 사유 (없으면 {})
      "advanced.inflectionPoints": "not implemented in this backend build (...)"
    }
  },

  "dates": ["2025-07-12", "..."],  // 길이 = candleCount. 모든 indicator 시계열의 공통 x축(인덱스 정렬)

  "indicators": { /* §3 */ },
  "patterns":   { /* §4 */ },
  "advanced":   { /* §5 */ }
}
```

**정렬 규약(중요)**: `indicators` 아래 모든 배열(`values`, `upper`, `macd` 등)은 길이가
`dates`와 같고 **인덱스로 정렬**된다. `dates[i]`가 그 배열 `[i]`의 날짜다. 워밍업 구간은
`null`. (예외: 일목균형표 선행스팬은 미래로 이동 → §5-1에서 별도 규정.)

---

## 3. `indicators` — 기본 수치 지표

정의: `lib/analysis/indicators.ts`. 각 지표는 **독립적으로 null 가능**(프론트가 필요한 것만 골라 씀).

```jsonc
"indicators": {
  "sma": {                     // null 가능
    "byPeriod": [
      { "period": 5,   "values": [null, ..., 314.2] },
      { "period": 20,  "values": [...] },
      { "period": 60,  "values": [...] },
      { "period": 120, "values": [...] }
    ]
  },
  "ema": { "byPeriod": [ { "period": 5, "values": [...] }, ... ] },  // sma와 동일 형태, null 가능

  "rsi": {                     // null 가능
    "period": 14,
    "values": [null, ..., 62.93]      // Wilder smoothing, 0..100, 소수 2자리
  },

  "macd": {                    // null 가능
    "fastPeriod": 12,
    "slowPeriod": 26,
    "signalPeriod": 9,
    "macd":      [null, ..., 4.6147], // MACD 라인 (EMA12 - EMA26)
    "signal":    [null, ..., 1.894],  // 시그널 (MACD의 EMA9)
    "histogram": [null, ..., 2.7207]  // macd - signal
  },

  "bollinger": {               // null 가능
    "period": 20,
    "stdDevMult": 2,
    "upper":  [null, ..., 342.1],
    "middle": [null, ..., 315.3],     // = SMA(20)
    "lower":  [null, ..., 288.5]
  }
}
```

### 지표별 최소 캔들 수 & null 규칙
| 지표 | 최소 캔들 | null 시 `unavailable` 키 |
|------|----------|------------------------|
| `sma`/`ema` (프리셋 5·20·60·120) | 각 period개. **일부만 부족하면 그 period만 `byPeriod`에서 빠짐** | `indicators.sma.60`, `indicators.ema.120` 등 period별 |
| `sma`/`ema` (전체) | 최소 5개 미만이면 객체 자체 `null` | `indicators.sma`, `indicators.ema` |
| `rsi` | 15 (14+1) | `indicators.rsi` |
| `macd` | 26 | `indicators.macd` |
| `bollinger` | 20 | `indicators.bollinger` |

> `sma`/`ema`의 `byPeriod`에는 **데이터가 충분한 프리셋만** 들어간다. 예: 21개 캔들이면
> `[{period:5},{period:20}]`만 있고 60·120은 빠지며 `unavailable`에 사유가 남는다.
> 소수 자리: 가격계 지표 4자리, RSI 2자리 (`round()`).

---

## 4. `patterns` — 구조적 차트 패턴

정의: `lib/analysis/patterns.ts`(구조), `lib/analysis/harmonic.ts`(하모닉). 최소 25개 캔들
필요(피벗 탐지). 부족 시 두 배열 모두 `[]`이고 `unavailable["patterns"]`에 사유.

```jsonc
"patterns": {
  "structural": [
    {
      "type": "double-bottom",       // §4-1 목록
      "category": "reversal",        // "reversal" | "continuation" | "gap" | "other"
      "confidence": 0.967,           // 0..1, threshold(0.5) 이상만 포함
      "range": { "start": "2026-01-05", "end": "2026-02-18" },
      "keyPoints": [                 // 판단 근거 극값 좌표
        { "date": "2026-01-05", "price": 90.1,  "kind": "bottom" },
        { "date": "2026-02-18", "price": 90.6,  "kind": "bottom" }
      ],
      "note": "..."                  // 선택(있을 수도, 없을 수도)
    }
  ],
  "harmonic": [
    {
      "type": "harmonic-gartley",    // §4-2
      "category": "harmonic",
      "confidence": 0.72,
      "range": { "start": "...", "end": "..." },  // X ~ D
      "keyPoints": [                 // X,A,B,C,D 5좌표
        { "date": "...", "price": 100, "kind": "X" }, { "...": "A/B/C/D" }
      ],
      "note": "D is the potential reversal zone (PRZ)"
    }
  ]
}
```

- 배열은 `confidence` **내림차순** 정렬. `patternConfidenceThreshold`(0.5) 미만은 제외(노이즈 컷).
- `range`: 프론트가 차트 위 구간 오버레이에 사용. `keyPoints`: "왜 이 패턴인지" 표시용.
- `kind` 값 예: `"peak"`,`"trough"`,`"left-shoulder"`,`"head"`,`"right-shoulder"`,`"top"`,`"bottom"`,`"rim"`,`"gap-edge"`,`"pole-start"`,`"pole-end"`,`"consolidation-end"`,`"handle"`,`"X"`~`"D"`.
  (`"rim"` = 원형/V자 반전 패턴의 좌우 끝점 — 중앙 극값(`top`/`bottom`)과 짝을 이룬다.
  `"pole-start"`/`"pole-end"`/`"consolidation-end"` = 깃발형·페넌트형의 깃대 시작·끝과 눌림목 끝.
  `"handle"` = 컵앤핸들의 핸들 저점.)

### 4-1. `structural` 구현 패턴 (type 값)
| category | type |
|----------|------|
| reversal | `head-and-shoulders`, `inverse-head-and-shoulders`, `double-top`, `double-bottom`, `triple-top`, `triple-bottom`, `rounding-bottom`, `rounding-top`, `v-reversal` |
| continuation | `symmetric-triangle`, `ascending-triangle`, `descending-triangle`, `rectangle`, `rising-wedge`, `falling-wedge`, `flag`, `pennant`, `cup-and-handle` |
| other | `broadening-formation` |
| gap | `gap-up`, `gap-down`, `common-gap` |

**원형바닥/원형천장 (`rounding-bottom` / `rounding-top`) 판단 기준** — 개별 피크/트로프 매칭이
아니라 **곡률**로 판단한다(스킬 지침). 종가를 센터드 SMA(±2)로 평활한 뒤 후보 구간
(길이 30·45·60봉, 1/4씩 슬라이딩)마다 2차 다항식 `y=a·x²+b·x+c`를 최소제곱 피팅한다.
`a>0`이면 U자(바닥), `a<0`이면 역U자(천장). 채택 조건: 피팅 결정계수 `R²≥0.6`,
정점(vertex)이 구간 가운데 50% 안, 림-정점 깊이 `≥3%`, **양쪽 팔(arm) 기울기 모두
`≤0.8%/봉`(완만)**. `confidence = 0.4 + 0.6·(0.7·R² + 0.3·정점중앙성)`. 구간 겹치면
고신뢰 것만 남긴다. `keyPoints`: 좌측 림 → 중앙 극값(`bottom`/`top`) → 우측 림.

**V자형 반전 (`v-reversal`) 판단 기준** — 급격한 단일 지점 반전. 각 피벗(트로프=V, 피크=역V)
좌우 5봉의 기울기가 **반대 부호이면서 둘 다 `≥1.5%/봉`으로 가파른지**로 판단한다.
이 하한(1.5%/봉)이 원형 패턴의 팔 기울기 상한(0.8%/봉)보다 확실히 높아 완만한 원형바닥과
겹치지 않는다(코드에 `V_REVERSAL_MIN_ARM_SLOPE` / `ROUNDING_MAX_ARM_SLOPE` 상수로 명시).
`confidence = 0.5 + 0.5·(0.6·가파름 + 0.4·좌우대칭)`. `keyPoints`: 좌측 림 → 스파이크 극값 → 우측 림.

**깃발형/페넌트형 (`flag` / `pennant`) 판단 기준** — 깃대(pole)와 눌림목(consolidation)을 분리 탐지한다.
깃대: 종가 기준 `≥12%`의 급격한 이동(길이 5·8·12봉 후보). 그 직후 눌림목 구간(길이 5·8·12봉)이
① 고저 변동폭이 깃대 높이의 `≤50%`(좁음), ② 깃대를 `≤50%`만 되돌림, ③ 중심선 기울기가 깃대와
같은 방향으로 `>1%/봉` 과하게 진행하지 않을 것(눌림목은 반대·횡보). 눌림목의 상단(고가)·하단(저가)
추세선을 최소제곱 피팅해 **채널 폭이 끝에서 시작의 65% 미만으로 좁아지면 `pennant`(수렴), 아니면
`flag`(평행)**. `confidence = 0.45 + 0.55·(0.6·깃대강도 + 0.4·눌림목좁음)`. 구간 겹치면 고신뢰 것만.
`keyPoints`: 깃대 시작(`pole-start`) → 깃대 끝(`pole-end`) → 눌림목 끝(`consolidation-end`).

**컵앤핸들 (`cup-and-handle`) 판단 기준** — 원형바닥(cup) 탐지 결과를 재사용한다. `rounding-bottom`으로
컵을 찾은 뒤, 컵 우측 림 직후 짧은 핸들 구간(길이 5·8·12봉 후보)에서 저점 눌림을 검사: ① 실제 하락
(림 대비 `≥2%`), ② 컵 깊이의 `≤50%`로 얕음, ③ 컵의 상단 절반 안에 머묾. 여러 핸들 길이 중 가장
얕은(신뢰 높은) 것을 채택. `confidence = 0.5·컵신뢰 + 0.5·(0.4 + 0.6·핸들얕음)`. 구간 겹치면 고신뢰 것만.
`keyPoints`: 좌측 림(`rim`) → 컵 바닥(`bottom`) → 우측 림(`rim`) → 핸들 저점(`handle`).

### 4-2. `harmonic` 구현 패턴 (type 값)
`harmonic-gartley`, `harmonic-butterfly`, `harmonic-bat`, `harmonic-crab`
(XABCD 5극값 + AB/XA·BC/AB·CD/BC·AD/XA 피보나치 비율, 4비율 밴드 점수 평균 = confidence).

### 4-3. 추가 구현 패턴 (채널/다이아몬드/섬반전)

- **채널 (`channel-up`/`channel-down`)** — `trendLineShapes`의 same-sign(같은 방향 기울기) 분기 안에서
  구간 시작·끝의 채널 폭(상단선-하단선)을 비교해 끝 폭이 시작 폭의 75~133% 안이면(평행 유지)
  채널로, 그보다 좁아지면 기존 쐐기형(wedge)으로 분류한다. 박스권(둘 다 수평)과 로직을 공유하되
  기울기가 0이 아니어도 되는 일반화 버전이다.
- **다이아몬드형 (`diamond-top`/`diamond-bottom`)** — 최근 14개 극값 구간을 절반으로 나눠, 앞쪽은
  확산형(추세선이 벌어짐) 뒤쪽은 삼각수렴(추세선이 좁아짐) 조건을 모두 만족할 때만 판정하는
  복합 패턴. 구간 시작~끝의 종가 방향으로 top/bottom을 구분한다(하락 마감=top, 상승 마감=bottom).
- **섬반전 (`island-reversal`)** — 방향이 반대인 두 갭이 6봉 이내에 나타나고 그 사이 캔들들이
  양쪽 갭 레벨 바깥에 완전히 고립돼 있을 때 판정한다(위로 갭 진입→아래로 갭 이탈=천장 섬,
  반대는 바닥 섬). `gaps()`와 같은 임계값(2%)을 쓰되 인덱스를 추적해 갭 쌍을 짝짓는다.

갭은 여전히 위치기반 하위분류(돌파/추세/소멸갭)를 세분하지 않고 `gap-up`/`gap-down`(미충전) vs
`common-gap`(5봉내 충전)으로만 분류한다 — 섬반전만 별도 타입으로 분리했다.

---

## 5. `advanced` — 고급 기법

```jsonc
"advanced": {
  "ichimoku":       { /* §5-1 */ } | null,
  "elliottWave":    { /* §5-2 */ } | null,
  "inflectionPoints": { /* §5-3 */ } | null
}
```

### 5-1. `ichimoku` (일목균형표) — 정의 `lib/analysis/ichimoku.ts`
최소 78 캔들(52+26). 부족 시 `null` + `unavailable["advanced.ichimoku"]`.

```jsonc
"ichimoku": {
  "tenkanPeriod": 9, "kijunPeriod": 26, "senkouBPeriod": 52, "displacement": 26,
  "tenkan":  [null, ..., 298.38],   // 전환선 (9H+9L)/2,  길이 = candleCount
  "kijun":   [null, ...],           // 기준선 (26H+26L)/2, 길이 = candleCount
  "chikou":  [..., null, null],     // 후행스팬: 종가를 26봉 뒤로. 마지막 26개 null. 길이 = candleCount
  "leadingSpanA": [null, ..., v],   // 선행스팬A (전환+기준)/2 를 26봉 앞으로. 길이 = candleCount + 26
  "leadingSpanB": [null, ..., v],   // 선행스팬B (52H+52L)/2 를 26봉 앞으로. 길이 = candleCount + 26
  "projectedDates": ["2026-07-14", ... 26개],  // 선행스팬 미래 구간(캔들 없는 날) x축
  "signal": 1                       // 1=강매수, -1=강매도, 0=중립(관망). 마지막 캔들 기준
}
```

> **선행스팬 정렬(주의)**: `leadingSpanA/B`만 길이가 `candleCount + displacement(26)`다.
> 인덱스 `[0 .. candleCount-1]`는 `dates`에 대응, 인덱스 `[candleCount .. candleCount+25]`는
> `projectedDates[0..25]`(미래)에 대응한다. 즉 구름(cloud)은 차트 오른쪽으로 26봉 뻗는다.
> `signal`: TK크로스 + 구름 위/아래 위치 + 구름 색(A><B) 세 조건을 모두 만족할 때만 ±1.

### 5-2. `elliottWave` (엘리엇 파동) — 정의 `lib/analysis/elliott.ts`
최소 26 캔들. 부족 시 `null` + `unavailable["advanced.elliottWave"]`.
"가장 단순한 유효 해석 하나" 전략 — 최근 5스윙을 1-2-3-4-5 임펄스 3대 철칙으로 검증,
위반하면 오판보다 미검출을 택해 `impulse:null`.

```jsonc
"elliottWave": {
  "impulse": {                       // 규칙 위반 시 null
    "direction": "up",               // "up" | "down"
    "waves": [                       // 1~5 파동
      { "label": "1", "date": "...", "price": 120.0 }, ... { "label": "5", ... }
    ],
    "checks": {                      // 통과한 철칙(투명성용)
      "wave2Retrace": true,          // 2파가 1파 시작점을 넘지 않음
      "wave3NotShortest": true,      // 3파가 최단이 아님
      "wave4NoOverlap": true         // 4파가 1파 영역 침범 안 함
    },
    "completed": true                // 5파가 시리즈 끝 근처면 true
  },
  "reason": null,                    // impulse가 null일 때만 사유 문자열
  "signal": -1                       // 1=매수(ABC조정완료 등), -1=매도(5파상승완료), 0=관망
}
```
> `impulse`가 `null`이면 `reason`에 사유 문자열, `signal:0`. `impulse`가 있으면 `reason:null`.

### 5-3. `inflectionPoints` (변곡점 예측) — 정의 `lib/analysis/inflection.ts`
원 스킬(`inflection-point-predictor`)은 ML 50% + 규칙 35% + 뉴스 15% 앙상블이나, ML/뉴스 레그는
학습모델·외부 신호에 의존해 결정적 코드로 옮길 수 없다 — **규칙 35% 레그만** 구현했다
(거래량 이상, RSI 다이버전스, OBV 다이버전스, BB 스퀴즈). 최소 25봉, 부족 시 `null`+사유.

```jsonc
"inflectionPoints": {
  "points": [
    {
      "date": "2026-05-20", "price": 132.61, "direction": "up",  // "up" | "down"
      "confidence": 0.55,
      "signals": [
        { "rule": "rsi-divergence", "detail": "price lower vs prior trough, RSI higher" },
        { "rule": "obv-divergence", "detail": "price down vs prior trough, OBV up" }
      ]
    }
  ],
  "note": "rule-based only ... points mark past pivots where >=2 rules corroborated the turn, not a live forecast"
}
```

- 규칙별 가중치: 거래량이상 0.25 · RSI다이버전스 0.30 · OBV다이버전스 0.25 · BB스퀴즈 0.20. 2개 이상
  규칙이 동시에 성립해야(가중합 ≥0.5) 후보로 채택 — 단일 규칙만으로는 노이즈로 보고 버린다.
- **한계(숨기지 않고 명시)**: 과거 피벗을 사후에 규칙으로 재확인하는 방식이라, 진짜 "미래 예측"이
  아니라 "이 시점에 추세 전환을 뒷받침하는 규칙이 2개 이상 겹쳤다"는 사후 플래그에 가깝다.
  `note` 필드에 이 한계를 그대로 노출한다.

---

## 6. 구현/미구현 요약 (QA 체크리스트)

| 층위 | 구현 | 미구현 |
|------|------|--------|
| 기본 지표 | SMA, EMA(5/20/60/120), RSI(14,Wilder), MACD(12/26/9), Bollinger(20,2σ) | — (요구 전부 구현) |
| 차트 패턴 | H&S/역H&S, 이중·삼중 천장/바닥, 원형바닥/천장, V자반전, 삼각수렴(상승/하락/대칭), 박스권, 쐐기(상승/하락), 채널(상승/하강), 깃발/페넌트, 컵앤핸들, 확산형, 다이아몬드, 갭, 섬반전, 하모닉(Gartley/Butterfly/Bat/Crab) | — (스킬 목록 전부 구현) |
| 고급 기법 | 일목균형표(5선+구름+신호), 엘리엇파동(임펄스 1-5), 변곡점예측(규칙 기반 4종) | — (규칙 레그 전부 구현, ML/뉴스 레그는 아키텍처 제약으로 범위 밖) |

## 7. 검증 기록
- 지표 수치: `lib/analysis/indicators.ts`를 고전 Wilder RSI 레퍼런스 벡터로 검증 — RSI[14]=70.46(레퍼런스 70.53, 반올림 오차 내), SMA/EMA/MACD/Bollinger 정렬·부호 통과.
- 파이프라인 라이브 검증: `GET /api/analysis` — US(AAPL, 252봉), KR(005930.KS, 123봉) 200 정상.
  데이터 부족(1mo·21봉)에서 60/120 SMA·MACD·패턴·일목·엘리엇 각각 null+사유, 요청은 200 유지.
  에러: bad market/누락 symbol 400, 미상장 404, 공통 봉투 확인.

# 05 · QA Integration — 최종 통합 검증 리포트

> 파이프라인 전체(stock-data → technical-analysis → frontend-chart) 완료 후 최종 QA.
> 방법: 문서(01~04) ↔ 실제 코드(`lib/*`, `components/*`, `app/*`) 정적 대조 +
> `npm run build` + `next dev`(포트 3945) 라이브 fetch/curl + 실제 브라우저 렌더 구동.
> **검증일**: 2026-07-12 · **검증자**: qa-integration-agent

## 종합 결과: **PASS — 배포 차단 이슈 없음**

6개 검증 항목 전부 통과. 크래시/깨진 화면/필드 불일치 0건. 경미한 UX 관찰 2건(비차단).
이전 리포트(`04_qa-integration-agent_report.md`, 경계면 1↔3)에서 발견된 이슈는 없었고, 이번에도 재발 없음.

| # | 검증 항목 | 결과 |
|---|----------|------|
| 1 | 경계면 3↔7: `02_output-schema` 필드명 ↔ `components/` 파싱 필드명 일치 | **PASS** |
| 2 | `null` 지표를 프론트가 크래시 없이 처리 (짧은 기간 재현) | **PASS** |
| 3 | KR(005930) · US(AAPL) 두 시장 화면 B 정상 동작 | **PASS** |
| 4 | 에러 상태(404/400/502) 와이어프레임 §7 규칙대로 반영 | **PASS** |
| 5 | `04_notes` 제한사항이 오해를 주는 형태가 아닌 의도된 축소인지 | **PASS** |
| 6 | `npm run build` 통과 | **PASS** |

---

## 1. 경계면 3↔7 — 필드명 정합성 (핵심)

`technical-analysis-agent` 출력 스키마와 프론트 소비 코드를 필드 단위로 교차 대조.
프론트는 백엔드 타입을 `import type`으로 그대로 소비(`lib/api.ts` → `@/lib/analysis/index`,
`@/lib/schema`)하므로 컴파일 타임에 drift가 잡힌다. 라이브 응답 키까지 재확인:

| 응답 필드 (문서 §) | 소비 코드 | 결과 |
|---|---|---|
| `indicators.sma.byPeriod[].period/values` | `ChartStack.tsx:166`, `LayerControls.tsx:83` | 일치 |
| `indicators.bollinger.upper/middle/lower` | `ChartStack.tsx:193-195` | 일치 |
| `indicators.rsi.values` | `ChartStack.tsx:297,473` | 일치 |
| `indicators.macd.macd/signal/histogram` (`signalLine` 오배치 없음) | `ChartStack.tsx:322,332,338` | 일치 |
| `advanced.ichimoku.tenkan/kijun/chikou` | `ChartStack.tsx:218-220` | 일치 |
| **`advanced.ichimoku.leadingSpanA/B` + `projectedDates`** (길이 = candleCount+26) | `ChartStack.tsx:64-77`(`toLeadingLine`), `229,237` | 일치 — 미래 26봉 축(`[...dates,...projected]`)에 정확히 매핑 |
| `advanced.elliottWave.impulse.waves[].label/date/price` | `ChartStack.tsx:256-274` | 일치 |
| `advanced.elliottWave.reason`, `.signal` | `SignalPopover.tsx:28-29` | 일치 (impulse:null → reason 노출) |
| **`patterns[].range.{start,end}`** | `ChartStack.tsx:375-376`(밴드), `chart/page.tsx:152`(줌) | 일치 |
| **`patterns[].keyPoints[].{date,price,kind}`** | `ChartStack.tsx:244-252` | 일치 — `kind`로 arrowUp/Down 방향 결정 |
| **`patterns[].confidence`** (내림차순) | `chart/page.tsx:126-128` 병합 후 재정렬, `LayerControls.tsx:177` | 일치 |
| `patterns[].category` → 색/라벨 | `format.ts:64,51` | 일치 (reversal/continuation/gap/harmonic/other 전부 매핑) |
| `meta.unavailable[키]` → 비활성 사유 | `LayerControls.tsx:81-88, 113` | 일치 (`need N candles, have M` 정규식 파싱) |
| `advanced.inflectionPoints` (항상 null) | `LayerControls.tsx:211-217` (`⊘` 영구 비활성) | 일치 |

라이브 응답 키 덤프(AAPL/US, 251봉)에서 `macd`/`ichimoku`/`bollinger`/`pattern`/`keyPoint`/`range`
키 집합이 문서 §3~5와 문자 단위로 동일함을 확인. **불일치 0건.**

## 2. null 지표 처리 — 크래시 없음

`005930.KS` **1M(22봉)** 실구동 화면:
- 이동평균 5·20 활성, **"MA 60·120 · 캔들 60개 필요 (현재 22)"** 비활성 행 표시.
- 볼린저 활성(22≥20), RSI 활성(22≥15).
- **MACD "캔들 26개 필요 (현재 22)"**, **일목 "캔들 78개 필요 (현재 22)"**, **엘리엇 "캔들 26개 필요 (현재 22)"** 전부 비활성+사유.
- ② 패턴 토글 자체 비활성(25봉 미만), 탐지 카운트 숨김.
- 변곡점 "이 빌드에서 미제공".
- **콘솔 에러 0, 차트 정상 렌더.** 지표 객체 null → `ChartStack`의 모든 오버레이가
  `analysis?.indicators.X` / `?.advanced.X` 가드로 조용히 스킵(크래시 없음).

curl 재현(AAPL from/to 8봉)에서도 HTTP 200 유지, `unavailable`에 13개 키 사유 정확 기재.

## 3. KR/US 양시장 화면 B

- **US(AAPL)**: `$315.32`, 2자리 소수, 패턴 14건, MA/볼린저/RSI(62.93)/MACD(4.61·1.89)/일목(선행A·B 미래연장)/패턴 오버레이(이중바닥 0.97 범위밴드+bottom 마커 2개)/신호요약(일목 ▲강세+1) 전부 렌더.
- **KR(005930)**: `₩285,000`, **소수 없음**, `지연 시세·15~20분` 배지, ▲+2.52%(상승=빨강), 패턴 27건. 동일 렌더 경로.
- 두 시장 응답 shape 차이는 `market`/`currency`/`symbol`/`name`뿐(라이브 확인). 프론트 조건분기 없음 — 렌더 정상.

## 4. 에러 상태 (와이어프레임 §7)

라이브 확인:
- **404**(`ZZZZINVALID`): 화면 "데이터를 찾을 수 없습니다 (미상장·상장폐지 가능)" + 검색복귀 버튼. ✔
- **400**(bad market / 누락 symbol / from≥to): `ApiCallError.code` 분기로 "요청이 올바르지 않습니다". ✔
- **502/네트워크**: "데이터 소스 오류" + 다시 시도 + `cause` 접이식(`chart/page.tsx:322-335`). ✔
- **분석만 실패**(캔들 정상): 상단 안내 후 차트는 그대로 그림(`chart/page.tsx:223-228`). ✔
- 빈 결과(200·0봉)와 404를 명확히 구분(EmptyState vs ErrorState). ✔

## 5. `04_notes` 제한사항 — 의도된 축소 확인

전부 크래시/깨짐이 아니라 **의도된 범위 축소**이며 사용자에게 오해를 주지 않음:
1. **일목 구름 fill 미구현** → 선행A/B를 **라인 2개**로 그리고 미래 26봉 확장은 정상. 음영만 없음(라이브 화면 확인). 기능 손실 아님.
2. **EMA 미오버레이** → 응답엔 `ema` 존재하나 화면은 SMA만. 컨트롤에 EMA 항목 자체가 없어 "빠졌다"는 오해 없음.
3. **모바일 탭 대신 세로 스택** → 기능 손실 없이 화면만 길어짐. 데스크톱 우선 명시.
4. 하모닉 XABCD 전용선 미구현 → 리스트/밴드/마커는 표시. (현 US/KR 구간엔 하모닉 0건이라 화면 영향 없음.)

## 6. 빌드

`npm run build` — `✓ Compiled successfully` + `Finished TypeScript` 통과. 타입 에러 0.
`import type` 계약 소비 구조 덕에 스키마 drift 발생 시 빌드가 실패하도록 안전망 존재.

---

## 경미한 관찰 (비차단 · 후속 폴리시 권장)

1. **엘리엇 `reason` 영문 노출**: `impulse:null`일 때 신호요약/컨트롤에 백엔드 원문
   `"most recent 5-swing sequence violates an Elliott impulse rule"`가 영어 그대로 표시됨.
   와이어프레임 §5의 "reason 노출" 규정 자체는 준수(크래시/불일치 아님)이나, 한국어 UI에서 영문
   문장이 튀는 UX 갭. → 프론트에 reason 코드→한글 매핑 or 백엔드 reason 한글화 시 개선.
   담당: frontend-chart-agent(포맷 매핑) 또는 technical-analysis-agent(메시지) 협의.
2. **AAPL 엘리엇/하모닉 미검출이 기본**: 두 종목 모두 `elliottWave.impulse:null`,
   `harmonic:[]`. 문서 §5-2 "미검출 우선" 전략대로 정상이나, 사용자가 "고급 기법을 켰는데
   아무것도 안 나온다"고 느낄 수 있음. reason 노출로 이미 완화됨 — 관찰만 기록.

**미해결 불일치 없음. 원인 에이전트 재작업 통지 불필요. 배포 진행 가능.**

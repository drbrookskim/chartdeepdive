# 04 · QA Integration — 중간 점검 리포트

> 이 파일은 최종 리포트가 아니라 **점진적 QA의 중간 기록**이다. 각 경계면을 검증할 때마다 추가된다.

## 경계면 1 ↔ 3: stock-data-agent(OHLCV) ↔ technical-analysis-agent(분석)

**검증 일시**: 2026-07-12
**대상**: `_workspace/01_...api-spec.md`, `_workspace/02_...output-schema.md` + 실제 코드/라이브 응답
**방법**: 정적 grep(필드명) + `npm run dev`(포트 3939) + `/api/analysis` 라이브 호출(AAPL/US, 005930.KS/KR)

### 결과: **경계면 1↔3 이상 없음** (5개 항목 전부 통과)

| # | 검증 항목 | 결과 |
|---|----------|------|
| 1 | 캔들 필드명 일치 (`{date,open,high,low,close,volume,adjclose}`) | PASS |
| 2 | `/api/analysis` 응답 구조 = 문서(§2~5), US·KR 둘 다 200 | PASS |
| 3 | `indicators` 배열들이 `dates`와 길이·인덱스 정렬 | PASS |
| 4 | 일목 `leadingSpanA/B` 길이 = `candleCount+26`, `projectedDates` 존재 | PASS |
| 5 | 데이터 부족 시 지표 null + 사유, 전체 200 유지 | PASS |

### 근거 상세

**1. 필드명 (정적 검증)** — `closePrice`/`adjClose` 등 변종 없음. `lib/schema.ts`의 `Candle`은
`{date,open,high,low,close,volume,adjclose}`로 명세와 1:1. `lib/sources/yahoo.ts:89-99`가 정확히 이 필드로
정규화하고, `lib/analysis/*.ts`는 `c.close/.high/.low/.date`만 접근(변종 접근자 0건).
분석 라우트(`app/api/analysis/route.ts:25`)가 `loadOhlcv`(경계면 1의 공유 헬퍼)를 그대로 호출하므로 입력 계약 단일 소스 유지.

**2·3. 응답 구조 & 배열 정렬 (라이브)**
- AAPL/US: candleCount=251, dates.length=251, `market:"US" currency:"USD"`. 모든 indicator 배열(sma·ema 4프리셋, rsi, macd 3라인, bollinger 3밴드) 길이=251.
- 005930.KS/KR: candleCount=243, dates.length=243, `market:"KR" currency:"KRW"`, `name:"Samsung Electronics Co., Ltd."`. 동일하게 전부 길이=243.
- 두 시장 응답 shape 동일 — 차이는 `market`/`currency`/`symbol`/`name`뿐(문서 §6, 01-§6 주장과 일치). 프론트 조건분기 불필요.
- `macd` 키 = `fastPeriod,slowPeriod,signalPeriod,macd,signal,histogram` (문서 §3와 정확히 일치, `signal`/`signalLine` 같은 오배치 없음).
- 패턴 배열 confidence 내림차순 정렬 확인, threshold(0.5) 미만 0건.

**4. 일목균형표 (라이브)**
- AAPL: leadingSpanA/B len=277 (=251+26), projectedDates len=26, signal=1.
- 005930: leadingSpanA/B len=269 (=243+26), projectedDates len=26, signal=0.
- 나머지 선(tenkan/kijun/chikou)은 candleCount와 동일 길이 — 문서 §5-1 정렬 규정과 일치.

**5. 데이터 부족 (라이브, AAPL from=2026-06-25&to=2026-07-08 → 8캔들)**
- HTTP 200 유지. `sma`/`ema`는 `byPeriod:[{period:5}]`만 남고 20/60/120 제거.
- rsi·macd·bollinger·ichimoku·elliottWave 전부 null, `patterns` 빈 배열.
- `meta.unavailable`에 각 항목 사유("need N candles, have 8") 정확히 기재.

### 특이사항 (불일치 아님)
- `elliottWave.impulse`는 두 종목 모두 null(`reason` 채워짐, signal=0) — 문서 §5-2의 "미검출 우선" 전략대로 정상 동작.
- `harmonic` 패턴 두 종목 모두 0건 — 탐지 실패가 아니라 해당 구간에 유효 XABCD 없음(정상 가능).
- `inflectionPoints`는 항상 null + 고정 사유 — 문서 §5-3와 일치.

**미해결 이슈 없음.** 원인 에이전트 통지 불필요.

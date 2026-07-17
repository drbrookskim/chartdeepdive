# 01 · Stock Data Agent — API 명세 & 공통 스키마

> 이 문서는 백엔드 데이터 레이어의 **계약(contract)**이다. `technical-analysis-agent`,
> `frontend-chart-agent`, `qa-integration-agent`가 참조한다. 스키마를 바꿀 때는
> 반드시 이 문서를 먼저 갱신하고 두 소비 에이전트에 알린다.

- 스택: Next.js 16 (App Router, TypeScript) · API는 `app/api/*/route.ts`
- 데이터 소스: **Yahoo Finance**(`yahoo-finance2` v4, npm) + **Naver Finance 자동완성**(KR 한글 검색)
- 코드 위치: `lib/schema.ts`(스키마), `lib/sources/*`(어댑터), `lib/cache.ts`(캐시), `app/api/*`(라우트)

---

## 1. 공통 OHLCV 스키마 (확정)

모든 데이터 소스는 아래 형태로 정규화된 뒤에만 분석 엔진/프론트로 넘어간다.
정의: `lib/schema.ts`.

```jsonc
// GET /api/ohlcv 성공 응답
{
  "symbol": "AAPL",
  "market": "US",            // "KR" | "US" 만 허용
  "currency": "USD",         // ISO 4217 (US=USD, KR=KRW)
  "source": "yahoo-finance2",
  "interval": "1d",
  "name": "Apple Inc.",      // 없으면 null
  "candles": [
    {
      "date": "2026-07-10",  // ISO 8601, 시장 현지 거래일
      "open": 314.72,
      "high": 316.91,
      "low": 312.17,
      "close": 315.32,
      "volume": 34109200,
      "adjclose": 315.32     // 분할/배당 조정 종가 (추가 필드, 아래 참고)
    }
  ]
}
```

### 필드 규칙
- `date`: 항상 `YYYY-MM-DD`, **시장 현지 거래일**. US 바는 UTC 13:30(개장)으로 오므로
  `America/New_York`, KR 바는 `Asia/Seoul` 기준으로 로컬 날짜 변환한다.
- 가격 필드: 항상 **숫자**(문자열 아님), 원본 정밀도 유지(반올림 없음).
- `volume`: 정수(주식 수). Yahoo가 null이면 0.
- `market`: `"KR"` | `"US"` 만 허용.
- **`adjclose`** (추가 결정): 공통 스키마 핵심은 `{date,open,high,low,close,volume}`이지만,
  Yahoo가 조정 종가를 항상 함께 주므로 **가산 필드**로 포함한다. 장기 이동평균/수익률
  계산에 조정 종가가 필요한 분석 지표가 재조회 없이 쓸 수 있게 하기 위함. 값이 없으면 `null`.
  → `technical-analysis-agent`가 조정 종가를 요청한 경우 이미 충족됨.

---

## 2. 데이터 소스 매핑

### 2-1. 미국 (Yahoo `chart`)
`lib/sources/yahoo.ts`. 실제 응답 → 공통 스키마 매핑 (라이브 응답으로 검증):

| Yahoo `chart` 필드      | 공통 스키마      |
|------------------------|-----------------|
| `quotes[].date` (UTC)  | `candles[].date` (현지 변환) |
| `quotes[].open`        | `candles[].open` |
| `quotes[].high`        | `candles[].high` |
| `quotes[].low`         | `candles[].low`  |
| `quotes[].close`       | `candles[].close`|
| `quotes[].volume`      | `candles[].volume` |
| `quotes[].adjclose`    | `candles[].adjclose` |
| `meta.currency`        | `currency`       |
| `meta.longName/shortName` | `name`        |

> **아키텍처 주의**: `UsStockInfo` MCP는 **개발 세션 전용 도구**이며 배포 서버 런타임에서
> 호출 불가. 필드 구조 확인용으로만 참고했고, 프로덕션은 `yahoo-finance2` 패키지가 직접 호출한다.

### 2-2. 한국 — 데이터 소스 조사 결과 & 선택 근거

조사한 후보와 판단:

| 후보 | 결과 |
|------|------|
| **pykrx** | 파이썬 라이브러리. Node/Next.js 런타임에서 직접 호출 불가 → **탈락**. |
| **KRX 공공데이터 API** | 인증키 발급·쿼터 필요, 일별 지연 데이터. 키 없이는 동작 불가 → 보류. |
| **Naver 금융 시세 JSON** | 키 없이 Node `fetch`로 접근 가능하나 비공식. |
| **Yahoo Finance (`.KS`/`.KQ`)** | **채택**. KOSPI=`.KS`, KOSDAQ=`.KQ` 접미사로 KRW OHLCV 제공. 라이브 검증 완료(예: `005930.KS` 삼성전자). |

**선택**: OHLCV는 **Yahoo Finance 단일 경로**로 KR·US를 모두 처리한다(코드 경로 하나 → 유지보수/정규화 일관성). KR은 `005930.KS`처럼 접미사를 붙여 조회하고, 6자리 코드만 오면 `.KS`→`.KQ` 순으로 시도한다.

**단, 검색은 예외**: Yahoo `search`는 **한글 질의를 거부**한다(`Invalid Search Query`). 그래서 한글 종목명 검색은 **Naver 금융 자동완성**(`https://ac.stock.naver.com/ac`)으로 해결한다. 이 엔드포인트는 `code`(6자리)+`name`(한글)+`typeCode`(KOSPI/KOSDAQ)를 주므로, 이를 Yahoo 심볼(`{code}.KS|.KQ`)로 매핑해 검색 결과의 `symbol`이 곧바로 `/api/ohlcv`에 쓰이도록 했다.

**한계(미구현 아님, 명시)**:
- Yahoo KR 시세는 **실시간이 아니라 약 15~20분 지연** 종가/일봉 기준이다. 진짜 실시간 호가가 필요하면 향후 KRX 유료/키 기반 소스로 교체 가능하도록 어댑터(`lib/sources/`)를 분리해 두었다.
- Naver 자동완성은 KOSPI/KOSDAQ 종목만 취급(KONEX 등 제외).

---

## 3. 엔드포인트

### 3-1. `GET /api/search?q=<질의>`
티커/종목명(한글·영문) 부분 일치 검색.
- 한글 질의 → Naver만. 영문/티커 질의 → Yahoo(글로벌·US) + Naver(KR) 병합·중복제거.
- 한 소스가 실패해도 다른 소스 결과는 반환(부분 실패 격리).

**요청 예**: `/api/search?q=apple`

**성공 응답 (200)**:
```json
{
  "query": "apple",
  "results": [
    { "symbol": "AAPL", "name": "Apple Inc.", "market": "US", "exchange": "NASDAQ" },
    { "symbol": "APLE", "name": "Apple Hospitality REIT, Inc.", "market": "US", "exchange": "NYSE" }
  ]
}
```

**한글 검색 예**: `/api/search?q=삼성`
```json
{
  "query": "삼성",
  "results": [
    { "symbol": "005930.KS", "name": "삼성전자", "market": "KR", "exchange": "KOSPI" },
    { "symbol": "006400.KS", "name": "삼성SDI", "market": "KR", "exchange": "KOSPI" }
  ]
}
```

- `q` 누락/공백 → **400** `{ "error": { "code": "BAD_REQUEST", "message": "query parameter `q` is required" } }`
- 결과 없음 → `results: []` (검색은 빈 배열이 정상. 시세 조회와 구분).

### 3-2. `GET /api/ohlcv?symbol=<sym>&market=<KR|US>&period=<1y>&interval=<1d>`
정규화된 OHLCV 반환. `symbol`은 검색 결과의 `symbol`을 그대로 사용.

| 파라미터 | 필수 | 기본 | 설명 |
|---------|------|------|------|
| `symbol` | ✅ | — | 예 `AAPL`, `005930.KS`, 또는 KR 6자리 코드 `035720` |
<!-- fallback: bare 6자리 KR 코드는 .KS→.KQ 순으로 시도하되, KOSDAQ 종목이 .KS에서 캔들은 정상이나 name이 깨진 alias("247540.KS,0P0001GZPV,623889")로 오는 케이스가 있어, .KS 응답의 name이 정상 회사명이 아니면(isBrokenName) .KQ도 조회해 정상 name을 가진 쪽을 채택한다(둘 다 이름 없으면 데이터 있는 쪽 반환). -->

| `market` | ✅ | — | `KR` \| `US` |
| `period` | — | `1y` | `1mo,3mo,6mo,1y,2y,5y,10y` |
| `interval` | — | `1d` | 예 `1d` |
| `from`,`to` | — | — | `YYYY-MM-DD`. 주면 `period` 대신 이 구간 사용 |

**요청 예**: `/api/ohlcv?symbol=005930.KS&market=KR&period=1mo`
→ 성공 응답은 §1의 형태(단 `currency:"KRW"`, `market:"KR"`).

**에러 응답** (공통 봉투, 조용히 빈 배열 반환 금지):
| 상황 | HTTP | code |
|------|------|------|
| `symbol` 누락 / `market`≠KR·US / `from`≥`to` | 400 | `BAD_REQUEST` |
| 종목을 못 찾음(미상장/오타/상장폐지) | 404 | `NOT_FOUND` |
| 외부 소스 재시도 후에도 실패 | 502 | `SOURCE_ERROR` (`cause` 포함) |

```json
// 404 예
{ "error": { "code": "NOT_FOUND",
  "message": "no OHLCV data for symbol 'ZZZZINVALID' on market 'US'",
  "cause": "No data found, symbol may be delisted" } }
```

---

## 4. 에러 핸들링 / 재시도
- 모든 외부 호출은 `lib/retry.ts`의 `retryOnce`로 **1회 재시도** 후 실패 시 에러 상태를 응답에 담는다(조용히 무시 금지).
- Yahoo는 미상장 심볼에 대해 예외를 던지므로 라우트에서 메시지를 판별해 `NOT_FOUND`(404)로 분류.

## 5. 캐싱 (`lib/cache.ts`)
- 소스 어댑터와 **분리**된 인메모리 TTL 캐시. 소스가 바뀌어도 캐시 로직 재사용.
- 조회 구간이 **오늘을 포함**하면(마지막 봉이 움직임) TTL 60초(`INTRADAY`), 과거 데이터만이면 24시간(`HISTORICAL`).
- 검색 결과 TTL 1시간(`SEARCH`).
- 단일 노드 프로세스 기준. 스케일 아웃 시 Redis 등으로 교체.

## 6. 소비자 유의사항
- **프론트(`frontend-chart-agent`)**: `/api/search` → 사용자 선택 → 선택 항목의 `symbol`+`market`으로 `/api/ohlcv` 호출. 404/502를 빈 데이터와 반드시 구분해 UI 처리.
- **분석(`technical-analysis-agent`)**: `candles`는 오름차순(과거→현재). 조정 종가는 `adjclose` 사용. 추가 필드 필요 시 이 문서 갱신 요청 → 협의.
- **QA(`qa-integration-agent`)**: §3의 성공/에러 예시가 계약 shape. KR/US 응답 차이는 `currency`/`market`/`symbol` 접미사뿐, 캔들 구조는 동일.

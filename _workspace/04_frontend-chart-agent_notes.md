# 04 · Frontend Chart Agent — 구현 노트

> 승인된 `03_frontend-chart-agent_wireframe.md` 레이아웃을 그대로 구현한 프론트엔드
> 문서. 컴포넌트 구조 · 차트 라이브러리 선택 근거 · API 연동 방식 · 미구현/제한사항을
> `qa-integration-agent`가 코드-응답 대조 검증할 수 있도록 정리한다.

- 스택: Next.js 16 (App Router, TypeScript, Turbopack) · React 19 · 클라이언트 렌더링 차트
- 백엔드: 같은 프로젝트의 `app/api/search`·`app/api/ohlcv`·`app/api/analysis` (재계산 없음)
- 빌드: `npm run build` **통과**(타입체크 포함). 라이브 검증: AAPL 1Y 실데이터로 전 레이어 렌더 확인.

---

## 1. 차트 라이브러리 선택 — `lightweight-charts` v4.2.3 (TradingView)

| 후보 | 판단 |
|------|------|
| recharts / chart.js | 범용. 캔들+다중 오버레이+주석 조합이 번거롭고 성능/축 정렬 취약 → 탈락 |
| **lightweight-charts v4** | **채택**. 캔들·라인·히스토그램 시리즈, 마커, priceLine, 다중 price scale, 미래 시간 확장(일목 구름 연장)을 기본 지원. 경량(≈45KB gz)·캔버스 렌더로 250봉+오버레이도 부드럽다. |
| lightweight-charts v5 | 최신이나 API가 `addSeries(SeriesType)`로 바뀌고 pane 기능이 미성숙. **v4의 안정적 `addCandlestickSeries`/`addLineSeries` API로 고정**(위험 최소화). |

**서브패널(RSI/MACD) 구현**: v4는 네이티브 다중 pane이 없어, **메인·RSI·MACD를 각각 독립
`IChartApi` 인스턴스**로 만들고 `subscribeVisibleLogicalRangeChange`로 **시간축을 상호 동기화**
한다(한 pane을 줌/스크롤하면 나머지도 따라옴 — 라이브 검증됨). 거래량은 메인 pane 하단에
별도 price scale(`scaleMargins top:0.82`) 오버레이 히스토그램으로 얹었다.

---

## 2. 화면·컴포넌트 구조

```
app/
  layout.tsx            루트. 테마 flash 방지 인라인 스크립트(localStorage 'cdd-theme')
  globals.css           디자인 토큰(목업 팔레트) + 전 컴포넌트 스타일 + 라이트/다크
  page.tsx              화면 A — 검색 (client). 자동완성/최근검색/시장필터/키보드 내비
  chart/page.tsx        화면 B — 차트 분석 (client). 데이터 fetch·상태·레이어 오케스트레이션
components/
  ThemeToggle.tsx       ◑ 라이트/다크 토글 (data-theme + localStorage)
  ChartStack.tsx        ★ 핵심. lightweight-charts 래퍼. 메인/RSI/MACD pane 생성·동기화,
                        MA·볼린저·일목·엘리엇 오버레이, 패턴 마커+밴드, 미래 구름 확장
  LayerControls.tsx     우측 3레이어 컨트롤(①기본/②패턴/③고급). null·미구현 비활성+사유
  SignalPopover.tsx     종목요약바 "신호요약" 팝오버(일목/엘리엇 signal + 상위 패턴)
lib/
  api.ts                fetch 헬퍼 + ApiCallError. 백엔드 타입을 `import type`으로 소비
  recent.ts             최근검색 localStorage(최대 8, symbol 기준 dedupe)
  format.ts             통화/부호 포맷, 패턴 한글 라벨, category 색 매핑, signal 텍스트
```

### 상태 흐름 (chart/page.tsx)
- URL 쿼리(`symbol,market,name,exchange`)로 대상 결정 → `/api/ohlcv`+`/api/analysis`를
  **병렬 fetch**(AbortController로 취소). 캔들이 오면 차트를 그리고 분석은 도착 즉시 레이어 채움.
- `layers` 상태: `{ma,bollinger,rsi,macd,ichimoku,elliott}` (기본 MA·볼린저 ON, 나머지 OFF).
- 패턴은 `showPatterns`(리스트 표시) + `selected`(포커스된 1건) 분리. 리스트 클릭 → 해당
  `range`로 차트 이동 + 마커/밴드 표시. 재클릭 시 해제.
- 테마 변경은 `useThemeVersion`(MutationObserver on `data-theme`)이 감지해 ChartStack을
  리빌드(캔버스는 CSS 변수를 못 읽으므로 재생성 필요).

### ChartStack 리빌드 전략
단일 `useEffect`가 `[candles, analysis, layers, selectedPattern, themeVersion]` 변경 시
전체 차트를 재생성한다(시리즈 diff 대신). 데이터가 작아(≤수백 봉) 비용이 낮고 훨씬 단순·견고.
초기 컨테이너 폭이 0으로 잡히는 레이스는 `ResizeObserver`가 실제 폭 도착 시 `fitContent`로 보정.

---

## 3. 분석 스키마 → 화면 매핑 (02 문서 필드 그대로 소비)

| 레이어 | 응답 필드 | 렌더 |
|--------|-----------|------|
| ① MA | `indicators.sma.byPeriod[].values` | 메인 라인(period별 색: 5·20·60·120). null=선 끊김. 있는 period만 온다 |
| ① 볼린저 | `indicators.bollinger.upper/middle/lower` | 상·하단 라인 + 중심 점선(SMA20) |
| ① RSI | `indicators.rsi.values` | RSI 서브 pane + 70/30 priceLine, 현재값 표기 |
| ① MACD | `indicators.macd.macd/signal/histogram` | MACD 서브 pane: 히스토그램(양=up/음=down) + 2라인 |
| ② 패턴 | `patterns.structural[]`+`patterns.harmonic[]` | confidence 내림차순 리스트. 선택 시 `range` 밴드 + `keyPoints` 마커(bottom↑/top↓) + `range`로 줌 |
| ③ 일목 | `advanced.ichimoku` | 전환/기준/후행 + 선행A/B 라인. `leadingSpanA/B`의 `projectedDates` 꼬리로 **오른쪽 26봉 미래 확장** |
| ③ 엘리엇 | `advanced.elliottWave.impulse.waves[]` | ①~⑤ 라벨 마커 + 파동 연결선. `impulse:null`이면 `reason` 노출 |
| 신호요약 | `ichimoku.signal`, `elliottWave.signal`, 상위 패턴 | 팝오버. 부호+화살표 병기, 면책 문구 |

- MA/RSI/MACD/볼린저/일목/엘리엇 객체가 `null`이면 컨트롤 체크박스를 **회색 비활성 + 툴팁**
  (`meta.unavailable[키]` 사유를 "캔들 N개 필요 (현재 M)"로 정규화).
- 일부 MA period만 부족하면(`indicators.sma.60/120`) 별도 비활성 행으로 사유 표시.
- `advanced.inflectionPoints`(규칙 기반 4종 구현됨) → 체크박스 활성, 켜면 차트에 `IP {confidence}`
  화살표 마커(방향별 상승/하락 색). `null`인 경우(캔들 부족)만 회색 비활성 + 사유.

---

## 4. 에러/빈 상태 (와이어프레임 §7 준수)

`lib/api.ts`가 공통 에러 봉투를 `ApiCallError{code,message,cause,status}`로 던진다.
- `404 NOT_FOUND` → "데이터를 찾을 수 없습니다 (미상장·상장폐지 가능)" + 검색 복귀 버튼.
- `502 SOURCE_ERROR`/네트워크 → "데이터 소스 오류" + 다시 시도(reloadKey 재fetch) + `cause` 접이식.
- `400 BAD_REQUEST` → "요청이 올바르지 않습니다".
- 200이지만 캔들 0개 → 에러 아님, "표시할 시세 데이터가 없습니다"(기간 변경 유도).
- **분석만 실패**(캔들은 정상) → 차트는 그대로 그리고 상단에 "분석 결과 불러오지 못함" 안내(숨기지 않음).
- KR 시장 → 요약바에 "지연 시세 · 15~20분" 배지(스펙 §2-2).

검색(화면 A): 400(빈 질의)은 드롭다운 미표시, 네트워크 실패는 "검색을 불러오지 못했습니다 + 다시 시도",
정상 빈 결과는 "일치하는 종목이 없습니다"(회색 안내, 에러 아님).

---

## 5. 접근성 / 반응형

- 상승/하락은 색(빨강/파랑) **+ 부호(▲▼, +/−)** 병기. 신호도 화살표+수치 병기.
- 배지/팝오버/드롭다운 배경 **불투명**(EquiSense 반투명 금지 피드백 반영).
- 라이트/다크: `prefers-color-scheme` + `data-theme` 오버라이드 양방향. 차트도 테마 리빌드.
- **데스크톱 완성 우선**으로 마감. 모바일(≤900px)은 **최소 대응**:
  - 레이아웃 1컬럼으로 접힘, 서브패널(RSI/MACD)은 세로로 쌓여 스크롤.
  - 우측 레이어 컨트롤 → 하단 sticky 시트(`⚙ 레이어 설정` 핸들로 접기/펼치기).
  - 차트는 핀치줌/좌우 스크롤(lightweight-charts 기본 터치) 지원.

---

## 6. 미구현 / 제한사항 (숨기지 않고 명시)

1. ~~일목 구름 채우기(fill)~~ — 해결됨. lightweight-charts v4에 "두 시리즈 사이 밴드 채움"
   프리미티브가 없어, 패턴 구간 밴드(`patternband`)와 동일한 방식(SVG 오버레이 + `timeToCoordinate`
   /`priceToCoordinate` + 팬·줌·리사이즈 재계산)으로 구현. A/B 관계가 바뀌는 지점마다 구간을 나눠
   빨강(A>B)/파랑(A<B)으로 색이 바뀐다. (검토했던 "area-series 2개로 마스킹" 트릭은 마스크가
   그 아래 캔들까지 덮어버리는 문제가 있어 폐기.)
2. ~~모바일 서브패널 탭 전환~~ — 해결됨. RSI+MACD 둘 다 켜지면 `.subtab-bar` 탭이 뜨고
   (900px 미만에서만, CSS 미디어쿼리), 비활성 패널은 `display:none`. 데스크톱은 항상 스택.
   탭 전환 시 `activeSubTab`이 이펙트 의존성이라 차트가 다시 만들어지며 보이는 패널만
   실제 폭으로 그려짐(숨은 상태에서 만들면 폭 0 버그 회피).
3. ~~SMA만 오버레이~~ — 해결됨. EMA 토글 추가(레이어①, 점선으로 SMA와 구분), 기본값 OFF(화면 과밀 방지).
4. ~~하모닉 XABCD 선 연결~~ — 해결됨. 하모닉 패턴 선택 시 X-A-B-C-D를 점선으로 연결하고, D 지점은
   원형 마커+"PRZ" 라벨로 강조(`--harmonic` 색).
5. ~~appbar 인라인 재검색 드롭다운~~ — 해결됨. 검색 로직을 `components/SearchBox.tsx`로 추출해
   홈페이지·차트 헤더 양쪽에서 재사용. pill 클릭 시 그 자리에서 입력창+드롭다운으로 바뀜.

---

## 7. QA가 확인할 계약 포인트
- 프론트는 지표를 **재계산하지 않음** — `indicators/patterns/advanced` 필드를 그대로 소비.
- 인덱스 정렬: 모든 지표 시계열은 `dates[i]`↔`values[i]`. 일목 선행스팬만 `dates+projectedDates` 축.
- 패턴 정렬은 응답의 confidence 내림차순을 프론트에서도 병합 후 재정렬(structural+harmonic).
- KR/US 차이는 `currency`·`market`·`symbol` 접미사·지연배지뿐, 렌더 경로 동일.

---

## 8. 리스킨 검증 (목업 색감·톤·타이포 반영 확인)

사용자가 승인 단계 정적 목업(`wireframe_mockup.html`)의 **비주얼 스타일**을 실앱에 적용해
달라고 요청. 레이아웃은 유지, 색/폰트/표면만 대상.

**검증 결과 — 이미 목업과 완전 일치. 신규 변경 없음.** 구현 단계에서 목업의 `<style>` 토큰을
그대로 이식해 두었고(파일 헤더 주석에 명시), 재대조 결과 불일치 지점이 없었다.

- **`app/globals.css` 토큰**: 라이트/다크/`prefers-color-scheme` 3블록 모두 목업 `:root`·
  `[data-theme="dark"]` 값과 **byte 단위 동일**. (`--bg #f7f5f1`/`#14120e`, `--surface`,
  `--accent #a97722`/`#e6b45c`, `--up #c8433f`/`#ec6a63`, `--down #3667c2`/`#7aa3ee`,
  카테고리색 `--reversal/--continuation/--gapcat/--harmonic`, `--serif/--sans/--mono`,
  `--shadow`, `--radius`) — 목업에 없던 `--other`(기타 패턴 카테고리용)만 추가.
- **하드코딩 색 0건**: `app`·`components`·`lib`의 `.ts/.tsx` 전역 grep에서 hex/rgb 하드코딩
  없음. 인라인 `style`은 전부 레이아웃 속성이거나 `var(--token)` 참조.
- **차트 색(`ChartStack.tsx`)**: `cssVar()`로 토큰만 참조 — 캔들 up/down=`--up/--down`,
  MA20=`--accent`, MA60=`--gapcat`, 볼린저=`--text-faint`, 거래량=up/down+`66` 알파,
  RSI=`--harmonic`, MACD 라인=`--accent`/시그널=`--gapcat`/히스토=up/down+`99`,
  일목 선행A=`--continuation`/선행B=`--gapcat`, 그리드=`--surface-3` 점선, 축=`--border`.
  테마 토글 시 `themeVersion` 의존성으로 차트 전량 리빌드되어 다크 색 즉시 반영.
- **패턴 카테고리 배지색(`lib/format.ts` `categoryColorVar`)**: reversal→`--reversal`,
  continuation→`--continuation`, gap→`--gapcat`, harmonic→`--harmonic`, 그 외→`--other`.

**시각 확인(로컬 dev :3000, 브라우저)**:
- 라이트 검색화면: 따뜻한 페이퍼 배경 + 상단 amber 방사 글로우 + 세리프 헤딩/브랜드 ✓
- 라이트 차트: 상승=빨강·하락=파랑 캔들, amber MA20, 점선 그리드, amber 토글 ✓
- 다크 차트: 그래파이트 배경 + 밝은 amber 액센트 + 밝은 red/blue 캔들 ✓
- 패턴 레이어: 지속형=green·반전형=orange·갭=blue-violet 도트 ✓
- `npm run build` 통과(타입체크 포함).

---

## 9. 차트 뷰 크기 조절 + 줌 동적 해상도/히스토리

**크기 조절**: 메인 차트 아래 드래그 핸들(`.resizehandle`). `mainHeightRef`(ref, state 아님)로
관리 — 드래그 중엔 `mainApiRef.current.applyOptions({height})`만 호출해 전체 차트 재생성 없이
실시간 반영. 240~900px. 다음 심볼/기간 변경에도 사용자가 고른 높이 유지.

**줌인 시 동적 해상도**: 보이는 봉이 15개 밑으로 떨어지고(그것도 30일 이내 구간일 때만) 그
구간만 1시간봉(`interval=1h`)으로 재요청해 교체. 줌아웃하면 일봉으로 복귀. `lib/sources/yahoo.ts`에
인트라데이 타임스탬프 분기 추가 — 날짜만 쓰면 같은 날 여러 봉이 겹치는 버그라 ISO 타임스탬프로
전환(`toChartTime` 헬퍼가 문자열/UTCTimestamp 분기).

**좌측 팬 시 자동 히스토리 로드**: 기간 버튼은 초기 뷰만 결정 — 왼쪽 끝까지 팬/줌해도 빈 공간 없이
과거 데이터를 자동으로 이어붙인다. `checkLoadMore()`가 `subscribeVisibleTimeRangeChange`에서
"보이는 봉 수가 로드된 전체 봉 수와 거의 같다"(=fitContent로 전체를 보여주는 초기 상태)를
"사용자가 진짜 확대해서 왼쪽 끝을 미는 중"과 구분해 후자일 때만 180일치 청크를 추가 요청,
날짜 기준 중복 제거 후 앞에 붙이고 `setVisibleRange`로 보던 구간을 그대로 복원(`fitContent()`
호출 안 함 — 안 그러면 사용자가 보던 위치에서 "전체보기"로 튕겨나감).

**폐기한 접근**: 초기 마운트 직후 무조건 `checkLoadMore()` 한 번 호출 — `fitContent()` 직후는
항상 "전체 데이터가 화면에 다 보임"=logical.from 0이라 이게 "왼쪽 끝 도달"과 구분이 안 돼서
매 로드마다 자동으로 과거 데이터를 무한정 이어붙이는 폭주 버그가 남. "이벤트 첫 발생 스킵" 플래그로
땜빵했다가도 재현돼서, 결국 봉 개수 비율 기반 판정으로 교체해 해결.

## 10. 히스토리 10년 상한 · 기본 기간 3M · RSI/MACD 리사이즈 · 기본 크기 확대

**히스토리 10년 상한**: `checkLoadMore()`에 `MAX_HISTORY_YEARS=10` 컷오프 추가. 가장 이른 로드된
봉 날짜가 컷오프보다 이르면 더 요청 안 하고 `noMoreHistoryRef.current=true`로 멈춤(빈 공간 없음 —
그냥 그 시점에서 팬이 막힘). 컷오프에 걸치는 마지막 청크는 `from`을 컷오프 날짜로 클램프.

**기본 기간 3M**: `app/chart/page.tsx`의 `period` 초기값 `"1y"` → `"3mo"`.

**메인/RSI/MACD 줌 각각 동작**: 기존 다중 pane 동기화 루프(§1, §9)가 이미 모든 pane 상호 동기화하므로
별도 로직 불필요 — RSI/MACD에서 줌/팬해도 `setVisibleLogicalRange`로 메인에 전파되고, 메인 자신의
`subscribeVisibleTimeRangeChange`가 그 변화를 감지해 `checkZoomResolution`/`checkLoadMore`를 그대로
실행한다. 동기화 핸들러 안에 이 체크들을 직접 넣는 시도는 RSI/MACD의 자체 초기 `fitContent()` 중에도
발동해 메인 뷰가 찌그러지는 회귀를 일으켜 되돌림(주석으로 이유 남김). 브라우저에서 RSI 패널 위에서
스크롤 줌 → 메인 x축도 같이 변하는 것 확인.

**RSI/MACD 리사이즈**: 메인과 동일한 드래그 핸들 패턴을 `makeResizeHandler(heightRef, apiRef, min, max)`
팩토리로 일반화해 RSI(`rsiHeightRef`/`rsiApiRef`)·MACD(`macdHeightRef`/`macdApiRef`)에도 적용.
90~500px, 첫 렌더 240px.

**기본 크기 확대**: `DEFAULT_MAIN_HEIGHT` 320→560, RSI/MACD 기본 110(하드코딩)→240(`DEFAULT_SUB_HEIGHT`).
사용자 첨부 스크린샷 비율 근사치 — 픽셀 단위 정합은 아님.

**dev 전용 아티팩트(실버그 아님)**: RSI+MACD 토글을 같은 JS 틱에서 동시에 클릭하면 `next dev`에서만
메인 차트가 찌그러짐(React StrictMode의 이펙트 이중 실행 타이밍 문제). `next build && next start`
프로덕션 모드로 동일 시나리오 재현 시 정상 — 배포본에는 영향 없음. 디버그용 `console.log` 전부 제거.

## 11. 기간 선택 UI 제거 · 메인 차트 10년 로드 + 3개월 기본 뷰 · OHLC 기본 요소

**기간 선택 UI 삭제**: 우측 상단 `.periods` 버튼 그룹(1M/3M/6M/1Y/2Y/5Y) 완전 제거.
`app/chart/page.tsx`의 `period` state도 삭제 — `FETCH_PERIOD="10y"` 상수로 고정해 OHLCV·분석 API를
항상 10년치로 요청한다. 미사용 `.periods` CSS 삭제.

**메인 차트: 10년 로드 + 3개월 기본 뷰**: 데이터는 10년 전체(AAPL 기준 2513봉)가 한 번에 로드되므로
왼쪽으로 계속 팬해도 추가 fetch 없이 바로 과거를 탐색할 수 있다(기존 `checkLoadMore` 10년 컷오프는
그대로 안전장치로 남김 — 10년 지점에 닿으면 멈춤). 단, `fitContent()`로 전체를 다 보여주면 캔들이
줄처럼 찌그러지므로, `ChartStack.tsx`의 초기 뷰 설정을 `DEFAULT_VIEW_MONTHS=3`으로 최근 3개월만
`setVisibleRange`하도록 교체(패턴 포커스·인트라데이 줌·히스토리 팬 복원 케이스는 기존 로직 유지).

**버그 발견 및 수정 — 리사이즈 시 기본 뷰가 깨짐**: 브라우저 검증 중, 뷰포트 크기가 바뀌면(리사이즈
관찰자가 폭 변화를 감지) 메인 차트가 다시 `fitContent()`를 호출해 로드된 10년 전체를 다 보여주는
것을 발견 — `DEFAULT_VIEW_MONTHS` 3개월 기본값이 창 크기 조절 한 번에 날아감. 원래 이 refit은
"마운트 직후 그리드 레이아웃이 아직 안 잡혀 폭이 0일 때"만 필요했던 것인데, 조건이 `grew`(폭이 이전과
다르면 항상)로 되어 있어 이후의 일반 리사이즈에도 걸렸다. `lastWidth === 0`(최초 미확정 상태)이었을
때만 refit하도록 조건을 좁혀 수정 — 리사이즈해도 사용자가 보던 범위 유지되는 것 확인.

**캔들차트 기본 요소 보강**:
- **OHLC 호버 레전드**: 메인 패널 좌상단에 시가/고가/저가/종가/등락(±값·%)/거래량을 표시하는
  `.ohlcbar` 오버레이 추가. 마우스가 차트 위에 없을 때는 최신 봉 값을 기본 표시하고,
  `subscribeCrosshairMove`로 호버 중인 봉의 값을 실시간 갱신(`main.unsubscribeCrosshairMove`로
  언마운트 시 정리).
- **워터마크**: `main.applyOptions({ watermark })`로 캔들 배경에 옅은 종목 심볼 텍스트 표시
  (`rgba(128,128,128,0.09)`, 캔들을 가리지 않는 저대비).
- 나머지(크로스헤어, 우측 가격축 자동 스케일, 마지막가 점선, 시간축)는 기존 lightweight-charts 기본
  옵션으로 이미 충족되어 있었음 — 신규 구현 아님.

## 12. 패턴 기본 표시 + 체크박스 다중선택

**패턴 레이어 기본 ON**: `app/chart/page.tsx`의 `showPatterns` 기본값 `false`→`true`. 페이지 로딩 시
3개월 기본 뷰(§11) 안에서 바로 패턴 마커가 보인다.

**단일선택 → 체크박스 다중선택**: 기존에는 패턴 목록 항목을 클릭하면 그 패턴 하나만 선택되고(단일
`selected: {p,key}|null`), 선택 시 차트 뷰가 그 패턴의 range로 강제 이동(포커스 줌)하는 방식이었다.
다중선택 요구에 맞게 구조를 바꿨다:
- `selected` 단일 상태 → `selectedKeys: Set<string>`. 새 분석 결과가 들어올 때마다(`patternsWithKeys`
  변경) 전체 키로 리셋 — 기본 전체 선택.
- 패턴 키 생성(`${type}-${range.start}-${i}`)을 페이지에서 한 번만 계산(`patternsWithKeys` useMemo)해
  `LayerControls`·`ChartStack`에 그대로 전달 — 두 컴포넌트가 각자 키를 다시 만들면서 어긋나는 걸 방지.
- `LayerControls`의 패턴 리스트 항목이 단일 select 버튼에서 체크박스(`.cb`, 기존 `CheckRow`와 같은
  스타일 재사용)로 교체, 상단에 "N/전체개 표시 중" + "전체 선택"/"전체 해제" 버튼 행 추가.
- `ChartStack`의 `selectedPattern: Pattern|null` 단일 prop → `selectedPatterns: Pattern[]`. 마커
  렌더링(키포인트 화살표/원, 하모닉 XABCD 라인)을 배열 순회로 변경해 선택된 모든 패턴을 동시에 그린다.

**포커스 줌 제거**: 다중선택에서는 "선택 시 그 패턴 range로 뷰 강제 이동"이 의미가 없어(어느 패턴에
맞출지 불명확) 그 블록을 통째로 삭제했다. 곁들여 있던 단일 패턴 강조용 DOM 밴드 오버레이
(`bandRef`/`drawBand`/`.patternband` CSS)도 함께 제거 — 많아야 1개 패턴에만 의미 있던 장치라 다중선택
UI로 일반화하지 않고 걷어냈다. `checkZoomResolution`/`checkLoadMore`에 있던 `if (selectedPattern)
return` 가드(포커스 모드 중엔 줌/히스토리 로직을 건너뛰던 것)도 함께 삭제 — 더 이상 강제 포커스가
없으므로 불필요.

**버그 발견 및 수정 — 리사이즈 시 3개월 기본값이 다시 깨짐**: §11에서 이미 한 번 고쳤던 리사이즈 refit
문제가 변종으로 재발했다. 이번엔 브라우저 뷰포트를 바꾼 직후 새로고침하면, 차트가 폭 0으로 먼저
마운트되어 `applyDefaultRange()`(3개월 설정)가 실행된 뒤, `ResizeObserver`의 최초 콜백이 `wasUnsized`
분기를 타면서 그냥 `fitContent()`를 불러 3개월 설정을 덮어썼다(로드된 10년 전체가 보이는 상태로
튐 — "전체 해제"를 눌러도 마커 개수만 0/247로 바뀌고 뷰는 여전히 넓은 상태로 재현). 리사이즈 옵저버가
`fitContent()`를 직접 부르지 않고, 초기 뷰를 결정하던 로직을 `applyDefaultRange()` 함수로 뽑아 양쪽
(최초 마운트 직후, 리사이즈 옵저버의 `wasUnsized` 분기)에서 같은 함수를 재호출하도록 통일해 수정.

## 13. 패턴 목록 최근순 정렬 · 마커 한글화 · 마지막 봉 우측축 정렬

**패턴 목록 정렬 기준 변경**: `app/chart/page.tsx`의 `patterns` 정렬을 confidence 내림차순 →
`range.end` 날짜 내림차순(최근 것 먼저, confidence는 tie-break)으로 변경. 사이드바 패턴 목록이
"최근 발생한 패턴부터" 순서로 보인다. "신호요약" 팝오버가 쓰는 `topPattern`(가장 신뢰도 높은 패턴 1건)은
이 정렬과 별개 의미이므로, `patterns`를 confidence로 다시 정렬한 값에서 뽑도록 분리
(`useMemo`) — 목록 정렬 변경이 신호요약 표시를 바꾸지 않도록.

**패턴 마커 텍스트 한글화**: 차트 위 키포인트 마커(`top`/`bottom`/`peak`/`trough`/`rim`/`head`/
`left-shoulder`/`right-shoulder`/`pole-start`/`pole-end`/`consolidation-end`/`handle`/`gap-edge`)가
영문 그대로 렌더링되고 있었음 — `lib/format.ts`에 `patternKindLabel()` 매핑(고점/저점/가장자리/헤드/
좌측 어깨/우측 어깨/깃대 시작/깃대 끝/조정 종료/손잡이/갭 경계) 추가해 `ChartStack.tsx` 마커 생성부에
적용. 하모닉 패턴의 X/A/B/C/D는 국제 표준 표기라 번역하지 않고 그대로 둠. 변곡점 마커 `IP 0.xx`도
`변곡 0.xx`로 한글화.

**마지막 봉을 우측 축에 정렬**: `common.timeScale.rightOffset`을 4→0으로 변경 — 이전엔 최신 봉과
우측 가격축 사이에 빈 봉 4개만큼 여백이 있어 최근 날짜가 축에서 떨어져 보였다. 메인/RSI/MACD가 같은
`common` 설정을 공유하므로 세 패널 모두에 적용됨.

## 14. 메인 차트 기본 높이 뷰포트 비례 · 패턴 체크 시 위치 이동+핑 애니메이션

**기본 높이를 고정 px → 뷰포트 비례로 변경**: "첨부 스크린샷과 같은 크기로"라는 요청이 이번까지 세
번째였는데, 매번 스크린샷의 실제 캡처 창 크기를 알 수 없어 고정 px 값(320→560 등)을 계속 추측만
해온 상황이었다. 근본 원인은 스크린샷마다 브라우저 창 높이가 다르다는 것 — 같은 고정 px는 창이 작으면
과하게 크고 창이 크면 작아 보인다. `DEFAULT_MAIN_HEIGHT`(고정 560, SSR 폴백용으로만 남김) 대신
`defaultMainHeight()` 헬퍼가 `window.innerHeight * 0.62`(240~1000px로 clamp)를 계산해 최초 마운트 시
`mainHeightRef`의 초기값으로 사용하도록 변경 — 어떤 창 크기에서 열어도 화면 대비 비율이 일정하게
유지된다. `MAX_MAIN_HEIGHT`도 900→1000으로 소폭 상향(큰 모니터에서 과도하게 잘리지 않도록).

**패턴 체크 시 해당 위치로 이동 + 핑 애니메이션**: `LayerControls`에서 패턴 체크박스를 off→on으로 켤
때(`app/chart/page.tsx`의 `togglePatternKey`), 그 패턴 객체를 `focusPattern: {p, seq}` 상태로 세팅해
`ChartStack`에 내려보낸다(`seq`는 같은 패턴을 연달아 다시 체크해도 매번 새 객체가 되도록 하는 카운터 —
객체 참조가 안 바뀌면 React 이펙트가 재실행되지 않는 문제 방지).
- `ChartStack.tsx`에 `candleSeriesRef`를 새로 둬서(기존엔 캔들 시리즈가 메인 빌드 이펙트 안 지역변수로만
  존재) 별도의 가벼운 이펙트가 차트 전체를 재생성하지 않고도 좌표 계산에 접근할 수 있게 함.
- `focusPattern` 변경을 구독하는 새 `useEffect`(메인 빌드 이펙트와 완전히 분리 — 패턴 체크가 차트
  스택 전체 재생성을 유발하지 않도록)가: (1) 패턴의 `range`를 60% 여백을 두고 `setVisibleRange`로
  이동, (2) 패턴의 마지막 keyPoint 좌표에 `.patternpulse` div를 위치시키고 `animate` 클래스를 리트리거
  (제거→`offsetWidth` 강제 리플로우→재추가 트릭으로 같은 패턴 연속 체크 시에도 애니메이션이 처음부터
  다시 재생됨)해 핑 애니메이션 실행, 3초 뒤 `display:none`으로 정리.
- CSS `@keyframes patternpulse-ping`: 반경이 커지며 옅어지는 원형 링이 1.4초씩 2회 재생(위치를
  강조하는 "레이더 핑" 느낌).
- 브라우저에서 순차로 두 패턴을 체크해 각각 그 위치로 뷰가 이동하고 pulse DOM(`display:block`,
  `animate` 클래스, 좌표 지정)이 갱신되는 것 확인.

## 15. RSI/MACD가 메인과 어긋나는 버그 — 근본 원인 2건 발견·수정

사용자가 스크린샷에 빨간펜으로 "마지막 날짜가 우측 좌표축까지 안 붙는다"고 표시(RSI/MACD 패널만
해당, 메인 캔들은 정상). 스크린샷/`console.log` 몇 번은 신뢰 못 할 아티팩트로 판명(초기 렌더 타이밍,
탭 재사용 시 콘솔 버퍼 잔존, 스크롤-스크린샷 좌표 불일치 등) — 최종적으로 캔버스 픽셀을 직접 스캔해
계열 색상(RSI `--harmonic` 보라, MACD `--accent`)의 마지막 컬럼 위치를 재는 방법으로 그라운드트루스를
확보(`getImageData`로 각 x열에 계열 색상 픽셀이 있는지 검사, 마지막 발견 x좌표/캔버스폭 = ratio).

**원인 1 — 날짜 기반 `setVisibleRange`가 요청보다 훨씬 넓게 적용됨**: `DEFAULT_VIEW_MONTHS=3`으로
`{from: "2026-04-13", to: "2026-07-13"}`(정확히 3개월)를 `setVisibleRange`에 넘겼는데, 직후
`getVisibleRange()`로 재확인하면 `{from: "2025-06-20", to: "2026-07-13"}`(약 13개월)가 적용되어
있었음 — `to`가 데이터셋의 정확한 마지막 날짜와 일치하고 `rightOffset:0`인 조합에서
lightweight-charts v4가 요청한 것보다 훨씬 넓게 확대해버리는 것으로 보임(라이브러리 내부 동작까지는
특정 못 함). 고침: 날짜 대신 **bar 개수 기반** `setVisibleLogicalRange`로 교체
(`DEFAULT_VIEW_BARS=63`, `{from: total-63, to: total-1}`) — 날짜 검색을 아예 거치지 않아 항상 요청한
그대로 적용됨.

**원인 2 — RSI/MACD 패널 자체의 bar 인덱스가 메인과 어긋남**: RSI(14)/MACD(12,26,9)는 워밍업 구간이
있어 `toLine()`이 앞의 null 값을 건너뛰고 시리즈를 세팅했음. 메인 캔들 차트는 캔들 시리즈가 전체
`dates`를 다 갖고 있어 그 차트의 bar 0 = `dates[0]`이지만, RSI/MACD 차트는 캔들이 없고 라인/히스토그램
시리즈만 있어서 **그 시리즈 자신의 첫 데이터 포인트가 그 차트의 bar 0을 결정**한다 — RSI라면 워밍업만큼
밀려서 bar 0 = `dates[14]`가 되어버려, 메인의 logical range를 그대로 복사해도 RSI 쪽에서는 다른 날짜를
가리키게 되고(뒤쪽에 실제 데이터가 없는 여백이 남음), 최근 값으로 갈수록 그 어긋남이 누적돼 라인이
우측 끝 훨씬 못 미쳐 멈추는 것으로 나타났다(실측 76.9%). 고침: `toLine()`과 별개로 `toLineWithGaps()`
헬퍼를 추가 — 워밍업 구간도 값 없는 **whitespace 포인트**(`{time}`만 있고 `value` 없음, lightweight-charts
가 지원하는 개념)로 채워 넣어 RSI/MACD 시리즈가 `dates` 전체 길이를 그대로 갖도록 함. 이제 모든 패널의
bar 인덱스가 1:1로 정렬되어, 메인의 logical range를 그대로 복사(초기 동기화)하거나 pan/zoom 중 sync
loop(logical range 상호 전파)가 실제로 정확하게 맞아떨어진다. RSI/MACD 히스토그램 색상 매핑도 whitespace
포인트엔 `value`가 없으므로 `"value" in d`로 분기해 조건부 적용.

**동기화 방식도 logical로 통일**: RSI/MACD 최초 생성 직후 메인과 맞추던 코드를
`main.timeScale().getVisibleRange()`(date) 복사 방식에서 `getVisibleLogicalRange()`(bar-index)
복사로 변경 — 위 원인 1과 같은 이유로 date 기반은 신뢰할 수 없음이 확인됐기 때문.

**검증**: 캔버스 픽셀 스캔으로 메인 99.97%, RSI 99.12%, MACD 99.12% (완전한 100%가 아닌 건 선 굵기의
안티앨리어싱 오차 — 육안/기능상 문제 없음). 패턴 체크 시 포커스 이동(§14, 날짜 기반 `setVisibleRange`
그대로 사용 — 마지막 날짜가 아닌 임의 과거 구간이라 원인 1의 조건에 해당하지 않아 문제 없음 확인)에도
RSI/MACD가 정확히 같은 구간으로 따라오는 것 확인.

## 16. 위치 핑을 화살표 바운스로 교체 · 다중 봉 패턴 형태선 확대

**위치 핑 애니메이션 교체**: §14의 원형 링 확대·페이드 애니메이션(`patternpulse-ping`)을 위/아래로
살짝 튀는 화살표로 교체. `positionPulse()`가 anchor의 `kind`(bottom/trough/low 매칭)로 방향을 판정해
`▲`(상승, `--up` 색) 또는 `▼`(하락, `--down` 색)를 텍스트로 세팅하고 `.up`/`.down` 클래스를 부여,
anchor 좌표에서 방향에 맞게 16px 띄워 배치(화살표가 가리키는 지점에 겹치지 않도록). CSS는 `scale`
대신 `translateY(0 → -9px → 0)` 바운스를 4회 반복한 뒤(`patternpulse-bob`, 0.45s×4=1.8s) 0.3s
페이드아웃(`patternpulse-fade`, `animation-fill-mode: forwards`로 끝 상태 유지) — 두 애니메이션을
쉼표로 동시 등록해 각자의 delay/duration으로 순차 실행되게 함.

**다중 봉 구조적 패턴도 형태선으로 표시**: 기존엔 하모닉(Gartley/Butterfly/Bat/Crab)에만 keyPoints를
잇는 점선을 그려 XABCD 스윙 구조를 보여줬고, 나머지 패턴(이중/삼중바닥·천장, 원형바닥/천장, V자반전,
헤드앤숄더, 깃발형, 컵앤핸들 등)은 각 키포인트에 화살표/원 마커만 찍혀 있어 "무슨 모양인지"가 점들만
보고는 잘 안 읽혔다. 하모닉 전용이던 라인 그리기를 `pat.keyPoints.length >= 2`인 모든 선택된 패턴으로
일반화 — 각 패턴의 카테고리 색상(`categoryColorVar`)으로 keyPoints를 순서대로 잇는 실선(하모닉만 기존
그대로 점선 유지)을 추가해, 이중바닥은 "W", 원형바닥은 완만한 곡선, V자반전은 "V" 모양이 캔들 위에
그대로 겹쳐 보이게 함. 브라우저에서 원형바닥 체크 시 가장자리→저점→가장자리를 잇는 둥근 곡선이 실제로
렌더링되는 것 확인.

## 17. 형광(네온) 스타일 적용 · 패턴 기본값 전체 해제

**형광 색상 도입**: `app/globals.css` `:root`에 `--neon: #39ff14`(라이트/다크 공통 고정값 — 테마와
무관하게 항상 튀어야 하므로) 추가, `ChartStack.tsx`에도 같은 값을 `NEON` 상수로 선언(JS 쪽 lightweight-
charts 시리즈 옵션은 CSS 변수를 못 읽으므로 별도 상수 필요, 값은 동일하게 유지).

**패턴 형태선을 형광 + 굵게 + 곡선으로**: §16에서 카테고리 색상(`categoryColorVar`)으로 그리던 keyPoints
연결선을 전부 `NEON` 단색으로, `lineWidth` 1→3, `lineType: LineType.Curved`(lightweight-charts v4
지원 — 직선 대신 스플라인 보간 곡선)로 변경. 하모닉만 유지하던 점선 스타일은 그대로 둠. 마커(화살표/원)
색상은 기존 카테고리색 유지 — 형광 처리는 "형태선"에만 적용.

**위치 핑 화살표에 형광 테두리**: `.patternpulse`에 `-webkit-text-stroke: 1.5px var(--neon)` +
`text-shadow`(네온 글로우 2겹)를 추가 — 화살표 자체 색(▲=`--up`/▼=`--down`)은 유지한 채 테두리만
네온으로 강조. `getComputedStyle`로 `webkitTextStrokeColor`가 실제 `rgb(57,255,20)`으로 적용됨을
브라우저에서 확인.

**패턴 기본값을 전체 해제로 변경**: §12에서 "새 분석 결과 로드 시 전체 선택"이었던 기본 동작을
"전체 해제"로 뒤집음(`app/chart/page.tsx`— `patternsWithKeys` 변경 시 `setSelectedKeys(new Set())`).
패턴 레이어 스위치(`showPatterns`) 자체는 계속 기본 ON이라, 페이지 로딩 직후엔 목록만 보이고 체크박스는
전부 비어 있으며 마커/형태선은 사용자가 개별 선택하거나 "전체 선택"을 눌러야 나타난다.

## 18. 패턴 체크 시 봉차트가 커졌다 사라지는 플리커 — 근본 원인은 전체 rebuild

**증상**: 패턴 체크박스를 켤 때마다 메인 캔들 차트가 순간적으로 커졌다가 원래 크기로 돌아오는 깜빡임.

**원인**: `selectedPatterns`가 메인 차트를 통째로 만드는 거대한 `useEffect`의 의존성 배열에 들어있었다
— §16에서 패턴 형태선(keyPoints 연결선)을 추가하면서 이 배열에 자연스럽게 편입된 것. 패턴 체크박스를
누를 때마다 `selectedPatterns` 참조가 바뀌므로, 매번 기존 lightweight-charts 인스턴스 3개(메인/RSI/MACD)를
전부 `chart.remove()`로 파괴하고 `createChart()`로 처음부터 다시 만들었다 — 새 차트가 아직 폭/높이가
확정되기 전(또는 기본 캔버스 크기) 상태로 한 프레임 그려졌다가 실제 크기로 리사이즈되는 과정이
"커졌다가 사라지는" 것처럼 보인 것. 패턴 체크는 사용자가 아주 빈번하게 누르는 조작이라 이 rebuild
비용이 매번 눈에 띄는 플리커로 나타났다.

**수정**: 패턴 마커/형태선 그리기 로직을 `drawPatternShapes()` 함수로 분리해 메인 rebuild 이펙트
밖(컴포넌트 본문, `useCallback`)으로 뽑고, `selectedPatterns`를 rebuild 이펙트의 의존성 배열에서
제거했다. 대신 `selectedPatterns`만 의존하는 별도의 가벼운 `useEffect`가 `drawPatternShapes()`를
호출 — 기존 차트 인스턴스(`mainApiRef`/`candleSeriesRef`)를 그대로 재사용해 패턴 라인 시리즈만
추가/제거(`extraSeriesRef`)하고 `setMarkers()`만 다시 호출한다. 하모닉이 아닌 조합(엘리엇 파동·변곡점)
마커는 `staticMarkersRef`에 rebuild 시점에 한 번 저장해뒀다가 패턴 마커와 합쳐서(`setMarkers`) 세팅 —
두 이펙트가 서로 다른 시점에 실행돼도 마커가 서로 덮어쓰지 않도록.

**검증**: 패턴 체크 전/후로 메인 패널의 실제 `<canvas>` DOM 엘리먼트 참조를 저장해 비교
(`canvas === window.__beforeCanvas`) → `true`, 캔버스 크기(`width`/`height`)도 불변 — 차트가 전혀
재생성되지 않고 같은 인스턴스에 라인만 추가됐음을 확인. 화면상 플리커 없이 형태선이 바로 나타남.

## 19. 패턴 리스트 높이 동기화 · RSI 기본 ON · 라인 그리기 애니메이션 · 지속 화살표 · 갭 패턴 플리커

**패턴 리스트를 메인 차트 높이에 맞추고 내부 스크롤**: 사이드바 패턴 목록이 247건까지 그냥 이어져
페이지 전체 높이가 9863px까지 늘어나던 문제(§18 근처에서 이미 관찰) 해결. `ChartStack`에
`onMainHeightChange?: (h:number)=>void` prop 추가 — 메인 차트 생성 직후 및 드래그 리사이즈 중
(`makeResizeHandler`에 `onChange` 콜백 파라미터 추가) 호출. `app/chart/page.tsx`가 이 값을
`mainHeight` state로 받아 `LayerControls`에 `patternListMaxHeight`로 전달, `.patternlist`에
`maxHeight`+`overflowY:auto` 적용. 검증: `mainPanelHeight`와 `listClientHeight`가 정확히 일치(670px),
`document.body.scrollHeight`가 9863px→1400px로 감소.

**RSI 기본 ON**: `app/chart/page.tsx` layers 초기값 `rsi: false`→`true`.

**패턴 다중선택 구조를 key 기반 diff로 재설계**: 지금까지 `ChartStack`은 `selectedPatterns: Pattern[]`을
받아 매번 전체(라인+화살표)를 지우고 다시 그렸다. "체크한 패턴만 애니메이션으로 그려지고, 이미 켜진
패턴은 그대로 유지, 화살표는 체크 해제 전까지 계속 표시"하려면 어떤 패턴이 *새로* 켜졌는지 구분해야
해서, prop을 `{ p: Pattern; key: string }[]`로 바꾸고(`app/chart/page.tsx`의 `patternsWithKeys`를 그대로
필터링해 전달), `drawPatternShapes`를 diff 기반으로 재작성:
- `patternSeriesRef: Map<key, LineSeries>`, `patternArrowsRef: Map<key, HTMLDivElement>` — 이제 선택
  안 된 키만 제거, 이미 있는 키는 그대로 두고, 새 키만 추가.
- **라인 그리기 애니메이션**: 새로 추가되는 키에 한해 `animatePatternLine()`(모듈 레벨 함수, `performance.now()`
  기반 `requestAnimationFrame` 루프)이 keyPoints를 1개→전체까지 순차적으로 `setData()`해 500ms에 걸쳐
  라인이 점점 그려지도록 함. 이미 그려진 패턴은 `shape.setData(fullData)`로 즉시 갱신(재애니메이션 안 함).
- **화살표를 1회성 핑에서 지속 표시로 전환**: 기존 단일 `pulseRef` div(3초 후 `display:none`)를 걷어내고,
  패턴별로 DOM 엘리먼트를 동적 생성해 `.patternarrows` 컨테이너(새 ref, `panel__chart` 안에 항상 존재)에
  append — 체크 해제되면 `el.remove()`. CSS 애니메이션도 `patternpulse-bob 0.9s infinite`로 바꿔 무한
  반복(`patternpulse-fade` 키프레임은 삭제). 각 화살표는 `dataset.time`/`dataset.price`/`dataset.dir`에
  좌표 정보를 저장해두고, 새 `repositionArrows()`(컴포넌트 레벨 `useCallback`)가 이 값들로 모든 화살표의
  화면 좌표를 재계산 — pan/zoom(`rangeHandler`)·리사이즈(`ResizeObserver`)·패턴 그리기 직후·포커스 이동
  후(rAF) 등 뷰가 바뀔 수 있는 모든 지점에서 호출해 화살표가 항상 올바른 위치를 따라가도록 함.

**갭 패턴(갭상승/갭하락/일반갭 등) 체크 시 플리커 수정**: §18에서 패턴 체크 자체의 rebuild 플리커는
고쳤지만, `focusPattern`(패턴 위치로 뷰 이동) 이펙트가 여전히 날짜 기반 `setVisibleRange`를 쓰고
있었다 — §15에서 이미 발견한 "`rightOffset:0`+특정 날짜 조합에서 요청보다 훨씬 넓은 범위가 적용되는"
lightweight-charts 동작이, keyPoints가 2개뿐이라 range span이 1~2일밖에 안 되는 갭 계열 패턴에서 특히
심하게 발현되어 "커졌다 사라지는" 것처럼 보였다. `candles` 배열에서 `pat.range.start/end`에 대응하는
실제 봉 인덱스를 찾아 `setVisibleLogicalRange`(bar-index)로 교체 — 날짜 검색 경로를 완전히 우회.

**검증**: `mainPanelHeight===listClientHeight`(670px) 일치, `body.scrollHeight` 9863→1400. 이중바닥
체크 후 V자반전 추가 체크 → 화살표 2개 모두 유지(`display:block`) 확인. 갭상승 체크 전/후 메인 캔버스
DOM 노드 identity 비교 → `true`(재생성 없음), 뷰가 정확히 갭 구간으로 확대되고 "갭 경계" 화살표 2개 +
초록 연결선이 정상 표시되는 것 스크린샷으로 확인.

## 20. 라인 그리기 애니메이션이 뚝뚝 끊기는 문제 — lightweight-charts 시리즈 → SVG path로 전환

**증상**: §19의 `animatePatternLine()`(keyPoints를 1개→전체까지 `series.setData(fullData.slice(0,count))`로
점진 공개)이 실제로는 매끄럽지 않았다. 원인: 대부분의 패턴 keyPoints가 2~5개뿐이라, 3초짜리
애니메이션이라 해도 실제로는 `count`가 1→2→3처럼 정수 단계로만 뛰어서 화면엔 몇 번의 순간 점프로만
보였다(특히 2개짜리 갭 패턴은 사실상 애니메이션 없이 중간에 한 번 툭 나타나는 수준).

**수정**: 패턴 형태선을 lightweight-charts `addLineSeries()`(bar 단위로만 데이터를 공개할 수 있음)에서
plain SVG `<path>` 오버레이로 교체(`.patternlines`, 기존 `.cloudlayer`/일목구름과 같은
timeToCoordinate/priceToCoordinate 기반 재계산 패턴). 좌표들을 Catmull-Rom→베지어 변환
(`catmullRomPath`)으로 부드러운 곡선 path 하나로 만들고, `revealPath()`가
`stroke-dasharray`/`stroke-dashoffset` CSS 트랜지션으로 path 전체 길이(`getTotalLength()`)를
기준삼아 그려낸다 — 점 개수와 무관하게 진짜 연속적인 "선이 그어지는" 효과. `patternPathsRef`/
`patternPointsRef`/`patternRevealedRef`로 패턴별 상태 관리(이미 다 그려진 패턴은 재애니메이션 없이
`d` 속성만 갱신, pan/zoom 시 `drawPatternLinePositions()`가 dasharray도 함께 재동기화해 경로가 바뀌어도
끊겨 보이지 않게 함). 하모닉 패턴 전용이던 점선 스타일은 stroke-dasharray를 리빌 애니메이션 용도로
전용해야 해서 §20에서 일단 제거(전부 실선)했다가, 이번에 복구했다(아래 §21).

## 21. 하모닉 패턴 점선 복구

§20에서 리빌 애니메이션에 `stroke-dasharray`(단일 대시 = path 전체 길이, `dashoffset`을 그 길이→0으로
트랜지션)를 쓰게 되면서, 같은 속성을 반복 점선 패턴("6 4" 같은)으로도 쓰던 하모닉 전용 스타일과
충돌해 걷어냈었는데, 이번에 다시 구분해달라는 요청. `revealPath()`에 `finalDashArray?: string` 파라미터
추가 — 리빌 트랜지션이 끝나는 시점(`setTimeout(durationMs)`)에 `stroke-dasharray`를 고정 점선 패턴
(`HARMONIC_DASH = "10 6"`)으로 바꿔치기해, "쭉 그어지는 애니메이션"은 그대로 두고 애니메이션이 끝난
후의 정적 상태만 점선으로 표시한다. 어떤 패턴이 하모닉인지는 `patternHarmonicRef: Set<string>`에
기록(패턴 path 최초 생성 시 `pat.category === "harmonic"`이면 추가, 체크 해제 시 삭제) —
`drawPatternLinePositions()`의 pan/zoom 재동기화 분기도 이 Set을 참조해 하모닉이면 점선을, 아니면
기존처럼 solid 길이를 다시 세팅하도록 함께 수정. AAPL·TSLA 둘 다 이 스킬 세션 데이터에서 하모닉 패턴이
탐지되지 않아 화면으로 직접 재현 확인은 못 했음 — 로직 자체는 §16(최초 도입)·§20(SVG 전환)과 동일한
패턴을 그대로 따르는 단순 변경이라 빌드 통과로 갈음.

## 22. §20 리빌 애니메이션이 실제로는 아예 재생 안 되던 회귀 — rAF가 이 환경에서 멈춤

**증상**: 사용자가 "패턴 라인 그려지는 애니메이션이 없어졌다"고 보고. 실제로 라인 자체(최종 결과물)는
여전히 정상 렌더링됐지만, "서서히 그려지는" 과정 없이 곧바로 완성된 상태로 나타나고 있었다.

**원인**: §20에서 `revealPath()`가 "새로 DOM에 삽입한 요소에 트랜지션을 같은 tick에 걸면 브라우저가
씹는다"는 문제를 피하려고 `requestAnimationFrame`을 이중으로 감싸서 실제 트랜지션 시작을 한 프레임
미뤘는데, 브라우저 pane에서 직접 `getComputedStyle`로 폴링해 확인해보니 `path.style.transition`이
`"none"`에 영구히 멈춰 있었다 — 즉 이중 rAF의 콜백 자체가 실행되지 않고 있었다. 이 자동화/미니뷰
브라우저 환경에서 `requestAnimationFrame`이 페이지가 비활성/백그라운드로 취급될 때 스로틀되거나 아예
보류되는 것으로 보인다(일반 브라우저의 "백그라운드 탭에서 rAF 정지" 동작과 같은 종류). 트랜지션이
안 걸린 채로 몇 초 뒤 `strokeDashoffset`이 (React 리렌더나 다른 DOM 변경 계기로) 갑자기 "0"으로
반영되면서, 애니메이션 없이 툭 나타나는 것처럼 보인 것.

**수정**: 이중 `requestAnimationFrame` 대신 `setTimeout(fn, 20)`으로 교체 — 트랜지션은 순전히 시각
효과라 rAF의 "다음 페인트와 정확히 동기화" 보장이 필요 없고, `setTimeout`이 이런 백그라운드/비활성
상황에서 훨씬 더 안정적으로 스케줄링된다. `finalDashArray`(하모닉 점선 전환) 타이머도 시작 지연
20ms만큼 맞춰 `durationMs+20`으로 보정. 브라우저에서 재확인: 클릭 직후 `path.style.transition`이
`"stroke-dashoffset 3000ms linear"`로 정상 세팅되고(이전엔 `"none"`에 고착), 최종적으로 라인도
완성된 채로 렌더링되는 것 확인.

## 23. 갭하락 등 짧은 패턴 체크 시 확대된 봉차트가 0.5초 나타났다 사라지는 현상

**증상**: 갭상승/갭하락/일반갭처럼 keyPoints가 2개뿐(span 1~2일)인 패턴을 체크하면, focus-jump로
확대된 뷰가 잠깐 보였다가 곧 사라지고 원래 상태로 돌아갔다.

**원인**: `checkZoomResolution()`("줌인 시 동적 해상도" — 화면에 보이는 봉이 `ZOOM_BAR_THRESHOLD=15`개
밑으로 떨어지면 400ms 디바운스 후 그 구간만 1시간봉으로 재요청해 교체하는 기능, §9)에 `selectedPattern`
가드가 있었는데, §12~§19에서 다중선택 구조로 리팩터링하며 그 가드가 빠졌다. 갭 패턴은 span이 워낙
짧아 focus-jump 후 뷰에 보이는 봉 수가 15개를 가볍게 밑도는데, 이게 그대로 "사용자가 확대했다"로
오인식돼 인트라데이 데이터를 새로 fetch하고 `zoomCandles` state를 세팅 — 이 state가 메인 차트 rebuild
이펙트의 의존성이라 차트 3개(메인/RSI/MACD)가 통째로 파괴·재생성됐다. 그 rebuild 순간이 "확대된
봉차트가 사라짐"으로 보인 것.

**수정**: `patternFocusActiveRef`(불리언 ref) 추가 — focus-jump 이펙트가 뷰를 옮기는 시점에 `true`로
세팅하고 2초 뒤 자동으로 `false`로 되돌린다(그 사이엔 사용자가 실제로 수동 줌해도 해상도 전환이 잠깐
억제되지만, 포커스 점프 자체가 만든 좁은 뷰에서 오작동하는 것보다 훨씬 드문 트레이드오프). 이 값이
`true`인 동안 `checkZoomResolution()`이 아무 것도 안 하도록 맨 위에 가드 추가. 브라우저 검증: 갭하락
체크 전/후/2.5초 뒤까지 메인 캔버스 DOM 노드 identity 비교 — 계속 `true`(재생성 전혀 없음), 확대된
일봉 뷰가 시간봉으로 안 바뀌고 그대로 안정적으로 유지되는 것 확인.

## 24. §23 수정이 실제로는 불충분했음 — 시간 기반 해제가 근본적으로 잘못된 접근

**증상**: §23 배포 후에도 "갭하락 선택 시 확대된 봉차트가 잠깐 나타났다 사라진다"는 재보고를 받고
재현 — 처음 체크했을 땐 정상이었지만, "전체 해제 → 같은 패턴 재체크" 시퀀스에서 여전히 재현됐다.
확인해보니 뷰가 조용히 인트라데이(1시간봉) 데이터로 전환돼 있었다(OHLC 값과 거래량이 일봉 대비 훨씬
작은 인트라데이 숫자로 바뀜, "9 9 10 10 10" 식의 이상한 x축 날짜 라벨).

**원인**: §23의 `patternFocusActiveRef`는 **2초 타이머**로 자동 해제됐는데, 갭 패턴처럼 focus-jump가
만든 좁은 뷰는 원래 계속 `ZOOM_BAR_THRESHOLD`(15봉) 밑에 머무는 게 정상 상태다(그게 확대의 목적이니
당연함) — 타이머가 만료되는 순간 가드가 풀리고, 뷰는 여전히 좁으므로 `checkZoomResolution`이 다시
정상적으로(가드 없이) 실행돼 인트라데이 전환 타이머를 재예약한다. 즉 "패턴 체크 직후 몇 초"만 억제해봐야
근본적으로 소용없었다 — 사용자가 그 확대된 뷰를 몇 초 이상 그냥 보고만 있어도(또는 그 사이에 다른
조작을 몇 번 하는 동안 시간이 흘러도) 결국 전환이 발동한다.

**수정**: 시간 기반 해제를 완전히 버리고 **사용자의 실제 상호작용 기반**으로 바꿨다 — focus-jump는
`patternFocusActiveRef.current = true`를 무기한 유지하고, 메인 차트 컨테이너에 `wheel`/`mousedown`
리스너를 새로 달아 사용자가 실제로 마우스 휠 확대나 드래그를 하는 순간에만 `false`로 풀리도록 함(그
전까지는 패턴이 만든 뷰가 몇 초든 몇 분이든 안정적으로 유지됨). `checkLoadMore()`에도 같은 가드를
추가(§23에서 빠져 있었음 — 히스토리 자동 로드도 같은 이유로 좁은 뷰를 흔들 수 있어서). focus-jump
직전엔 이미 예약돼 있던 `zoomTimerRef`도 명시적으로 `clearTimeout` — 가드는 *새* 타이머 예약만 막지,
이미 카운트다운 중이던 타이머는 못 막기 때문. 브라우저에서 "전체 해제 → 재체크"를 반복해도 OHLC 값이
계속 일봉 그대로(₩1,902,000 등) 유지되는 것으로 재검증.

## 25. focus-jump 확대율을 패턴 span 비례 → 3개월 고정폭으로 변경

§14에서 "패턴 체크 시 그 위치로 이동"을 구현할 때, 패턴의 range span에 비례해서(`pad = max(3,
round(span*0.6))`) 확대하도록 했었다 — keyPoints가 많고 span이 긴 패턴(원형바닥 등)은 적당히
넓게 보였지만, 갭 계열처럼 keyPoints 2개(span 1~2일)뿐인 패턴은 최소 pad(3바)가 적용돼도 전체
뷰가 겨우 7~10바 정도로 "과하게 확대된" 상태가 됐다(§23/§24에서 봤던 "0.5초 반짝임"과는 별개로,
이 확대 자체가 사용자에게 지나치게 좁게 느껴짐). 요청: "3개월이 보이는 뷰 크기로".

패턴 span에 비례한 padding 대신, **뷰 폭 자체를 기본 뷰와 같은 `DEFAULT_VIEW_BARS`(63바, ~3개월)로
고정**하고 패턴을 그 중앙에 오도록 변경 — `centerIdx = round((startIdx+endIdx)/2)`,
`half = round(DEFAULT_VIEW_BARS/2)`, `setVisibleLogicalRange({from: centerIdx-half, to:
centerIdx+half})`(배열 경계는 기존처럼 clamp). 패턴이 얼마나 짧든 길든 항상 3개월 폭 근처로 보여서,
갭 패턴만 유독 심하게 확대돼 보이던 문제가 없어짐.

**추가 보정 — 데이터 끝부분 clamp 시 폭이 좁아지는 문제**: 최초 구현(위 `centerIdx±half`를 그냥
`Math.max(0,·)`/`Math.min(length-1,·)`로만 clamp)으로 갭하락을 확인해보니 뷰가 6주 정도(63바에
못 미침)로만 넓어졌다 — 패턴이 로드된 데이터의 최근 끝부분 근처에 있어서 `to`가 `length-1`로 잘리고
그만큼 `from`은 안 당겨져 전체 폭이 좁아진 것. `viewFrom`/`viewTo`를 한쪽이 잘리면 반대쪽으로 그만큼
밀어주는 방식(`applyDefaultRange`의 3개월 기본값 계산과 같은 스타일)으로 교체 — 데이터 시작/끝
근처의 패턴도 항상 정확히 `DEFAULT_VIEW_BARS`(63바) 폭을 확보하도록 수정. 브라우저 재검증: 갭하락
체크 시 뷰가 정확히 4/13~7/16(약 3개월, 데이터 최근 끝까지 꽉 채움)으로 확대되는 것 확인.

"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import ThemeToggle from "@/components/ThemeToggle";
import LayerControls from "@/components/LayerControls";
import SignalPopover from "@/components/SignalPopover";
import SearchBox from "@/components/SearchBox";
import type { LayerState } from "@/components/ChartStack";
import type { Pattern } from "@/lib/analysis/patterns";
import {
  fetchOhlcv,
  fetchAnalysis,
  ApiCallError,
  type OhlcvResponse,
  type AnalysisResult,
  type Market,
  type SearchResult,
} from "@/lib/api";
import { pushRecent } from "@/lib/recent";
import { formatPrice, formatSigned } from "@/lib/format";

// lightweight-charts touches the DOM/window; load the chart client-side only.
const ChartStack = dynamic(() => import("@/components/ChartStack"), {
  ssr: false,
});

// The period selector is gone: the main chart always fetches 10 years of
// history so panning back in time never dead-ends, while ChartStack.tsx sets
// the initial *visible* viewport to the most recent 3 months.
const FETCH_PERIOD = "10y";

/** Observe data-theme mutations so charts rebuild with the right palette. */
function useThemeVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    const obs = new MutationObserver(() => setV((n) => n + 1));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => obs.disconnect();
  }, []);
  return v;
}

function ChartInner() {
  const router = useRouter();
  const params = useSearchParams();
  const symbol = params.get("symbol") ?? "";
  const market = (params.get("market") as Market) ?? "US";
  const nameParam = params.get("name") ?? "";
  const exchange = params.get("exchange") ?? "";

  const [ohlcv, setOhlcv] = useState<OhlcvResponse | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiCallError | null>(null);
  const [analysisError, setAnalysisError] = useState<ApiCallError | null>(null);

  const [layers, setLayers] = useState<LayerState>({
    ma: true,
    ema: false,
    bollinger: true,
    volume: true,
    volumeProfile: false,
    rsi: true,
    macd: false,
    ichimoku: false,
    elliott: false,
    inflection: false,
  });
  // Mirrors the main chart's live rendered height (ChartStack reports it via
  // onMainHeightChange) so the pattern list can be capped/scrolled to match
  // instead of stretching the whole page.
  const [mainHeight, setMainHeight] = useState<number | null>(null);
  // Patterns default to hidden — the user opts in per-pattern (or "전체
  // 선택"). `selectedKeys` is reset to "none" whenever a fresh pattern list
  // arrives (new symbol/analysis), not on every render.
  const [showPatterns, setShowPatterns] = useState(true);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  // Set whenever a pattern is just checked on — tells ChartStack to pan to
  // it (keeping the user's current zoom level, not resetting it). seq forces
  // a fresh object even if the same pattern is re-checked twice in a row.
  const [focusPattern, setFocusPattern] = useState<{ p: Pattern; seq: number } | null>(null);
  const focusSeqRef = useRef(0);
  const [showSignals, setShowSignals] = useState(false);
  const [sheetCollapsed, setSheetCollapsed] = useState(true);
  const [researching, setResearching] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const themeVersion = useThemeVersion();

  // Persist to recent searches on first successful load.
  useEffect(() => {
    if (symbol && ohlcv) {
      pushRecent({
        symbol,
        name: ohlcv.name ?? nameParam ?? symbol,
        market,
        exchange: exchange || null,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, ohlcv]);

  // Fetch OHLCV + analysis in parallel when the target or period changes.
  useEffect(() => {
    if (!symbol) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setAnalysisError(null);
    // Without this, switching symbols left the PREVIOUS stock's ohlcv/analysis
    // sitting in state while the new fetch was in flight — the render in
    // between showed the old stock's stale chart (loading&&!ohlcv was false
    // since ohlcv was still truthy), and if that stale response then failed
    // to overwrite in time, `candles.length` could momentarily read from
    // in-between/inconsistent state and fall through to EmptyState instead
    // of the loading skeleton. Clearing both up front makes every symbol
    // change behave like a fresh mount.
    setOhlcv(null);
    setAnalysis(null);

    fetchOhlcv({ symbol, market, period: FETCH_PERIOD }, ctrl.signal)
      .then((data) => setOhlcv(data))
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setOhlcv(null);
        setError(e instanceof ApiCallError ? e : new ApiCallError("SOURCE_ERROR", String(e), 0));
      })
      .finally(() => {
        // React 18 StrictMode (dev only) double-invokes this effect: the
        // first invocation's request gets aborted by its own cleanup almost
        // immediately, rejecting near-instantly with AbortError — but
        // .finally() still runs for a rejected promise regardless of *why*
        // it rejected. Without this guard, that phantom aborted request's
        // finally fired setLoading(false) while the REAL (second) request
        // was still in flight, briefly showing EmptyState (loading=false,
        // ohlcv=null) until the real one resolved. Only the request that
        // actually owns this ctrl (i.e. wasn't the one aborted) may flip it.
        if (!ctrl.signal.aborted) setLoading(false);
      });

    fetchAnalysis({ symbol, market, period: FETCH_PERIOD }, ctrl.signal)
      .then((data) => setAnalysis(data))
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setAnalysis(null);
        setAnalysisError(e instanceof ApiCallError ? e : null);
      });

    return () => ctrl.abort();
  }, [symbol, market, reloadKey]);

  const patterns = useMemo<Pattern[]>(() => {
    if (!analysis) return [];
    // Most recent pattern first (by where it ends), confidence as tiebreak.
    return [...analysis.patterns.structural, ...analysis.patterns.harmonic].sort(
      (a, b) => b.range.end.localeCompare(a.range.end) || b.confidence - a.confidence,
    );
  }, [analysis]);

  const patternsWithKeys = useMemo(
    () => patterns.map((p, i) => ({ p, key: `${p.type}-${p.range.start}-${i}` })),
    [patterns],
  );

  // A fresh pattern list (new symbol/analysis) defaults to "none selected".
  useEffect(() => {
    setSelectedKeys(new Set());
  }, [patternsWithKeys]);

  const selectedPatterns = useMemo(
    () => (showPatterns ? patternsWithKeys.filter((x) => selectedKeys.has(x.key)) : []),
    [showPatterns, patternsWithKeys, selectedKeys],
  );

  // "신호요약" wants the highest-confidence pattern, independent of the
  // recency order the sidebar list uses.
  const topPattern = useMemo(
    () => [...patterns].sort((a, b) => b.confidence - a.confidence)[0] ?? null,
    [patterns],
  );

  const summary = useMemo(() => {
    const cs = ohlcv?.candles ?? [];
    if (cs.length < 1) return null;
    const last = cs[cs.length - 1];
    const prev = cs.length > 1 ? cs[cs.length - 2] : last;
    const delta = last.close - prev.close;
    const pct = prev.close ? (delta / prev.close) * 100 : 0;
    return { close: last.close, delta, pct, up: delta >= 0 };
  }, [ohlcv]);

  function toggleLayer(key: keyof LayerState) {
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }));
  }
  function togglePatterns() {
    setShowPatterns((s) => !s);
  }
  function togglePatternKey(key: string) {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        const found = patternsWithKeys.find((x) => x.key === key);
        if (found) setFocusPattern({ p: found.p, seq: ++focusSeqRef.current });
      }
      return next;
    });
  }
  function selectAllPatterns() {
    setSelectedKeys(new Set(patternsWithKeys.map((x) => x.key)));
  }
  function deselectAllPatterns() {
    setSelectedKeys(new Set());
  }
  function selectSearch(r: SearchResult) {
    pushRecent(r);
    setResearching(false);
    const qs = new URLSearchParams({
      symbol: r.symbol,
      market: r.market,
      name: r.name ?? "",
      exchange: r.exchange ?? "",
    });
    router.push(`/chart?${qs}`);
  }

  const displayName = ohlcv?.name ?? nameParam ?? symbol;
  const currency = ohlcv?.currency ?? (market === "KR" ? "KRW" : "USD");

  return (
    <>
      <header className="appbar">
        <button className="appbar__back" onClick={() => router.push("/")}>
          Chart Deep Dive
        </button>
        <div className="appbar__center">
          {researching ? (
            <SearchBox
              onSelect={selectSearch}
              placeholder={`${displayName} 대신 검색…`}
              autoFocus
              onBlurClose={() => setResearching(false)}
            />
          ) : (
            <button
              className="appbar__id"
              onClick={() => setResearching(true)}
              title="다른 종목 검색"
            >
              🔍 {displayName} · {exchange || market} · {symbol} ▾
            </button>
          )}
        </div>
        <ThemeToggle />
      </header>

      <div className="summarybar">
        <span className="summarybar__name">{displayName}</span>
        <span className="summarybar__meta">
          {symbol} · {exchange || market} · {currency}
        </span>
        {market === "KR" && <span className="delaybadge">지연 시세 · 15~20분</span>}
        {summary && (
          <>
            <span className="summarybar__price">
              {formatPrice(summary.close, currency)}
            </span>
            <span className={`summarybar__delta ${summary.up ? "up" : "down"}`}>
              {summary.up ? "▲" : "▼"} {formatSigned(summary.pct)}% (
              {formatSigned(summary.delta, currency === "KRW" ? 0 : 2)})
            </span>
          </>
        )}
        <button className="signalbtn" onClick={() => setShowSignals((s) => !s)}>
          신호요약 →
        </button>
        {showSignals && (
          <SignalPopover
            analysis={analysis}
            topPattern={topPattern}
            onClose={() => setShowSignals(false)}
          />
        )}
      </div>

      {/* main body */}
      {loading && !ohlcv ? (
        <LoadingState />
      ) : error ? (
        <ErrorState error={error} symbol={symbol} onBack={() => router.push("/")} onRetry={() => setReloadKey((k) => k + 1)} />
      ) : ohlcv && ohlcv.candles.length > 0 ? (
        <div className="layoutgrid">
          <div className="chartcol">
            {analysisError && (
              <div className="note-line" style={{ paddingBottom: 10 }}>
                분석 결과를 불러오지 못했습니다({analysisError.code}). 캔들은 정상
                표시되며, 지표/패턴/고급 기법은 일시적으로 비활성입니다.
              </div>
            )}
            <ChartStack
              symbol={symbol}
              market={market}
              currency={currency}
              candles={ohlcv.candles}
              analysis={analysis}
              layers={layers}
              selectedPatterns={selectedPatterns}
              focusPattern={focusPattern}
              themeVersion={themeVersion}
              onMainHeightChange={setMainHeight}
            />
          </div>

          <aside className={`sidecol ${sheetCollapsed ? "collapsed" : ""}`}>
            <button
              className="sheet-handle"
              onClick={() => setSheetCollapsed((c) => !c)}
            >
              <span>⚙ 레이어 설정</span>
              <span>{sheetCollapsed ? "▲" : "▼"}</span>
            </button>
            <LayerControls
              analysis={analysis}
              layers={layers}
              onLayer={toggleLayer}
              showPatterns={showPatterns}
              onTogglePatterns={togglePatterns}
              patternsWithKeys={patternsWithKeys}
              selectedKeys={selectedKeys}
              onTogglePatternKey={togglePatternKey}
              onSelectAllPatterns={selectAllPatterns}
              onDeselectAllPatterns={deselectAllPatterns}
              patternListMaxHeight={mainHeight}
            />
          </aside>
        </div>
      ) : (
        <EmptyState symbol={symbol} onBack={() => router.push("/")} />
      )}
    </>
  );
}

function LoadingState() {
  return (
    <div style={{ padding: 18 }}>
      <div className="skeleton" style={{ height: 320, marginBottom: 14 }} />
      <div className="loading-hint">시세·분석을 불러오는 중…</div>
    </div>
  );
}

function EmptyState({ symbol, onBack }: { symbol: string; onBack: () => void }) {
  return (
    <div className="centerbox">
      <h2>표시할 시세 데이터가 없습니다</h2>
      <p>‘{symbol}’ 종목의 캔들 데이터가 없습니다.</p>
      <button className="btn" onClick={onBack}>
        검색으로
      </button>
    </div>
  );
}

function ErrorState({
  error,
  symbol,
  onBack,
  onRetry,
}: {
  error: ApiCallError;
  symbol: string;
  onBack: () => void;
  onRetry: () => void;
}) {
  if (error.code === "NOT_FOUND") {
    return (
      <div className="centerbox">
        <h2>데이터를 찾을 수 없습니다</h2>
        <p>
          ‘{symbol}’ 종목의 데이터를 찾을 수 없습니다 (미상장·상장폐지 가능).
        </p>
        <button className="btn primary" onClick={onBack}>
          검색으로 돌아가기
        </button>
      </div>
    );
  }
  if (error.code === "BAD_REQUEST") {
    return (
      <div className="centerbox">
        <h2>요청이 올바르지 않습니다</h2>
        <p>요청 파라미터를 확인해 주세요.</p>
        <button className="btn" onClick={onBack}>
          검색으로
        </button>
      </div>
    );
  }
  // SOURCE_ERROR / NETWORK / etc.
  return (
    <div className="centerbox">
      <h2>데이터 소스 오류</h2>
      <p>데이터 소스 오류로 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p>
      <button className="btn primary" onClick={onRetry}>
        다시 시도
      </button>
      {error.cause && (
        <details className="details-cause">
          <summary>상세</summary>
          <pre>{error.cause}</pre>
        </details>
      )}
    </div>
  );
}

export default function ChartPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <ChartInner />
    </Suspense>
  );
}

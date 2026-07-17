"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { searchStocks, ApiCallError, type SearchResult, type Market } from "@/lib/api";

function MarketBadge({ result }: { result: SearchResult }) {
  const cls = result.market === "KR" ? "kr" : "us";
  return <span className={`badge ${cls}`}>{result.exchange ?? result.market}</span>;
}

interface Props {
  onSelect: (r: SearchResult) => void;
  markets?: { KR: boolean; US: boolean };
  placeholder?: string;
  initialQuery?: string;
  autoFocus?: boolean;
  onBlurClose?: () => void;
}

/** Query input + live dropdown, shared by the search page and the chart page's inline re-search pill. */
export default function SearchBox({
  onSelect,
  markets = { KR: true, US: true },
  placeholder = "삼성전자, AAPL, 005930 …",
  initialQuery = "",
  autoFocus = false,
  onBlurClose,
}: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const abortRef = useRef<AbortController | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const runSearch = useCallback(async (q: string) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const res = await searchStocks(q, ctrl.signal);
      setResults(res.results);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return;
      const msg =
        e instanceof ApiCallError && e.code === "BAD_REQUEST" ? null : "검색을 불러오지 못했습니다.";
      setError(msg);
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 1) {
      setResults([]);
      setOpen(false);
      setError(null);
      return;
    }
    setOpen(true);
    const t = setTimeout(() => runSearch(q), 220);
    return () => clearTimeout(t);
  }, [query, runSearch]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
        onBlurClose?.();
      }
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = results.filter((r) => markets[r.market]);

  function pick(r: SearchResult) {
    setOpen(false);
    onSelect(r);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setOpen(false);
      onBlurClose?.();
      return;
    }
    if (!open || filtered.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    if (filtered.length === 0) return;
    pick(filtered[active >= 0 ? active : 0]);
  }

  return (
    <div className="searchbox" ref={boxRef}>
      <div className="searchbox__field">
        <input
          type="text"
          value={query}
          placeholder={placeholder}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(-1);
          }}
          onFocus={() => query.trim() && setOpen(true)}
          onKeyDown={onKeyDown}
          autoFocus={autoFocus}
          aria-label="종목 검색"
        />
        <button
          type="button"
          className="searchbox__submit"
          onClick={submit}
          disabled={filtered.length === 0}
        >
          검색
        </button>
      </div>

      {open && (
        <div className="autocomplete" role="listbox">
          {error ? (
            <div className="autocomplete__error">
              {error}
              <button onClick={() => runSearch(query.trim())}>다시 시도</button>
            </div>
          ) : loading && filtered.length === 0 ? (
            <div className="autocomplete__empty">검색 중…</div>
          ) : filtered.length === 0 ? (
            <div className="autocomplete__empty">일치하는 종목이 없습니다</div>
          ) : (
            filtered.map((r, i) => (
              <button
                key={r.symbol}
                className={`autocomplete__row ${i === active ? "active" : ""}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(r)}
              >
                <div>
                  <div className="autocomplete__name">{r.name}</div>
                  <div className="autocomplete__symbol">{r.symbol}</div>
                </div>
                <span className="autocomplete__meta">
                  <MarketBadge result={r} />
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

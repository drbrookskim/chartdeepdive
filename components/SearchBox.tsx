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
  commandMode?: boolean;
}

/** Query input + live dropdown, shared by the search page and the chart page's inline re-search pill. */
export default function SearchBox({
  onSelect,
  markets = { KR: true, US: true },
  placeholder = "삼성전자, AAPL, 005930 …",
  initialQuery = "",
  autoFocus = false,
  onBlurClose,
  commandMode = false,
}: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [cmdOpen, setCmdOpen] = useState(!commandMode);
  const [isMac, setIsMac] = useState(true);
  const [held, setHeld] = useState<{ mod: boolean; key: boolean }>({ mod: false, key: false });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const abortRef = useRef<AbortController | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const cmdBtnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const springRef = useRef<{ w: number; wv: number; wt: number; sc: number; scv: number; sct: number }>({
    w: 128, wv: 0, wt: 128, sc: 1, scv: 0, sct: 1,
  });

  useEffect(() => {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    setIsMac(/mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform ?? navigator.platform ?? ""));
  }, []);

  useEffect(() => {
    if (!commandMode) return;
    const closedW = () => Math.max(118, Math.ceil(cmdBtnRef.current?.offsetWidth ?? 128));
    const openW = () => Math.min(360, Math.max(220, window.innerWidth - 180));
    springRef.current.wt = cmdOpen ? openW() : closedW();
    if (!cmdOpen) setOpen(false);
  }, [cmdOpen, commandMode]);

  useEffect(() => {
    if (!commandMode) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      const sp = springRef.current;
      const sub = 4;
      const h = dt / sub;
      for (let i = 0; i < sub; i++) {
        const aw = -300 * (sp.w - sp.wt) - 28 * sp.wv;
        sp.wv += aw * h;
        sp.w += sp.wv * h;
        const asc = -520 * (sp.sc - sp.sct) - 34 * sp.scv;
        sp.scv += asc * h;
        sp.sc += sp.scv * h;
      }
      if (pillRef.current) {
        pillRef.current.style.width = `${Math.max(96, sp.w).toFixed(2)}px`;
        pillRef.current.style.transform = Math.abs(sp.sc - 1) > 0.001 ? `scale(${sp.sc.toFixed(4)})` : "";
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [commandMode]);

  useEffect(() => {
    if (!commandMode) return;
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const onKeyDownWin = (e: KeyboardEvent) => {
      const modDown = isMac ? e.metaKey : e.ctrlKey;
      const kDown = e.key.toLowerCase() === "k" || e.code === "KeyK";
      if (!cmdOpen) {
        setHeld((c) => (c.mod === modDown && c.key === kDown ? c : { mod: modDown, key: kDown }));
        springRef.current.sct = modDown || kDown ? 0.97 : 1;
      }
      if (!e.repeat && modDown && kDown) {
        e.preventDefault();
        setCmdOpen((prev) => {
          const next = !prev;
          if (next) setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 40);
          return next;
        });
        return;
      }
      if (!cmdOpen && e.key === "/" && !isTyping(e.target)) {
        e.preventDefault();
        setCmdOpen(true);
        setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 40);
      }
    };
    const resetKeys = (e?: KeyboardEvent) => {
      const modDown = e ? (isMac ? e.metaKey : e.ctrlKey) : false;
      const kDown = e ? (e.key.toLowerCase() === "k" || e.code === "KeyK") && e.type === "keydown" : false;
      setHeld({ mod: modDown, key: kDown });
      if (!modDown && !kDown) springRef.current.sct = 1;
    };
    const onBlurWin = () => resetKeys();
    window.addEventListener("keydown", onKeyDownWin);
    window.addEventListener("keyup", resetKeys);
    window.addEventListener("blur", onBlurWin);
    return () => {
      window.removeEventListener("keydown", onKeyDownWin);
      window.removeEventListener("keyup", resetKeys);
      window.removeEventListener("blur", onBlurWin);
    };
  }, [commandMode, isMac, cmdOpen]);

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
        e instanceof ApiCallError && e.code === "BAD_REQUEST" ? null : "검색 결과를 불러오지 못했습니다.";
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
        if (commandMode) setCmdOpen(false);
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
      if (commandMode) {
        setCmdOpen(false);
        setQuery("");
        inputRef.current?.blur();
      }
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
    <div className={commandMode ? "searchbox cdd-cmd-wrap" : "searchbox"} ref={boxRef}>
      {commandMode ? (
        <div ref={pillRef} className={`cdd-cmd-pill${cmdOpen ? " open" : ""}`} style={{ width: 128 }}>
          <button
            ref={cmdBtnRef}
            type="button"
            className="cdd-cmd-btn"
            aria-expanded={cmdOpen}
            onPointerDown={() => { if (!cmdOpen) springRef.current.sct = 0.97; }}
            onPointerUp={() => { springRef.current.sct = 1; }}
            onPointerLeave={() => { springRef.current.sct = 1; }}
            onClick={() => {
              setCmdOpen(true);
              setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 40);
            }}
          >
            <span>Search</span>
            <span className="cdd-cmd-keys" aria-hidden="true">
              <kbd className="cdd-cmd-kbd" data-on={held.mod ? "true" : undefined}>{isMac ? "⌘" : "Ctrl"}</kbd>
              <kbd className="cdd-cmd-kbd" data-on={held.key ? "true" : undefined}>K</kbd>
            </span>
          </button>
          <div className="cdd-cmd-field">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ color: "var(--cb-muted)", flexShrink: 0 }} aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              ref={inputRef}
              className="cdd-cmd-input"
              type="text"
              value={query}
              placeholder={placeholder}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(-1);
              }}
              onFocus={() => query.trim() && setOpen(true)}
              onBlur={() => {
                setTimeout(() => {
                  if (!query.trim() && !boxRef.current?.contains(document.activeElement)) {
                    setCmdOpen(false);
                    setOpen(false);
                  }
                }, 120);
              }}
              onKeyDown={onKeyDown}
              aria-label="종목 검색"
            />
            <button
              type="button"
              className="cdd-cmd-kbd"
              title="닫기 (Esc)"
              onClick={() => {
                setCmdOpen(false);
                setOpen(false);
                setQuery("");
                inputRef.current?.blur();
              }}
            >
              Esc
            </button>
          </div>
        </div>
      ) : (
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
      )}

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

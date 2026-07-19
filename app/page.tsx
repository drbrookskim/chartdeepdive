"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession, signIn } from "next-auth/react";
import ThemeToggle from "@/components/ThemeToggle";
import UserChip from "@/components/UserChip";
import SearchBox from "@/components/SearchBox";
import type { SearchResult, Market } from "@/lib/api";
import { getRecent, pushRecent, removeRecent } from "@/lib/recent";

export default function SearchPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const [markets, setMarkets] = useState<{ KR: boolean; US: boolean }>({
    KR: true,
    US: true,
  });
  const [recent, setRecent] = useState<SearchResult[]>([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setRecent(getRecent());
  }, []);

  const RECENT_COLLAPSED = 6;
  const visibleRecent = expanded ? recent : recent.slice(0, RECENT_COLLAPSED);

  function select(r: SearchResult) {
    pushRecent(r);
    const qs = new URLSearchParams({
      symbol: r.symbol,
      market: r.market,
      name: r.name ?? "",
      exchange: r.exchange ?? "",
    });
    router.push(`/chart?${qs}`);
  }

  function toggleMarket(m: Market) {
    setMarkets((prev) => {
      // Never allow both off — that would hide every result silently.
      const next = { ...prev, [m]: !prev[m] };
      if (!next.KR && !next.US) return prev;
      return next;
    });
  }

  return (
    <>
      <header className="appheader">
        <span className="appheader__brand">Chart Deep Dive</span>
        <div className="appheader__right">
          <div className="marketchip" role="group" aria-label="시장 필터">
            <button
              className={markets.KR ? "on" : ""}
              onClick={() => toggleMarket("KR")}
              aria-pressed={markets.KR}
            >
              KR
            </button>
            <button
              className={markets.US ? "on" : ""}
              onClick={() => toggleMarket("US")}
              aria-pressed={markets.US}
            >
              US
            </button>
          </div>
          <UserChip />
          <ThemeToggle />
        </div>
      </header>

      <main className="searchhero">
        <h1>Dive into the Chart</h1>

        {status === "loading" ? null : session ? (
          <>
            <SearchBox onSelect={select} markets={markets} autoFocus />

            {recent.length > 0 && (
              <div className="recent">
                <div className="recent__label">최근 검색</div>
                <div className="recent__chips">
                  {visibleRecent.map((r) => (
                    <div key={r.symbol} className="chipholder">
                      <button className="chip" data-initial={r.name.slice(0, 1)} onClick={() => select(r)}>
                        <strong>{r.name}</strong>
                        <small>{r.symbol}</small>
                      </button>
                      <button
                        className="chipremove"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRecent(removeRecent(r.symbol));
                        }}
                        aria-label={`${r.name} 최근 검색에서 삭제`}
                        title="삭제"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  {recent.length > RECENT_COLLAPSED && (
                    <button
                      className="chip chip--toggle"
                      onClick={() => setExpanded((v) => !v)}
                    >
                      <span className="chip__toggleicon" data-expanded={expanded} />
                      <strong>{expanded ? "간략히" : "더보기"}</strong>
                    </button>
                  )}
                </div>
              </div>
            )}
          </>
        ) : (
          <button className="googlesignin" onClick={() => signIn("google")}>
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.87 2.7-6.62z"
              />
              <path
                fill="#34A853"
                d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18z"
              />
              <path
                fill="#FBBC05"
                d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.33z"
              />
              <path
                fill="#EA4335"
                d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58z"
              />
            </svg>
            Google로 계속하기
          </button>
        )}
      </main>
    </>
  );
}

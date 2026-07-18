"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession, signIn, signOut } from "next-auth/react";
import ThemeToggle from "@/components/ThemeToggle";
import SearchBox from "@/components/SearchBox";
import type { SearchResult, Market } from "@/lib/api";
import { getRecent, pushRecent } from "@/lib/recent";

export default function SearchPage() {
  const router = useRouter();
  const { data: session, status } = useSession();
  const [markets, setMarkets] = useState<{ KR: boolean; US: boolean }>({
    KR: true,
    US: true,
  });
  const [recent, setRecent] = useState<SearchResult[]>([]);

  useEffect(() => {
    setRecent(getRecent());
  }, []);

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
          {session && (
            <button className="signoutbtn" onClick={() => signOut()}>
              {session.user?.name} 로그아웃
            </button>
          )}
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
                  {recent.map((r) => (
                    <button
                      key={r.symbol}
                      className="chip"
                      data-initial={r.name.slice(0, 1)}
                      onClick={() => select(r)}
                    >
                      <strong>{r.name}</strong>
                      <small>{r.symbol}</small>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <button className="googlesignin" onClick={() => signIn("google")}>
            Google로 로그인
          </button>
        )}
      </main>
    </>
  );
}

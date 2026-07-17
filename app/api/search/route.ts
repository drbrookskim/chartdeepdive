// GET /api/search?q=<query>
// Ticker / company-name search across KR (KOSPI/KOSDAQ) and US (NYSE/NASDAQ).
// - Hangul query        -> Naver only (Yahoo can't search Hangul)
// - ASCII/ticker query  -> Yahoo (global incl. US) + Naver (KR names), merged
// Each result: { symbol, name, market, exchange }. `symbol` is directly usable
// against /api/ohlcv.

import { NextResponse } from "next/server";
import { cached, TTL } from "@/lib/cache";
import { searchYahoo } from "@/lib/sources/yahoo";
import { searchNaver, resolveKoreanName } from "@/lib/sources/naver";
import type { SearchResponse, SearchResult, ApiError } from "@/lib/schema";
import { HTTP_STATUS } from "@/lib/schema";

const HANGUL = /[ㄱ-힝]/;

function dedupe(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    if (seen.has(r.symbol)) continue;
    seen.add(r.symbol);
    out.push(r);
  }
  return out;
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 1) {
    const body: ApiError = {
      error: { code: "BAD_REQUEST", message: "query parameter `q` is required" },
    };
    return NextResponse.json(body, { status: HTTP_STATUS.BAD_REQUEST });
  }

  const results = await cached(`search:${q.toLowerCase()}`, TTL.SEARCH, async () => {
    const isHangul = HANGUL.test(q);

    // Query the applicable sources; one source failing must not sink the other.
    const tasks: Promise<SearchResult[]>[] = [searchNaver(q).catch(() => [])];
    if (!isHangul) tasks.push(searchYahoo(q).catch(() => []));

    const settled = await Promise.all(tasks);
    const merged = dedupe(settled.flat());

    // Yahoo returns English names even for KR listings; any KR result not
    // already covered by Naver (i.e. found only via Yahoo's English-name
    // search) needs its name backfilled to Korean.
    const needsKorean = merged.filter((r) => r.market === "KR" && !HANGUL.test(r.name));
    if (needsKorean.length > 0) {
      const korean = await Promise.all(needsKorean.map((r) => resolveKoreanName(r.symbol)));
      korean.forEach((name, i) => {
        if (name) needsKorean[i].name = name;
      });
    }
    return merged;
  });

  const body: SearchResponse = { query: q, results };
  return NextResponse.json(body);
}

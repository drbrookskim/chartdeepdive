// Naver Finance autocomplete adapter — the ONLY practical Node-native source
// for Hangul-name Korean stock search (Yahoo's search endpoint rejects Hangul
// with "Invalid Search Query"). Public JSON endpoint used by finance.naver.com's
// own search box. See _workspace/01_stock-data-agent_api-spec.md for the
// data-source survey and why this was chosen over KRX open API / pykrx.
//
// It only provides SEARCH (symbol resolution). OHLCV for the resolved symbol is
// fetched from Yahoo via the ".KS"/".KQ" suffix, keeping one OHLCV code path.

import type { SearchResult } from "../schema";
import { retryOnce } from "../retry";

const AC_URL = "https://ac.stock.naver.com/ac";

interface NaverItem {
  code: string; // 6-digit KRX code
  name: string; // Hangul name
  typeCode: string; // "KOSPI" | "KOSDAQ" | "KONEX" | ...
  typeName: string;
  nationCode: string; // "KOR" for Korean listings
  category: string; // "stock" | "index" | ...
}

/** Map KRX board to the Yahoo suffix. KONEX/others are unsupported here. */
function yahooSuffix(typeCode: string): ".KS" | ".KQ" | null {
  if (typeCode === "KOSPI") return ".KS";
  if (typeCode === "KOSDAQ") return ".KQ";
  return null;
}

/**
 * Resolve Korean stocks by Hangul/English/code substring. Returns [] on no
 * match. Throws on transport failure (route falls back / surfaces the error).
 */
export async function searchNaver(query: string): Promise<SearchResult[]> {
  const url = `${AC_URL}?q=${encodeURIComponent(query)}&target=stock&nationCode=KOR`;
  const json = await retryOnce(async () => {
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://finance.naver.com/",
      },
    });
    if (!r.ok) throw new Error(`Naver autocomplete HTTP ${r.status}`);
    return (await r.json()) as { items?: NaverItem[] };
  });

  const items = json.items ?? [];
  const out: SearchResult[] = [];
  for (const it of items) {
    if (it.category !== "stock" || it.nationCode !== "KOR") continue;
    const suffix = yahooSuffix(it.typeCode);
    if (!suffix) continue; // skip KONEX etc. (no reliable Yahoo OHLCV)
    out.push({
      symbol: `${it.code}${suffix}`,
      name: it.name,
      market: "KR",
      exchange: it.typeCode, // "KOSPI" | "KOSDAQ"
    });
  }
  return out;
}

/**
 * Resolve a KR stock's Korean display name from its 6-digit code, so KR
 * results always show a Hangul name even when discovered another way (e.g.
 * Yahoo's English-name search, or an OHLCV lookup by bare code/symbol).
 * Returns null if Naver has no match (caller falls back to whatever name it
 * already has).
 */
export async function resolveKoreanName(symbolOrCode: string): Promise<string | null> {
  const code = symbolOrCode.replace(/\.(KS|KQ)$/i, "");
  if (!/^\d{6}$/.test(code)) return null;
  const results = await searchNaver(code).catch(() => []);
  return results.find((r) => r.symbol.startsWith(code))?.name ?? null;
}

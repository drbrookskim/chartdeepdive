// GET /api/ohlcv?symbol=<sym>&market=<KR|US>&period=<1y>&interval=<1d>
//   or  ...&from=YYYY-MM-DD&to=YYYY-MM-DD  (from/to override period)
// Returns normalized OHLCV (common schema) for one instrument. Both markets are
// served by the Yahoo adapter; KR bare 6-digit codes are resolved to .KS/.KQ
// and the display name is overridden to Korean (see lib/sources/ohlcv.ts,
// shared with /api/analysis so the two routes never diverge on this logic).

import { NextResponse } from "next/server";
import { loadOhlcv, parseOhlcvParams, isNotFoundError } from "@/lib/sources/ohlcv";
import type { ApiError } from "@/lib/schema";
import { HTTP_STATUS } from "@/lib/schema";

function err(code: ApiError["error"]["code"], message: string, cause?: string) {
  const body: ApiError = { error: { code, message, ...(cause ? { cause } : {}) } };
  return NextResponse.json(body, { status: HTTP_STATUS[code] });
}

export async function GET(req: Request) {
  const parsed = parseOhlcvParams(new URL(req.url).searchParams);
  if (!parsed.ok) return err("BAD_REQUEST", parsed.message);
  const { params } = parsed;

  try {
    const data = await loadOhlcv(params);
    if (!data) {
      return err(
        "NOT_FOUND",
        `no OHLCV data for symbol '${params.symbol}' on market '${params.market}'`,
      );
    }
    return NextResponse.json(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Yahoo throws (rather than returning empty) for unknown/delisted symbols.
    // That's a NOT_FOUND condition, not an upstream outage.
    if (isNotFoundError(msg)) {
      return err(
        "NOT_FOUND",
        `no OHLCV data for symbol '${params.symbol}' on market '${params.market}'`,
        msg,
      );
    }
    return err("SOURCE_ERROR", "upstream data source failed after retry", msg);
  }
}

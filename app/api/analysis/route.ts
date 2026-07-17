// GET /api/analysis?symbol=<sym>&market=<KR|US>&period=<1y>&interval=<1d>
//   or  ...&from=YYYY-MM-DD&to=YYYY-MM-DD  (from/to override period)
// Fetches normalized OHLCV internally (same params/logic as /api/ohlcv) and
// returns the three-layer technical analysis (indicators / patterns / advanced).
// Under-length indicators come back as null with a reason in meta.unavailable
// rather than failing the whole request.

import { NextResponse } from "next/server";
import { loadOhlcv, parseOhlcvParams, isNotFoundError } from "@/lib/sources/ohlcv";
import { analyze } from "@/lib/analysis";
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
    const ohlcv = await loadOhlcv(params);
    if (!ohlcv) {
      return err(
        "NOT_FOUND",
        `no OHLCV data for symbol '${params.symbol}' on market '${params.market}'`,
      );
    }
    const result = analyze({
      symbol: ohlcv.symbol,
      market: ohlcv.market,
      currency: ohlcv.currency,
      name: ohlcv.name,
      interval: ohlcv.interval,
      candles: ohlcv.candles,
    });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
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

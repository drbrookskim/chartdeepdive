// Frontend API client for the search / ohlcv / analysis routes. Types are
// imported (type-only, erased at build) from the backend contract modules so
// the UI consumes the exact shapes documented in _workspace/01 and 02 — no
// re-computation, no drift.

import type {
  SearchResponse,
  SearchResult,
  OhlcvResponse,
  ApiError,
  ApiErrorCode,
  Market,
} from "@/lib/schema";
import type { AnalysisResult } from "@/lib/analysis/index";

export type { SearchResult, OhlcvResponse, AnalysisResult, Market };

/** Thrown by the fetch helpers so callers can branch on the error code. */
export class ApiCallError extends Error {
  code: ApiErrorCode | "NETWORK";
  cause?: string;
  status: number;
  constructor(
    code: ApiErrorCode | "NETWORK",
    message: string,
    status: number,
    cause?: string,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

function isApiError(body: unknown): body is ApiError {
  return (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof (body as ApiError).error?.code === "string"
  );
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiCallError("NETWORK", "네트워크 요청에 실패했습니다", 0);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* fall through to status handling below */
  }
  if (!res.ok) {
    if (isApiError(body)) {
      throw new ApiCallError(
        body.error.code,
        body.error.message,
        res.status,
        body.error.cause,
      );
    }
    throw new ApiCallError("SOURCE_ERROR", `요청 실패 (${res.status})`, res.status);
  }
  return body as T;
}

export function searchStocks(
  q: string,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  return getJson<SearchResponse>(`/api/search?q=${encodeURIComponent(q)}`, signal);
}

interface OhlcvParams {
  symbol: string;
  market: Market;
  period?: string;
  /** Overrides `period` with an explicit date window (e.g. for zoomed-in intraday fetches). */
  from?: string;
  to?: string;
  /** Bar size; defaults to "1d" server-side. */
  interval?: string;
}

export function fetchOhlcv(
  { symbol, market, period, from, to, interval }: OhlcvParams,
  signal?: AbortSignal,
): Promise<OhlcvResponse> {
  const qs = new URLSearchParams({ symbol, market });
  if (from && to) {
    qs.set("from", from);
    qs.set("to", to);
  } else {
    qs.set("period", period ?? "1y");
  }
  if (interval) qs.set("interval", interval);
  return getJson<OhlcvResponse>(`/api/ohlcv?${qs}`, signal);
}

export function fetchAnalysis(
  { symbol, market, period }: OhlcvParams,
  signal?: AbortSignal,
): Promise<AnalysisResult> {
  const qs = new URLSearchParams({ symbol, market, period: period ?? "1y" });
  return getJson<AnalysisResult>(`/api/analysis?${qs}`, signal);
}

// Common data schema shared by all data sources, the analysis engine, and the
// frontend. Every source adapter MUST normalize into these shapes. If this
// schema changes, notify technical-analysis-agent and frontend-chart-agent
// BEFORE shipping the change.

export type Market = "KR" | "US";

/** One trading day (or interval bar) of price data. */
export interface Candle {
  /** ISO 8601 date `YYYY-MM-DD`, in the market's local trading calendar. */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /**
   * Split/dividend-adjusted close. Additive optional field: the core schema is
   * {date,open,high,low,close,volume}; `adjclose` is provided when the source
   * supplies it (Yahoo always does) so indicators that need adjusted series
   * (e.g. long-window moving averages) don't have to refetch. May be null if
   * unavailable.
   */
  adjclose: number | null;
}

/** Result of GET /api/ohlcv (success). */
export interface OhlcvResponse {
  symbol: string;
  market: Market;
  /** ISO 4217 currency code, e.g. "USD" | "KRW". */
  currency: string;
  /** Which adapter produced the data, for debugging/QA. */
  source: string;
  /** Bar interval, e.g. "1d". */
  interval: string;
  /** Company/instrument display name when known. */
  name: string | null;
  candles: Candle[];
}

/** One row of GET /api/search results. */
export interface SearchResult {
  /** Canonical symbol usable directly against /api/ohlcv (e.g. "AAPL", "005930.KS"). */
  symbol: string;
  name: string;
  market: Market;
  /** Human-readable exchange label, e.g. "NASDAQ" | "KOSPI" | "KOSDAQ". */
  exchange: string | null;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
}

export type ApiErrorCode =
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "SOURCE_ERROR"
  | "NOT_IMPLEMENTED";

/** Uniform error envelope. Never return an empty array to signal "not found". */
export interface ApiError {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Underlying cause (e.g. upstream error message) when relevant. */
    cause?: string;
  };
}

export const HTTP_STATUS: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  NOT_IMPLEMENTED: 501,
  SOURCE_ERROR: 502,
};

export interface SuiteSignalContext {
  signalId: string;
  action: string;
  confidence: number | null;
  combined: number | null;
  style: string;
  period: string;
}

export interface SuiteContext {
  from: string;
  theme: string;
  signal: SuiteSignalContext | null;
}

export function readSuiteContextFromParams(params: URLSearchParams): SuiteContext {
  const confRaw = params.get("sig_conf");
  const scoreRaw = params.get("sig_score");
  const hasSignal = Boolean(
    params.get("signal_id") ||
      params.get("sig_action") ||
      confRaw !== null ||
      scoreRaw !== null,
  );

  return {
    from: params.get("from") ?? "",
    theme: params.get("theme") ?? "",
    signal: hasSignal
      ? {
          signalId: params.get("signal_id") ?? "",
          action: params.get("sig_action") ?? "",
          confidence: confRaw !== null ? Number(confRaw) : null,
          combined: scoreRaw !== null ? Number(scoreRaw) : null,
          style: params.get("sig_style") ?? "",
          period: params.get("sig_period") ?? "",
        }
      : null,
  };
}

export function buildSignnithFeedbackUrl(payload: {
  ticker: string;
  theme?: string;
  signalId?: string;
  feedbackScore: number;
  feedbackSummary: string;
}): string {
  const qs = new URLSearchParams();
  if (payload.ticker) qs.set("ticker", payload.ticker.toUpperCase());
  if (payload.theme) qs.set("theme", payload.theme);
  qs.set("from", "chartdeepdive");
  if (payload.signalId) qs.set("signal_id", payload.signalId);
  qs.set("fb_score", String(payload.feedbackScore));
  qs.set("fb_summary", payload.feedbackSummary);
  return `https://drbrookskim.github.io/signnith/?${qs.toString()}`;
}

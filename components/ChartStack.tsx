"use client";

// Multi-pane financial chart built on lightweight-charts (TradingView).
// Panes: main (candles + MA/Bollinger/Ichimoku overlays + volume overlay +
// pattern/Elliott markers), RSI sub-panel, MACD sub-panel. Each pane is its own
// IChartApi instance; their time scales are kept in sync. The whole stack is
// rebuilt imperatively when the data, the visible layers, the focused pattern,
// or the theme changes — data is small (~250 bars) so a rebuild is cheap and
// far simpler than diffing series.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createChart,
  ColorType,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import { fetchOhlcv, type OhlcvResponse, type AnalysisResult, type Market } from "@/lib/api";
import type { Pattern } from "@/lib/analysis/patterns";
import { categoryColorVar, formatAxisPrice, formatPrice, formatSigned, patternKindLabel } from "@/lib/format";

/** Neon accent for pattern shape-lines / the location-ping arrow outline —
 * deliberately theme-independent so it always pops against candles. */
const NEON = "#39ff14";

type Candle = OhlcvResponse["candles"][number];

/** Compact volume abbreviation (1.2M / 34.1K) for the OHLC hover legend. */
function formatVol(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
}

/** How many daily bars ("trading days") the initial view shows — about 3
 * months. Bar-count based (not a date-range setVisibleRange call): with
 * rightOffset:0, lightweight-charts' date-based setVisibleRange resolves to a
 * far wider range than requested (observed ~13 months instead of 3) — a
 * logical (bar-index) range is unambiguous and renders exactly as asked. */
const DEFAULT_VIEW_BARS = 63;
// priceScale("right").width() can report 0 before the scale has been
// measured (e.g. a chart created on a backgrounded/inactive tab, where the
// browser defers that layout pass) — floor it so the pattern-line/arrow clip
// below never silently falls back to "no clip at all".
const AXIS_WIDTH_FALLBACK = 60;

export interface LayerState {
  ma: boolean;
  ema: boolean;
  bollinger: boolean;
  volume: boolean;
  volumeProfile: boolean;
  rsi: boolean;
  macd: boolean;
  ichimoku: boolean;
  elliott: boolean;
  inflection: boolean;
}

interface Props {
  symbol: string;
  market: Market;
  currency: string;
  candles: OhlcvResponse["candles"];
  analysis: AnalysisResult | null;
  layers: LayerState;
  selectedPatterns: { p: Pattern; key: string }[];
  /** Set (with a fresh object each time, even for the same pattern) whenever
   * the user just checked a pattern in the sidebar — pans the chart to it
   * without changing the current zoom level. */
  focusPattern: { p: Pattern; seq: number } | null;
  themeVersion: number;
  /** Reports the main pane's live rendered height (px) — lets the sidebar
   * pattern list cap its own height to match instead of stretching the page. */
  onMainHeightChange?: (height: number) => void;
}

const MIN_MAIN_HEIGHT = 240;
const MAX_MAIN_HEIGHT = 1000;
const DEFAULT_MAIN_HEIGHT = 560;
/** Fraction of the browser window's height the main chart defaults to on
 * first mount — a fixed pixel default doesn't scale across window sizes, so
 * this is measured against whatever viewport the page actually loads in. */
const DEFAULT_MAIN_HEIGHT_RATIO = 0.62;

const MIN_SUB_HEIGHT = 90;
const MAX_SUB_HEIGHT = 500;
const DEFAULT_SUB_HEIGHT = 240;
const DEFAULT_VOLUME_HEIGHT = 120;

function defaultMainHeight(): number {
  if (typeof window === "undefined") return DEFAULT_MAIN_HEIGHT;
  return Math.round(
    Math.min(MAX_MAIN_HEIGHT, Math.max(MIN_MAIN_HEIGHT, window.innerHeight * DEFAULT_MAIN_HEIGHT_RATIO)),
  );
}

/** Zoomed-in-enough bar count that daily bars look sparse -> worth fetching finer data. */
const ZOOM_BAR_THRESHOLD = 15;
/** Only swap resolution if the visible window is still short enough for Yahoo intraday limits. */
const ZOOM_MAX_SPAN_DAYS = 30;
const ZOOM_INTERVAL = "1h";

/** Panned within this many bars of the left edge -> fetch an older chunk. */
const LOAD_MORE_BAR_MARGIN = 10;
/** Days fetched per older chunk. */
const LOAD_MORE_CHUNK_DAYS = 180;
/** Hard cap on how far back auto-loaded history reaches. */
const MAX_HISTORY_YEARS = 10;

const cssVar = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** MA preset -> fixed line color (matches the legend) — literal hex, not
 * theme tokens, per explicit request (5=black, 10=dark blue, 20=orange,
 * 60=green, 120=dark gray, same in both themes). */
const MA_COLORS: Record<number, string> = {
  5: "#000000",
  10: "#4d79c7",
  20: "#ffa733",
  60: "#4caf5a",
  120: "#8a8a8a",
};

type LineDatum = { time: Time; value: number };

/** Build {time,value}[] from an index-aligned series, dropping nulls (warm-up). */
function toLine(dates: string[], values: (number | null)[]): LineDatum[] {
  const out: LineDatum[] = [];
  for (let i = 0; i < values.length && i < dates.length; i++) {
    const v = values[i];
    if (v != null) out.push({ time: dates[i] as Time, value: v });
  }
  return out;
}

/**
 * Like `toLine`, but keeps a (valueless) whitespace point for warm-up dates
 * instead of dropping them. RSI/MACD panes have no candlestick series of
 * their own, so whichever series is added first defines that pane's bar
 * index space — if the warm-up were dropped, the pane's bar 0 would map to a
 * *later* date than main's bar 0, throwing off any logical-range sync
 * between panes by exactly the warm-up length (visibly: the line stops well
 * short of the right edge). Padding with whitespace keeps every pane's bar
 * index aligned 1:1 with `dates`/main's candles.
 */
function toLineWithGaps(
  dates: string[],
  values: (number | null)[],
): (LineDatum | { time: Time })[] {
  const out: (LineDatum | { time: Time })[] = [];
  for (let i = 0; i < dates.length; i++) {
    const v = values[i];
    out.push(v != null ? { time: dates[i] as Time, value: v } : { time: dates[i] as Time });
  }
  return out;
}

/** Leading spans are longer than `dates` — the tail maps to projectedDates. */
function toLeadingLine(
  dates: string[],
  projected: string[],
  values: (number | null)[],
): LineDatum[] {
  const axis = [...dates, ...projected];
  const out: LineDatum[] = [];
  for (let i = 0; i < values.length && i < axis.length; i++) {
    const v = values[i];
    if (v != null) out.push({ time: axis[i] as Time, value: v });
  }
  return out;
}

/**
 * Daily-or-coarser dates ("YYYY-MM-DD") are passed straight through as the
 * business-day string form lightweight-charts expects. Intraday candles
 * carry a full ISO timestamp (see yahoo.ts) which the library doesn't parse
 * as a string `Time` — convert to a UTCTimestamp (epoch seconds) instead.
 */
function toChartTime(dateStr: string, intraday: boolean): Time {
  if (!intraday) return dateStr as Time;
  return Math.floor(new Date(dateStr).getTime() / 1000) as Time;
}

/** Smooth SVG path through points via a Catmull-Rom-to-Bezier conversion —
 * same "curved" look the old LineType.Curved series gave, but as a plain
 * path so its reveal can be animated with stroke-dashoffset (buttery smooth
 * regardless of how few points the pattern has — 2-3 point patterns like
 * gap-up/down animated as an all-or-nothing jump under the old point-by-point
 * `series.setData()` approach since there was nothing to interpolate between). */
function catmullRomPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return "";
  if (pts.length === 2) return `M${pts[0].x},${pts[0].y} L${pts[1].x},${pts[1].y}`;
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${p2.x},${p2.y}`;
  }
  return d;
}

/** Harmonic patterns (Gartley/Butterfly/Bat/Crab) keep the dashed style they
 * had before the reveal animation existed — everything else is solid. */
const HARMONIC_DASH = "10 6";
/** How long a pattern line takes to draw itself in (revealPath's durationMs). */
const PATTERN_REVEAL_MS = 3000;
/** Golden/dead-cross lines are a single short MA segment, not a multi-bar
 * shape — a quicker 1.5s reveal reads better than the full 3s used elsewhere. */
const CROSS_REVEAL_MS = 1500;

/** Draws a path's full length in from nothing over `durationMs`, via a CSS
 * stroke-dashoffset transition — smooth for any number of points, unlike
 * revealing one keyPoint at a time. A single dash covering the whole path
 * (dasharray = [len, len]) reads as solid while the offset counts down to 0;
 * if `finalDashArray` is given, it's swapped in right as the reveal finishes
 * so the repeating dash pattern doesn't fight the reveal's own dasharray use. */
function revealPath(path: SVGPathElement, durationMs = 3000, finalDashArray?: string) {
  const len = path.getTotalLength();
  if (len <= 0) return;
  path.style.transition = "none";
  path.style.strokeDasharray = `${len}`;
  path.style.strokeDashoffset = `${len}`;
  path.getBoundingClientRect(); // force reflow so the transition below actually animates
  // Starting the transition in the same tick as inserting/first-styling the
  // path gets silently dropped by the browser (no prior committed style to
  // transition *from*) — the line would just pop in fully drawn instead of
  // animating. Deferring the actual dashoffset change lets the "no
  // transition" state above commit first. requestAnimationFrame is the usual
  // way to defer this, but it can stall for many seconds in a backgrounded/
  // inactive tab (observed here) since the transition is purely cosmetic and
  // not worth losing entirely — a short setTimeout is far more reliably
  // scheduled and 20ms is imperceptible against a multi-second reveal.
  setTimeout(() => {
    path.style.transition = `stroke-dashoffset ${durationMs}ms linear`;
    path.style.strokeDashoffset = "0";
  }, 20);
  if (finalDashArray) {
    setTimeout(() => {
      path.style.transition = "none";
      path.style.strokeDasharray = finalDashArray;
      path.style.strokeDashoffset = "0";
    }, durationMs + 20);
  }
}

export default function ChartStack({
  symbol,
  market,
  currency,
  candles,
  analysis,
  layers,
  selectedPatterns,
  focusPattern,
  themeVersion,
  onMainHeightChange,
}: Props) {
  const mainRef = useRef<HTMLDivElement>(null);
  const volumeRef = useRef<HTMLDivElement>(null);
  const rsiRef = useRef<HTMLDivElement>(null);
  const macdRef = useRef<HTMLDivElement>(null);
  const cloudRef = useRef<SVGSVGElement>(null);
  const patternLinesRef = useRef<SVGSVGElement>(null);
  const userLinesRef = useRef<SVGSVGElement>(null);
  const hLabelsRef = useRef<SVGSVGElement>(null);
  const volumeProfileRef = useRef<SVGSVGElement>(null);
  const ohlcRef = useRef<HTMLDivElement>(null);
  const arrowsContainerRef = useRef<HTMLDivElement>(null);
  // User-drawn horizontal/trend lines (see the drawing-tool toolbar below).
  // Data lives in refs (not state) since drawing them is imperative chart-API
  // work, not something React needs to re-render for; `drawMode` (toolbar
  // button look) and `drawingsTick` (bumped on every add/remove so the
  // individual-delete list below the toolbar re-renders) are the only state.
  // Cleared on a real symbol change (new instrument) but NOT on incidental
  // rebuilds (toggling an unrelated layer recreates candleSeries too — see
  // the big rebuild effect below — so horizontals must be reapplied there
  // each time, not wiped).
  const [drawMode, setDrawMode] = useState<"horizontal" | "trend" | null>(null);
  const drawModeRef = useRef<typeof drawMode>(null);
  useEffect(() => {
    drawModeRef.current = drawMode;
    if (drawMode !== "trend") trendPendingRef.current = null;
  }, [drawMode]);
  const [, setDrawingsTick] = useState(0);
  // Brief visual "pressed" flash on the 전체 지우기 button after a real click
  // (:active alone barely shows for a fast click) — reverts on its own.
  const [justCleared, setJustCleared] = useState(false);
  const drawingIdRef = useRef(0);
  const horizontalsRef = useRef<{ id: number; price: number }[]>([]);
  const trendsRef = useRef<
    { id: number; p1: { time: Time; price: number }; p2: { time: Time; price: number } }[]
  >([]);
  // Drag-to-edit state for existing horizontal/trend lines when not in a
  // draw mode — set on mousedown after hit-testing, cleared on mouseup.
  const dragRef = useRef<
    | { type: "horizontal"; id: number }
    | { type: "trend"; id: number; end: "p1" | "p2" }
    // Grabbing the line body (not an endpoint) translates both points
    // together — origP1/origP2/origMouse are the pixel-space snapshot taken
    // at drag start so every move computes a fresh delta from the same base.
    | {
        type: "trend";
        id: number;
        end: "body";
        origP1: { time: Time; price: number };
        origP2: { time: Time; price: number };
        origMouseX: number;
        origMouseY: number;
      }
    | null
  >(null);
  // A line becomes draggable only after a long-press "unlocks" it (shown
  // dashed); clicking that same dashed line again (without dragging), or
  // clicking anywhere else, re-locks it (back to solid).
  const editingLineRef = useRef<{ type: "horizontal" | "trend"; id: number } | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mouseDownPosRef = useRef<{ x: number; y: number } | null>(null);
  const mouseMovedRef = useRef(false);
  const wasEditingAtDownRef = useRef(false);
  const trendPendingRef = useRef<{ time: Time; price: number } | null>(null);
  const priceLineHandlesRef = useRef<Map<number, IPriceLine>>(new Map());
  // Persisted outside the big rebuild effect so drawPatternShapes/repositionArrows
  // (which must NOT trigger a full chart rebuild) can still read the live series.
  const candleSeriesRef = useRef<ReturnType<IChartApi["addCandlestickSeries"]> | null>(null);
  // Pattern shape-lines (plain SVG <path>s, not lightweight-charts series —
  // see revealPath/catmullRomPath) + location arrows, keyed by pattern key so
  // an already-checked pattern's line/arrow is left alone (no re-animate)
  // when some *other* pattern is checked/unchecked — only added/removed
  // entries change. Kept outside the big rebuild effect so checking a pattern
  // only touches these, instead of tearing down and recreating the whole
  // chart stack (which visibly flickered/resized).
  const patternPathsRef = useRef<Map<string, SVGPathElement>>(new Map());
  const patternPointsRef = useRef<Map<string, { date: string; price: number }[]>>(new Map());
  const patternRevealedRef = useRef<Set<string>>(new Set());
  const patternHarmonicRef = useRef<Set<string>>(new Set());
  const patternArrowsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const elliottPointsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const staticMarkersRef = useRef<SeriesMarker<Time>[]>([]);
  // Mobile only (see .subtab-bar CSS breakpoint): RSI/MACD share screen space
  // via tabs instead of stacking, so only one sub-chart needs real width at a
  // time. Desktop ignores this and always shows both stacked.
  const [activeSubTab, setActiveSubTab] = useState<"rsi" | "macd">("rsi");

  // Drag-resizable main chart height. Kept in a ref (not state) so dragging
  // resizes the live chart via applyOptions() instead of tearing the whole
  // stack down on every pixel of mouse movement; the effect below only reads
  // it once, at (re)creation time, so the user's chosen size survives symbol
  // changes and re-renders.
  const mainHeightRef = useRef(defaultMainHeight());
  const mainApiRef = useRef<IChartApi | null>(null);
  const volumeHeightRef = useRef(DEFAULT_VOLUME_HEIGHT);
  const volumeApiRef = useRef<IChartApi | null>(null);
  const rsiHeightRef = useRef(DEFAULT_SUB_HEIGHT);
  const rsiApiRef = useRef<IChartApi | null>(null);
  const macdHeightRef = useRef(DEFAULT_SUB_HEIGHT);
  const macdApiRef = useRef<IChartApi | null>(null);

  // Zoom-adaptive resolution: when the user zooms in past the point where
  // daily bars go sparse, swap the main pane's data for a finer intraday
  // fetch of just the visible window; zoom back out and it reverts to the
  // original daily series. Overlays (MA/Bollinger/ichimoku/patterns) stay on
  // the original daily `analysis` — recomputing them at intraday resolution
  // is out of scope here (documented in _workspace/04).
  const [zoomCandles, setZoomCandles] = useState<OhlcvResponse["candles"] | null>(null);
  const zoomKeyRef = useRef<string | null>(null);
  const zoomTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Infinite-pan history: the period buttons only pick the *initial* window.
  // Panning/zooming past the left edge fetches an older chunk and prepends
  // it, so scrolling back in time never dead-ends into blank space. Resets
  // whenever the symbol/period fetch changes (a fresh `candles` prop).
  const [historyCandles, setHistoryCandles] = useState<OhlcvResponse["candles"] | null>(null);
  const loadingMoreRef = useRef(false);
  const noMoreHistoryRef = useRef(false);
  const restoreRangeRef = useRef<{ from: Time; to: Time } | null>(null);
  // Latest user-set visible bar range (logical/bar-index, not dates) — kept
  // continuously up to date by rangeHandler below and consulted by
  // applyDefaultRange() so toggling a layer checkbox (which recreates the
  // whole chart instance) reopens at the same pan/zoom the user had, instead
  // of snapping back to the default 3-month view every time. Cleared on a
  // real symbol change (see the effect below) so a *new* stock still starts
  // at the default view rather than inheriting the old one's scroll position.
  const preservedRangeRef = useRef<{ from: number; to: number } | null>(null);
  useEffect(() => {
    preservedRangeRef.current = null;
  }, [symbol, market]);

  // Repositions every persistent pattern arrow to match the main pane's
  // current time/price scale — called after drawPatternShapes and on every
  // pan/zoom/resize of the main chart (arrows are plain DOM, not part of the
  // canvas, so they don't move on their own when the chart does).
  const repositionArrows = useCallback(() => {
    const main = mainApiRef.current;
    const series = candleSeriesRef.current;
    if (!main || !series) return;
    // The arrow glyph is center-anchored (translate(-50%,-50%), ~22px font),
    // so a keyPoint right at/after the plot's right edge would have it
    // straddle the axis gutter and get eaten by patternarrows' overflow:
    // hidden — clamp SMALL overshoots so it stays fully inside the plot
    // instead of vanishing there. But timeToCoordinate extrapolates linearly
    // for times far outside the current pan window (never returns null just
    // for being off-screen) — clamping those too pinned them to the edge
    // permanently instead of letting them scroll out of view, which is what
    // stacked a pile of arrows in the top-right corner. Anything more than a
    // hair past either edge is hidden instead.
    const plotWidth =
      (mainRef.current?.clientWidth ?? 0) - Math.max(main.priceScale("right").width(), AXIS_WIDTH_FALLBACK);
    const ARROW_HALF = 12;
    const EDGE_OVERSHOOT = 40;
    for (const el of patternArrowsRef.current.values()) {
      const t = el.dataset.time;
      const p = el.dataset.price;
      if (!t || !p) continue;
      const rawX = main.timeScale().timeToCoordinate(t as Time);
      const y = series.priceToCoordinate(Number(p));
      if (rawX == null || y == null || rawX < -EDGE_OVERSHOOT || rawX > plotWidth + EDGE_OVERSHOOT) {
        el.style.display = "none";
        continue;
      }
      const x = Math.min(rawX, plotWidth - ARROW_HALF);
      el.style.display = "block";
      el.style.left = `${x}px`;
      el.style.top = `${y + (el.dataset.dir === "up" ? 16 : -16)}px`;
    }
    for (const el of elliottPointsRef.current.values()) {
      const t = el.dataset.time;
      const p = el.dataset.price;
      if (!t || !p) continue;
      const rawX = main.timeScale().timeToCoordinate(t as Time);
      const y = series.priceToCoordinate(Number(p));
      if (rawX == null || y == null || rawX < -EDGE_OVERSHOOT || rawX > plotWidth + EDGE_OVERSHOOT) {
        el.style.display = "none";
        continue;
      }
      el.style.display = "flex";
      el.style.left = `${Math.min(rawX, plotWidth - ARROW_HALF)}px`;
      el.style.top = `${y - 16}px`;
    }
  }, []);

  // Recomputes every pattern shape-line's pixel path to match the main
  // pane's current time/price scale — called after drawPatternShapes and on
  // every pan/zoom/resize (paths are plain SVG, not lightweight-charts
  // series, so they don't move on their own when the chart does). Paths that
  // already finished their reveal animation get their dasharray resynced (no
  // transition) too, so panning/zooming doesn't leave them partially hidden
  // — the reveal's dasharray length is a snapshot of the path length *at
  // animation time*, which goes stale the moment the geometry changes.
  const drawPatternLinePositions = useCallback(() => {
    const main = mainApiRef.current;
    const series = candleSeriesRef.current;
    if (!main || !series) return;
    // Shape-lines/arrows sit in a container that spans the whole pane
    // (including the price-axis gutter on the right), so a keyPoint near the
    // latest bar would otherwise draw over the axis labels — clip both
    // layers to stop exactly at the plot area, same as the candles.
    const axisWidth = Math.max(main.priceScale("right").width(), AXIS_WIDTH_FALLBACK);
    // clip-path (not a width/right resize) for the SVG specifically — as a
    // replaced element it doesn't reliably size itself from inset+right once
    // width/height are left implicit (falls back to its 300x150 intrinsic
    // box), so it stays full-size and gets clipped post-layout instead.
    if (patternLinesRef.current) patternLinesRef.current.style.clipPath = `inset(0 ${axisWidth}px 0 0)`;
    if (arrowsContainerRef.current) arrowsContainerRef.current.style.right = `${axisWidth}px`;
    for (const [key, path] of patternPathsRef.current) {
      const pts = patternPointsRef.current.get(key);
      if (!pts) continue;
      const coords: { x: number; y: number }[] = [];
      for (const p of pts) {
        const x = main.timeScale().timeToCoordinate(p.date as Time);
        const y = series.priceToCoordinate(p.price);
        if (x != null && y != null) coords.push({ x, y });
      }
      if (coords.length < 2) {
        path.style.display = "none";
        continue;
      }
      path.style.display = "";
      path.setAttribute("d", catmullRomPath(coords));
      if (patternRevealedRef.current.has(key)) {
        path.style.transition = "none";
        if (patternHarmonicRef.current.has(key)) {
          path.style.strokeDasharray = HARMONIC_DASH;
        } else {
          path.style.strokeDasharray = `${path.getTotalLength()}`;
        }
        path.style.strokeDashoffset = "0";
      }
    }
  }, []);

  // Redraws user-drawn trend lines (two-point straight lines, not tied to any
  // pattern) to match the current time/price scale — same trigger points as
  // drawPatternLinePositions (pan/zoom/resize). One <g class="line"+"number">
  // pair per trend, created lazily and reused; numbering is by current array
  // position (not the stable id) so deleting one renumbers the rest, matching
  // the toolbar list below. A trend whose points have scrolled out of view is
  // simply hidden rather than removed.
  const drawUserLines = useCallback(() => {
    const main = mainApiRef.current;
    const series = candleSeriesRef.current;
    const svg = userLinesRef.current;
    if (!main || !series || !svg) return;
    const axisWidth = Math.max(main.priceScale("right").width(), AXIS_WIDTH_FALLBACK);
    svg.style.clipPath = `inset(0 ${axisWidth}px 0 0)`;
    const SVG_NS = "http://www.w3.org/2000/svg";

    while (svg.children.length < trendsRef.current.length) {
      const g = document.createElementNS(SVG_NS, "g");
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("stroke", NEON);
      line.setAttribute("stroke-width", "2");
      // Badge (neon rect + black text) matching the horizontal price line's
      // native axis-label look, instead of plain outlined text.
      const badge = document.createElementNS(SVG_NS, "rect");
      badge.setAttribute("fill", NEON);
      badge.setAttribute("rx", "3");
      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("fill", "#000");
      label.setAttribute("font-size", "12");
      label.setAttribute("font-weight", "700");
      // Resize handles — small circles at each endpoint, shown only while
      // this trend is the one currently unlocked for editing (see
      // editingLineRef), so dragging either end to change the line's length
      // has an obvious grab target instead of relying on an invisible
      // hit-test radius.
      const handle1 = document.createElementNS(SVG_NS, "circle");
      const handle2 = document.createElementNS(SVG_NS, "circle");
      for (const h of [handle1, handle2]) {
        h.setAttribute("r", "5");
        h.setAttribute("fill", cssVar("--bg"));
        h.setAttribute("stroke", NEON);
        h.setAttribute("stroke-width", "2");
      }
      // On-canvas delete button — a small × badge shown only while this
      // trend is unlocked for editing, so removing a line no longer requires
      // scrolling down to the toolbar's separate chip list. pointer-events
      // is re-enabled just for this element since the whole svg has
      // pointer-events:none; the actual click is handled by one delegated
      // listener on the svg (see onLineDeleteClick below) keyed off
      // data-del-type/data-del-id rather than a per-element listener, since
      // these DOM nodes are pooled/reused across renders.
      const delBtn = document.createElementNS(SVG_NS, "g");
      delBtn.setAttribute("data-del-type", "trend");
      delBtn.style.cursor = "pointer";
      delBtn.style.pointerEvents = "auto";
      const delCircle = document.createElementNS(SVG_NS, "circle");
      delCircle.setAttribute("r", "8");
      delCircle.setAttribute("fill", "#c0392b");
      const delX = document.createElementNS(SVG_NS, "text");
      delX.setAttribute("fill", "#fff");
      delX.setAttribute("font-size", "11");
      delX.setAttribute("font-weight", "700");
      delX.setAttribute("text-anchor", "middle");
      delX.setAttribute("dominant-baseline", "central");
      delX.textContent = "×";
      delBtn.appendChild(delCircle);
      delBtn.appendChild(delX);

      g.appendChild(line);
      g.appendChild(badge);
      g.appendChild(label);
      g.appendChild(handle1);
      g.appendChild(handle2);
      g.appendChild(delBtn);
      svg.appendChild(g);
    }
    while (svg.children.length > trendsRef.current.length) {
      svg.lastChild?.remove();
    }
    trendsRef.current.forEach((trend, i) => {
      const g = svg.children[i] as SVGGElement;
      const line = g.children[0] as SVGLineElement;
      const badge = g.children[1] as SVGRectElement;
      const label = g.children[2] as SVGTextElement;
      const handle1 = g.children[3] as SVGCircleElement;
      const handle2 = g.children[4] as SVGCircleElement;
      const delBtn = g.children[5] as SVGGElement;
      const x1 = main.timeScale().timeToCoordinate(trend.p1.time);
      const y1 = series.priceToCoordinate(trend.p1.price);
      const x2 = main.timeScale().timeToCoordinate(trend.p2.time);
      const y2 = series.priceToCoordinate(trend.p2.price);
      if (x1 == null || y1 == null || x2 == null || y2 == null) {
        g.style.display = "none";
        return;
      }
      g.style.display = "";
      line.setAttribute("x1", `${x1}`);
      line.setAttribute("y1", `${y1}`);
      line.setAttribute("x2", `${x2}`);
      line.setAttribute("y2", `${y2}`);
      const editing = editingLineRef.current?.type === "trend" && editingLineRef.current.id === trend.id;
      line.setAttribute("stroke-dasharray", editing ? "6 4" : "none");
      label.textContent = `추세선 ${i + 1}`;
      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2 - 8;
      label.setAttribute("x", `${midX}`);
      label.setAttribute("y", `${midY}`);
      const box = label.getBBox();
      badge.setAttribute("x", `${box.x - 5}`);
      badge.setAttribute("y", `${box.y - 3}`);
      badge.setAttribute("width", `${box.width + 10}`);
      badge.setAttribute("height", `${box.height + 6}`);
      handle1.setAttribute("cx", `${x1}`);
      handle1.setAttribute("cy", `${y1}`);
      handle2.setAttribute("cx", `${x2}`);
      handle2.setAttribute("cy", `${y2}`);
      handle1.style.display = handle2.style.display = editing ? "" : "none";
      delBtn.setAttribute("data-del-id", `${trend.id}`);
      delBtn.setAttribute("transform", `translate(${box.x + box.width + 12}, ${box.y + box.height / 2 - 3})`);
      delBtn.style.display = editing ? "" : "none";
    });

    // Horizontal lines' labels — the native IPriceLine axis label has no
    // font-weight option, so it's hidden (reapplyHorizontals sets
    // axisLabelVisible: false) and replaced with a bold badge here, styled
    // like the trend label, right-aligned just inside the price axis gutter.
    const hsvg = hLabelsRef.current;
    if (hsvg) {
      hsvg.style.clipPath = `inset(0 ${axisWidth}px 0 0)`;
      while (hsvg.children.length < horizontalsRef.current.length) {
        const g = document.createElementNS(SVG_NS, "g");
        const badge = document.createElementNS(SVG_NS, "rect");
        badge.setAttribute("fill", NEON);
        badge.setAttribute("rx", "3");
        const label = document.createElementNS(SVG_NS, "text");
        label.setAttribute("fill", "#000");
        label.setAttribute("font-size", "12");
        label.setAttribute("font-weight", "700");
        // Same on-canvas delete affordance as the trend label (see the
        // trend loop above for why this is a delegated click, not a
        // per-element listener).
        const delBtn = document.createElementNS(SVG_NS, "g");
        delBtn.setAttribute("data-del-type", "horizontal");
        delBtn.style.cursor = "pointer";
        delBtn.style.pointerEvents = "auto";
        const delCircle = document.createElementNS(SVG_NS, "circle");
        delCircle.setAttribute("r", "8");
        delCircle.setAttribute("fill", "#c0392b");
        const delX = document.createElementNS(SVG_NS, "text");
        delX.setAttribute("fill", "#fff");
        delX.setAttribute("font-size", "11");
        delX.setAttribute("font-weight", "700");
        delX.setAttribute("text-anchor", "middle");
        delX.setAttribute("dominant-baseline", "central");
        delX.textContent = "×";
        delBtn.appendChild(delCircle);
        delBtn.appendChild(delX);
        g.appendChild(badge);
        g.appendChild(label);
        g.appendChild(delBtn);
        hsvg.appendChild(g);
      }
      while (hsvg.children.length > horizontalsRef.current.length) {
        hsvg.lastChild?.remove();
      }
      const plotWidth = (mainRef.current?.clientWidth ?? 0) - axisWidth;
      horizontalsRef.current.forEach((h, i) => {
        const g = hsvg.children[i] as SVGGElement;
        const badge = g.children[0] as SVGRectElement;
        const label = g.children[1] as SVGTextElement;
        const delBtn = g.children[2] as SVGGElement;
        const y = series.priceToCoordinate(h.price);
        if (y == null) {
          g.style.display = "none";
          return;
        }
        g.style.display = "";
        label.textContent = `수평선 ${i + 1}  ${formatAxisPrice(h.price, currency)}`;
        label.setAttribute("y", `${y + 4}`);
        const w = label.getBBox().width;
        label.setAttribute("x", `${Math.max(0, plotWidth - w - 6)}`);
        const box = label.getBBox();
        badge.setAttribute("x", `${box.x - 5}`);
        badge.setAttribute("y", `${box.y - 3}`);
        badge.setAttribute("width", `${box.width + 10}`);
        badge.setAttribute("height", `${box.height + 6}`);
        const editing = editingLineRef.current?.type === "horizontal" && editingLineRef.current.id === h.id;
        delBtn.setAttribute("data-del-id", `${h.id}`);
        delBtn.setAttribute("transform", `translate(${box.x - 12}, ${box.y + box.height / 2 - 3})`);
        delBtn.style.display = editing ? "" : "none";
      });
    }
  }, [currency]);

  // Recreates every horizontal line's IPriceLine from horizontalsRef, in
  // array order, so the title numbering ("수평선 N") always matches current
  // position — the only way to renumber, since a price line's title can't be
  // edited after creation. Cheap: horizontal counts are always small.
  const reapplyHorizontals = useCallback(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    for (const h of priceLineHandlesRef.current.values()) series.removePriceLine(h);
    priceLineHandlesRef.current = new Map(
      horizontalsRef.current.map((h, i) => [
        h.id,
        series.createPriceLine({
          price: h.price,
          color: NEON,
          lineWidth: 2,
          lineStyle:
            editingLineRef.current?.type === "horizontal" && editingLineRef.current.id === h.id
              ? LineStyle.Dashed
              : LineStyle.Solid,
          // The native axis label can't be set bold (no such option in
          // PriceLineOptions) — hidden here and replaced with our own bold
          // SVG badge (see drawUserLines) so it matches the trend line label.
          axisLabelVisible: false,
          title: `수평선 ${i + 1}`,
        }),
      ]),
    );
  }, []);

  // Draws the selected patterns' keyPoint markers + shape-lines + location
  // arrows on the main pane and merges the markers with the elliott/inflection
  // ones (staticMarkersRef, populated by the big rebuild effect). Diffs
  // against what's already drawn (keyed by pattern key) so an already-checked
  // pattern's line/arrow is left alone — only newly-checked patterns animate
  // in, only newly-unchecked ones are removed. Only touches the existing
  // chart — no rebuild — so toggling a pattern checkbox doesn't tear down and
  // recreate the whole chart stack.
  const drawPatternShapes = useCallback(
    (patterns: { p: Pattern; key: string }[]) => {
      const main = mainApiRef.current;
      const candleSeries = candleSeriesRef.current;
      const arrowsContainer = arrowsContainerRef.current;
      const svg = patternLinesRef.current;
      if (!main || !candleSeries || !arrowsContainer || !svg) return;

      const nextKeys = new Set(patterns.map((x) => x.key));

      for (const [key, path] of patternPathsRef.current) {
        if (!nextKeys.has(key)) {
          path.remove();
          patternPathsRef.current.delete(key);
          patternPointsRef.current.delete(key);
          patternRevealedRef.current.delete(key);
          patternHarmonicRef.current.delete(key);
        }
      }
      for (const [key, el] of patternArrowsRef.current) {
        if (!nextKeys.has(key)) {
          el.remove();
          patternArrowsRef.current.delete(key);
        }
      }

      const newlyAdded: { key: string; durationMs: number }[] = [];
      const patternMarkers: SeriesMarker<Time>[] = [];
      for (const { p: pat, key } of patterns) {
        for (const kp of pat.keyPoints) {
          const isLow = /bottom|trough|low|golden/.test(kp.kind);
          const isPrz = pat.category === "harmonic" && kp.kind === "D";
          patternMarkers.push({
            time: kp.date as Time,
            position: isLow ? "belowBar" : "aboveBar",
            color: cssVar(isPrz ? "--harmonic" : categoryColorVar(pat.category)),
            shape: isPrz ? "circle" : isLow ? "arrowUp" : "arrowDown",
            text: isPrz ? "PRZ" : patternKindLabel(kp.kind),
          });
        }

        // Connect the keyPoints with a curved line so multi-bar patterns
        // (double/triple bottom, V-reversal, head-and-shoulders, ...) read as
        // their actual shape ("W", "V", ...). Neon + thick so it pops against
        // the candles. New patterns draw themselves in over a few seconds
        // (revealPath, below) instead of popping in fully-formed; already-
        // drawn ones are left untouched (repositioned, not re-animated).
        if (pat.keyPoints.length >= 2 && !patternPathsRef.current.has(key)) {
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
          path.setAttribute("fill", "none");
          path.setAttribute("stroke", NEON);
          path.setAttribute("stroke-width", "3");
          path.setAttribute("stroke-linecap", "round");
          path.setAttribute("stroke-linejoin", "round");
          svg.appendChild(path);
          patternPathsRef.current.set(key, path);
          patternPointsRef.current.set(
            key,
            pat.keyPoints.map((kp) => ({ date: kp.date, price: kp.price })),
          );
          if (pat.category === "harmonic") patternHarmonicRef.current.add(key);
          newlyAdded.push({ key, durationMs: pat.category === "cross" ? CROSS_REVEAL_MS : PATTERN_REVEAL_MS });
        }

        // Persistent bouncing arrow at the pattern's anchor point — stays as
        // long as the pattern is checked (not a one-shot ping).
        if (!patternArrowsRef.current.has(key)) {
          const anchor = pat.keyPoints[pat.keyPoints.length - 1] ?? pat.keyPoints[0];
          if (anchor) {
            const isLowAnchor = /bottom|trough|low|golden/.test(anchor.kind);
            const el = document.createElement("div");
            el.className = `patternpulse ${isLowAnchor ? "up" : "down"} animate`;
            el.textContent = isLowAnchor ? "▲" : "▼";
            el.dataset.time = anchor.date;
            el.dataset.price = String(anchor.price);
            el.dataset.dir = isLowAnchor ? "up" : "down";
            arrowsContainer.appendChild(el);
            patternArrowsRef.current.set(key, el);
          }
        }
      }

      const all = [...staticMarkersRef.current, ...patternMarkers];
      all.sort((a, b) => String(a.time).localeCompare(String(b.time)));
      candleSeries.setMarkers(all);
      repositionArrows();
      drawPatternLinePositions();
      for (const { key, durationMs } of newlyAdded) {
        const path = patternPathsRef.current.get(key);
        if (path) {
          revealPath(path, durationMs, patternHarmonicRef.current.has(key) ? HARMONIC_DASH : undefined);
        }
        // Marked "revealed" only once the animation has actually finished —
        // not synchronously here — so a pan/zoom/resize mid-reveal can't race
        // drawPatternLinePositions() into snapping the line to full solid
        // before the animation's own duration is up (see
        // drawPatternLinePositions below).
        setTimeout(() => patternRevealedRef.current.add(key), durationMs);
      }
    },
    [repositionArrows, drawPatternLinePositions],
  );

  // A new symbol/period fetch invalidates any intraday zoom override / extended history.
  useEffect(() => {
    setZoomCandles(null);
    zoomKeyRef.current = null;
    setHistoryCandles(null);
    loadingMoreRef.current = false;
    noMoreHistoryRef.current = false;
    // Drawings are per-instrument — a genuinely new symbol clears them (this
    // effect does NOT fire for pan-triggered history loads or intraday zoom
    // swaps, which use separate local state, so mid-session drawings survive
    // those). Price-line handles die with the old candleSeries on its own.
    horizontalsRef.current = [];
    priceLineHandlesRef.current = new Map();
    trendsRef.current = [];
    trendPendingRef.current = null;
    setDrawingsTick((t) => t + 1);
  }, [candles]);

  useEffect(() => {
    if (!mainRef.current || candles.length === 0) return;

    const text = cssVar("--text-muted");
    const border = cssVar("--border");
    const up = cssVar("--up");
    const down = cssVar("--down");
    const grid = cssVar("--surface-3");

    const common = {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: text,
        fontFamily: cssVar("--sans") || "sans-serif",
      },
      grid: {
        vertLines: { color: grid, style: LineStyle.Dotted },
        horzLines: { color: grid, style: LineStyle.Dotted },
      },
      rightPriceScale: { borderColor: border },
      // rightOffset 0: the latest bar sits flush against the right axis
      // instead of floating a few bars in from the edge.
      timeScale: { borderColor: border, rightOffset: 0 },
      crosshair: { horzLine: { labelBackgroundColor: text } },
      // Zoom only via mouse wheel; drag is left/right pan only (no vertical
      // price-axis rescale-by-drag, no pinch/axis-drag zoom).
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: {
        mouseWheel: true,
        pinch: false,
        axisPressedMouseMove: { time: false, price: false },
      },
    } as const;

    const charts: IChartApi[] = [];
    // Intraday zoom override (if any) replaces the main pane's own candles;
    // every overlay/indicator below still reads the original daily `candles`
    // via `analysis.dates`, unaffected.
    const baseCandles = historyCandles ?? candles;
    const effectiveCandles = zoomCandles ?? baseCandles;
    const isIntraday = zoomCandles !== null;

    // ---- main chart ----
    const main = createChart(mainRef.current, {
      ...common,
      height: mainHeightRef.current,
      width: mainRef.current.clientWidth,
    });
    charts.push(main);
    mainApiRef.current = main;
    onMainHeightChange?.(mainHeightRef.current);
    main.applyOptions({
      watermark: {
        visible: true,
        text: symbol,
        color: "rgba(128,128,128,0.09)",
        fontSize: 44,
        horzAlign: "center",
        vertAlign: "center",
      },
      localization: {
        priceFormatter: (price: number) => formatAxisPrice(price, currency),
      },
    });

    const candleSeries = main.addCandlestickSeries({
      upColor: up,
      downColor: down,
      borderUpColor: up,
      borderDownColor: down,
      wickUpColor: up,
      wickDownColor: down,
    });
    candleSeries.setData(
      effectiveCandles.map((c) => ({
        time: toChartTime(c.date, isIntraday),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    candleSeriesRef.current = candleSeries;

    // Re-apply user-drawn horizontal lines to the freshly-created series —
    // this effect recreates candleSeries on every rebuild (any layer toggle,
    // not just a symbol change), so the old IPriceLine handles are already
    // gone with the old series; horizontalsRef is the durable source of truth.
    reapplyHorizontals();

    // ---- volume profile (매물대): horizontal bars showing traded volume by
    // price level, bucketed over the currently VISIBLE bars — the price axis
    // autoscales to the visible window, so bucketing the whole loaded range
    // (e.g. 10y of history) put most bins' price levels far outside that
    // window, mapping to coordinates off the pane (only a handful of recent
    // bins ever rendered). Recomputed on every pan/zoom via rangeHandler.
    // Bucketed by each bar's close price; drawn behind the candles via low
    // opacity rather than z-order (the candle pane isn't a layerable DOM
    // node to draw under).
    const VP_BINS = 24;
    const VP_MAX_WIDTH_FRAC = 0.28;
    const drawVolumeProfile = () => {
      const svg = volumeProfileRef.current;
      const series = candleSeriesRef.current;
      if (!svg) return;
      if (!layers.volumeProfile || !series || effectiveCandles.length === 0) {
        svg.innerHTML = "";
        return;
      }
      const SVG_NS = "http://www.w3.org/2000/svg";
      const visRange = main.timeScale().getVisibleLogicalRange();
      const fromIdx = visRange ? Math.max(0, Math.floor(visRange.from)) : 0;
      const toIdx = visRange
        ? Math.min(effectiveCandles.length - 1, Math.ceil(visRange.to))
        : effectiveCandles.length - 1;
      const visibleCandles = effectiveCandles.slice(fromIdx, toIdx + 1);
      if (visibleCandles.length === 0) {
        svg.innerHTML = "";
        return;
      }
      let lo = Infinity;
      let hi = -Infinity;
      for (const c of visibleCandles) {
        if (c.low < lo) lo = c.low;
        if (c.high > hi) hi = c.high;
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
        svg.innerHTML = "";
        return;
      }
      const bins = new Array(VP_BINS).fill(0);
      const binSize = (hi - lo) / VP_BINS;
      for (const c of visibleCandles) {
        const idx = Math.min(VP_BINS - 1, Math.max(0, Math.floor((c.close - lo) / binSize)));
        bins[idx] += c.volume;
      }
      const maxVol = Math.max(...bins, 1);
      const axisWidth = Math.max(main.priceScale("right").width(), AXIS_WIDTH_FALLBACK);
      const plotWidth = (mainRef.current?.clientWidth ?? 0) - axisWidth;
      const maxBarPx = plotWidth * VP_MAX_WIDTH_FRAC;

      while (svg.children.length < VP_BINS) svg.appendChild(document.createElementNS(SVG_NS, "rect"));
      while (svg.children.length > VP_BINS) svg.lastChild?.remove();

      for (let i = 0; i < VP_BINS; i++) {
        const rect = svg.children[i] as SVGRectElement;
        const priceTop = lo + (i + 1) * binSize;
        const priceBottom = lo + i * binSize;
        const yTop = series.priceToCoordinate(priceTop);
        const yBottom = series.priceToCoordinate(priceBottom);
        if (yTop == null || yBottom == null || bins[i] <= 0) {
          rect.style.display = "none";
          continue;
        }
        rect.style.display = "";
        const barW = (bins[i] / maxVol) * maxBarPx;
        rect.setAttribute("x", `${Math.max(0, plotWidth - barW)}`);
        rect.setAttribute("y", `${Math.min(yTop, yBottom)}`);
        rect.setAttribute("width", `${barW}`);
        rect.setAttribute("height", `${Math.max(1, Math.abs(yBottom - yTop) - 1)}`);
        rect.setAttribute("fill", cssVar("--accent"));
        rect.setAttribute("opacity", "0.28");
      }
    };
    drawVolumeProfile();

    // ---- volume sub-panel (own pane between main and RSI, not an overlay) ----
    if (layers.volume && volumeRef.current) {
      const volumeChart = createChart(volumeRef.current, {
        ...common,
        height: volumeHeightRef.current,
        width: volumeRef.current.clientWidth,
      });
      charts.push(volumeChart);
      volumeApiRef.current = volumeChart;
      const volSeries = volumeChart.addHistogramSeries({
        priceFormat: { type: "volume" },
      });
      volSeries.setData(
        effectiveCandles.map((c) => ({
          time: toChartTime(c.date, isIntraday),
          value: c.volume,
          color: c.close >= c.open ? `${up}99` : `${down}99`,
        })),
      );
      // NOT fitContent() here either — see the RSI block below; synced to
      // main's actual visible range in the block that follows all panes.
    }
    // A resolution swap (daily <-> intraday zoom) or a fresh mount changes the
    // bar count, so a previously-set logical range no longer points at the
    // same window — fit the newly-loaded data instead of preserving stale bar
    // indices. Loading an older history chunk is the one case that must NOT
    // refit (the user is mid-pan and shouldn't get yanked back to "show all")
    // — restore the exact date window they were looking at instead.
    // Also re-run from the resize observer below: if the pane mounts before
    // the grid layout settles (width 0), the observer's first real-width
    // callback must reapply this same logic, not a bare fitContent() (which
    // would blow the 3-month default out to "show all ~10 years").
    function applyDefaultRange() {
      if (restoreRangeRef.current) {
        main.timeScale().setVisibleRange(restoreRangeRef.current);
        restoreRangeRef.current = null;
      } else if (isIntraday) {
        main.timeScale().fitContent();
      } else if (preservedRangeRef.current) {
        // A layer checkbox (MA/Bollinger/ichimoku/...) was toggled, which
        // recreates the whole chart instance — reopen at the same bars the
        // user had scrolled/zoomed to instead of resetting to the default
        // window. Cleared on an actual symbol change (see the effect above).
        main.timeScale().setVisibleLogicalRange(preservedRangeRef.current);
      } else {
        // Up to MAX_HISTORY_YEARS of daily data is loaded so the user can pan
        // freely into the past, but the initial viewport only shows the most
        // recent ~63 bars (fitContent() would zoom out to show all ~10 years
        // of bars as a squished line).
        const total = effectiveCandles.length;
        main.timeScale().setVisibleLogicalRange({
          from: Math.max(0, total - DEFAULT_VIEW_BARS),
          to: total - 1,
        });
      }
    }
    applyDefaultRange();

    // ---- OHLC hover legend ----
    function updateOhlc(c: Candle | undefined) {
      const el = ohlcRef.current;
      if (!el || !c) return;
      const changed = c.close - c.open;
      const pct = c.open ? (changed / c.open) * 100 : 0;
      const dir = changed >= 0 ? "up" : "down";
      el.innerHTML =
        `<span>O <b>${formatPrice(c.open, currency)}</b></span>` +
        `<span>H <b>${formatPrice(c.high, currency)}</b></span>` +
        `<span>L <b>${formatPrice(c.low, currency)}</b></span>` +
        `<span>C <b>${formatPrice(c.close, currency)}</b></span>` +
        `<span class="${dir}">${dir === "up" ? "▲" : "▼"} ${formatSigned(changed, currency === "KRW" ? 0 : 2)} (${formatSigned(pct)}%)</span>` +
        `<span>거래량 <b>${formatVol(c.volume)}</b></span>`;
    }
    updateOhlc(effectiveCandles[effectiveCandles.length - 1]);
    const crosshairHandler = (param: MouseEventParams<Time>) => {
      if (!param.time) {
        updateOhlc(effectiveCandles[effectiveCandles.length - 1]);
        return;
      }
      const match = effectiveCandles.find(
        (c) => toChartTime(c.date, isIntraday) === param.time,
      );
      updateOhlc(match ?? effectiveCandles[effectiveCandles.length - 1]);
    };
    main.subscribeCrosshairMove(crosshairHandler);

    const dates = analysis?.dates ?? candles.map((c) => c.date);

    // ---- layer 1: moving averages ----
    if (layers.ma && analysis?.indicators.sma) {
      for (const ma of analysis.indicators.sma.byPeriod) {
        const s = main.addLineSeries({
          color: MA_COLORS[ma.period] ?? cssVar("--accent"),
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        s.setData(toLine(dates, ma.values));
      }
    }

    // ---- layer 1: exponential moving averages (dashed, distinct from solid SMA) ----
    if (layers.ema && analysis?.indicators.ema) {
      for (const ma of analysis.indicators.ema.byPeriod) {
        const s = main.addLineSeries({
          color: MA_COLORS[ma.period] ?? cssVar("--accent"),
          lineWidth: 2,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        s.setData(toLine(dates, ma.values));
      }
    }

    // ---- layer 1: bollinger bands ----
    if (layers.bollinger && analysis?.indicators.bollinger) {
      const bb = analysis.indicators.bollinger;
      const faint = cssVar("--text-faint");
      const mk = (vals: (number | null)[], dashed = false) => {
        const s = main.addLineSeries({
          color: faint,
          lineWidth: 1,
          lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        s.setData(toLine(dates, vals));
      };
      mk(bb.upper);
      mk(bb.middle, true);
      mk(bb.lower);
    }

    // Cloud fill redraw hook, wired to the pan/zoom + resize handlers below.
    // Populated inside the ichimoku block if that layer is on; a no-op otherwise.
    let drawCloud = () => {};
    // Toggling ichimoku off (or switching symbol) still reruns this whole
    // rebuild effect but leaves the cloudRef <svg> DOM node itself intact
    // (it isn't destroyed/recreated with the chart) — without an explicit
    // clear here, the polygon fill drawn while it was on just stayed on
    // screen forever since drawCloud only ever gets reassigned, never a
    // "remove what's there" call, when the layer is off.
    if (cloudRef.current) cloudRef.current.innerHTML = "";

    // ---- layer 3: ichimoku ----
    if (layers.ichimoku && analysis?.advanced.ichimoku) {
      const ich = analysis.advanced.ichimoku;
      const mkLine = (
        vals: (number | null)[],
        color: string,
        width: 1 | 2 = 1,
        dashed = false,
      ) => {
        const s = main.addLineSeries({
          color,
          lineWidth: width,
          lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        s.setData(toLine(dates, vals));
        return s;
      };
      mkLine(ich.tenkan, cssVar("--up"));
      mkLine(ich.kijun, cssVar("--down"));
      mkLine(ich.chikou, cssVar("--text-faint"), 1, true);
      // leading spans extend `displacement` bars into the future (projectedDates)
      const spanA = main.addLineSeries({
        color: cssVar("--continuation"),
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      spanA.setData(toLeadingLine(dates, ich.projectedDates, ich.leadingSpanA));
      const spanB = main.addLineSeries({
        color: cssVar("--gapcat"),
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      spanB.setData(toLeadingLine(dates, ich.projectedDates, ich.leadingSpanB));

      // Cloud fill: lightweight-charts v4 has no primitive for shading between
      // two arbitrary line series, so we draw an SVG polygon overlay ourselves
      // (same timeToCoordinate/priceToCoordinate + resize/pan redraw pattern
      // the pattern-range band below already uses) instead of the area-series
      // "opaque mask" trick, which would paint over the candles beneath it.
      const cloudAxis = [...dates, ...ich.projectedDates];
      const segments: { bullish: boolean; a: LineDatum[]; b: LineDatum[] }[] = [];
      {
        let i = 0;
        while (i < cloudAxis.length) {
          const av = ich.leadingSpanA[i];
          const bv = ich.leadingSpanB[i];
          if (av == null || bv == null) {
            i++;
            continue;
          }
          const bullish = av >= bv;
          const segA: LineDatum[] = [];
          const segB: LineDatum[] = [];
          let j = i;
          while (j < cloudAxis.length) {
            const a2 = ich.leadingSpanA[j];
            const b2 = ich.leadingSpanB[j];
            if (a2 == null || b2 == null || a2 >= b2 !== bullish) break;
            segA.push({ time: cloudAxis[j] as Time, value: a2 });
            segB.push({ time: cloudAxis[j] as Time, value: b2 });
            j++;
          }
          if (segA.length >= 2) segments.push({ bullish, a: segA, b: segB });
          i = j;
        }
      }

      const cloudUp = cssVar("--up");
      const cloudDown = cssVar("--down");
      drawCloud = () => {
        const svg = cloudRef.current;
        if (!svg) return;
        const ts = main.timeScale();
        const parts: string[] = [];
        for (const seg of segments) {
          const pts: string[] = [];
          for (const p of seg.a) {
            const x = ts.timeToCoordinate(p.time);
            const y = candleSeries.priceToCoordinate(p.value);
            if (x != null && y != null) pts.push(`${x},${y}`);
          }
          for (let k = seg.b.length - 1; k >= 0; k--) {
            const p = seg.b[k];
            const x = ts.timeToCoordinate(p.time);
            const y = candleSeries.priceToCoordinate(p.value);
            if (x != null && y != null) pts.push(`${x},${y}`);
          }
          if (pts.length >= 3) {
            parts.push(
              `<polygon points="${pts.join(" ")}" fill="${seg.bullish ? cloudUp : cloudDown}" fill-opacity="0.15" />`,
            );
          }
        }
        svg.innerHTML = parts.join("");
      };
      drawCloud();
    }

    // ---- markers: elliott + inflection (static per rebuild; patterns are
    // drawn separately by drawPatternShapes so toggling a pattern checkbox
    // doesn't need a full chart rebuild) ----
    const staticMarkers: SeriesMarker<Time>[] = [];

    if (layers.elliott && analysis?.advanced.elliottWave?.impulse) {
      const imp = analysis.advanced.elliottWave.impulse;
      // Was --accent-ink (a text/ink token, nearly blended into the candles)
      // at width 2 — bumped to a dedicated high-contrast color + thicker
      // line + bigger markers so the wave count reads at a glance instead
      // of disappearing next to MA/Bollinger overlays.
      const wave = main.addLineSeries({
        color: cssVar("--elliott"),
        lineWidth: 3,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
      wave.setData(imp.waves.map((w) => ({ time: w.date as Time, value: w.price })));
      // Wave-point badges are custom HTML (see elliottPointsRef below), not
      // native SeriesMarker, so the neon fill + black border/number can be
      // styled independently — a single marker's shape and text always
      // share one color, which can't express that combo.
    }

    if (layers.inflection && analysis?.advanced.inflectionPoints) {
      // Bigger arrows (default marker size 1 read as tiny slivers against
      // full OHLC candles) so a predicted turn is as visually loud as an
      // actual pattern marker.
      for (const p of analysis.advanced.inflectionPoints.points) {
        staticMarkers.push({
          time: p.date as Time,
          position: p.direction === "up" ? "belowBar" : "aboveBar",
          color: cssVar(p.direction === "up" ? "--up" : "--down"),
          shape: p.direction === "up" ? "arrowUp" : "arrowDown",
          text: `변곡 ${p.confidence.toFixed(2)}`,
          size: 2,
        });
      }
    }

    staticMarkersRef.current = staticMarkers;
    // The old chart (if any) is being torn down below, taking its pattern
    // series with it; stale arrow/path DOM nodes need explicit cleanup though
    // (they're plain DOM overlays, not lightweight-charts series).
    patternPathsRef.current = new Map();
    patternPointsRef.current = new Map();
    patternRevealedRef.current = new Set();
    patternHarmonicRef.current = new Set();
    if (patternLinesRef.current) patternLinesRef.current.innerHTML = "";
    for (const el of patternArrowsRef.current.values()) el.remove();
    patternArrowsRef.current = new Map();
    for (const el of elliottPointsRef.current.values()) el.remove();
    elliottPointsRef.current = new Map();
    drawPatternShapes(selectedPatterns);

    // Same bouncing neon-outlined arrows checked patterns get (see
    // patternArrowsRef inside drawPatternShapes) — added *after* the wipe
    // above, which clears the whole Map on every rebuild (including
    // unrelated layer toggles); adding these earlier just had them deleted
    // a few lines later.
    if (layers.elliott && analysis?.advanced.elliottWave?.impulse && arrowsContainerRef.current) {
      const waves = analysis.advanced.elliottWave.impulse.waves;
      waves.forEach((w, i) => {
        const el = document.createElement("div");
        el.className = "elliottpoint";
        el.textContent = w.label;
        el.dataset.time = w.date;
        el.dataset.price = String(w.price);
        arrowsContainerRef.current!.appendChild(el);
        elliottPointsRef.current.set(`elliott-pt-${i}`, el);
      });
      const last = waves[waves.length - 1];
      const prevWave = waves[waves.length - 2];
      if (last) {
        // Direction from the actual price move into this point (not the
        // 1/3/5 vs 2/4/A/C label, which only reads "up" if the whole
        // impulse count happens to be bullish) — one arrow at the most
        // recent wave, the actionable "where are we now" spot; earlier
        // wave points already have their own numbered circle markers.
        const isLow = prevWave ? last.price <= prevWave.price : true;
        const el = document.createElement("div");
        el.className = `patternpulse ${isLow ? "up" : "down"} animate`;
        el.textContent = isLow ? "▲" : "▼";
        el.dataset.time = last.date;
        el.dataset.price = String(last.price);
        el.dataset.dir = isLow ? "up" : "down";
        arrowsContainerRef.current.appendChild(el);
        patternArrowsRef.current.set("elliott-wave", el);
      }
    }
    if (layers.inflection && analysis?.advanced.inflectionPoints && arrowsContainerRef.current) {
      // One persistent bouncing arrow per predicted turn — same visual
      // language as a checked pattern, not just the small static glyph the
      // series marker above already gives it.
      analysis.advanced.inflectionPoints.points.forEach((p, i) => {
        const el = document.createElement("div");
        el.className = `patternpulse ${p.direction === "up" ? "up" : "down"} animate`;
        el.textContent = p.direction === "up" ? "▲" : "▼";
        el.dataset.time = p.date;
        el.dataset.price = String(p.price);
        el.dataset.dir = p.direction === "up" ? "up" : "down";
        arrowsContainerRef.current!.appendChild(el);
        patternArrowsRef.current.set(`inflection-${i}`, el);
      });
    }
    repositionArrows();

    // NOT another main.timeScale().fitContent() here: the restore-or-fit
    // decision already made right after candle/volume data was set (above)
    // is the one that must stick — an unconditional refit here was
    // clobbering it (visible as the main pane snapping back to a fresh
    // fitContent() range whenever RSI/MACD panels were toggled on).

    // ---- RSI sub-panel ----
    if (layers.rsi && rsiRef.current && analysis?.indicators.rsi) {
      const rsiChart = createChart(rsiRef.current, {
        ...common,
        height: rsiHeightRef.current,
        width: rsiRef.current.clientWidth,
      });
      charts.push(rsiChart);
      rsiApiRef.current = rsiChart;
      const rsiSeries = rsiChart.addLineSeries({
        color: cssVar("--harmonic"),
        lineWidth: 2,
        priceLineVisible: false,
      });
      rsiSeries.setData(toLineWithGaps(dates, analysis.indicators.rsi.values));
      for (const level of [70, 30]) {
        rsiSeries.createPriceLine({
          price: level,
          color: cssVar("--text-faint"),
          lineStyle: LineStyle.Dashed,
          lineWidth: 1,
          axisLabelVisible: true,
          title: level === 70 ? "과매수" : "과매도",
        });
      }
      // NOT fitContent() here: it computes RSI's own bar-fit independently of
      // main, which visibly diverges from main's date-based default/restored
      // range (the RSI line would stop well short of the right edge). Synced
      // to main's actual visible range below instead.
    }

    // ---- MACD sub-panel ----
    if (layers.macd && macdRef.current && analysis?.indicators.macd) {
      const m = analysis.indicators.macd;
      const macdChart = createChart(macdRef.current, {
        ...common,
        height: macdHeightRef.current,
        width: macdRef.current.clientWidth,
      });
      charts.push(macdChart);
      macdApiRef.current = macdChart;
      const hist = macdChart.addHistogramSeries({ priceLineVisible: false });
      hist.setData(
        toLineWithGaps(dates, m.histogram).map((d) =>
          "value" in d ? { ...d, color: d.value >= 0 ? `${up}99` : `${down}99` } : d,
        ),
      );
      const macdLine = macdChart.addLineSeries({
        color: cssVar("--accent"),
        lineWidth: 1,
        priceLineVisible: false,
      });
      macdLine.setData(toLineWithGaps(dates, m.macd));
      const sigLine = macdChart.addLineSeries({
        color: cssVar("--gapcat"),
        lineWidth: 1,
        priceLineVisible: false,
      });
      sigLine.setData(toLineWithGaps(dates, m.signal));
      // NOT fitContent() here either — see the RSI block above.
    }

    // RSI/MACD were just created without setting their own range; match
    // main's actual visible range exactly instead of letting them each
    // fitContent() independently (which visibly diverged from main's
    // range). Logical (bar-index), not date-based — setVisibleRange with a
    // date range resolved to a far wider window than requested here (see
    // applyDefaultRange above), so bar-index sync is what's reliable.
    {
      const mainLogical = main.timeScale().getVisibleLogicalRange();
      if (mainLogical) {
        for (const c of charts) {
          if (c !== main) c.timeScale().setVisibleLogicalRange(mainLogical);
        }
      }
    }

    // ---- sync time scales across all panes ----
    let syncing = false;
    const unsubs: (() => void)[] = [];
    for (const src of charts) {
      const handler = (range: unknown) => {
        if (syncing || !range) return;
        syncing = true;
        for (const dst of charts) {
          if (dst !== src) {
            dst
              .timeScale()
              .setVisibleLogicalRange(
                range as { from: number; to: number },
              );
          }
        }
        syncing = false;
        // NOT drawBand()/checkZoomResolution()/checkLoadMore() here: this
        // handler also fires from RSI/MACD's own initial fitContent() during
        // chart creation, before their range has settled — running the main
        // pane's checks against that transient range corrupts main's view.
        // main.timeScale()'s own subscribeVisibleTimeRangeChange (below)
        // already fires whenever main's range changes for any reason,
        // including being synced in from a pan/zoom on RSI or MACD, so
        // zooming on those panes still drives main's resolution-swap and
        // history auto-load without this handler needing to do it directly.
      };
      src.timeScale().subscribeVisibleLogicalRangeChange(handler);
      unsubs.push(() =>
        src.timeScale().unsubscribeVisibleLogicalRangeChange(handler),
      );
    }

    // ---- zoom-adaptive resolution ----
    function checkZoomResolution() {
      const logical = main.timeScale().getVisibleLogicalRange();
      if (!logical) return;
      const barsVisible = logical.to - logical.from;

      if (isIntraday) {
        if (barsVisible >= ZOOM_BAR_THRESHOLD * 2) {
          setZoomCandles(null); // zoomed back out far enough: drop the override
          zoomKeyRef.current = null;
        }
        return;
      }
      if (barsVisible >= ZOOM_BAR_THRESHOLD) return;

      const range = main.timeScale().getVisibleRange();
      if (!range) return;
      const fromMs = new Date(range.from as string).getTime();
      const toMs = new Date(range.to as string).getTime();
      const spanDays = (toMs - fromMs) / 86400000;
      if (!Number.isFinite(spanDays) || spanDays <= 0 || spanDays > ZOOM_MAX_SPAN_DAYS) return;

      const from = new Date(fromMs).toISOString().slice(0, 10);
      const to = new Date(toMs + 86400000).toISOString().slice(0, 10); // pad a day so the edge bar isn't clipped
      const key = `${from}_${to}_${ZOOM_INTERVAL}`;
      if (zoomKeyRef.current === key) return;

      if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current);
      zoomTimerRef.current = setTimeout(() => {
        zoomKeyRef.current = key;
        fetchOhlcv({ symbol, market, from, to, interval: ZOOM_INTERVAL })
          .then((res) => {
            if (res.candles.length > 0) setZoomCandles(res.candles);
          })
          .catch(() => {
            // silent: keep the current daily view on failure
          });
      }, 400);
    }

    // ---- infinite-pan history: fetch an older chunk near the left edge ----
    function checkLoadMore() {
      if (isIntraday) return; // only extend the daily series
      if (loadingMoreRef.current || noMoreHistoryRef.current) return;
      const logical = main.timeScale().getVisibleLogicalRange();
      if (!logical || logical.from > LOAD_MORE_BAR_MARGIN) return;
      // logical.from<=margin is ALSO what a freshly fitContent()-ed chart
      // reports (the whole dataset fits on screen, so "the left edge" is
      // just wherever bar 0 happens to be) — that's not a user asking for
      // more history. Only fetch when they've actually zoomed in relative to
      // what's loaded, i.e. there's unrendered room to the left within the
      // CURRENT array that they're pushing past.
      if (logical.to - logical.from >= effectiveCandles.length - 1) return;

      const earliest = effectiveCandles[0]?.date;
      if (!earliest) return;

      const cutoff = new Date();
      cutoff.setUTCFullYear(cutoff.getUTCFullYear() - MAX_HISTORY_YEARS);
      if (new Date(earliest) <= cutoff) {
        noMoreHistoryRef.current = true; // already at the 10-year cap
        return;
      }

      const visRange = main.timeScale().getVisibleRange();
      if (!visRange) return;

      const fromDate = new Date(earliest);
      fromDate.setUTCDate(fromDate.getUTCDate() - LOAD_MORE_CHUNK_DAYS);
      if (fromDate < cutoff) fromDate.setTime(cutoff.getTime()); // don't request past the cap
      const from = fromDate.toISOString().slice(0, 10);

      loadingMoreRef.current = true;
      fetchOhlcv({ symbol, market, from, to: earliest, interval: "1d" })
        .then((res) => {
          if (res.candles.length === 0) {
            noMoreHistoryRef.current = true;
            return;
          }
          setHistoryCandles((prev) => {
            const base = prev ?? candles;
            const seen = new Set(base.map((c) => c.date));
            const older = res.candles.filter((c) => !seen.has(c.date));
            if (older.length === 0) {
              noMoreHistoryRef.current = true;
              return prev;
            }
            restoreRangeRef.current = visRange as { from: Time; to: Time };
            return [...older, ...base];
          });
        })
        .catch(() => {
          // silent: keep current data, retry on the next pan/zoom event
        })
        .finally(() => {
          loadingMoreRef.current = false;
        });
    }

    const rangeHandler = () => {
      const logical = main.timeScale().getVisibleLogicalRange();
      if (logical) preservedRangeRef.current = { from: logical.from, to: logical.to };
      drawCloud();
      checkZoomResolution();
      checkLoadMore();
      repositionArrows();
      drawPatternLinePositions();
      drawUserLines();
      drawVolumeProfile();
    };
    main.timeScale().subscribeVisibleTimeRangeChange(rangeHandler);
    drawCloud();

    // ---- drawing tool: horizontal lines (native price lines) + trend lines
    // (custom SVG, see drawUserLines) — drawModeRef/trendPendingRef so this
    // handler (captured once per rebuild) always sees the latest toolbar
    // selection without the whole chart needing to be rebuilt on every click.
    const onChartClick = (param: MouseEventParams) => {
      const mode = drawModeRef.current;
      const series = candleSeriesRef.current;
      if (!mode || !series || !param.point) return;
      const price = series.coordinateToPrice(param.point.y);
      if (price == null) return;
      if (mode === "horizontal") {
        horizontalsRef.current.push({ id: ++drawingIdRef.current, price });
        reapplyHorizontals();
        drawUserLines();
        setDrawingsTick((t) => t + 1);
        return;
      }
      // trend mode: first click sets the anchor, second click finalizes it
      if (!param.time) return; // clicked outside the plotted bars
      const point = { time: param.time, price };
      if (!trendPendingRef.current) {
        trendPendingRef.current = point;
      } else {
        trendsRef.current.push({ id: ++drawingIdRef.current, p1: trendPendingRef.current, p2: point });
        trendPendingRef.current = null;
        drawUserLines();
        setDrawingsTick((t) => t + 1);
      }
    };
    main.subscribeClick(onChartClick);

    // ---- drawing tool: drag-to-edit existing horizontal/trend lines when
    // not actively placing a new one. Hit-tests against the same coordinates
    // drawUserLines()/reapplyHorizontals() already compute; horizontal drags
    // move the native IPriceLine directly (applyOptions, no recreation),
    // trend endpoint drags rewrite that point and redraw the SVG line.
    const HIT_TOLERANCE = 8;
    const localXY = (e: MouseEvent) => {
      const rect = mainRef.current!.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const distToSegment = (px: number, py: number, x1: number, y1: number, x2: number, y2: number) => {
      const dx = x2 - x1;
      const dy = y2 - y1;
      const lenSq = dx * dx + dy * dy;
      const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
      return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    };
    const hitTestLines = (x: number, y: number): typeof dragRef.current => {
      const series = candleSeriesRef.current;
      if (!series) return null;
      for (const t of trendsRef.current) {
        const x1 = main.timeScale().timeToCoordinate(t.p1.time);
        const y1 = series.priceToCoordinate(t.p1.price);
        if (x1 != null && y1 != null && Math.hypot(x - x1, y - y1) < HIT_TOLERANCE) {
          return { type: "trend", id: t.id, end: "p1" };
        }
        const x2 = main.timeScale().timeToCoordinate(t.p2.time);
        const y2 = series.priceToCoordinate(t.p2.price);
        if (x2 != null && y2 != null && Math.hypot(x - x2, y - y2) < HIT_TOLERANCE) {
          return { type: "trend", id: t.id, end: "p2" };
        }
        // Not on either endpoint — check the segment body so long-pressing
        // anywhere along the line (not just its ends) unlocks it too.
        if (x1 != null && y1 != null && x2 != null && y2 != null) {
          if (distToSegment(x, y, x1, y1, x2, y2) < HIT_TOLERANCE) {
            return {
              type: "trend",
              id: t.id,
              end: "body",
              origP1: t.p1,
              origP2: t.p2,
              origMouseX: x,
              origMouseY: y,
            };
          }
        }
      }
      for (const h of horizontalsRef.current) {
        const hy = series.priceToCoordinate(h.price);
        if (hy != null && Math.abs(y - hy) < HIT_TOLERANCE) return { type: "horizontal", id: h.id };
      }
      return null;
    };
    const LONG_PRESS_MS = 500;
    const MOVE_CANCEL_PX = 4;
    const isEditingHit = (hit: NonNullable<typeof dragRef.current>) =>
      editingLineRef.current?.type === hit.type && editingLineRef.current.id === hit.id;
    const restyleHit = (hit: { type: "horizontal" | "trend"; id: number }) => {
      if (hit.type === "horizontal") reapplyHorizontals();
      else drawUserLines();
    };
    // Locks (re-solidifies) whatever line is currently unlocked, if any —
    // called both when a click lands elsewhere on the chart and, via the
    // document-level listener below, when it lands outside the chart entirely.
    const finishEditing = () => {
      const target = editingLineRef.current;
      if (!target) return;
      editingLineRef.current = null;
      restyleHit(target);
    };
    const onDrawMouseDown = (e: MouseEvent) => {
      if (drawModeRef.current) return; // placing a new line takes priority
      const { x, y } = localXY(e);
      const hit = hitTestLines(x, y);
      if (!hit || !isEditingHit(hit)) finishEditing();
      if (!hit) return;
      e.preventDefault();
      // Also stop the event from ever reaching lightweight-charts' own
      // mousedown handling (registered on the canvas, a descendant of this
      // container) — without this the library's own click-drag-to-pan
      // gesture engaged *in parallel* with our own drag, so grabbing a
      // line's endpoint to resize it instead panned the whole chart while
      // the endpoint move happened invisibly underneath. Requires this
      // listener to be registered in the capture phase (see addEventListener
      // below) since by the time a bubble-phase listener on this ancestor
      // would run, the canvas's own same-phase handler has already fired.
      e.stopPropagation();
      mouseDownPosRef.current = { x, y };
      mouseMovedRef.current = false;
      wasEditingAtDownRef.current = isEditingHit(hit);
      if (wasEditingAtDownRef.current) {
        // already unlocked (dashed) — drag starts immediately
        dragRef.current = hit;
        return;
      }
      // locked — a long press unlocks it (dashed) and starts the drag; a
      // quick click/release before the timer does nothing.
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null;
        if (mouseMovedRef.current) return;
        editingLineRef.current = { type: hit.type, id: hit.id };
        restyleHit(hit);
        dragRef.current = hit;
      }, LONG_PRESS_MS);
    };
    const onDrawMouseMove = (e: MouseEvent) => {
      const series = candleSeriesRef.current;
      const drag = dragRef.current;
      const { x, y } = localXY(e);
      if (mouseDownPosRef.current) {
        const moved = Math.hypot(x - mouseDownPosRef.current.x, y - mouseDownPosRef.current.y) > MOVE_CANCEL_PX;
        if (moved) {
          mouseMovedRef.current = true;
          if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
          }
        }
      }
      if (!drag) {
        if (!drawModeRef.current && mainRef.current) {
          const hit = hitTestLines(x, y);
          mainRef.current.style.cursor = !hit
            ? ""
            : isEditingHit(hit)
              ? hit.type === "horizontal"
                ? "ns-resize"
                : "move"
              : "pointer";
        }
        return;
      }
      if (!series) return;
      if (drag.type === "horizontal") {
        const price = series.coordinateToPrice(y);
        if (price == null) return;
        const h = horizontalsRef.current.find((h) => h.id === drag.id);
        if (!h) return;
        h.price = price;
        priceLineHandlesRef.current.get(drag.id)?.applyOptions({ price });
        drawUserLines(); // reposition the custom bold label to follow the drag
      } else if (drag.end === "body") {
        // Translate both endpoints by the same pixel delta so the segment
        // keeps its shape instead of pivoting around one point. Clamped to
        // the actual plotted bar range — coordinateToTime returns null past
        // the first/last bar (e.g. dragging right with rightOffset 0, where
        // the latest bar already sits flush against the axis), which would
        // otherwise silently no-op the whole translation.
        const t = trendsRef.current.find((t) => t.id === drag.id);
        if (!t) return;
        let dxPx = x - drag.origMouseX;
        const dyPx = y - drag.origMouseY;
        const x1 = main.timeScale().timeToCoordinate(drag.origP1.time);
        const y1 = series.priceToCoordinate(drag.origP1.price);
        const x2 = main.timeScale().timeToCoordinate(drag.origP2.time);
        const y2 = series.priceToCoordinate(drag.origP2.price);
        if (x1 == null || y1 == null || x2 == null || y2 == null) return;
        const firstBarX = main.timeScale().timeToCoordinate(toChartTime(effectiveCandles[0].date, isIntraday));
        const lastBarX = main.timeScale().timeToCoordinate(
          toChartTime(effectiveCandles[effectiveCandles.length - 1].date, isIntraday),
        );
        if (firstBarX != null && lastBarX != null) {
          const loX = Math.min(x1, x2);
          const hiX = Math.max(x1, x2);
          dxPx = Math.max(firstBarX - loX, Math.min(lastBarX - hiX, dxPx));
        }
        const time1 = main.timeScale().coordinateToTime(x1 + dxPx);
        const price1 = series.coordinateToPrice(y1 + dyPx);
        const time2 = main.timeScale().coordinateToTime(x2 + dxPx);
        const price2 = series.coordinateToPrice(y2 + dyPx);
        if (time1 == null || price1 == null || time2 == null || price2 == null) return;
        t.p1 = { time: time1, price: price1 };
        t.p2 = { time: time2, price: price2 };
        drawUserLines();
      } else {
        const time = main.timeScale().coordinateToTime(x);
        const price = series.coordinateToPrice(y);
        if (time == null || price == null) return;
        const t = trendsRef.current.find((t) => t.id === drag.id);
        if (!t) return;
        t[drag.end] = { time, price };
        drawUserLines();
      }
    };
    const onDrawMouseUp = () => {
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      const hit = dragRef.current;
      // A plain click (no drag) on a line that was ALREADY dashed before
      // this mousedown re-locks it (solid) — editing confirmed done. A long
      // press that just unlocked it during this same gesture leaves it
      // dashed even if released without moving.
      if (hit && wasEditingAtDownRef.current && !mouseMovedRef.current) {
        editingLineRef.current = null;
        restyleHit(hit);
      }
      dragRef.current = null;
      mouseDownPosRef.current = null;
    };
    mainRef.current.addEventListener("mousedown", onDrawMouseDown, true);
    window.addEventListener("mousemove", onDrawMouseMove);
    window.addEventListener("mouseup", onDrawMouseUp);
    // On-canvas delete (×) buttons on the currently-editing line's badge —
    // delegated to one listener per overlay svg since the badge <g> nodes
    // are pooled/reused across redraws (see drawUserLines), so attaching a
    // fresh listener per node on every redraw would leak.
    const onLineDeleteClick = (e: MouseEvent) => {
      const target = (e.target as Element).closest("[data-del-type]");
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      const type = target.getAttribute("data-del-type");
      const id = Number(target.getAttribute("data-del-id"));
      if (type === "horizontal") {
        horizontalsRef.current = horizontalsRef.current.filter((h) => h.id !== id);
        reapplyHorizontals();
      } else if (type === "trend") {
        trendsRef.current = trendsRef.current.filter((t) => t.id !== id);
      }
      if (editingLineRef.current?.type === type && editingLineRef.current.id === id) {
        editingLineRef.current = null;
      }
      drawUserLines();
      setDrawingsTick((t) => t + 1);
    };
    userLinesRef.current?.addEventListener("mousedown", onLineDeleteClick, true);
    hLabelsRef.current?.addEventListener("mousedown", onLineDeleteClick, true);
    // Clicking anywhere outside the chart entirely (sidebar, header, ...)
    // also finishes editing — onDrawMouseDown only covers clicks inside the
    // chart itself. Capture phase so it fires before the click's own handler.
    const onDocumentMouseDown = (e: MouseEvent) => {
      if (editingLineRef.current && !mainRef.current?.contains(e.target as Node)) finishEditing();
    };
    document.addEventListener("mousedown", onDocumentMouseDown, true);

    // ---- responsive resize: all panes share the chart column width ----
    // The chart can be created before the grid finishes laying out (width ~0);
    // when the real width first arrives we must refit so bars aren't
    // left-anchored in an over-wide pane. Later resizes (window resize, sidebar
    // toggle) must NOT refit — with up to 10 years loaded, fitContent() would
    // blow away the 3-month default / whatever the user panned to.
    let lastWidth = mainRef.current.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = mainRef.current?.clientWidth;
      if (!w) return;
      const wasUnsized = lastWidth === 0;
      lastWidth = w;
      for (const c of charts) c.applyOptions({ width: w });
      if (wasUnsized) applyDefaultRange();
      drawCloud();
      repositionArrows();
      drawPatternLinePositions();
      drawUserLines();
      drawVolumeProfile();
    });
    if (mainRef.current) ro.observe(mainRef.current);
    drawUserLines();

    return () => {
      ro.disconnect();
      main.unsubscribeCrosshairMove(crosshairHandler);
      main.timeScale().unsubscribeVisibleTimeRangeChange(rangeHandler);
      main.unsubscribeClick(onChartClick);
      mainRef.current?.removeEventListener("mousedown", onDrawMouseDown, true);
      window.removeEventListener("mousemove", onDrawMouseMove);
      window.removeEventListener("mouseup", onDrawMouseUp);
      document.removeEventListener("mousedown", onDocumentMouseDown, true);
      userLinesRef.current?.removeEventListener("mousedown", onLineDeleteClick, true);
      hLabelsRef.current?.removeEventListener("mousedown", onLineDeleteClick, true);
      dragRef.current = null;
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
      if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current);
      mainApiRef.current = null;
      volumeApiRef.current = null;
      rsiApiRef.current = null;
      macdApiRef.current = null;
      candleSeriesRef.current = null;
      for (const u of unsubs) u();
      for (const c of charts) c.remove();
    };
    // selectedPatterns is intentionally excluded: it's drawn by the
    // dedicated effect below (via drawPatternShapes) so toggling a pattern
    // checkbox doesn't tear down and rebuild the whole chart stack.
  }, [
    candles,
    analysis,
    layers,
    themeVersion,
    activeSubTab,
    zoomCandles,
    historyCandles,
  ]);

  // Redraw pattern markers/shape-lines when the selection changes, without
  // touching the rest of the chart (see drawPatternShapes/staticMarkersRef
  // above) — this is what actually fixes the "candles flash bigger then
  // snap back" flicker: previously selectedPatterns was a dep of the big
  // rebuild effect, so every checkbox click destroyed and recreated the
  // whole chart stack (briefly showing it at its just-created, not-yet-sized
  // state).
  useEffect(() => {
    drawPatternShapes(selectedPatterns);
  }, [selectedPatterns, drawPatternShapes]);

  // Pan to a just-checked pattern — keeps the user's current zoom level
  // (bar count), only shifts which window of it is showing. Separate from
  // the big rebuild effect so checking a pattern doesn't tear down and
  // recreate the whole chart stack, just pans it.
  useEffect(() => {
    if (!focusPattern) return;
    const main = mainApiRef.current;
    if (!main) return;
    const pat = focusPattern.p;

    let startIdx = candles.findIndex((c) => c.date >= pat.range.start);
    if (startIdx === -1) startIdx = candles.length - 1;
    let endIdx = -1;
    for (let i = candles.length - 1; i >= 0; i--) {
      if (candles[i].date <= pat.range.end) {
        endIdx = i;
        break;
      }
    }
    if (endIdx === -1) endIdx = startIdx;
    if (endIdx < startIdx) [startIdx, endIdx] = [endIdx, startIdx];

    const logical = main.timeScale().getVisibleLogicalRange();
    const width = logical ? logical.to - logical.from : DEFAULT_VIEW_BARS;
    const centerIdx = Math.round((startIdx + endIdx) / 2);
    const half = width / 2;
    let viewFrom = centerIdx - half;
    let viewTo = centerIdx + half;
    if (viewTo > candles.length - 1) {
      viewFrom -= viewTo - (candles.length - 1);
      viewTo = candles.length - 1;
    }
    if (viewFrom < 0) {
      viewTo -= viewFrom;
      viewFrom = 0;
    }
    main.timeScale().setVisibleLogicalRange({
      from: Math.max(0, viewFrom),
      to: Math.min(viewTo, candles.length - 1),
    });

    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        repositionArrows();
        drawPatternLinePositions();
      }),
    );
    return () => cancelAnimationFrame(raf);
  }, [focusPattern, candles, repositionArrows, drawPatternLinePositions]);

  // Drag a handle below a pane to resize it; live via applyOptions (see the
  // *HeightRef/*ApiRef pairs above) so no chart rebuild happens per pixel.
  function makeResizeHandler(
    heightRef: React.MutableRefObject<number>,
    apiRef: React.MutableRefObject<IChartApi | null>,
    min: number,
    max: number,
    onChange?: (height: number) => void,
  ) {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      const startY = e.clientY;
      const startHeight = heightRef.current;
      function onMove(ev: MouseEvent) {
        const next = Math.min(max, Math.max(min, startHeight + (ev.clientY - startY)));
        heightRef.current = next;
        apiRef.current?.applyOptions({ height: next });
        onChange?.(next);
      }
      function onUp() {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    };
  }
  const onMainResizeDown = makeResizeHandler(
    mainHeightRef,
    mainApiRef,
    MIN_MAIN_HEIGHT,
    MAX_MAIN_HEIGHT,
    onMainHeightChange,
  );
  const onVolumeResizeDown = makeResizeHandler(volumeHeightRef, volumeApiRef, MIN_SUB_HEIGHT, MAX_SUB_HEIGHT);
  const onRsiResizeDown = makeResizeHandler(rsiHeightRef, rsiApiRef, MIN_SUB_HEIGHT, MAX_SUB_HEIGHT);
  const onMacdResizeDown = makeResizeHandler(macdHeightRef, macdApiRef, MIN_SUB_HEIGHT, MAX_SUB_HEIGHT);

  function clearDrawings() {
    const series = candleSeriesRef.current;
    if (series) for (const h of priceLineHandlesRef.current.values()) series.removePriceLine(h);
    priceLineHandlesRef.current = new Map();
    horizontalsRef.current = [];
    trendsRef.current = [];
    trendPendingRef.current = null;
    drawUserLines();
    setDrawingsTick((t) => t + 1);
    setJustCleared(true);
    setTimeout(() => setJustCleared(false), 220);
  }

  function removeHorizontal(id: number) {
    horizontalsRef.current = horizontalsRef.current.filter((h) => h.id !== id);
    reapplyHorizontals();
    drawUserLines();
    setDrawingsTick((t) => t + 1);
  }

  function removeTrend(id: number) {
    trendsRef.current = trendsRef.current.filter((t) => t.id !== id);
    drawUserLines();
    setDrawingsTick((t) => t + 1);
  }

  return (
    <>
      <div className="panel">
        <div className="panel__label">
          <span>메인 캔들 차트</span>
          <span className="v">
            {selectedPatterns.length
              ? `패턴 ${selectedPatterns.length}건 표시 중`
              : "캔들 · 거래량 · 오버레이"}
          </span>
        </div>
        <div className="drawtools">
          <button
            className={drawMode === "horizontal" ? "on" : ""}
            onClick={() => setDrawMode((m) => (m === "horizontal" ? null : "horizontal"))}
            title="수평선 그리기"
          >
            수평선
          </button>
          <button
            className={drawMode === "trend" ? "on" : ""}
            onClick={() => setDrawMode((m) => (m === "trend" ? null : "trend"))}
            title="추세선 그리기 (두 점 클릭)"
          >
            추세선
          </button>
          <button
            className={justCleared ? "pressed" : ""}
            onClick={clearDrawings}
            title="그린 선 전부 지우기"
          >
            전체 지우기
          </button>
        </div>
        {(horizontalsRef.current.length > 0 || trendsRef.current.length > 0) && (
          <div className="drawinglist">
            {horizontalsRef.current.map((h, i) => (
              <span key={h.id} className="drawingchip">
                수평선 {i + 1}: {h.price.toLocaleString()}
                <button onClick={() => removeHorizontal(h.id)} aria-label="이 수평선 삭제" title="삭제">
                  ×
                </button>
              </span>
            ))}
            {trendsRef.current.map((t, i) => (
              <span key={t.id} className="drawingchip">
                추세선 {i + 1}
                <button onClick={() => removeTrend(t.id)} aria-label="이 추세선 삭제" title="삭제">
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className={`panel__chart ${drawMode ? "drawing" : ""}`}>
          <div ref={ohlcRef} className="ohlcbar" />
          <div ref={mainRef} />
          <svg ref={volumeProfileRef} className="volumeprofile" />
          <svg ref={cloudRef} className="cloudlayer" />
          <svg ref={patternLinesRef} className="patternlines" />
          <svg ref={userLinesRef} className="userlines" />
          <svg ref={hLabelsRef} className="userlines" />
          <div ref={arrowsContainerRef} className="patternarrows" />
        </div>
        <div
          className="resizehandle"
          onMouseDown={onMainResizeDown}
          title="드래그해서 차트 높이 조절"
        >
          <span />
        </div>
        <div className="legend">
          {layers.ma && <span><i style={{ background: MA_COLORS[5] }} />MA5</span>}
          {layers.ma && <span><i style={{ background: MA_COLORS[10] }} />MA10</span>}
          {layers.ma && <span><i style={{ background: MA_COLORS[20] }} />MA20</span>}
          {layers.ma && <span><i style={{ background: MA_COLORS[60] }} />MA60</span>}
          {layers.ma && <span><i style={{ background: MA_COLORS[120] }} />MA120</span>}
          {layers.ema && (
            <span><i style={{ background: "var(--accent)", borderTop: "1px dashed var(--accent)" }} />EMA(점선)</span>
          )}
          {layers.bollinger && (
            <span><i style={{ background: "var(--text-faint)" }} />볼린저</span>
          )}
          {layers.ichimoku && (
            <>
              <span><i style={{ background: "var(--continuation)" }} />선행A</span>
              <span><i style={{ background: "var(--gapcat)" }} />선행B</span>
            </>
          )}
          {layers.elliott && (
            <span title="엘리엇 파동: 추세 5파(1→2→3→4→5) 뒤 조정 3파(A→B→C)가 이어지는 구조. 캔들 위 원형 마커의 숫자/알파벳이 각 파동의 순서.">
              <i style={{ background: "var(--elliott)" }} />엘리엇파동(1~5·A~C)
            </span>
          )}
          {layers.inflection && (
            <span title="변곡점 예측: 추세가 곧 꺾일 것으로 예측되는 지점. 거래량 이상·RSI/OBV 다이버전스·볼린저밴드 수축 등 규칙 기반 신호를 종합한 신뢰도(0~1, 1에 가까울수록 신호가 강함)를 화살표 옆 숫자로 표시.">
              <i style={{ background: "var(--up)" }} />▲/<i style={{ background: "var(--down)" }} />▼ 변곡(신뢰도 0~1)
            </span>
          )}
          <span>
            <i style={{ background: "var(--up)" }} />▲상승 /{" "}
            <i style={{ background: "var(--down)" }} />▼하락
          </span>
        </div>
      </div>

      {layers.volume && (
        <div className="panel">
          <div className="panel__label">
            <span>거래량</span>
            <span className="v">{(candles.at(-1)?.volume ?? 0).toLocaleString()}</span>
          </div>
          <div className="panel__chart">
            <div ref={volumeRef} />
          </div>
          <div className="resizehandle" onMouseDown={onVolumeResizeDown} title="드래그해서 거래량 높이 조절">
            <span />
          </div>
        </div>
      )}

      {layers.rsi && layers.macd && (
        <div className="subtab-bar">
          <button
            className={activeSubTab === "rsi" ? "on" : ""}
            onClick={() => setActiveSubTab("rsi")}
          >
            RSI
          </button>
          <button
            className={activeSubTab === "macd" ? "on" : ""}
            onClick={() => setActiveSubTab("macd")}
          >
            MACD
          </button>
        </div>
      )}

      {layers.rsi && (
        <div className={`panel ${layers.macd && activeSubTab !== "rsi" ? "subtab-hidden" : ""}`}>
          <div className="panel__label">
            <span>RSI (14)</span>
            <span className="v">
              {lastNonNull(analysis?.indicators.rsi?.values)?.toFixed(2) ?? "—"}
            </span>
          </div>
          <div className="panel__chart">
            <div ref={rsiRef} />
          </div>
          <div className="resizehandle" onMouseDown={onRsiResizeDown} title="드래그해서 RSI 높이 조절">
            <span />
          </div>
        </div>
      )}

      {layers.macd && (
        <div className={`panel ${layers.rsi && activeSubTab !== "macd" ? "subtab-hidden" : ""}`}>
          <div className="panel__label">
            <span>MACD (12,26,9)</span>
            <span className="v">
              MACD {lastNonNull(analysis?.indicators.macd?.macd)?.toFixed(2) ?? "—"} ·
              Signal {lastNonNull(analysis?.indicators.macd?.signal)?.toFixed(2) ?? "—"}
            </span>
          </div>
          <div className="panel__chart">
            <div ref={macdRef} />
          </div>
          <div className="resizehandle" onMouseDown={onMacdResizeDown} title="드래그해서 MACD 높이 조절">
            <span />
          </div>
        </div>
      )}
    </>
  );
}

function lastNonNull(arr?: (number | null)[]): number | null {
  if (!arr) return null;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) return arr[i];
  }
  return null;
}

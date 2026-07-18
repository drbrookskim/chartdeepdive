// Recent-search persistence (localStorage). Mirrors the EquiSense "recent
// first" pattern referenced in the wireframe. Stores the minimal fields needed
// to jump straight back into a chart.

import type { SearchResult } from "@/lib/schema";

const KEY = "cdd-recent";
const MAX = 12;

export function getRecent(): SearchResult[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SearchResult[]) : [];
  } catch {
    return [];
  }
}

export function pushRecent(item: SearchResult): SearchResult[] {
  const existing = getRecent().filter((r) => r.symbol !== item.symbol);
  const next = [item, ...existing].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* quota/full — ignore, non-critical */
  }
  return next;
}

export function removeRecent(symbol: string): SearchResult[] {
  const next = getRecent().filter((r) => r.symbol !== symbol);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* quota/full — ignore, non-critical */
  }
  return next;
}

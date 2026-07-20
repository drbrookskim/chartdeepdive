"use client";

// Recent-search list, account-based (stored in the signed-in user's JWT via
// the session `update()` trigger — see auth.ts's callbacks) rather than
// per-browser localStorage, so it follows the Google account across devices.
// Signed-out visitors get an empty list; push/remove are no-ops for them.

import { useSession } from "next-auth/react";
import type { SearchResult } from "@/lib/schema";

const MAX = 12;

export function useRecent() {
  const { data: session, update } = useSession();
  const recent = session?.recent ?? [];

  async function push(item: SearchResult) {
    if (!session) return;
    const next = [item, ...recent.filter((r) => r.symbol !== item.symbol)].slice(0, MAX);
    await update({ recent: next });
  }

  async function remove(symbol: string) {
    if (!session) return;
    await update({ recent: recent.filter((r) => r.symbol !== symbol) });
  }

  return { recent, push, remove };
}

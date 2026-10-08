/**
 * app/api/symbols/route.ts
 * Server-side only — Vercel IP (not Iran) → Binance / Bybit / LBank / Bitunix
 * + market indices: BTC.D, USDT.D, TOTAL2, TOTAL3, OTHERS.D
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Hit = {
  symbol: string;
  baseCoin?: string;
  quoteCoin?: string;
  market: "Spot" | "Futures" | "Index";
  exchange?: string;
};

const INDEX_SYMBOLS: Hit[] = [
  { symbol: "BTC.D", baseCoin: "BTC", quoteCoin: "DOM", market: "Index", exchange: "GLOBAL" },
  { symbol: "USDT.D", baseCoin: "USDT", quoteCoin: "DOM", market: "Index", exchange: "GLOBAL" },
  { symbol: "OTHERS.D", baseCoin: "OTHERS", quoteCoin: "DOM", market: "Index", exchange: "GLOBAL" },
  { symbol: "TOTAL2", baseCoin: "TOTAL2", quoteCoin: "USD", market: "Index", exchange: "GLOBAL" },
  { symbol: "TOTAL3", baseCoin: "TOTAL3", quoteCoin: "USD", market: "Index", exchange: "GLOBAL" },
];

async function safeJson(url: string, timeoutMs = 8000): Promise<any | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": "AlarmChert/1.0" },
      next: { revalidate: 300 },
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fromBinance(): Promise<Hit[]> {
  const [spot, fut] = await Promise.all([
    safeJson("https://api.binance.com/api/v3/exchangeInfo"),
    safeJson("https://fapi.binance.com/fapi/v1/exchangeInfo"),
  ]);
  const out: Hit[] = [];
  for (const s of spot?.symbols || []) {
    if (s.status !== "TRADING") continue;
    if (s.quoteAsset !== "USDT" && s.quoteAsset !== "USDC") continue;
    out.push({
      symbol: s.symbol,
      baseCoin: s.baseAsset,
      quoteCoin: s.quoteAsset,
      market: "Spot",
      exchange: "BINANCE",
    });
  }
  for (const s of fut?.symbols || []) {
    if (s.status !== "TRADING") continue;
    if (s.quoteAsset !== "USDT") continue;
    out.push({
      symbol: s.symbol,
      baseCoin: s.baseAsset,
      quoteCoin: s.quoteAsset,
      market: "Futures",
      exchange: "BINANCE",
    });
  }
  return out;
}

async function fromBybit(): Promise<Hit[]> {
  const [spot, fut] = await Promise.all([
    safeJson(
      "https://api.bybit.com/v5/market/instruments-info?category=spot&status=Trading&limit=1000"
    ),
    safeJson(
      "https://api.bybit.com/v5/market/instruments-info?category=linear&status=Trading&limit=1000"
    ),
  ]);
  const out: Hit[] = [];
  for (const x of spot?.result?.list || []) {
    out.push({
      symbol: x.symbol,
      baseCoin: x.baseCoin,
      quoteCoin: x.quoteCoin,
      market: "Spot",
      exchange: "BYBIT",
    });
  }
  for (const x of fut?.result?.list || []) {
    out.push({
      symbol: x.symbol,
      baseCoin: x.baseCoin,
      quoteCoin: x.quoteCoin,
      market: "Futures",
      exchange: "BYBIT",
    });
  }
  return out;
}

async function fromLBank(): Promise<Hit[]> {
  // https://api.lbkex.com/v1/currencyPairs.do  → ["btc_usdt", ...]
  const data = await safeJson("https://api.lbkex.com/v1/currencyPairs.do");
  const pairs: string[] = Array.isArray(data) ? data : data?.data || [];
  const out: Hit[] = [];
  for (const p of pairs) {
    if (typeof p !== "string") continue;
    const [base, quote] = p.toLowerCase().split("_");
    if (!base || !quote) continue;
    if (quote !== "usdt" && quote !== "usdc") continue;
    out.push({
      symbol: `${base.toUpperCase()}${quote.toUpperCase()}`,
      baseCoin: base.toUpperCase(),
      quoteCoin: quote.toUpperCase(),
      market: "Spot",
      exchange: "LBANK",
    });
  }
  return out;
}

async function fromBitunix(): Promise<Hit[]> {
  // Spot pairs
  const spot = await safeJson(
    "https://api.bitunix.com/api/spot/v1/common/coin_pair/list"
  );
  const out: Hit[] = [];
  for (const x of spot?.data || []) {
    if (x.isOpen === "0" || x.isOpen === 0) continue;
    const base = (x.base || "").toUpperCase();
    const quote = (x.quote || "").toUpperCase();
    if (!base || !quote) continue;
    if (quote !== "USDT" && quote !== "USDC") continue;
    out.push({
      symbol: `${base}${quote}`,
      baseCoin: base,
      quoteCoin: quote,
      market: "Spot",
      exchange: "BITUNIX",
    });
  }
  // Futures
  const fut = await safeJson(
    "https://fapi.bitunix.com/api/v1/futures/market/trading_pairs"
  );
  for (const x of fut?.data || []) {
    if (x.symbolStatus && x.symbolStatus !== "OPEN") continue;
    const sym = (x.symbol || "").toUpperCase();
    if (!sym) continue;
    out.push({
      symbol: sym,
      baseCoin: (x.base || sym.replace("USDT", "")).toUpperCase(),
      quoteCoin: (x.quote || "USDT").toUpperCase(),
      market: "Futures",
      exchange: "BITUNIX",
    });
  }
  return out;
}

function mergeHits(lists: Hit[][]): Hit[] {
  const seen = new Set<string>();
  const out: Hit[] = [];
  // Prefer Binance > Bybit > LBank > Bitunix for same symbol
  for (const list of lists) {
    for (const h of list) {
      const key = h.symbol.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...h, symbol: key });
    }
  }
  return out;
}

export async function GET() {
  try {
    const results = await Promise.allSettled([
      fromBinance(),
      fromBybit(),
      fromLBank(),
      fromBitunix(),
    ]);

    const lists: Hit[][] = results.map((r) =>
      r.status === "fulfilled" ? r.value : []
    );
    const sources = {
      binance: lists[0].length,
      bybit: lists[1].length,
      lbank: lists[2].length,
      bitunix: lists[3].length,
    };

    const merged = mergeHits(lists);

    // Always include market indices at the top of search results
    const withIndex = [...INDEX_SYMBOLS, ...merged];

    return NextResponse.json({
      ok: true,
      count: withIndex.length,
      sources,
      data: withIndex,
    });
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: String(e?.message || e),
        data: INDEX_SYMBOLS,
      },
      { status: 200 }
    );
  }
}

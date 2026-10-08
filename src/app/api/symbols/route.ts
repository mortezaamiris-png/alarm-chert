/**
 * src/app/api/symbols/route.ts
 * هر صرافی جدا — بدون ادغام نمادها
 * بدون شاخص‌های تقریبی (BTC.D / TOTAL2 / ...)
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

type Hit = {
  symbol: string;
  baseCoin?: string;
  quoteCoin?: string;
  market: "Spot" | "Futures";
  exchange: string;
};

async function safeJson(url: string, timeoutMs = 12000): Promise<any | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": "AlarmChert/1.0" },
      cache: "no-store",
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const text = await res.text();
    if (!text || text.startsWith("<!")) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function splitBaseQuote(sym: string): { base: string; quote: string } {
  const s = sym.toUpperCase();
  for (const q of ["USDT", "USDC", "USD", "BTC", "ETH", "BUSD"]) {
    if (s.endsWith(q) && s.length > q.length) {
      return { base: s.slice(0, -q.length), quote: q };
    }
  }
  return { base: s, quote: "" };
}

/** Binance — lightweight ticker/price (~150KB) */
async function fromBinance(): Promise<Hit[]> {
  const data = await safeJson("https://data-api.binance.vision/api/v3/ticker/price");
  if (!Array.isArray(data)) return [];
  const out: Hit[] = [];
  for (const row of data) {
    const symbol = String(row.symbol || "").toUpperCase();
    if (!symbol.endsWith("USDT") && !symbol.endsWith("USDC")) continue;
    if (
      symbol.includes("UPUSDT") ||
      symbol.includes("DOWNUSDT") ||
      symbol.includes("BULL") ||
      symbol.includes("BEAR")
    )
      continue;
    const { base, quote } = splitBaseQuote(symbol);
    out.push({
      symbol,
      baseCoin: base,
      quoteCoin: quote,
      market: "Spot",
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
      symbol: String(x.symbol).toUpperCase(),
      baseCoin: x.baseCoin,
      quoteCoin: x.quoteCoin,
      market: "Spot",
      exchange: "BYBIT",
    });
  }
  for (const x of fut?.result?.list || []) {
    out.push({
      symbol: String(x.symbol).toUpperCase(),
      baseCoin: x.baseCoin,
      quoteCoin: x.quoteCoin,
      market: "Futures",
      exchange: "BYBIT",
    });
  }
  return out;
}

async function fromLBank(): Promise<Hit[]> {
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
  const out: Hit[] = [];
  const spot = await safeJson(
    "https://api.bitunix.com/api/spot/v1/common/coin_pair/list"
  );
  for (const x of spot?.data || []) {
    if (x.isOpen === "0" || x.isOpen === 0) continue;
    const base = (x.base || "").toUpperCase();
    const quote = (x.quote || "").toUpperCase();
    if (!base || (quote !== "USDT" && quote !== "USDC")) continue;
    out.push({
      symbol: `${base}${quote}`,
      baseCoin: base,
      quoteCoin: quote,
      market: "Spot",
      exchange: "BITUNIX",
    });
  }
  const fut = await safeJson(
    "https://fapi.bitunix.com/api/v1/futures/market/trading_pairs"
  );
  for (const x of fut?.data || []) {
    if (x.symbolStatus && x.symbolStatus !== "OPEN") continue;
    const sym = String(x.symbol || "").toUpperCase();
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

export async function GET() {
  try {
    const results = await Promise.allSettled([
      fromBinance(),
      fromBybit(),
      fromLBank(),
      fromBitunix(),
    ]);

    const binance = results[0].status === "fulfilled" ? results[0].value : [];
    const bybit = results[1].status === "fulfilled" ? results[1].value : [];
    const lbank = results[2].status === "fulfilled" ? results[2].value : [];
    const bitunix = results[3].status === "fulfilled" ? results[3].value : [];

    // هر صرافی جدا — بدون ادغام
    const data = [...binance, ...bybit, ...lbank, ...bitunix];

    return NextResponse.json({
      ok: true,
      count: data.length,
      sources: {
        binance: binance.length,
        bybit: bybit.length,
        lbank: lbank.length,
        bitunix: bitunix.length,
      },
      data,
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message || e), data: [] },
      { status: 200 }
    );
  }
}

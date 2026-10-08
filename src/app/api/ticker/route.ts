/**
 * app/api/ticker/route.ts
 * Multi-exchange last price + 24h % (server-side)
 * Query:
 *   ?symbol=BTCUSDT
 *   ?symbols=BTCUSDT,ETHUSDT,BTC.D
 * Response: { ok, data: { BTCUSDT: { lastPrice, price24hPcnt } } }
 */
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = { lastPrice: number; price24hPcnt: number | null; exchange?: string };

const INDEX_SET = new Set([
  "BTC.D",
  "USDT.D",
  "OTHERS.D",
  "TOTAL2",
  "TOTAL3",
  "TOTAL",
]);

async function safeFetch(url: string, timeoutMs = 8000): Promise<any | null> {
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
    return await res.json();
  } catch {
    return null;
  }
}

async function indicesValues(): Promise<Record<string, Row>> {
  const g = await safeFetch("https://api.coingecko.com/api/v3/global");
  const d = g?.data || {};
  const pct = d.market_cap_percentage || {};
  const totalUsd = Number(d.total_market_cap?.usd) || 0;
  const btcD = Number(pct.btc) || 0;
  const ethD = Number(pct.eth) || 0;
  const usdtD = Number(pct.usdt) || 0;
  const othersD = Math.max(0, 100 - btcD - ethD - usdtD);
  const chg = Number(d.market_cap_change_percentage_24h_usd);
  const chgFrac = Number.isFinite(chg) ? chg / 100 : null;

  return {
    "BTC.D": { lastPrice: btcD, price24hPcnt: null, exchange: "COINGECKO" },
    "USDT.D": { lastPrice: usdtD, price24hPcnt: null, exchange: "COINGECKO" },
    "OTHERS.D": { lastPrice: othersD, price24hPcnt: null, exchange: "COINGECKO" },
    TOTAL: { lastPrice: totalUsd, price24hPcnt: chgFrac, exchange: "COINGECKO" },
    TOTAL2: {
      lastPrice: totalUsd * (1 - btcD / 100),
      price24hPcnt: chgFrac,
      exchange: "COINGECKO",
    },
    TOTAL3: {
      lastPrice: totalUsd * (1 - btcD / 100 - ethD / 100),
      price24hPcnt: chgFrac,
      exchange: "COINGECKO",
    },
  };
}

async function fromBinance(symbols: string[]): Promise<Record<string, Row>> {
  const out: Record<string, Row> = {};
  // 24hr ticker all then filter (efficient for many symbols)
  const [spot, fut] = await Promise.all([
    safeFetch("https://api.binance.com/api/v3/ticker/24hr"),
    safeFetch("https://fapi.binance.com/fapi/v1/ticker/24hr"),
  ]);
  const want = new Set(symbols);
  for (const list of [spot, fut]) {
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      const s = String(t.symbol || "").toUpperCase();
      if (!want.has(s) || out[s]) continue;
      const last = parseFloat(t.lastPrice);
      const pct = parseFloat(t.priceChangePercent);
      if (!Number.isFinite(last)) continue;
      out[s] = {
        lastPrice: last,
        price24hPcnt: Number.isFinite(pct) ? pct / 100 : null,
        exchange: "BINANCE",
      };
    }
  }
  return out;
}

async function fromBybit(symbols: string[]): Promise<Record<string, Row>> {
  const out: Record<string, Row> = {};
  const want = new Set(symbols);
  for (const category of ["spot", "linear"] as const) {
    const json = await safeFetch(
      `https://api.bybit.com/v5/market/tickers?category=${category}`
    );
    const list = json?.result?.list;
    if (!Array.isArray(list)) continue;
    for (const t of list) {
      const s = String(t.symbol || "").toUpperCase();
      if (!want.has(s) || out[s]) continue;
      const last = parseFloat(t.lastPrice);
      const pct = parseFloat(t.price24hPcnt);
      if (!Number.isFinite(last)) continue;
      out[s] = {
        lastPrice: last,
        price24hPcnt: Number.isFinite(pct) ? pct : null,
        exchange: "BYBIT",
      };
    }
  }
  return out;
}

async function fromLBank(symbols: string[]): Promise<Record<string, Row>> {
  const out: Record<string, Row> = {};
  // single call all tickers
  const json = await safeFetch("https://api.lbkex.com/v2/ticker/24hr.do");
  const list = Array.isArray(json) ? json : json?.data;
  if (!Array.isArray(list)) return out;
  const want = new Set(symbols);
  for (const t of list) {
    // symbol like btc_usdt
    const raw = String(t.symbol || t.pair || "").toLowerCase();
    const sym = raw.replace("_", "").toUpperCase();
    if (!want.has(sym) || out[sym]) continue;
    const last = parseFloat(t.ticker?.latest || t.latest || t.lastPrice || t.close);
    const pct = parseFloat(t.ticker?.change || t.change || t.priceChangePercent);
    if (!Number.isFinite(last)) continue;
    out[sym] = {
      lastPrice: last,
      price24hPcnt: Number.isFinite(pct) ? (Math.abs(pct) > 1 ? pct / 100 : pct) : null,
      exchange: "LBANK",
    };
  }
  return out;
}

async function fromBitunix(symbols: string[]): Promise<Record<string, Row>> {
  const out: Record<string, Row> = {};
  const want = symbols.filter((s) => !INDEX_SET.has(s));
  if (!want.length) return out;

  // futures tickers batch
  const fut = await safeFetch(
    `https://fapi.bitunix.com/api/v1/futures/market/tickers?symbols=${want.join(",")}`
  );
  for (const t of fut?.data || []) {
    const s = String(t.symbol || "").toUpperCase();
    if (out[s]) continue;
    const last = parseFloat(t.lastPrice || t.last);
    if (!Number.isFinite(last)) continue;
    const open = parseFloat(t.open);
    let pct: number | null = null;
    if (Number.isFinite(open) && open !== 0) pct = (last - open) / open;
    out[s] = { lastPrice: last, price24hPcnt: pct, exchange: "BITUNIX" };
  }

  // spot last price one-by-one for missing (cap 15)
  let n = 0;
  for (const s of want) {
    if (out[s] || n >= 15) continue;
    n++;
    const j = await safeFetch(
      `https://api.bitunix.com/api/spot/v1/market/last_price?symbol=${s}`
    );
    const last = parseFloat(j?.data?.price || j?.data?.last || j?.data);
    if (!Number.isFinite(last)) continue;
    out[s] = { lastPrice: last, price24hPcnt: null, exchange: "BITUNIX" };
  }
  return out;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const one = sp.get("symbol");
  const many = sp.get("symbols");
  const symbols = (
    many
      ? many.split(",")
      : one
      ? [one]
      : []
  )
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  if (!symbols.length) {
    return NextResponse.json({ ok: false, error: "symbol(s) required", data: {} });
  }

  try {
    const data: Record<string, Row> = {};
    const needIndex = symbols.some((s) => INDEX_SET.has(s));
    const coins = symbols.filter((s) => !INDEX_SET.has(s));

    const tasks: Promise<Record<string, Row>>[] = [];
    if (needIndex) tasks.push(indicesValues());
    if (coins.length) {
      tasks.push(fromBinance(coins));
      tasks.push(fromBybit(coins));
      tasks.push(fromLBank(coins));
      tasks.push(fromBitunix(coins));
    }

    const results = await Promise.allSettled(tasks);
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const [sym, row] of Object.entries(r.value)) {
        if (!symbols.includes(sym)) continue;
        if (!data[sym]) data[sym] = row;
      }
    }

    // single-symbol compatibility
    if (one && data[one.toUpperCase()]) {
      return NextResponse.json({
        ok: true,
        ...data[one.toUpperCase()],
        data: { [one.toUpperCase()]: data[one.toUpperCase()] },
      });
    }

    return NextResponse.json({ ok: true, data });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message || e), data: {} },
      { status: 200 }
    );
  }
}

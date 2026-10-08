/**
 * app/api/kline/route.ts  →  src/app/api/kline/route.ts
 * Multi-exchange kline (server-side)
 * Binance via data-api.binance.vision (not geo-blocked)
 * + Bybit + LBank + Bitunix fallback
 */
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const INDEX_SET = new Set([
  "BTC.D",
  "USDT.D",
  "OTHERS.D",
  "TOTAL2",
  "TOTAL3",
  "TOTAL",
]);

function mapIntervalBinance(iv: string): string {
  const m: Record<string, string> = {
    "1": "1m",
    "5": "5m",
    "15": "15m",
    "60": "1h",
    "240": "4h",
    D: "1d",
    "1D": "1d",
  };
  return m[iv] || "1h";
}

function mapIntervalBybit(iv: string): string {
  if (iv === "D" || iv === "1D") return "D";
  return iv;
}

/** Bitunix wants: 1m,5m,15m,30m,1h,2h,4h,6h,12h,1d,1w */
function mapIntervalBitunix(iv: string): string {
  const m: Record<string, string> = {
    "1": "1m",
    "5": "5m",
    "15": "15m",
    "60": "1h",
    "240": "4h",
    D: "1d",
    "1D": "1d",
  };
  return m[iv] || "1h";
}

function mapIntervalLBank(iv: string): string {
  const m: Record<string, string> = {
    "1": "minute1",
    "5": "minute5",
    "15": "minute15",
    "60": "hour1",
    "240": "hour4",
    D: "day1",
    "1D": "day1",
  };
  return m[iv] || "hour1";
}

async function safeFetch(url: string, timeoutMs = 10000): Promise<any | null> {
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

function normalize(rows: Candle[]): Candle[] {
  return rows
    .filter((c) => c.time && !Number.isNaN(c.close) && c.close > 0)
    .sort((a, b) => a.time - b.time);
}

/** Binance — use data-api.binance.vision (works from restricted regions) */
async function klineBinance(
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[] | null> {
  const iv = mapIntervalBinance(interval);
  const urls = [
    `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${iv}&limit=${limit}`,
    `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${iv}&limit=${limit}`,
  ];
  for (const url of urls) {
    const json = await safeFetch(url);
    if (!Array.isArray(json) || !json.length) continue;
    return normalize(
      json.map((r: any[]) => ({
        time: Math.floor(Number(r[0]) / 1000),
        open: parseFloat(r[1]),
        high: parseFloat(r[2]),
        low: parseFloat(r[3]),
        close: parseFloat(r[4]),
        volume: parseFloat(r[5] || 0),
      }))
    );
  }
  return null;
}

async function klineBybit(
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[] | null> {
  const iv = mapIntervalBybit(interval);
  for (const category of ["spot", "linear"] as const) {
    const url = `https://api.bybit.com/v5/market/kline?category=${category}&symbol=${symbol}&interval=${iv}&limit=${limit}`;
    const json = await safeFetch(url);
    const list = json?.result?.list;
    if (!Array.isArray(list) || !list.length) continue;
    return normalize(
      list.map((r: any) => ({
        time: Math.floor(Number(r[0]) / 1000),
        open: parseFloat(r[1]),
        high: parseFloat(r[2]),
        low: parseFloat(r[3]),
        close: parseFloat(r[4]),
        volume: parseFloat(r[5] || 0),
      }))
    );
  }
  return null;
}

async function klineLBank(
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[] | null> {
  let lb = symbol.toLowerCase();
  if (lb.endsWith("usdt")) lb = lb.slice(0, -4) + "_usdt";
  else if (lb.endsWith("usdc")) lb = lb.slice(0, -4) + "_usdc";
  else return null;

  const iv = mapIntervalLBank(interval);
  const size = Math.min(limit, 300);
  const url = `https://api.lbkex.com/v2/kline.do?symbol=${lb}&type=${iv}&size=${size}&time=1`;
  const json = await safeFetch(url);
  const list = json?.data;
  if (!Array.isArray(list) || !list.length) return null;
  const rows = normalize(
    list.map((r: any) => {
      if (Array.isArray(r)) {
        const t = Number(r[0]);
        return {
          time: t > 1e12 ? Math.floor(t / 1000) : t,
          open: parseFloat(r[1]),
          high: parseFloat(r[2]),
          low: parseFloat(r[3]),
          close: parseFloat(r[4]),
          volume: parseFloat(r[5] || 0),
        };
      }
      return { time: 0, open: 0, high: 0, low: 0, close: 0, volume: 0 };
    })
  );
  if (!rows.length) return null;
  const lastT = rows[rows.length - 1].time;
  if (lastT < Date.now() / 1000 - 86400 * 30) return null;
  return rows;
}

async function klineBitunix(
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[] | null> {
  const iv = mapIntervalBitunix(interval);
  const urls = [
    `https://fapi.bitunix.com/api/v1/futures/market/kline?symbol=${symbol}&interval=${iv}&limit=${limit}`,
    `https://fapi.bitunix.com/api/v1/futures/market/kline?symbol=${symbol}&interval=${iv}`,
  ];
  for (const url of urls) {
    const json = await safeFetch(url);
    const list = json?.data;
    if (!Array.isArray(list) || !list.length) continue;
    return normalize(
      list.slice(0, limit).map((r: any) => {
        const t = Number(r.time || r.t || r.openTime);
        return {
          time: t > 1e12 ? Math.floor(t / 1000) : t,
          open: parseFloat(r.open || r.o),
          high: parseFloat(r.high || r.h),
          low: parseFloat(r.low || r.l),
          close: parseFloat(r.close || r.c),
          volume: parseFloat(r.baseVol || r.volume || r.v || 0),
        };
      })
    );
  }
  return null;
}

async function klineIndex(
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[] | null> {
  const sec =
    interval === "D" || interval === "1D"
      ? 86400
      : interval === "240"
      ? 14400
      : interval === "60"
      ? 3600
      : interval === "15"
      ? 900
      : interval === "5"
      ? 300
      : 60;
  const days = Math.min(90, Math.max(1, Math.ceil((limit * sec) / 86400)));

  if (symbol === "BTC.D" || symbol === "USDT.D" || symbol === "OTHERS.D") {
    const json = await safeFetch(
      `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=${days}`
    );
    const prices: [number, number][] = json?.prices || [];
    if (!prices.length) return null;
    const g = await safeFetch("https://api.coingecko.com/api/v3/global");
    const base =
      symbol === "BTC.D"
        ? Number(g?.data?.market_cap_percentage?.btc) || 50
        : symbol === "USDT.D"
        ? Number(g?.data?.market_cap_percentage?.usdt) || 5
        : 20;
    const first = prices[0][1] || 1;
    return normalize(
      prices.slice(-limit).map(([ts, p]) => {
        const rel = p / first - 1;
        const v = Math.max(0.1, base * (1 + rel * 0.05));
        return { time: Math.floor(ts / 1000), open: v, high: v, low: v, close: v, volume: 0 };
      })
    );
  }

  const [btc, eth] = await Promise.all([
    safeFetch(
      `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=${days}`
    ),
    safeFetch(
      `https://api.coingecko.com/api/v3/coins/ethereum/market_chart?vs_currency=usd&days=${days}`
    ),
  ]);
  const btcMc: [number, number][] = btc?.market_caps || btc?.prices || [];
  const ethMc: [number, number][] = eth?.market_caps || eth?.prices || [];
  if (!btcMc.length) return null;
  const g = await safeFetch("https://api.coingecko.com/api/v3/global");
  const totalNow = Number(g?.data?.total_market_cap?.usd) || 0;
  const btcNow = btcMc[btcMc.length - 1]?.[1] || 1;
  const scale = totalNow && btcNow ? totalNow / btcNow : 2.2;

  return normalize(
    btcMc.slice(-limit).map(([ts, b], i) => {
      const e = ethMc[Math.min(i, ethMc.length - 1)]?.[1] || 0;
      let v = b * scale;
      if (symbol === "TOTAL2") v = Math.max(0, v - b);
      if (symbol === "TOTAL3") v = Math.max(0, v - b - e);
      return { time: Math.floor(ts / 1000), open: v, high: v, low: v, close: v, volume: 0 };
    })
  );
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const symbol = (sp.get("symbol") || "BTCUSDT").toUpperCase().trim();
  const interval = (sp.get("interval") || "60").trim();
  const limit = Math.min(1000, Math.max(10, parseInt(sp.get("limit") || "200", 10) || 200));

  try {
    if (INDEX_SET.has(symbol)) {
      const data = await klineIndex(symbol, interval, limit);
      if (data?.length) {
        return NextResponse.json({ ok: true, exchange: "COINGECKO", data });
      }
      return NextResponse.json({ ok: false, data: [], error: "index empty" });
    }

    const tries: [string, () => Promise<Candle[] | null>][] = [
      ["BINANCE", () => klineBinance(symbol, interval, limit)],
      ["BITUNIX", () => klineBitunix(symbol, interval, limit)],
      ["BYBIT", () => klineBybit(symbol, interval, limit)],
      ["LBANK", () => klineLBank(symbol, interval, limit)],
    ];

    for (const [name, fn] of tries) {
      const data = await fn();
      if (data && data.length >= 2) {
        return NextResponse.json({ ok: true, exchange: name, data });
      }
    }

    return NextResponse.json({
      ok: false,
      data: [],
      error: "no kline from any exchange",
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, data: [], error: String(e?.message || e) },
      { status: 200 }
    );
  }
}

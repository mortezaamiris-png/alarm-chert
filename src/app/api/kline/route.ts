/**
 * /api/kline — fast path for live chart
 * Edge runtime + Binance Vision first
 * Place at: src/app/api/kline/route.ts
 */
import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";
export const dynamic = "force-dynamic";

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/** Map UI interval codes → Binance interval strings */
function mapIntervalBinance(iv: string): string {
  const m: Record<string, string> = {
    "1": "1m",
    "5": "5m",
    "15": "15m",
    "60": "1h",
    "120": "2h",
    "240": "4h",
    D: "1d",
    "1D": "1d",
    W: "1w",
    "1W": "1w",
    M: "1M",
    "1M": "1M",
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "1h": "1h",
    "2h": "2h",
    "4h": "4h",
  };
  return m[iv] || "1m";
}

/** Map UI interval codes → OKX bar strings */
function mapIntervalOkx(iv: string): string {
  const m: Record<string, string> = {
    "1": "1m",
    "5": "5m",
    "15": "15m",
    "60": "1H",
    "120": "2H",
    "240": "4H",
    D: "1D",
    "1D": "1D",
    W: "1W",
    "1W": "1W",
    M: "1M",
    "1M": "1M",
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "1h": "1H",
    "2h": "2H",
    "4h": "4H",
  };
  return m[iv] || "1m";
}

async function fetchVision(
  symbol: string,
  interval: string,
  limit: number,
  endTimeSec?: number
): Promise<Candle[] | null> {
  const iv = mapIntervalBinance(interval);
  let url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${iv}&limit=${limit}`;
  // Binance expects milliseconds
  if (endTimeSec != null && endTimeSec > 0) {
    url += `&endTime=${endTimeSec * 1000}`;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const arr = await res.json();
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr.map((r: any) => ({
      time: Math.floor(Number(r[0]) / 1000),
      open: parseFloat(r[1]),
      high: parseFloat(r[2]),
      low: parseFloat(r[3]),
      close: parseFloat(r[4]),
      volume: parseFloat(r[5] || 0),
    }));
  } catch {
    return null;
  }
}

async function fetchOkx(
  symbol: string,
  interval: string,
  limit: number,
  endTimeSec?: number
): Promise<Candle[] | null> {
  const bar = mapIntervalOkx(interval);
  const inst = `${symbol.replace("USDT", "")}-USDT`;
  let url = `https://www.okx.com/api/v5/market/candles?instId=${inst}&bar=${bar}&limit=${limit}`;
  // OKX: after = older than this timestamp (ms)
  if (endTimeSec != null && endTimeSec > 0) {
    url += `&after=${endTimeSec * 1000}`;
  }
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const arr = j?.data;
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr
      .map((r: any) => ({
        time: Math.floor(Number(r[0]) / 1000),
        open: parseFloat(r[1]),
        high: parseFloat(r[2]),
        low: parseFloat(r[3]),
        close: parseFloat(r[4]),
        volume: parseFloat(r[5] || 0),
      }))
      .reverse();
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const symbol = (sp.get("symbol") || "BTCUSDT")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const interval = sp.get("interval") || "1";
  const limit = Math.min(
    Math.max(parseInt(sp.get("limit") || "500", 10) || 500, 1),
    1000
  );
  const endTimeRaw = sp.get("endTime");
  const endTimeSec =
    endTimeRaw != null && endTimeRaw !== ""
      ? Math.floor(Number(endTimeRaw))
      : undefined;
  const endArg =
    endTimeSec != null && Number.isFinite(endTimeSec) && endTimeSec > 0
      ? endTimeSec
      : undefined;

  // live tick: فقط Vision
  if (limit <= 10) {
    const data = await fetchVision(symbol, interval, limit, endArg);
    if (data) {
      return NextResponse.json(data, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    const okx = await fetchOkx(symbol, interval, limit, endArg);
    if (okx)
      return NextResponse.json(okx, {
        headers: { "Cache-Control": "no-store" },
      });
    return NextResponse.json({ error: "no data" }, { status: 502 });
  }

  let data = await fetchVision(symbol, interval, limit, endArg);
  if (!data) data = await fetchOkx(symbol, interval, limit, endArg);
  if (!data) {
    return NextResponse.json({ error: "no data" }, { status: 502 });
  }
  return NextResponse.json(data, {
    headers: { "Cache-Control": "no-store" },
  });
}

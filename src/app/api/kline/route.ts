/**
 * /api/kline — fast path for live chart
 * Edge runtime + Binance Vision first
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

function mapInterval(iv: string): string {
  const m: Record<string, string> = {
    "1": "1m",
    "5": "5m",
    "15": "15m",
    "60": "1h",
    "240": "4h",
    D: "1d",
    "1D": "1d",
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "1h": "1h",
    "4h": "4h",
  };
  return m[iv] || "1m";
}

async function fetchVision(
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[] | null> {
  const iv = mapInterval(interval);
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${iv}&limit=${limit}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
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
  limit: number
): Promise<Candle[] | null> {
  const m: Record<string, string> = {
    "1": "1m",
    "5": "5m",
    "15": "15m",
    "60": "1H",
    "240": "4H",
    D: "1D",
    "1D": "1D",
    "1m": "1m",
    "5m": "5m",
    "15m": "15m",
    "1h": "1H",
    "4h": "4H",
  };
  const bar = m[interval] || "1m";
  const inst = `${symbol.replace("USDT", "")}-USDT`;
  const url = `https://www.okx.com/api/v5/market/candles?instId=${inst}&bar=${bar}&limit=${limit}`;
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(6000),
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

  // live tick: فقط Vision
  if (limit <= 10) {
    const data = await fetchVision(symbol, interval, limit);
    if (data) {
      return NextResponse.json(data, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    const okx = await fetchOkx(symbol, interval, limit);
    if (okx)
      return NextResponse.json(okx, {
        headers: { "Cache-Control": "no-store" },
      });
    return NextResponse.json({ error: "no data" }, { status: 502 });
  }

  let data = await fetchVision(symbol, interval, limit);
  if (!data) data = await fetchOkx(symbol, interval, limit);
  if (!data) {
    return NextResponse.json({ error: "no data" }, { status: 502 });
  }
  return NextResponse.json(data, {
    headers: { "Cache-Control": "no-store" },
  });
}

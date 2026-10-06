import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  value: number;
  volume: number;
};

function toBinanceInterval(interval: string) {
  const map: Record<string, string> = {
    "1": "1m",
    "5": "5m",
    "15": "15m",
    "60": "1h",
    "120": "2h",
    "240": "4h",
    D: "1d",
    W: "1w",
    M: "1M",
  };
  return map[interval] || "1h";
}

function toOkxBar(interval: string) {
  const map: Record<string, string> = {
    "1": "1m",
    "5": "5m",
    "15": "15m",
    "60": "1H",
    "120": "2H",
    "240": "4H",
    D: "1D",
    W: "1W",
    M: "1M",
  };
  return map[interval] || "1H";
}

async function fromBybit(
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[] | null> {
  for (const category of ["spot", "linear"] as const) {
    try {
      const res = await fetch(
        `https://api.bybit.com/v5/market/kline?category=${category}&symbol=${symbol}&interval=${interval}&limit=${limit}`,
        { cache: "no-store", headers: { Accept: "application/json" } }
      );
      if (!res.ok) continue;
      const data = await res.json();
      const list = data?.result?.list;
      if (!list?.length) continue;
      // Bybit: [start, open, high, low, close, volume, turnover]
      return list
        .map((item: any) => ({
          time: Math.floor(Number(item[0]) / 1000),
          open: parseFloat(item[1]),
          high: parseFloat(item[2]),
          low: parseFloat(item[3]),
          close: parseFloat(item[4]),
          value: parseFloat(item[4]),
          volume: parseFloat(item[5] || "0"),
        }))
        .reverse();
    } catch {
      /* next */
    }
  }
  return null;
}

async function fromBinance(
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[] | null> {
  try {
    const bi = toBinanceInterval(interval);
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${bi}&limit=${limit}`,
      { cache: "no-store", headers: { Accept: "application/json" } }
    );
    if (!res.ok) return null;
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) return null;
    // Binance: [openTime, o, h, l, c, volume, ...]
    return list.map((item: any) => ({
      time: Math.floor(Number(item[0]) / 1000),
      open: parseFloat(item[1]),
      high: parseFloat(item[2]),
      low: parseFloat(item[3]),
      close: parseFloat(item[4]),
      value: parseFloat(item[4]),
      volume: parseFloat(item[5] || "0"),
    }));
  } catch {
    return null;
  }
}

async function fromOkx(
  symbol: string,
  interval: string,
  limit: number
): Promise<Candle[] | null> {
  try {
    const instId = symbol.replace(/USDT$/i, "-USDT").replace(/USDC$/i, "-USDC");
    const bar = toOkxBar(interval);
    const res = await fetch(
      `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`,
      { cache: "no-store", headers: { Accept: "application/json" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const list = data?.data;
    if (!Array.isArray(list) || !list.length) return null;
    // OKX: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm] newest first
    return list
      .map((item: any) => ({
        time: Math.floor(Number(item[0]) / 1000),
        open: parseFloat(item[1]),
        high: parseFloat(item[2]),
        low: parseFloat(item[3]),
        close: parseFloat(item[4]),
        value: parseFloat(item[4]),
        volume: parseFloat(item[5] || "0"),
      }))
      .reverse();
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  try {
    const symbol = (req.nextUrl.searchParams.get("symbol") || "")
      .trim()
      .toUpperCase();
    const interval = req.nextUrl.searchParams.get("interval") || "60";
    const limit = Math.min(
      parseInt(req.nextUrl.searchParams.get("limit") || "200", 10) || 200,
      500
    );

    if (!symbol) {
      return NextResponse.json({ error: "symbol required" }, { status: 400 });
    }

    const rows =
      (await fromBybit(symbol, interval, limit)) ||
      (await fromBinance(symbol, interval, limit)) ||
      (await fromOkx(symbol, interval, limit));

    if (!rows) {
      return NextResponse.json(
        { ok: false, error: "no data from any exchange" },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { ok: true, data: rows },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "failed" },
      { status: 500 }
    );
  }
}

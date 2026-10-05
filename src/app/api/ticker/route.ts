import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type TickerResult = {
  lastPrice: number;
  price24hPcnt: number;
  source: string;
};

async function fromBybit(symbol: string): Promise<TickerResult | null> {
  for (const category of ["spot", "linear"] as const) {
    try {
      const res = await fetch(
        `https://api.bybit.com/v5/market/tickers?category=${category}&symbol=${symbol}`,
        { cache: "no-store", headers: { Accept: "application/json" } }
      );
      if (!res.ok) continue;
      const data = await res.json();
      const row = data?.result?.list?.[0];
      if (!row?.lastPrice) continue;
      return {
        lastPrice: parseFloat(row.lastPrice),
        price24hPcnt: parseFloat(row.price24hPcnt || "0"),
        source: `bybit-${category}`,
      };
    } catch {
      /* next */
    }
  }
  return null;
}

async function fromBinance(symbol: string): Promise<TickerResult | null> {
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`,
      { cache: "no-store", headers: { Accept: "application/json" } }
    );
    if (!res.ok) return null;
    const row = await res.json();
    if (!row?.lastPrice) return null;
    return {
      lastPrice: parseFloat(row.lastPrice),
      price24hPcnt: parseFloat(row.priceChangePercent || "0") / 100,
      source: "binance",
    };
  } catch {
    return null;
  }
}

async function fromOkx(symbol: string): Promise<TickerResult | null> {
  try {
    // OKX uses BTC-USDT format
    const instId = symbol.replace(/USDT$/i, "-USDT").replace(/USDC$/i, "-USDC");
    const res = await fetch(
      `https://www.okx.com/api/v5/market/ticker?instId=${instId}`,
      { cache: "no-store", headers: { Accept: "application/json" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const row = data?.data?.[0];
    if (!row?.last) return null;
    const last = parseFloat(row.last);
    const open24h = parseFloat(row.open24h || row.sodUtc0 || "0");
    const pct = open24h > 0 ? (last - open24h) / open24h : 0;
    return {
      lastPrice: last,
      price24hPcnt: pct,
      source: "okx",
    };
  } catch {
    return null;
  }
}

async function getTicker(symbol: string): Promise<TickerResult | null> {
  return (
    (await fromBybit(symbol)) ||
    (await fromBinance(symbol)) ||
    (await fromOkx(symbol))
  );
}

export async function GET(req: NextRequest) {
  try {
    const symbolsParam = req.nextUrl.searchParams.get("symbols") || "";
    const symbols = symbolsParam
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 40);

    if (!symbols.length) {
      return NextResponse.json({ error: "symbols required" }, { status: 400 });
    }

    const results: Record<string, TickerResult> = {};

    await Promise.all(
      symbols.map(async (sym) => {
        const data = await getTicker(sym);
        if (data) results[sym] = data;
      })
    );

    return NextResponse.json(
      { ok: true, data: results },
      { headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "failed" },
      { status: 500 }
    );
  }
}

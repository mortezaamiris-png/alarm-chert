/**
 * app/api/market-indices/route.ts
 * BTC.D, USDT.D, OTHERS.D, TOTAL2, TOTAL3 via CoinGecko (server-side, no Iran IP issue)
 */
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/global", {
      headers: { Accept: "application/json" },
      next: { revalidate: 60 },
    });
    if (!res.ok) throw new Error(`coingecko ${res.status}`);
    const json = await res.json();
    const d = json?.data || {};
    const pct = d.market_cap_percentage || {};
    const totalUsd = Number(d.total_market_cap?.usd) || 0;

    const btcD = Number(pct.btc) || 0;
    const ethD = Number(pct.eth) || 0;
    const usdtD = Number(pct.usdt) || 0;
    const othersD = Math.max(0, 100 - btcD - ethD - usdtD);

    // TOTAL2 ≈ total market cap excluding BTC
    // TOTAL3 ≈ total market cap excluding BTC + ETH
    const total2 = totalUsd * (1 - btcD / 100);
    const total3 = totalUsd * (1 - btcD / 100 - ethD / 100);

    return NextResponse.json({
      ok: true,
      data: {
        "BTC.D": { value: btcD, unit: "%", label: "Bitcoin Dominance" },
        "USDT.D": { value: usdtD, unit: "%", label: "Tether Dominance" },
        "OTHERS.D": { value: othersD, unit: "%", label: "Others Dominance" },
        TOTAL2: { value: total2, unit: "USD", label: "Total excl. BTC" },
        TOTAL3: { value: total3, unit: "USD", label: "Total excl. BTC+ETH" },
        TOTAL: { value: totalUsd, unit: "USD", label: "Total Market Cap" },
      },
      updatedAt: d.updated_at || Math.floor(Date.now() / 1000),
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message || e) },
      { status: 200 }
    );
  }
}

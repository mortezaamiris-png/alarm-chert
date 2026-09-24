"use client";

import { useEffect, useRef } from "react";

export default function DashboardPage() {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;

    // Clear previous widget if any
    container.current.innerHTML = "";

    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.type = "text/javascript";
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: "BINANCE:BTCUSDT",
      interval: "60",
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "en",
      enable_publishing: false,
      backgroundColor: "rgba(15, 15, 15, 1)",
      gridColor: "rgba(42, 46, 57, 0.6)",
      hide_top_toolbar: false,
      hide_legend: false,
      save_image: true,
      calendar: false,
      hide_volume: false,
      support_host: "https://www.tradingview.com",
      allow_symbol_change: true,
      details: true,
      hotlist: true,
      studies: ["STD;SMA", "STD;RSI"],
    });

    container.current.appendChild(script);

    return () => {
      if (container.current) {
        container.current.innerHTML = "";
      }
    };
  }, []);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">Live Crypto Charts</h1>
        <p className="text-gray-400">
          Professional TradingView charts. Change the symbol using the search box inside the chart.
        </p>
      </div>

      {/* Chart Container */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden" style={{ height: "700px" }}>
        <div
          className="tradingview-widget-container"
          ref={container}
          style={{ height: "100%", width: "100%" }}
        >
          <div className="tradingview-widget-container__widget" style={{ height: "calc(100% - 32px)", width: "100%" }}></div>
        </div>
      </div>

      <div className="mt-6 text-center text-sm text-gray-500">
        Charts are provided by{" "}
        <a
          href="https://www.tradingview.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-orange-400 hover:underline"
        >
          TradingView
        </a>
      </div>
    </div>
  );
}

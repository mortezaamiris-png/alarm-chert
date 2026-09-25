"use client";

import { useEffect, useRef } from "react";

export default function DashboardPage() {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;

    // پاک کردن ویجت قبلی
    container.current.innerHTML = "";

    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.type = "text/javascript";
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: "BINANCE:BTCUSDT",
      interval: "60",
      timezone: "Asia/Tehran",
      theme: "dark",
      style: "1",
      locale: "en",
      enable_publishing: false,
      backgroundColor: "rgba(15, 15, 15, 1)",
      gridColor: "rgba(42, 46, 57, 0.6)",
      hide_top_toolbar: false,
      hide_legend: false,
      hide_side_toolbar: false,        // ← این خط مهمه (ابزارهای سمت چپ)
      allow_symbol_change: true,
      details: true,
      hotlist: true,
      calendar: false,
      save_image: true,
      withdateranges: true,
      hide_volume: false,
      support_host: "https://www.tradingview.com",
      studies: [
        "STD;SMA",
        "STD;RSI",
        "STD;MACD"
      ],
      // فعال کردن ابزارهای رسم
      drawings_access: {
        type: "all",
        tools: [
          { name: "Regression Trend" },
          { name: "Trend Line" },
          { name: "Ray" },
          { name: "Extended Line" },
          { name: "Horizontal Line" },
          { name: "Vertical Line" },
          { name: "Cross Line" },
          { name: "Parallel Channel" },
          { name: "Fibonacci Retracement" },
          { name: "Fibonacci Extension" },
          { name: "Long Position" },   // Risk/Reward
          { name: "Short Position" },  // Risk/Reward
          { name: "Rectangle" },
          { name: "Text" },
          { name: "Arrow" }
        ]
      }
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
          ابزارهای کامل TradingView فعال است. می‌تونی خط بکشی، Risk/Reward بزنی و از همه ابزارها استفاده کنی.
        </p>
      </div>

      <div 
        className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden" 
        style={{ height: "800px" }}
      >
        <div
          className="tradingview-widget-container"
          ref={container}
          style={{ height: "100%", width: "100%" }}
        >
          <div 
            className="tradingview-widget-container__widget" 
            style={{ height: "calc(100% - 32px)", width: "100%" }}
          ></div>
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

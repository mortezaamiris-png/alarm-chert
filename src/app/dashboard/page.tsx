"use client";

import { useEffect, useRef, useState } from "react";
import { createChart, IChartApi, ISeriesApi, LineStyle } from "lightweight-charts";
import { supabase } from "@/lib/supabase";
import Link from "next/link";

interface ChartLine {
  id: string;
  symbol: string;
  price: number;
  color: string;
}

export default function DashboardPage() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [lines, setLines] = useState<ChartLine[]>([]);
  const [selectedPrice, setSelectedPrice] = useState<number | null>(null);
  const [drawMode, setDrawMode] = useState(false);
  const priceLinesRef = useRef<Map<string, any>>(new Map());

  const fetchCandles = async (sym: string) => {
    try {
      const res = await fetch(
        `https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=60&limit=200`
      );
      const data = await res.json();
      if (data.result?.list) {
        return data.result.list
          .map((item: any) => ({
            time: Number(item[0]) / 1000,
            open: parseFloat(item[1]),
            high: parseFloat(item[2]),
            low: parseFloat(item[3]),
            close: parseFloat(item[4]),
          }))
          .reverse();
      }
      return [];
    } catch (e) {
      console.error("Candle fetch error:", e);
      return [];
    }
  };

  const fetchLines = async (sym: string) => {
    const { data } = await supabase
      .from("chart_lines")
      .select("*")
      .eq("symbol", sym)
      .order("created_at", { ascending: false });
    setLines(data || []);
  };

  const addLine = async (price: number) => {
    const { data, error } = await supabase
      .from("chart_lines")
      .insert([{ symbol, price, color: "#f97316" }])
      .select()
      .single();

    if (error) {
      alert("خطا در ذخیره خط: " + error.message);
      return;
    }
    setLines((prev) => [data, ...prev]);
    setSelectedPrice(null);
    setDrawMode(false);
  };

  const deleteLine = async (id: string) => {
    await supabase.from("chart_lines").delete().eq("id", id);
    setLines((prev) => prev.filter((l) => l.id !== id));

    const priceLine = priceLinesRef.current.get(id);
    if (priceLine && candleSeriesRef.current) {
      candleSeriesRef.current.removePriceLine(priceLine);
      priceLinesRef.current.delete(id);
    }
  };

  const createAlarmFromLine = (price: number) => {
    window.location.href = `/alerts?price=${price}&symbol=${symbol}`;
  };

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { color: "#0f0f0f" },
        textColor: "#d1d5db",
      },
      grid: {
        vertLines: { color: "#1f2937" },
        horzLines: { color: "#1f2937" },
      },
      width: chartContainerRef.current.clientWidth,
      height: 600,
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: {
        vertTouchDrag: true,
        horzTouchDrag: true,
        mouseWheel: true,
        pressedMouseMove: true,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;

    chart.subscribeClick((param) => {
      if (!param.point || !candleSeries) return;
      const price = candleSeries.coordinateToPrice(param.point.y);
      if (price) {
        setSelectedPrice(Number(price.toFixed(2)));
      }
    });

    const loadData = async () => {
      const candles = await fetchCandles(symbol);
      if (candles.length > 0) {
        candleSeries.setData(candles);
        chart.timeScale().fitContent();
      }
      await fetchLines(symbol);
    };

    loadData();

    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      chart.remove();
    };
  }, [symbol]);

  useEffect(() => {
    if (!candleSeriesRef.current) return;

    priceLinesRef.current.forEach((pl) => {
      candleSeriesRef.current?.removePriceLine(pl);
    });
    priceLinesRef.current.clear();

    lines.forEach((line) => {
      const priceLine = candleSeriesRef.current!.createPriceLine({
        price: line.price,
        color: line.color || "#f97316",
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: `${line.price}`,
      });
      priceLinesRef.current.set(line.id, priceLine);
    });
  }, [lines]);

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
        <div>
          <h1 className="text-2xl font-bold">چارت زنده</h1>
          <p className="text-gray-400 text-sm mt-1">
            اول دکمه «کشیدن خط» رو بزن، بعد روی چارت کلیک کن
          </p>
        </div>

        <div className="flex items-center gap-3">
          <input
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white w-32"
            placeholder="BTCUSDT"
          />
          <Link
            href="/alerts"
            className="bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-lg text-sm"
          >
            صفحه آلارم‌ها
          </Link>
        </div>
      </div>

      {/* نوار ابزار */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          onClick={() => {
            setDrawMode(!drawMode);
            setSelectedPrice(null);
          }}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
            drawMode
              ? "bg-orange-500 text-white"
              : "bg-gray-800 text-gray-300 hover:bg-gray-700"
          }`}
        >
          {drawMode ? "✕ خروج از حالت کشیدن" : "✏️ کشیدن خط"}
        </button>

        {drawMode && (
          <span className="text-sm text-orange-400">
            روی چارت کلیک کن تا خط کشیده بشه
          </span>
        )}
      </div>

      {/* باکس قیمت انتخاب شده */}
      {selectedPrice && (
        <div className="mb-4 p-4 bg-gray-900 border border-orange-500/50 rounded-xl flex flex-wrap items-center gap-3">
          <span className="text-orange-400 font-medium">
            قیمت انتخاب شده: {selectedPrice.toLocaleString()}
          </span>
          <button
            onClick={() => addLine(selectedPrice)}
            className="bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-lg text-sm"
          >
            تأیید و کشیدن خط
          </button>
          <button
            onClick={() => createAlarmFromLine(selectedPrice)}
            className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg text-sm"
          >
            ساخت آلارم
          </button>
          <button
            onClick={() => setSelectedPrice(null)}
            className="text-gray-400 hover:text-white text-sm"
          >
            انصراف
          </button>
        </div>
      )}

      {/* چارت */}
      <div
        ref={chartContainerRef}
        className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden"
        style={{ height: "600px", touchAction: "none" }}
        onWheel={(e) => e.stopPropagation()}
      />

      {/* لیست خط‌ها */}
      {lines.length > 0 && (
        <div className="mt-6">
          <h2 className="text-lg font-semibold mb-3">خط‌های ذخیره شده</h2>
          <div className="space-y-2">
            {lines.map((line) => (
              <div
                key={line.id}
                className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-lg px-4 py-3"
              >
                <span>
                  {symbol} @{" "}
                  <span className="text-orange-400">{line.price.toLocaleString()}</span>
                </span>
                <div className="flex gap-3">
                  <button
                    onClick={() => createAlarmFromLine(line.price)}
                    className="text-green-400 hover:text-green-300 text-sm"
                  >
                    آلارم
                  </button>
                  <button
                    onClick={() => deleteLine(line.id)}
                    className="text-red-400 hover:text-red-300 text-sm"
                  >
                    حذف
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

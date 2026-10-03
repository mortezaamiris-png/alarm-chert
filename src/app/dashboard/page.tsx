"use client";

import { useEffect, useRef, useState } from "react";
import { createChart, IChartApi, ISeriesApi, LineStyle, IPriceLine } from "lightweight-charts";
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
  const previewLineRef = useRef<IPriceLine | null>(null);

  const [symbol, setSymbol] = useState("BTCUSDT");
  const [lines, setLines] = useState<ChartLine[]>([]);
  const [drawMode, setDrawMode] = useState(false);
  const [previewPrice, setPreviewPrice] = useState<number | null>(null);
  const priceLinesRef = useRef<Map<string, IPriceLine>>(new Map());

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
      console.error(e);
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
      alert("خطا در ذخیره خط");
      return;
    }
    setLines((prev) => [data, ...prev]);
    setDrawMode(false);
    setPreviewPrice(null);
    if (previewLineRef.current && candleSeriesRef.current) {
      candleSeriesRef.current.removePriceLine(previewLineRef.current);
      previewLineRef.current = null;
    }
  };

  const deleteLine = async (id: string) => {
    await supabase.from("chart_lines").delete().eq("id", id);
    setLines((prev) => prev.filter((l) => l.id !== id));
    const pl = priceLinesRef.current.get(id);
    if (pl && candleSeriesRef.current) {
      candleSeriesRef.current.removePriceLine(pl);
      priceLinesRef.current.delete(id);
    }
  };

  const createAlarm = (price: number) => {
    window.location.href = `/alerts?price=${price}&symbol=${symbol}`;
  };

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: { background: { color: "#0f0f0f" }, textColor: "#d1d5db" },
      grid: { vertLines: { color: "#1f2937" }, horzLines: { color: "#1f2937" } },
      width: chartContainerRef.current.clientWidth,
      height: 600,
      timeScale: { timeVisible: true, secondsVisible: false },
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
      crosshair: {
        mode: 0, // Normal
        horzLine: {
          visible: true,
          labelVisible: true,
          style: LineStyle.Dashed,
          width: 1,
          color: "#f97316",
        },
        vertLine: {
          visible: true,
          labelVisible: false,
          style: LineStyle.Dashed,
          width: 1,
          color: "#6b7280",
        },
      },
    });

    const series = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });

    chartRef.current = chart;
    candleSeriesRef.current = series;

    // حرکت موس / لمس برای پیش‌نمایش خط
    chart.subscribeCrosshairMove((param) => {
      if (!drawMode || !param.point || !series) return;

      const price = series.coordinateToPrice(param.point.y);
      if (price === null) return;

      const rounded = Number(price.toFixed(2));
      setPreviewPrice(rounded);

      // خط پیش‌نمایش
      if (previewLineRef.current) {
        series.removePriceLine(previewLineRef.current);
      }
      previewLineRef.current = series.createPriceLine({
        price: rounded,
        color: "#f97316",
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "پیش‌نمایش",
      });
    });

    // کلیک برای تأیید خط
    chart.subscribeClick(() => {
      if (drawMode && previewPrice !== null) {
        // قیمت الان در previewPrice هست
      }
    });

    const load = async () => {
      const candles = await fetchCandles(symbol);
      if (candles.length) {
        series.setData(candles);
        chart.timeScale().fitContent();
      }
      await fetchLines(symbol);
    };
    load();

    const onResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
    };
  }, [symbol, drawMode]);

  // رسم خط‌های ذخیره شده
  useEffect(() => {
    if (!candleSeriesRef.current) return;

    priceLinesRef.current.forEach((pl) => {
      candleSeriesRef.current?.removePriceLine(pl);
    });
    priceLinesRef.current.clear();

    lines.forEach((line) => {
      const pl = candleSeriesRef.current!.createPriceLine({
        price: line.price,
        color: line.color || "#f97316",
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: String(line.price),
      });
      priceLinesRef.current.set(line.id, pl);
    });
  }, [lines]);

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
        <div>
          <h1 className="text-2xl font-bold">چارت زنده</h1>
          <p className="text-gray-400 text-sm mt-1">
            دکمه مداد رو بزن، بعد موس یا انگشت رو روی چارت حرکت بده
          </p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white w-32"
          />
          <Link href="/alerts" className="bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-lg text-sm">
            صفحه آلارم‌ها
          </Link>
        </div>
      </div>

      {/* ابزار */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          onClick={() => {
            setDrawMode(!drawMode);
            setPreviewPrice(null);
            if (previewLineRef.current && candleSeriesRef.current) {
              candleSeriesRef.current.removePriceLine(previewLineRef.current);
              previewLineRef.current = null;
            }
          }}
          className={`px-4 py-2 rounded-lg text-sm font-medium ${
            drawMode ? "bg-orange-500 text-white" : "bg-gray-800 text-gray-300"
          }`}
        >
          {drawMode ? "✕ خروج از حالت کشیدن" : "✏️ کشیدن خط"}
        </button>

        {drawMode && previewPrice !== null && (
          <>
            <span className="text-orange-400 text-sm">
              قیمت: {previewPrice.toLocaleString()}
            </span>
            <button
              onClick={() => addLine(previewPrice)}
              className="bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-lg text-sm"
            >
              تأیید خط
            </button>
            <button
              onClick={() => createAlarm(previewPrice)}
              className="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg text-sm"
            >
              ساخت آلارم
            </button>
          </>
        )}
      </div>

      <div
        ref={chartContainerRef}
        className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden"
        style={{ height: "600px", touchAction: "none" }}
      />

      {lines.length > 0 && (
        <div className="mt-6">
          <h2 className="text-lg font-semibold mb-3">خط‌های ذخیره شده</h2>
          <div className="space-y-2">
            {lines.map((line) => (
              <div key={line.id} className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
                <span>
                  {symbol} @ <span className="text-orange-400">{line.price.toLocaleString()}</span>
                </span>
                <div className="flex gap-3">
                  <button onClick={() => createAlarm(line.price)} className="text-green-400 text-sm">آلارم</button>
                  <button onClick={() => deleteLine(line.id)} className="text-red-400 text-sm">حذف</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

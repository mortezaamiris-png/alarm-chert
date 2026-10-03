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
  note?: string | null;
}

const TIMEFRAMES = [
  { label: "1m", value: "1" },
  { label: "5m", value: "5" },
  { label: "15m", value: "15" },
  { label: "1h", value: "60" },
  { label: "4h", value: "240" },
  { label: "1D", value: "D" },
];

const COLORS = ["#f97316", "#22c55e", "#3b82f6", "#eab308", "#ef4444", "#a855f7"];

export default function DashboardPage() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const previewLineRef = useRef<IPriceLine | null>(null);

  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval, setInterval] = useState("60");
  const [lines, setLines] = useState<ChartLine[]>([]);
  const [drawMode, setDrawMode] = useState(false);
  const [alarmMode, setAlarmMode] = useState(false);
  const [previewPrice, setPreviewPrice] = useState<number | null>(null);
  const [editingLine, setEditingLine] = useState<ChartLine | null>(null);
  const [editNote, setEditNote] = useState("");
  const [editColor, setEditColor] = useState("#f97316");
  const priceLinesRef = useRef<Map<string, IPriceLine>>(new Map());

  const fetchCandles = async (sym: string, tf: string) => {
    try {
      const res = await fetch(
        `https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=${tf}&limit=200`
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
    if (error) return alert("خطا در ذخیره خط");
    setLines((prev) => [data, ...prev]);
    resetModes();
  };

  const createAlarm = (price: number) => {
    window.location.href = `/alerts?price=${price}&symbol=${symbol}`;
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

  const updateLine = async () => {
    if (!editingLine) return;
    const { error } = await supabase
      .from("chart_lines")
      .update({ note: editNote, color: editColor, price: editingLine.price })
      .eq("id", editingLine.id);
    if (error) return alert("خطا در ویرایش");
    setLines((prev) =>
      prev.map((l) =>
        l.id === editingLine.id
          ? { ...l, note: editNote, color: editColor, price: editingLine.price }
          : l
      )
    );
    setEditingLine(null);
  };

  const resetModes = () => {
    setDrawMode(false);
    setAlarmMode(false);
    setPreviewPrice(null);
    if (previewLineRef.current && candleSeriesRef.current) {
      candleSeriesRef.current.removePriceLine(previewLineRef.current);
      previewLineRef.current = null;
    }
  };

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: { background: { color: "#0f0f0f" }, textColor: "#d1d5db" },
      grid: { vertLines: { color: "#1f2937" }, horzLines: { color: "#1f2937" } },
      width: chartContainerRef.current.clientWidth,
      height: 600,
      timeScale: { timeVisible: true, secondsVisible: false },
      handleScroll: { vertTouchDrag: true, horzTouchDrag: true, mouseWheel: true, pressedMouseMove: true },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      crosshair: {
        mode: 0,
        horzLine: { visible: true, labelVisible: true, style: LineStyle.Dashed, width: 1, color: "#f97316" },
        vertLine: { visible: true, labelVisible: false, style: LineStyle.Dashed, width: 1, color: "#6b7280" },
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

    chart.subscribeCrosshairMove((param) => {
      if ((!drawMode && !alarmMode) || !param.point || !series) return;
      const price = series.coordinateToPrice(param.point.y);
      if (price === null) return;
      const rounded = Number(price.toFixed(2));
      setPreviewPrice(rounded);

      if (previewLineRef.current) series.removePriceLine(previewLineRef.current);
      previewLineRef.current = series.createPriceLine({
        price: rounded,
        color: alarmMode ? "#22c55e" : "#f97316",
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: alarmMode ? "آلارم" : "خط",
      });
    });

    chart.subscribeClick(() => {
      if (!previewPrice) return;
      if (drawMode) {
        addLine(previewPrice);
      } else if (alarmMode) {
        createAlarm(previewPrice);
      }
    });

    const load = async () => {
      const candles = await fetchCandles(symbol, interval);
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
  }, [symbol, interval, drawMode, alarmMode]);

  useEffect(() => {
    if (!candleSeriesRef.current) return;
    priceLinesRef.current.forEach((pl) => candleSeriesRef.current?.removePriceLine(pl));
    priceLinesRef.current.clear();

    lines.forEach((line) => {
      const pl = candleSeriesRef.current!.createPriceLine({
        price: line.price,
        color: line.color || "#f97316",
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: line.note || String(line.price),
      });
      priceLinesRef.current.set(line.id, pl);
    });
  }, [lines]);

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      {/* هدر */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
        <div>
          <h1 className="text-2xl font-bold">چارت زنده</h1>
          <p className="text-gray-400 text-sm mt-1">مداد = کشیدن خط | آلارم = ساخت آلارم مستقیم</p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white w-28"
          />
          <Link href="/alerts" className="bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-lg text-sm">
            صفحه آلارم‌ها
          </Link>
        </div>
      </div>

      {/* تایم‌فریم */}
      <div className="mb-3 flex flex-wrap gap-2">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf.value}
            onClick={() => setInterval(tf.value)}
            className={`px-3 py-1.5 rounded text-sm ${
              interval === tf.value ? "bg-orange-500 text-white" : "bg-gray-800 text-gray-300"
            }`}
          >
            {tf.label}
          </button>
        ))}
      </div>

      {/* ابزارها */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          onClick={() => {
            setDrawMode(!drawMode);
            setAlarmMode(false);
            setPreviewPrice(null);
          }}
          className={`px-4 py-2 rounded-lg text-sm font-medium ${drawMode ? "bg-orange-500 text-white" : "bg-gray-800 text-gray-300"}`}
        >
          {drawMode ? "✕ خروج" : "✏️ کشیدن خط"}
        </button>

        <button
          onClick={() => {
            setAlarmMode(!alarmMode);
            setDrawMode(false);
            setPreviewPrice(null);
          }}
          className={`px-4 py-2 rounded-lg text-sm font-medium ${alarmMode ? "bg-green-600 text-white" : "bg-gray-800 text-gray-300"}`}
        >
          {alarmMode ? "✕ خروج" : "🔔 ساخت آلارم"}
        </button>

        {(drawMode || alarmMode) && previewPrice && (
          <span className="text-sm text-orange-400">
            قیمت: {previewPrice.toLocaleString()} — روی چارت کلیک کن تا تأیید بشه
          </span>
        )}
      </div>

      {/* چارت */}
      <div
        ref={chartContainerRef}
        className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden"
        style={{ height: "600px", touchAction: "none" }}
      />

      {/* لیست خط‌ها */}
      {lines.length > 0 && (
        <div className="mt-6">
          <h2 className="text-lg font-semibold mb-3">خط‌های ذخیره شده</h2>
          <div className="space-y-2">
            {lines.map((line) => (
              <div key={line.id} className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium" style={{ color: line.color }}>
                      {symbol} @ {line.price.toLocaleString()}
                    </span>
                    {line.note && <p className="text-sm text-gray-400 mt-1">{line.note}</p>}
                  </div>
                  <div className="flex gap-3 text-sm">
                    <button
                      onClick={() => {
                        setEditingLine(line);
                        setEditNote(line.note || "");
                        setEditColor(line.color || "#f97316");
                      }}
                      className="text-blue-400"
                    >
                      ویرایش
                    </button>
                    <button onClick={() => createAlarm(line.price)} className="text-green-400">
                      آلارم
                    </button>
                    <button onClick={() => deleteLine(line.id)} className="text-red-400">
                      حذف
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* مودال ویرایش */}
      {editingLine && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-full max-w-md">
            <h3 className="text-lg font-bold mb-4">ویرایش خط</h3>
            <div className="space-y-4">
              <div>
                <label className="text-sm text-gray-400">قیمت</label>
                <input
                  type="number"
                  value={editingLine.price}
                  onChange={(e) =>
                    setEditingLine({ ...editingLine, price: Number(e.target.value) })
                  }
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 mt-1"
                />
              </div>
              <div>
                <label className="text-sm text-gray-400">یادداشت</label>
                <input
                  type="text"
                  value={editNote}
                  onChange={(e) => setEditNote(e.target.value)}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 mt-1"
                  placeholder="مثلاً مقاومت مهم"
                />
              </div>
              <div>
                <label className="text-sm text-gray-400 mb-2 block">رنگ</label>
                <div className="flex gap-2">
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      onClick={() => setEditColor(c)}
                      className={`w-8 h-8 rounded-full ${editColor === c ? "ring-2 ring-white" : ""}`}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={updateLine} className="flex-1 bg-orange-500 hover:bg-orange-600 py-2 rounded-lg">
                ذخیره
              </button>
              <button onClick={() => setEditingLine(null)} className="flex-1 bg-gray-700 py-2 rounded-lg">
                انصراف
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect, useRef, useState, useCallback } from "react";
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

interface Alarm {
  id: string;
  symbol: string;
  price: number;
  condition: "above" | "below" | "cross";
  is_active: boolean;
  triggered: boolean;
  repeat: boolean;
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

export default function DashboardPage() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const previewLineRef = useRef<IPriceLine | null>(null);
  const alarmLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const chartLinesRef = useRef<Map<string, IPriceLine>>(new Map());

  const [symbol, setSymbol] = useState("BTCUSDT");
  const [interval, setIntervalTf] = useState("60");
  const [lines, setLines] = useState<ChartLine[]>([]);
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [mode, setMode] = useState<"none" | "draw" | "alarm" | "move">("none");
  const [previewPrice, setPreviewPrice] = useState<number | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [movingType, setMovingType] = useState<"line" | "alarm" | null>(null);
  const [condition, setCondition] = useState<"above" | "below" | "cross">("above");
  const [saving, setSaving] = useState(false);

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
    } catch {
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

  const fetchAlarms = async (sym: string) => {
    const { data } = await supabase
      .from("alarms")
      .select("*")
      .eq("symbol", sym)
      .eq("is_active", true)
      .eq("triggered", false)
      .order("created_at", { ascending: false });
    setAlarms(data || []);
  };

  const clearPreview = () => {
    if (previewLineRef.current && candleSeriesRef.current) {
      candleSeriesRef.current.removePriceLine(previewLineRef.current);
      previewLineRef.current = null;
    }
    setPreviewPrice(null);
  };

  const resetMode = () => {
    setMode("none");
    setMovingId(null);
    setMovingType(null);
    clearPreview();
  };

  const addLine = async (price: number) => {
    if (saving) return;
    setSaving(true);
    try {
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
      resetMode();
    } finally {
      setSaving(false);
    }
  };

  const createAlarmDirect = async (price: number) => {
    if (saving) return;
    setSaving(true);
    try {
      const { data, error } = await supabase
        .from("alarms")
        .insert([
          {
            symbol: symbol.toUpperCase(),
            price: Number(price),
            condition,
            is_active: true,
            triggered: false,
            repeat: false,
            note: "آلارم از چارت",
          },
        ])
        .select()
        .single();

      if (error) {
        alert("خطا در ساخت آلارم: " + error.message);
        return;
      }
      setAlarms((prev) => [data, ...prev]);
      resetMode();
      alert(`آلارم ذخیره شد: ${symbol} @ ${price.toLocaleString()}`);
    } finally {
      setSaving(false);
    }
  };

  const updateLinePrice = async (id: string, price: number) => {
    if (saving) return;
    setSaving(true);
    try {
      const { error } = await supabase.from("chart_lines").update({ price }).eq("id", id);
      if (error) {
        alert("خطا");
        return;
      }
      setLines((prev) => prev.map((l) => (l.id === id ? { ...l, price } : l)));
      resetMode();
    } finally {
      setSaving(false);
    }
  };

  const updateAlarmPrice = async (id: string, price: number) => {
    if (saving) return;
    setSaving(true);
    try {
      const { error } = await supabase.from("alarms").update({ price }).eq("id", id);
      if (error) {
        alert("خطا");
        return;
      }
      setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, price } : a)));
      resetMode();
    } finally {
      setSaving(false);
    }
  };

  const deleteLine = async (id: string) => {
    await supabase.from("chart_lines").delete().eq("id", id);
    setLines((prev) => prev.filter((l) => l.id !== id));
  };

  const deleteAlarm = async (id: string) => {
    await supabase.from("alarms").update({ is_active: false }).eq("id", id);
    setAlarms((prev) => prev.filter((a) => a.id !== id));
  };

  const startMove = (id: string, type: "line" | "alarm", price: number) => {
    setMode("move");
    setMovingId(id);
    setMovingType(type);
    setPreviewPrice(price);
  };

  const getConditionSymbol = (c: string) => {
    if (c === "above") return "≥";
    if (c === "below") return "≤";
    return "≈";
  };

  // رسم آلارم‌ها روی چارت
  const drawAlarmsOnChart = useCallback(() => {
    if (!candleSeriesRef.current) return;

    alarmLinesRef.current.forEach((pl) => {
      candleSeriesRef.current?.removePriceLine(pl);
    });
    alarmLinesRef.current.clear();

    alarms.forEach((alarm) => {
      if (mode === "move" && movingType === "alarm" && movingId === alarm.id) return;

      const color =
        alarm.condition === "above"
          ? "#22c55e"
          : alarm.condition === "below"
          ? "#ef4444"
          : "#3b82f6";

      const pl = candleSeriesRef.current!.createPriceLine({
        price: alarm.price,
        color,
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: `آلارم ${getConditionSymbol(alarm.condition)}`,
      });
      alarmLinesRef.current.set(alarm.id, pl);
    });
  }, [alarms, mode, movingId, movingType]);

  // رسم خط‌های چارت
  const drawChartLines = useCallback(() => {
    if (!candleSeriesRef.current) return;

    chartLinesRef.current.forEach((pl) => {
      candleSeriesRef.current?.removePriceLine(pl);
    });
    chartLinesRef.current.clear();

    lines.forEach((line) => {
      if (mode === "move" && movingType === "line" && movingId === line.id) return;

      const pl = candleSeriesRef.current!.createPriceLine({
        price: line.price,
        color: line.color || "#f97316",
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        axisLabelVisible: true,
        title: line.note || "خط",
      });
      chartLinesRef.current.set(line.id, pl);
    });
  }, [lines, mode, movingId, movingType]);

  useEffect(() => {
    drawAlarmsOnChart();
  }, [drawAlarmsOnChart]);

  useEffect(() => {
    drawChartLines();
  }, [drawChartLines]);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: { background: { color: "#0f0f0f" }, textColor: "#d1d5db" },
      grid: { vertLines: { color: "#1f2937" }, horzLines: { color: "#1f2937" } },
      width: chartContainerRef.current.clientWidth,
      height: 560,
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
        mode: 0,
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

    chart.subscribeCrosshairMove((param) => {
      if (mode === "none" || !param.point || !series) return;
      const price = series.coordinateToPrice(param.point.y);
      if (price === null) return;
      const rounded = Number(price.toFixed(2));
      setPreviewPrice(rounded);

      if (previewLineRef.current) series.removePriceLine(previewLineRef.current);
      previewLineRef.current = series.createPriceLine({
        price: rounded,
        color: mode === "alarm" ? "#22c55e" : mode === "move" ? "#3b82f6" : "#f97316",
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: mode === "alarm" ? "آلارم" : mode === "move" ? "جابه‌جایی" : "خط جدید",
      });
    });

    chart.subscribeClick(() => {
      if (!previewPrice || mode === "none" || saving) return;

      if (mode === "draw") {
        addLine(previewPrice);
      } else if (mode === "alarm") {
        createAlarmDirect(previewPrice);
      } else if (mode === "move" && movingId && movingType) {
        if (movingType === "line") updateLinePrice(movingId, previewPrice);
        else updateAlarmPrice(movingId, previewPrice);
      }
    });

    const load = async () => {
      const candles = await fetchCandles(symbol, interval);
      if (candles.length) {
        series.setData(candles);
        chart.timeScale().fitContent();
      }
      await Promise.all([fetchLines(symbol), fetchAlarms(symbol)]);
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
  }, [symbol, interval]);

  // وقتی mode عوض می‌شود، چارت را دوباره load نکن؛ فقط preview را مدیریت کن
  useEffect(() => {
    if (mode === "none") clearPreview();
  }, [mode]);

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
        <div>
          <h1 className="text-2xl font-bold">چارت زنده</h1>
          <p className="text-gray-400 text-sm mt-1">
            آلارم‌های فعال روی چارت با خط رنگی مشخص هستند
          </p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white w-28"
          />
          <Link
            href="/alerts"
            className="bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-lg text-sm"
          >
            صفحه آلارم‌ها
          </Link>
        </div>
      </div>

      {/* تایم‌فریم */}
      <div className="mb-3 flex flex-wrap gap-2">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf.value}
            onClick={() => setIntervalTf(tf.value)}
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
            setMode(mode === "draw" ? "none" : "draw");
            setMovingId(null);
            setMovingType(null);
            clearPreview();
          }}
          className={`px-4 py-2 rounded-lg text-sm font-medium ${
            mode === "draw" ? "bg-orange-500 text-white" : "bg-gray-800 text-gray-300"
          }`}
        >
          {mode === "draw" ? "✕ خروج" : "✏️ خط جدید"}
        </button>

        <button
          onClick={() => {
            setMode(mode === "alarm" ? "none" : "alarm");
            setMovingId(null);
            setMovingType(null);
            clearPreview();
          }}
          className={`px-4 py-2 rounded-lg text-sm font-medium ${
            mode === "alarm" ? "bg-green-600 text-white" : "bg-gray-800 text-gray-300"
          }`}
        >
          {mode === "alarm" ? "✕ خروج" : "🔔 آلارم"}
        </button>

        {mode === "alarm" && (
          <select
            value={condition}
            onChange={(e) => setCondition(e.target.value as any)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white"
          >
            <option value="above">بالای این قیمت (≥)</option>
            <option value="below">پایین این قیمت (≤)</option>
            <option value="cross">برخورد (≈)</option>
          </select>
        )}

        {mode !== "none" && previewPrice && (
          <span className="text-sm text-orange-400">
            {previewPrice.toLocaleString()} — یک بار روی چارت بزن
            {saving && " (در حال ذخیره...)"}
          </span>
        )}
      </div>

      <div
        ref={chartContainerRef}
        className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden"
        style={{ height: "560px", touchAction: "none" }}
      />

      {/* لیست آلارم‌های فعال */}
      <div className="mt-6">
        <h2 className="text-lg font-semibold mb-3 text-green-400">
          آلارم‌های فعال روی چارت ({alarms.length})
        </h2>
        {alarms.length === 0 ? (
          <p className="text-gray-500 text-sm">هنوز آلارم فعالی برای این نماد نیست</p>
        ) : (
          <div className="space-y-2">
            {alarms.map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between bg-gray-900 border border-green-900/40 rounded-lg px-4 py-3"
              >
                <div>
                  <span className="font-medium">
                    {a.symbol}{" "}
                    <span className="text-orange-400">
                      {getConditionSymbol(a.condition)} {a.price.toLocaleString()}
                    </span>
                  </span>
                </div>
                <div className="flex gap-3 text-sm">
                  <button
                    onClick={() => startMove(a.id, "alarm", a.price)}
                    className="text-blue-400"
                  >
                    جابه‌جا
                  </button>
                  <button onClick={() => deleteAlarm(a.id)} className="text-red-400">
                    حذف
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* لیست خط‌ها */}
      <div className="mt-6">
        <h2 className="text-lg font-semibold mb-3 text-orange-400">
          خط‌های ذخیره شده ({lines.length})
        </h2>
        {lines.length === 0 ? (
          <p className="text-gray-500 text-sm">خطی ذخیره نشده</p>
        ) : (
          <div className="space-y-2">
            {lines.map((line) => (
              <div
                key={line.id}
                className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-lg px-4 py-3"
              >
                <span style={{ color: line.color }}>
                  {symbol} @ {line.price.toLocaleString()}
                  {line.note && <span className="text-gray-400 text-sm mr-2"> — {line.note}</span>}
                </span>
                <div className="flex gap-3 text-sm">
                  <button
                    onClick={() => startMove(line.id, "line", line.price)}
                    className="text-blue-400"
                  >
                    جابه‌جا
                  </button>
                  <button
                    onClick={() => createAlarmDirect(line.price)}
                    className="text-green-400"
                  >
                    آلارم
                  </button>
                  <button onClick={() => deleteLine(line.id)} className="text-red-400">
                    حذف
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

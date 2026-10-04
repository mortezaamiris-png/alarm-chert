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

interface Alarm {
  id: string;
  symbol: string;
  price: number;
  condition: "above" | "below" | "cross";
  is_active: boolean;
  triggered: boolean;
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

function getPrecision(price: number) {
  if (price < 0.01) return { precision: 6, minMove: 0.000001 };
  if (price < 1) return { precision: 5, minMove: 0.00001 };
  if (price < 100) return { precision: 4, minMove: 0.0001 };
  if (price < 1000) return { precision: 3, minMove: 0.001 };
  return { precision: 2, minMove: 0.01 };
}

function formatPrice(price: number) {
  const { precision } = getPrecision(price);
  return Number(price.toFixed(precision));
}

export default function DashboardPage() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const previewLineRef = useRef<IPriceLine | null>(null);
  const alarmLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const chartLinesRef = useRef<Map<string, IPriceLine>>(new Map());

  const [symbol, setSymbol] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("chart_symbol") || "BTCUSDT";
    }
    return "BTCUSDT";
  });
  const [interval, setIntervalTf] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("chart_interval") || "60";
    }
    return "60";
  });

  const [lines, setLines] = useState<ChartLine[]>([]);
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [mode, setMode] = useState<"none" | "draw" | "alarm" | "move">("none");
  const [previewPrice, setPreviewPrice] = useState<number | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [movingType, setMovingType] = useState<"line" | "alarm" | null>(null);
  const [condition, setCondition] = useState<"above" | "below" | "cross">("above");
  const [saving, setSaving] = useState(false);

  const modeRef = useRef(mode);
  const previewPriceRef = useRef(previewPrice);
  const movingIdRef = useRef(movingId);
  const movingTypeRef = useRef(movingType);
  const conditionRef = useRef(condition);
  const savingRef = useRef(saving);
  const symbolRef = useRef(symbol);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { previewPriceRef.current = previewPrice; }, [previewPrice]);
  useEffect(() => { movingIdRef.current = movingId; }, [movingId]);
  useEffect(() => { movingTypeRef.current = movingType; }, [movingType]);
  useEffect(() => { conditionRef.current = condition; }, [condition]);
  useEffect(() => { savingRef.current = saving; }, [saving]);
  useEffect(() => { symbolRef.current = symbol; }, [symbol]);

  useEffect(() => {
    localStorage.setItem("chart_symbol", symbol);
  }, [symbol]);
  useEffect(() => {
    localStorage.setItem("chart_interval", interval);
  }, [interval]);

  const clearPreview = () => {
    if (previewLineRef.current && seriesRef.current) {
      seriesRef.current.removePriceLine(previewLineRef.current);
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
    if (savingRef.current) return;
    setSaving(true);
    try {
      const sym = symbolRef.current;
      const p = formatPrice(price);
      const { data, error } = await supabase
        .from("chart_lines")
        .insert([{ symbol: sym, price: p, color: "#f97316" }])
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
    if (savingRef.current) return;
    setSaving(true);
    try {
      const sym = symbolRef.current;
      const cond = conditionRef.current;
      const p = formatPrice(price);
      const { data, error } = await supabase
        .from("alarms")
        .insert([
          {
            symbol: sym.toUpperCase(),
            price: p,
            condition: cond,
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
      alert(`آلارم ذخیره شد: ${sym} @ ${p}`);
    } finally {
      setSaving(false);
    }
  };

  // تبدیل خط به آلارم + حذف از لیست خط‌ها
  const convertLineToAlarm = async (line: ChartLine) => {
    if (savingRef.current) return;
    setSaving(true);
    try {
      const sym = symbolRef.current;
      const cond = conditionRef.current;
      const { data, error } = await supabase
        .from("alarms")
        .insert([
          {
            symbol: sym.toUpperCase(),
            price: line.price,
            condition: cond,
            is_active: true,
            triggered: false,
            repeat: false,
            note: "آلارم از خط چارت",
          },
        ])
        .select()
        .single();
      if (error) {
        alert("خطا: " + error.message);
        return;
      }
      // حذف خط از جدول و لیست
      await supabase.from("chart_lines").delete().eq("id", line.id);
      setLines((prev) => prev.filter((l) => l.id !== line.id));
      setAlarms((prev) => [data, ...prev]);
      alert(`آلارم ساخته شد و خط حذف شد`);
    } finally {
      setSaving(false);
    }
  };

  const updateLinePrice = async (id: string, price: number) => {
    if (savingRef.current) return;
    setSaving(true);
    try {
      const p = formatPrice(price);
      const { error } = await supabase.from("chart_lines").update({ price: p }).eq("id", id);
      if (error) {
        alert("خطا");
        return;
      }
      setLines((prev) => prev.map((l) => (l.id === id ? { ...l, price: p } : l)));
      resetMode();
    } finally {
      setSaving(false);
    }
  };

  const updateAlarmPrice = async (id: string, price: number) => {
    if (savingRef.current) return;
    setSaving(true);
    try {
      const p = formatPrice(price);
      const { error } = await supabase.from("alarms").update({ price: p }).eq("id", id);
      if (error) {
        alert("خطا");
        return;
      }
      setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, price: p } : a)));
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

  const getConditionLabel = (c: string) => {
    if (c === "above") return "بالای قیمت";
    if (c === "below") return "پایین قیمت";
    return "برخورد";
  };

  const getConditionColor = (c: string) => {
    if (c === "above") return "text-green-400";
    if (c === "below") return "text-red-400";
    return "text-blue-400";
  };

  const loadCandles = async (sym: string, tf: string) => {
    try {
      const res = await fetch(
        `https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=${tf}&limit=200`
      );
      const data = await res.json();
      if (data.result?.list && seriesRef.current) {
        const candles = data.result.list
          .map((item: any) => ({
            time: Number(item[0]) / 1000,
            open: parseFloat(item[1]),
            high: parseFloat(item[2]),
            low: parseFloat(item[3]),
            close: parseFloat(item[4]),
          }))
          .reverse();
        if (candles.length === 0) return;

        const lastClose = candles[candles.length - 1].close;
        const { precision, minMove } = getPrecision(lastClose);

        seriesRef.current.applyOptions({
          priceFormat: { type: "price", precision, minMove },
        });
        seriesRef.current.setData(candles);
        chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
        chartRef.current?.timeScale().fitContent();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const loadLines = async (sym: string) => {
    const { data } = await supabase
      .from("chart_lines")
      .select("*")
      .eq("symbol", sym)
      .order("created_at", { ascending: false });
    setLines(data || []);
  };

  const loadAlarms = async (sym: string) => {
    const { data } = await supabase
      .from("alarms")
      .select("*")
      .eq("symbol", sym)
      .eq("is_active", true)
      .eq("triggered", false)
      .order("created_at", { ascending: false });
    setAlarms(data || []);
  };

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: { background: { color: "#0f0f0f" }, textColor: "#d1d5db" },
      grid: { vertLines: { color: "#1f2937" }, horzLines: { color: "#1f2937" } },
      width: chartContainerRef.current.clientWidth,
      height: 560,
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: {
        autoScale: true,
        scaleMargins: { top: 0.1, bottom: 0.1 },
        borderVisible: false,
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
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });

    chartRef.current = chart;
    seriesRef.current = series;

    chart.subscribeCrosshairMove((param) => {
      if (modeRef.current === "none" || !param.point || !seriesRef.current) return;
      const price = seriesRef.current.coordinateToPrice(param.point.y);
      if (price === null) return;
      const rounded = formatPrice(price);
      setPreviewPrice(rounded);
      if (previewLineRef.current) {
        seriesRef.current.removePriceLine(previewLineRef.current);
      }
      const m = modeRef.current;
      previewLineRef.current = seriesRef.current.createPriceLine({
        price: rounded,
        color: m === "alarm" ? "#22c55e" : m === "move" ? "#3b82f6" : "#f97316",
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: m === "alarm" ? "آلارم" : m === "move" ? "جابه‌جایی" : "خط جدید",
      });
    });

    chart.subscribeClick(() => {
      const m = modeRef.current;
      const price = previewPriceRef.current;
      if (!price || m === "none" || savingRef.current) return;
      if (m === "draw") addLine(price);
      else if (m === "alarm") createAlarmDirect(price);
      else if (m === "move" && movingIdRef.current && movingTypeRef.current) {
        if (movingTypeRef.current === "line") updateLinePrice(movingIdRef.current, price);
        else updateAlarmPrice(movingIdRef.current, price);
      }
    });

    const onResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", onResize);

    const savedSym = localStorage.getItem("chart_symbol") || "BTCUSDT";
    const savedTf = localStorage.getItem("chart_interval") || "60";
    loadCandles(savedSym, savedTf);
    loadLines(savedSym);
    loadAlarms(savedSym);

    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
    };
  }, []);

  useEffect(() => {
    resetMode();
    loadCandles(symbol, interval);
    loadLines(symbol);
    loadAlarms(symbol);
  }, [symbol, interval]);

  useEffect(() => {
    if (!seriesRef.current) return;
    alarmLinesRef.current.forEach((pl) => seriesRef.current?.removePriceLine(pl));
    alarmLinesRef.current.clear();
    alarms.forEach((alarm) => {
      if (mode === "move" && movingType === "alarm" && movingId === alarm.id) return;
      const color =
        alarm.condition === "above" ? "#22c55e" : alarm.condition === "below" ? "#ef4444" : "#3b82f6";
      const pl = seriesRef.current!.createPriceLine({
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

  useEffect(() => {
    if (!seriesRef.current) return;
    chartLinesRef.current.forEach((pl) => seriesRef.current?.removePriceLine(pl));
    chartLinesRef.current.clear();
    lines.forEach((line) => {
      if (mode === "move" && movingType === "line" && movingId === line.id) return;
      const pl = seriesRef.current!.createPriceLine({
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

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
        <div>
          <h1 className="text-2xl font-bold">چارت زنده</h1>
          <p className="text-gray-400 text-sm mt-1">یک بار روی چارت بزن تا تأیید شود</p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white w-28"
            placeholder="BTCUSDT"
          />
          <button
            onClick={() => {
              loadCandles(symbol, interval);
              loadLines(symbol);
              loadAlarms(symbol);
            }}
            className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg text-sm"
          >
            برو
          </button>
          <Link
            href="/alerts"
            className="bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-lg text-sm"
          >
            صفحه آلارم‌ها
          </Link>
        </div>
      </div>

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

        {mode !== "none" && previewPrice !== null && (
          <span className="text-sm text-orange-400">
            {previewPrice} — یک بار روی چارت بزن
            {saving && " (در حال ذخیره...)"}
          </span>
        )}
      </div>

      <div
        ref={chartContainerRef}
        className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden"
        style={{ height: "560px", touchAction: "none" }}
      />

      {/* آلارم‌ها با رنگ شرط */}
      <div className="mt-6">
        <h2 className="text-lg font-semibold mb-3 text-green-400">
          آلارم‌های فعال ({alarms.length})
        </h2>
        {alarms.length === 0 ? (
          <p className="text-gray-500 text-sm">آلارم فعالی نیست</p>
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
                      {getConditionSymbol(a.condition)} {a.price}
                    </span>
                  </span>
                </div>
                <div className="flex items-center gap-3 text-sm">
                  <span className={`font-medium ${getConditionColor(a.condition)}`}>
                    {getConditionLabel(a.condition)}
                  </span>
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

      {/* خط‌ها — با تبدیل به آلارم حذف می‌شوند */}
      <div className="mt-6">
        <h2 className="text-lg font-semibold mb-3 text-orange-400">
          خط‌های ذخیره شده ({lines.length})
        </h2>
        {lines.length === 0 ? (
          <p className="text-gray-500 text-sm">خطی نیست</p>
        ) : (
          <div className="space-y-2">
            {lines.map((line) => (
              <div
                key={line.id}
                className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-lg px-4 py-3"
              >
                <span style={{ color: line.color }}>
                  {symbol} @ {line.price}
                </span>
                <div className="flex gap-3 text-sm">
                  <button
                    onClick={() => startMove(line.id, "line", line.price)}
                    className="text-blue-400"
                  >
                    جابه‌جا
                  </button>
                  <button
                    onClick={() => convertLineToAlarm(line)}
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

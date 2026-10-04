"use client";

import { useEffect, useRef, useState } from "react";
import {
  createChart,
  IChartApi,
  ISeriesApi,
  LineStyle,
  IPriceLine,
} from "lightweight-charts";
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

type ToolMode = "none" | "draw" | "alarm" | "move";

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

function calcSMA(candles: { time: number; close: number }[], period: number) {
  const out: { time: number; value: number }[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) continue;
    let sum = 0;
    for (let j = 0; j < period; j++) sum += candles[i - j].close;
    out.push({ time: candles[i].time, value: sum / period });
  }
  return out;
}

export default function DashboardPage() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const previewLineRef = useRef<IPriceLine | null>(null);
  const alarmLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const chartLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const smaSeriesRef = useRef<{ s1: any; s2: any; s3: any } | null>(null);
  const pivotLinesRef = useRef<IPriceLine[]>([]);
  const candlesRef = useRef<any[]>([]);

  const [symbol, setSymbol] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem("chart_symbol") || "BTCUSDT" : "BTCUSDT"
  );
  const [interval, setIntervalTf] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem("chart_interval") || "60" : "60"
  );

  const [lines, setLines] = useState<ChartLine[]>([]);
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [mode, setMode] = useState<ToolMode>("none");
  const [previewPrice, setPreviewPrice] = useState<number | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [movingType, setMovingType] = useState<"line" | "alarm" | null>(null);
  const [condition, setCondition] = useState<"above" | "below" | "cross">("above");
  const [saving, setSaving] = useState(false);

  // اندیکاتورها
  const [showSMA, setShowSMA] = useState(false);
  const [smaVisible, setSmaVisible] = useState(true);
  const [smaSettings, setSmaSettings] = useState(false);
  const [sma1, setSma1] = useState(50);
  const [sma2, setSma2] = useState(100);
  const [sma3, setSma3] = useState(200);

  const [showPivot, setShowPivot] = useState(false);
  const [pivotVisible, setPivotVisible] = useState(true);
  const [showIndicatorMenu, setShowIndicatorMenu] = useState(false);

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

  useEffect(() => { localStorage.setItem("chart_symbol", symbol); }, [symbol]);
  useEffect(() => { localStorage.setItem("chart_interval", interval); }, [interval]);

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
      const p = formatPrice(price);
      const { data, error } = await supabase
        .from("chart_lines")
        .insert([{ symbol: symbolRef.current, price: p, color: "#f97316" }])
        .select()
        .single();
      if (error) { alert(error.message); return; }
      setLines((prev) => [data, ...prev]);
      resetMode();
    } finally { setSaving(false); }
  };

  const createAlarmDirect = async (price: number) => {
    if (savingRef.current) return;
    setSaving(true);
    try {
      const p = formatPrice(price);
      const { data, error } = await supabase
        .from("alarms")
        .insert([{
          symbol: symbolRef.current.toUpperCase(),
          price: p,
          condition: conditionRef.current,
          is_active: true,
          triggered: false,
          repeat: false,
          note: "آلارم از چارت",
        }])
        .select()
        .single();
      if (error) { alert(error.message); return; }
      setAlarms((prev) => [data, ...prev]);
      resetMode();
    } finally { setSaving(false); }
  };

  const updateLinePrice = async (id: string, price: number) => {
    const p = formatPrice(price);
    await supabase.from("chart_lines").update({ price: p }).eq("id", id);
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, price: p } : l)));
    resetMode();
  };

  const updateAlarmPrice = async (id: string, price: number) => {
    const p = formatPrice(price);
    await supabase.from("alarms").update({ price: p }).eq("id", id);
    setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, price: p } : a)));
    resetMode();
  };

  const deleteLine = async (id: string) => {
    await supabase.from("chart_lines").delete().eq("id", id);
    setLines((prev) => prev.filter((l) => l.id !== id));
  };

  const deleteAlarm = async (id: string) => {
    await supabase.from("alarms").update({ is_active: false }).eq("id", id);
    setAlarms((prev) => prev.filter((a) => a.id !== id));
  };

  const cycleCondition = async (alarm: Alarm) => {
    const next = alarm.condition === "above" ? "below" : alarm.condition === "below" ? "cross" : "above";
    await supabase.from("alarms").update({ condition: next }).eq("id", alarm.id);
    setAlarms((prev) => prev.map((a) => (a.id === alarm.id ? { ...a, condition: next } : a)));
  };

  const startMove = (id: string, type: "line" | "alarm", price: number) => {
    setMode("move");
    setMovingId(id);
    setMovingType(type);
    setPreviewPrice(price);
  };

  const getConditionSymbol = (c: string) => (c === "above" ? "≥" : c === "below" ? "≤" : "≈");
  const getConditionLabel = (c: string) => (c === "above" ? "بالای قیمت" : c === "below" ? "پایین قیمت" : "برخورد");
  const getConditionColor = (c: string) => (c === "above" ? "text-green-400" : c === "below" ? "text-red-400" : "text-blue-400");

  // ——— 3SMA ———
  const applySMA = (candles: any[]) => {
    if (!chartRef.current) return;
    removeSMA();
    if (!showSMA || !smaVisible) return;

    const s1 = chartRef.current.addLineSeries({ color: "#ef4444", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, title: `SMA${sma1}` });
    const s2 = chartRef.current.addLineSeries({ color: "#eab308", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, title: `SMA${sma2}` });
    const s3 = chartRef.current.addLineSeries({ color: "#a855f7", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, title: `SMA${sma3}` });

    s1.setData(calcSMA(candles, sma1) as any);
    s2.setData(calcSMA(candles, sma2) as any);
    s3.setData(calcSMA(candles, sma3) as any);
    smaSeriesRef.current = { s1, s2, s3 };
  };

  const removeSMA = () => {
    if (!chartRef.current || !smaSeriesRef.current) return;
    try {
      chartRef.current.removeSeries(smaSeriesRef.current.s1);
      chartRef.current.removeSeries(smaSeriesRef.current.s2);
      chartRef.current.removeSeries(smaSeriesRef.current.s3);
    } catch {}
    smaSeriesRef.current = null;
  };

  // ——— Pivot (کلاسیک از آخرین روز) ———
  const applyPivot = async (sym: string) => {
    if (!seriesRef.current) return;
    removePivot();
    if (!showPivot || !pivotVisible) return;

    try {
      const res = await fetch(
        `https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=D&limit=3`
      );
      const data = await res.json();
      const list = data.result?.list;
      if (!list || list.length < 2) return;

      // کندل قبلی کامل (دیروز)
      const prev = list[1];
      const high = parseFloat(prev[2]);
      const low = parseFloat(prev[3]);
      const close = parseFloat(prev[4]);
      const range = high - low;
      const pp = (high + low + close) / 3;

      const levels = [
        { price: pp, title: "PP", color: "#ffffff" },
        { price: 2 * pp - low, title: "R1", color: "#22c55e" },
        { price: pp + range, title: "R2", color: "#22c55e" },
        { price: 2 * pp - high + range, title: "R3", color: "#22c55e" },
        { price: 2 * pp - high, title: "S1", color: "#ef4444" },
        { price: pp - range, title: "S2", color: "#ef4444" },
        { price: 2 * pp - low - range, title: "S3", color: "#ef4444" },
      ];

      levels.forEach((lv) => {
        const pl = seriesRef.current!.createPriceLine({
          price: formatPrice(lv.price),
          color: lv.color,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: lv.title,
        });
        pivotLinesRef.current.push(pl);
      });
    } catch (e) {
      console.error(e);
    }
  };

  const removePivot = () => {
    if (!seriesRef.current) return;
    pivotLinesRef.current.forEach((pl) => {
      try { seriesRef.current?.removePriceLine(pl); } catch {}
    });
    pivotLinesRef.current = [];
  };

  const loadCandles = async (sym: string, tf: string) => {
    try {
      const res = await fetch(
        `https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=${tf}&limit=300`
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
        if (!candles.length) return;

        candlesRef.current = candles;
        const lastClose = candles[candles.length - 1].close;
        const { precision, minMove } = getPrecision(lastClose);
        seriesRef.current.applyOptions({ priceFormat: { type: "price", precision, minMove } });
        seriesRef.current.setData(candles);
        chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
        chartRef.current?.timeScale().fitContent();

        applySMA(candles);
        applyPivot(sym);
      }
    } catch (e) { console.error(e); }
  };

  const loadLines = async (sym: string) => {
    const { data } = await supabase.from("chart_lines").select("*").eq("symbol", sym).order("created_at", { ascending: false });
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
      rightPriceScale: { autoScale: true, scaleMargins: { top: 0.1, bottom: 0.1 }, borderVisible: false },
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
    seriesRef.current = series;

    chart.subscribeCrosshairMove((param) => {
      if (modeRef.current === "none" || !param.point || !seriesRef.current) return;
      const price = seriesRef.current.coordinateToPrice(param.point.y);
      if (price === null) return;
      const rounded = formatPrice(price);
      setPreviewPrice(rounded);
      if (previewLineRef.current) seriesRef.current.removePriceLine(previewLineRef.current);
      previewLineRef.current = seriesRef.current.createPriceLine({
        price: rounded,
        color: modeRef.current === "alarm" ? "#22c55e" : "#f97316",
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: modeRef.current === "alarm" ? "آلارم" : "خط",
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
      if (chartContainerRef.current) chart.applyOptions({ width: chartContainerRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);

    loadCandles(symbol, interval);
    loadLines(symbol);
    loadAlarms(symbol);

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
    if (candlesRef.current.length) applySMA(candlesRef.current);
    else removeSMA();
  }, [showSMA, smaVisible, sma1, sma2, sma3]);

  useEffect(() => {
    applyPivot(symbol);
  }, [showPivot, pivotVisible, symbol]);

  useEffect(() => {
    if (!seriesRef.current) return;
    alarmLinesRef.current.forEach((pl) => seriesRef.current?.removePriceLine(pl));
    alarmLinesRef.current.clear();
    alarms.forEach((alarm) => {
      if (mode === "move" && movingType === "alarm" && movingId === alarm.id) return;
      const color = alarm.condition === "above" ? "#22c55e" : alarm.condition === "below" ? "#ef4444" : "#3b82f6";
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
        </div>
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white w-28"
          />
          <button
            onClick={() => { loadCandles(symbol, interval); loadLines(symbol); loadAlarms(symbol); }}
            className="bg-gray-700 text-white px-3 py-2 rounded-lg text-sm"
          >
            برو
          </button>
          <Link href="/alerts" className="bg-orange-500 text-white px-4 py-2 rounded-lg text-sm">
            آلارم‌ها
          </Link>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf.value}
            onClick={() => setIntervalTf(tf.value)}
            className={`px-3 py-1.5 rounded text-sm ${interval === tf.value ? "bg-orange-500 text-white" : "bg-gray-800 text-gray-300"}`}
          >
            {tf.label}
          </button>
        ))}
      </div>

      {/* دکمه‌ها */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setMode(mode === "draw" ? "none" : "draw")}
          className={`px-3 py-2 rounded-lg text-sm ${mode === "draw" ? "bg-orange-500" : "bg-gray-800"}`}
        >
          ✏️ خط
        </button>
        <button
          onClick={() => setMode(mode === "alarm" ? "none" : "alarm")}
          className={`px-3 py-2 rounded-lg text-sm ${mode === "alarm" ? "bg-green-600" : "bg-gray-800"}`}
        >
          🔔 آلارم
        </button>

        {/* منوی اندیکاتور */}
        <div className="relative">
          <button
            onClick={() => setShowIndicatorMenu(!showIndicatorMenu)}
            className="px-3 py-2 rounded-lg text-sm bg-gray-800 hover:bg-gray-700"
          >
            📊 اندیکاتور
          </button>
          {showIndicatorMenu && (
            <div className="absolute top-full right-0 mt-2 bg-gray-900 border border-gray-700 rounded-xl z-50 min-w-[180px] py-2 shadow-xl">
              <button
                onClick={() => { setShowSMA(true); setShowIndicatorMenu(false); }}
                className="w-full text-right px-4 py-2 hover:bg-gray-800 text-sm"
              >
                3SMA
              </button>
              <button
                onClick={() => { setShowPivot(true); setShowIndicatorMenu(false); }}
                className="w-full text-right px-4 py-2 hover:bg-gray-800 text-sm"
              >
                Pivot Points
              </button>
            </div>
          )}
        </div>

        {mode === "alarm" && (
          <select value={condition} onChange={(e) => setCondition(e.target.value as any)} className="bg-gray-800 rounded-lg px-2 py-2 text-sm">
            <option value="above">بالا</option>
            <option value="below">پایین</option>
            <option value="cross">برخورد</option>
          </select>
        )}
      </div>

      {/* نوار اندیکاتورهای فعال (مثل عکس) */}
      <div className="mb-3 flex flex-wrap gap-2">
        {showSMA && (
          <div className="flex items-center gap-1 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-sm">
            <span className="text-gray-200">3SMA</span>
            <button onClick={() => setSmaVisible(!smaVisible)} className="p-1 text-gray-400 hover:text-white" title="نمایش/مخفی">
              {smaVisible ? "👁" : "👁‍🗨"}
            </button>
            <button onClick={() => setSmaSettings(!smaSettings)} className="p-1 text-gray-400 hover:text-white" title="تنظیمات">
              ⚙
            </button>
            <button onClick={() => { setShowSMA(false); removeSMA(); }} className="p-1 text-gray-400 hover:text-red-400" title="حذف">
              🗑
            </button>
          </div>
        )}
        {showPivot && (
          <div className="flex items-center gap-1 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-sm">
            <span className="text-gray-200">Pivot</span>
            <button onClick={() => setPivotVisible(!pivotVisible)} className="p-1 text-gray-400 hover:text-white">
              {pivotVisible ? "👁" : "👁‍🗨"}
            </button>
            <button onClick={() => { setShowPivot(false); removePivot(); }} className="p-1 text-gray-400 hover:text-red-400">
              🗑
            </button>
          </div>
        )}
      </div>

      {/* تنظیمات SMA */}
      {smaSettings && showSMA && (
        <div className="mb-3 flex flex-wrap gap-3 bg-gray-900 border border-gray-700 rounded-lg p-3 text-sm">
          <label className="flex items-center gap-2">
            SMA1
            <input type="number" value={sma1} onChange={(e) => setSma1(Number(e.target.value) || 50)} className="w-16 bg-gray-800 rounded px-2 py-1" />
          </label>
          <label className="flex items-center gap-2">
            SMA2
            <input type="number" value={sma2} onChange={(e) => setSma2(Number(e.target.value) || 100)} className="w-16 bg-gray-800 rounded px-2 py-1" />
          </label>
          <label className="flex items-center gap-2">
            SMA3
            <input type="number" value={sma3} onChange={(e) => setSma3(Number(e.target.value) || 200)} className="w-16 bg-gray-800 rounded px-2 py-1" />
          </label>
          <button onClick={() => setSmaSettings(false)} className="text-orange-400">بستن</button>
        </div>
      )}

      <div ref={chartContainerRef} className="bg-gray-900 border border-gray-800 rounded-xl" style={{ height: "560px", touchAction: "none" }} />

      {/* آلارم‌ها و خط‌ها (خلاصه) */}
      <div className="mt-6 grid md:grid-cols-2 gap-6">
        <div>
          <h2 className="text-green-400 font-semibold mb-2">آلارم‌ها ({alarms.length})</h2>
          {alarms.map((a) => (
            <div key={a.id} className="flex justify-between bg-gray-900 rounded-lg px-3 py-2 mb-2 text-sm">
              <span>{a.symbol} {getConditionSymbol(a.condition)} {a.price}</span>
              <div className="flex gap-2">
                <button onClick={() => cycleCondition(a)} className={getConditionColor(a.condition)}>{getConditionLabel(a.condition)}</button>
                <button onClick={() => startMove(a.id, "alarm", a.price)} className="text-blue-400">جابه‌جا</button>
                <button onClick={() => deleteAlarm(a.id)} className="text-red-400">حذف</button>
              </div>
            </div>
          ))}
        </div>
        <div>
          <h2 className="text-orange-400 font-semibold mb-2">خط‌ها ({lines.length})</h2>
          {lines.map((l) => (
            <div key={l.id} className="flex justify-between bg-gray-900 rounded-lg px-3 py-2 mb-2 text-sm">
              <span>{l.price}</span>
              <div className="flex gap-2">
                <button onClick={() => startMove(l.id, "line", l.price)} className="text-blue-400">جابه‌جا</button>
                <button onClick={() => deleteLine(l.id)} className="text-red-400">حذف</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

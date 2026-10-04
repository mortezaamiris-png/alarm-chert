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

interface RRPosition {
  id: string;
  type: "long" | "short";
  entry: number;
  sl: number;
  tp: number;
  rr: number;
  entryLine?: IPriceLine;
  slLine?: IPriceLine;
  tpLine?: IPriceLine;
}

type ToolMode =
  | "none"
  | "draw"
  | "alarm"
  | "move"
  | "fib"
  | "trend"
  | "vertical"
  | "long"
  | "short";

const TIMEFRAMES = [
  { label: "1m", value: "1" },
  { label: "5m", value: "5" },
  { label: "15m", value: "15" },
  { label: "1h", value: "60" },
  { label: "4h", value: "240" },
  { label: "1D", value: "D" },
];

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#3b82f6", "#a855f7", "#ef4444"];

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

function pct(from: number, to: number) {
  if (!from) return 0;
  return Number((((to - from) / from) * 100).toFixed(2));
}

export default function DashboardPage() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const previewLineRef = useRef<IPriceLine | null>(null);
  const alarmLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const chartLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const toolLinesRef = useRef<IPriceLine[]>([]);
  const toolSeriesRef = useRef<any[]>([]);

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
  const [rrPositions, setRrPositions] = useState<RRPosition[]>([]);
  const [mode, setMode] = useState<ToolMode>("none");
  const [previewPrice, setPreviewPrice] = useState<number | null>(null);
  const [previewTime, setPreviewTime] = useState<number | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [movingType, setMovingType] = useState<"line" | "alarm" | "rr-entry" | "rr-sl" | "rr-tp" | null>(null);
  const [condition, setCondition] = useState<"above" | "below" | "cross">("above");
  const [saving, setSaving] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [toolStep, setToolStep] = useState(0);
  const [toolPoint1, setToolPoint1] = useState<{ price: number; time: number } | null>(null);
  const [rrRatio, setRrRatio] = useState(2);

  const modeRef = useRef(mode);
  const previewPriceRef = useRef(previewPrice);
  const previewTimeRef = useRef(previewTime);
  const movingIdRef = useRef(movingId);
  const movingTypeRef = useRef(movingType);
  const conditionRef = useRef(condition);
  const savingRef = useRef(saving);
  const symbolRef = useRef(symbol);
  const toolStepRef = useRef(toolStep);
  const toolPoint1Ref = useRef(toolPoint1);
  const rrRatioRef = useRef(rrRatio);
  const rrPositionsRef = useRef(rrPositions);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { previewPriceRef.current = previewPrice; }, [previewPrice]);
  useEffect(() => { previewTimeRef.current = previewTime; }, [previewTime]);
  useEffect(() => { movingIdRef.current = movingId; }, [movingId]);
  useEffect(() => { movingTypeRef.current = movingType; }, [movingType]);
  useEffect(() => { conditionRef.current = condition; }, [condition]);
  useEffect(() => { savingRef.current = saving; }, [saving]);
  useEffect(() => { symbolRef.current = symbol; }, [symbol]);
  useEffect(() => { toolStepRef.current = toolStep; }, [toolStep]);
  useEffect(() => { toolPoint1Ref.current = toolPoint1; }, [toolPoint1]);
  useEffect(() => { rrRatioRef.current = rrRatio; }, [rrRatio]);
  useEffect(() => { rrPositionsRef.current = rrPositions; }, [rrPositions]);

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
    setPreviewTime(null);
  };

  const resetMode = () => {
    setMode("none");
    setMovingId(null);
    setMovingType(null);
    setToolStep(0);
    setToolPoint1(null);
    clearPreview();
    setShowTools(false);
  };

  const clearToolDrawings = () => {
    if (seriesRef.current) {
      toolLinesRef.current.forEach((pl) => {
        try { seriesRef.current?.removePriceLine(pl); } catch {}
      });
      rrPositionsRef.current.forEach((pos) => {
        try {
          if (pos.entryLine) seriesRef.current?.removePriceLine(pos.entryLine);
          if (pos.slLine) seriesRef.current?.removePriceLine(pos.slLine);
          if (pos.tpLine) seriesRef.current?.removePriceLine(pos.tpLine);
        } catch {}
      });
    }
    toolLinesRef.current = [];
    toolSeriesRef.current.forEach((s) => {
      try { chartRef.current?.removeSeries(s); } catch {}
    });
    toolSeriesRef.current = [];
    setRrPositions([]);
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
      if (error) { alert("خطا: " + error.message); return; }
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
      if (error) { alert("خطا: " + error.message); return; }
      setAlarms((prev) => [data, ...prev]);
      resetMode();
      alert(`آلارم ذخیره شد @ ${p}`);
    } finally { setSaving(false); }
  };

  const convertLineToAlarm = async (line: ChartLine) => {
    if (savingRef.current) return;
    setSaving(true);
    try {
      const { data, error } = await supabase
        .from("alarms")
        .insert([{
          symbol: symbolRef.current.toUpperCase(),
          price: line.price,
          condition: conditionRef.current,
          is_active: true,
          triggered: false,
          repeat: false,
          note: "آلارم از خط",
        }])
        .select()
        .single();
      if (error) { alert("خطا: " + error.message); return; }
      await supabase.from("chart_lines").delete().eq("id", line.id);
      setLines((prev) => prev.filter((l) => l.id !== line.id));
      setAlarms((prev) => [data, ...prev]);
    } finally { setSaving(false); }
  };

  const updateLinePrice = async (id: string, price: number) => {
    if (savingRef.current) return;
    setSaving(true);
    try {
      const p = formatPrice(price);
      await supabase.from("chart_lines").update({ price: p }).eq("id", id);
      setLines((prev) => prev.map((l) => (l.id === id ? { ...l, price: p } : l)));
      resetMode();
    } finally { setSaving(false); }
  };

  const updateAlarmPrice = async (id: string, price: number) => {
    if (savingRef.current) return;
    setSaving(true);
    try {
      const p = formatPrice(price);
      await supabase.from("alarms").update({ price: p }).eq("id", id);
      setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, price: p } : a)));
      resetMode();
    } finally { setSaving(false); }
  };

  const updateRRPrice = (id: string, field: "entry" | "sl" | "tp", price: number) => {
    if (!seriesRef.current) return;
    const p = formatPrice(price);
    setRrPositions((prev) =>
      prev.map((pos) => {
        if (pos.id !== id) return pos;
        // حذف خطوط قبلی
        try {
          if (pos.entryLine) seriesRef.current?.removePriceLine(pos.entryLine);
          if (pos.slLine) seriesRef.current?.removePriceLine(pos.slLine);
          if (pos.tpLine) seriesRef.current?.removePriceLine(pos.tpLine);
        } catch {}

        let entry = pos.entry;
        let sl = pos.sl;
        let tp = pos.tp;
        if (field === "entry") entry = p;
        if (field === "sl") sl = p;
        if (field === "tp") tp = p;

        // اگر entry یا sl عوض شد، tp را با R:R دوباره حساب کن
        if (field === "entry" || field === "sl") {
          const risk = Math.abs(entry - sl);
          tp = pos.type === "long"
            ? formatPrice(entry + risk * pos.rr)
            : formatPrice(entry - risk * pos.rr);
        }

        const entryLine = seriesRef.current!.createPriceLine({
          price: entry,
          color: "#3b82f6",
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          title: `ورود ${entry}`,
        });
        const slPct = Math.abs(pct(entry, sl));
        const slLine = seriesRef.current!.createPriceLine({
          price: sl,
          color: "#ef4444",
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          title: `SL ${sl} (−${slPct}%)`,
        });
        const tpPct = Math.abs(pct(entry, tp));
        const tpLine = seriesRef.current!.createPriceLine({
          price: tp,
          color: "#22c55e",
          lineWidth: 2,
          lineStyle: LineStyle.Solid,
          title: `TP ${tp} (+${tpPct}%) 1:${pos.rr}`,
        });

        return { ...pos, entry, sl, tp, entryLine, slLine, tpLine };
      })
    );
    resetMode();
  };

  const cycleCondition = async (alarm: Alarm) => {
    const next = alarm.condition === "above" ? "below" : alarm.condition === "below" ? "cross" : "above";
    await supabase.from("alarms").update({ condition: next }).eq("id", alarm.id);
    setAlarms((prev) => prev.map((a) => (a.id === alarm.id ? { ...a, condition: next } : a)));
  };

  const deleteLine = async (id: string) => {
    await supabase.from("chart_lines").delete().eq("id", id);
    setLines((prev) => prev.filter((l) => l.id !== id));
  };

  const deleteAlarm = async (id: string) => {
    await supabase.from("alarms").update({ is_active: false }).eq("id", id);
    setAlarms((prev) => prev.filter((a) => a.id !== id));
  };

  const deleteRR = (id: string) => {
    setRrPositions((prev) => {
      const pos = prev.find((p) => p.id === id);
      if (pos && seriesRef.current) {
        try {
          if (pos.entryLine) seriesRef.current.removePriceLine(pos.entryLine);
          if (pos.slLine) seriesRef.current.removePriceLine(pos.slLine);
          if (pos.tpLine) seriesRef.current.removePriceLine(pos.tpLine);
        } catch {}
      }
      return prev.filter((p) => p.id !== id);
    });
  };

  const startMove = (id: string, type: "line" | "alarm" | "rr-entry" | "rr-sl" | "rr-tp", price: number) => {
    setMode("move");
    setMovingId(id);
    setMovingType(type);
    setPreviewPrice(price);
  };

  const getConditionSymbol = (c: string) => (c === "above" ? "≥" : c === "below" ? "≤" : "≈");
  const getConditionLabel = (c: string) => (c === "above" ? "بالای قیمت" : c === "below" ? "پایین قیمت" : "برخورد");
  const getConditionColor = (c: string) => (c === "above" ? "text-green-400" : c === "below" ? "text-red-400" : "text-blue-400");

  const applyFib = (high: number, low: number) => {
    if (!seriesRef.current) return;
    const diff = high - low;
    FIB_LEVELS.forEach((level, i) => {
      const price = formatPrice(high - diff * level);
      const pl = seriesRef.current!.createPriceLine({
        price,
        color: FIB_COLORS[i],
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `Fib ${level}`,
      });
      toolLinesRef.current.push(pl);
    });
  };

  const applyTrendline = (p1: { price: number; time: number }, p2: { price: number; time: number }) => {
    if (!chartRef.current) return;
    const lineSeries = chartRef.current.addLineSeries({
      color: "#a855f7",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const t1 = Math.min(p1.time, p2.time);
    const t2 = Math.max(p1.time, p2.time);
    const price1 = p1.time <= p2.time ? p1.price : p2.price;
    const price2 = p1.time <= p2.time ? p2.price : p1.price;
    lineSeries.setData([
      { time: t1 as any, value: price1 },
      { time: t2 as any, value: price2 },
    ]);
    toolSeriesRef.current.push(lineSeries);
  };

  const applyVertical = (time: number) => {
    if (!chartRef.current) return;
    const price = previewPriceRef.current || 0;
    const lineSeries = chartRef.current.addLineSeries({
      color: "#6b7280",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    lineSeries.setData([
      { time: time as any, value: price * 0.5 },
      { time: time as any, value: price * 1.5 },
    ]);
    toolSeriesRef.current.push(lineSeries);
  };

  const applyLongShort = (entry: number, sl: number, isLong: boolean) => {
    if (!seriesRef.current) return;
    const risk = Math.abs(entry - sl);
    const rr = rrRatioRef.current;
    const tp = isLong
      ? formatPrice(entry + risk * rr)
      : formatPrice(entry - risk * rr);

    const entryF = formatPrice(entry);
    const slF = formatPrice(sl);
    const slPct = Math.abs(pct(entryF, slF));
    const tpPct = Math.abs(pct(entryF, tp));

    const entryLine = seriesRef.current.createPriceLine({
      price: entryF,
      color: "#3b82f6",
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      title: `ورود ${entryF}`,
    });
    const slLine = seriesRef.current.createPriceLine({
      price: slF,
      color: "#ef4444",
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      title: `SL ${slF} (−${slPct}%)`,
    });
    const tpLine = seriesRef.current.createPriceLine({
      price: tp,
      color: "#22c55e",
      lineWidth: 2,
      lineStyle: LineStyle.Solid,
      title: `TP ${tp} (+${tpPct}%) 1:${rr}`,
    });

    const pos: RRPosition = {
      id: Date.now().toString(),
      type: isLong ? "long" : "short",
      entry: entryF,
      sl: slF,
      tp,
      rr,
      entryLine,
      slLine,
      tpLine,
    };
    setRrPositions((prev) => [...prev, pos]);
  };

  const handleToolClick = (price: number, time: number) => {
    const m = modeRef.current;
    const step = toolStepRef.current;
    const p1 = toolPoint1Ref.current;

    if (m === "fib") {
      if (step === 0) {
        setToolPoint1({ price, time });
        setToolStep(1);
      } else {
        applyFib(Math.max(p1!.price, price), Math.min(p1!.price, price));
        resetMode();
      }
    } else if (m === "trend") {
      if (step === 0) {
        setToolPoint1({ price, time });
        setToolStep(1);
      } else {
        applyTrendline(p1!, { price, time });
        resetMode();
      }
    } else if (m === "vertical") {
      applyVertical(time);
      resetMode();
    } else if (m === "long" || m === "short") {
      if (step === 0) {
        setToolPoint1({ price, time });
        setToolStep(1);
      } else {
        applyLongShort(p1!.price, price, m === "long");
        resetMode();
      }
    }
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
        if (!candles.length) return;
        const lastClose = candles[candles.length - 1].close;
        const { precision, minMove } = getPrecision(lastClose);
        seriesRef.current.applyOptions({ priceFormat: { type: "price", precision, minMove } });
        seriesRef.current.setData(candles);
        chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
        chartRef.current?.timeScale().fitContent();
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
      if (param.time) setPreviewTime(param.time as number);
      if (previewLineRef.current) seriesRef.current.removePriceLine(previewLineRef.current);
      const m = modeRef.current;
      const isTool = ["fib", "trend", "vertical", "long", "short"].includes(m);
      previewLineRef.current = seriesRef.current.createPriceLine({
        price: rounded,
        color: isTool ? "#a855f7" : m === "alarm" ? "#22c55e" : m === "move" ? "#3b82f6" : "#f97316",
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: isTool ? "ابزار" : m === "alarm" ? "آلارم" : m === "move" ? "جابه‌جایی" : "خط",
      });
    });

    chart.subscribeClick(() => {
      const m = modeRef.current;
      const price = previewPriceRef.current;
      const time = previewTimeRef.current;
      if (!price || m === "none" || savingRef.current) return;

      if (m === "draw") addLine(price);
      else if (m === "alarm") createAlarmDirect(price);
      else if (m === "move" && movingIdRef.current && movingTypeRef.current) {
        const t = movingTypeRef.current;
        if (t === "line") updateLinePrice(movingIdRef.current, price);
        else if (t === "alarm") updateAlarmPrice(movingIdRef.current, price);
        else if (t === "rr-entry") updateRRPrice(movingIdRef.current, "entry", price);
        else if (t === "rr-sl") updateRRPrice(movingIdRef.current, "sl", price);
        else if (t === "rr-tp") updateRRPrice(movingIdRef.current, "tp", price);
      } else if (["fib", "trend", "vertical", "long", "short"].includes(m)) {
        handleToolClick(price, time || Date.now() / 1000);
      }
    });

    const onResize = () => {
      if (chartContainerRef.current) chart.applyOptions({ width: chartContainerRef.current.clientWidth });
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
    clearToolDrawings();
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

  const selectTool = (tool: ToolMode) => {
    setMode(tool);
    setToolStep(0);
    setToolPoint1(null);
    setMovingId(null);
    setMovingType(null);
    clearPreview();
    setShowTools(false);
  };

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
        <div>
          <h1 className="text-2xl font-bold">چارت زنده</h1>
          <p className="text-gray-400 text-sm mt-1">ابزارها • خط • آلارم • R:R</p>
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
            onClick={() => { loadCandles(symbol, interval); loadLines(symbol); loadAlarms(symbol); }}
            className="bg-gray-700 hover:bg-gray-600 text-white px-3 py-2 rounded-lg text-sm"
          >
            برو
          </button>
          <Link href="/alerts" className="bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-lg text-sm">
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

      <div className="mb-4 flex flex-wrap items-center gap-2 relative">
        <button
          onClick={() => selectTool(mode === "draw" ? "none" : "draw")}
          className={`px-4 py-2 rounded-lg text-sm font-medium ${mode === "draw" ? "bg-orange-500 text-white" : "bg-gray-800 text-gray-300"}`}
        >
          {mode === "draw" ? "✕ خروج" : "✏️ خط"}
        </button>
        <button
          onClick={() => selectTool(mode === "alarm" ? "none" : "alarm")}
          className={`px-4 py-2 rounded-lg text-sm font-medium ${mode === "alarm" ? "bg-green-600 text-white" : "bg-gray-800 text-gray-300"}`}
        >
          {mode === "alarm" ? "✕ خروج" : "🔔 آلارم"}
        </button>

        <div className="relative">
          <button
            onClick={() => setShowTools(!showTools)}
            className={`px-4 py-2 rounded-lg text-sm font-medium ${["fib", "trend", "vertical", "long", "short"].includes(mode) ? "bg-purple-600 text-white" : "bg-gray-800 text-gray-300"}`}
          >
            🛠 ابزارها
          </button>
          {showTools && (
            <div className="absolute top-full right-0 mt-2 bg-gray-900 border border-gray-700 rounded-xl shadow-xl z-50 min-w-[220px] py-2">
              <button onClick={() => selectTool("fib")} className="w-full text-right px-4 py-2.5 hover:bg-gray-800 text-sm">📐 فیبوناچی</button>
              <button onClick={() => selectTool("trend")} className="w-full text-right px-4 py-2.5 hover:bg-gray-800 text-sm">📈 ترندلاین</button>
              <button onClick={() => selectTool("vertical")} className="w-full text-right px-4 py-2.5 hover:bg-gray-800 text-sm">📏 خط عمودی</button>
              <button onClick={() => selectTool("long")} className="w-full text-right px-4 py-2.5 hover:bg-gray-800 text-sm text-green-400">🟢 Long (R:R)</button>
              <button onClick={() => selectTool("short")} className="w-full text-right px-4 py-2.5 hover:bg-gray-800 text-sm text-red-400">🔴 Short (R:R)</button>
              <hr className="border-gray-700 my-1" />
              <button onClick={() => { clearToolDrawings(); setShowTools(false); }} className="w-full text-right px-4 py-2.5 hover:bg-gray-800 text-sm text-gray-400">پاک کردن ابزارها</button>
            </div>
          )}
        </div>

        {mode === "alarm" && (
          <select value={condition} onChange={(e) => setCondition(e.target.value as any)} className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white">
            <option value="above">بالای قیمت (≥)</option>
            <option value="below">پایین قیمت (≤)</option>
            <option value="cross">برخورد (≈)</option>
          </select>
        )}

        {(mode === "long" || mode === "short") && (
          <select value={rrRatio} onChange={(e) => setRrRatio(Number(e.target.value))} className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white">
            <option value={1}>R:R 1:1</option>
            <option value={1.5}>R:R 1:1.5</option>
            <option value={2}>R:R 1:2</option>
            <option value={3}>R:R 1:3</option>
          </select>
        )}

        {mode !== "none" && (
          <span className="text-sm text-purple-400">
            {mode === "fib" && (toolStep === 0 ? "نقطه اول را بزن" : "نقطه دوم را بزن")}
            {mode === "trend" && (toolStep === 0 ? "نقطه اول ترند" : "نقطه دوم")}
            {mode === "vertical" && "روی چارت بزن"}
            {mode === "long" && (toolStep === 0 ? "نقطه ورود Long" : "حد ضرر را بزن")}
            {mode === "short" && (toolStep === 0 ? "نقطه ورود Short" : "حد ضرر را بزن")}
            {mode === "draw" && previewPrice && `${previewPrice}`}
            {mode === "alarm" && previewPrice && `${previewPrice}`}
            {mode === "move" && "قیمت جدید را انتخاب کن"}
          </span>
        )}
      </div>

      <div ref={chartContainerRef} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden" style={{ height: "560px", touchAction: "none" }} />

      {/* پوزیشن‌های R:R */}
      {rrPositions.length > 0 && (
        <div className="mt-6">
          <h2 className="text-lg font-semibold mb-3 text-purple-400">ریسک به ریوارد ({rrPositions.length})</h2>
          <div className="space-y-2">
            {rrPositions.map((pos) => (
              <div key={pos.id} className="bg-gray-900 border border-purple-900/40 rounded-lg px-4 py-3">
                <div className="flex items-center justify-between mb-2">
                  <span className={`font-medium ${pos.type === "long" ? "text-green-400" : "text-red-400"}`}>
                    {pos.type === "long" ? "🟢 Long" : "🔴 Short"} — R:R 1:{pos.rr}
                  </span>
                  <button onClick={() => deleteRR(pos.id)} className="text-red-400 text-sm">حذف</button>
                </div>
                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div className="flex items-center justify-between bg-gray-800 rounded px-3 py-2">
                    <span className="text-blue-400">ورود {pos.entry}</span>
                    <button onClick={() => startMove(pos.id, "rr-entry", pos.entry)} className="text-blue-300 text-xs">جابه‌جا</button>
                  </div>
                  <div className="flex items-center justify-between bg-gray-800 rounded px-3 py-2">
                    <span className="text-red-400">SL {pos.sl}</span>
                    <button onClick={() => startMove(pos.id, "rr-sl", pos.sl)} className="text-blue-300 text-xs">جابه‌جا</button>
                  </div>
                  <div className="flex items-center justify-between bg-gray-800 rounded px-3 py-2">
                    <span className="text-green-400">TP {pos.tp}</span>
                    <button onClick={() => startMove(pos.id, "rr-tp", pos.tp)} className="text-blue-300 text-xs">جابه‌جا</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* آلارم‌ها */}
      <div className="mt-6">
        <h2 className="text-lg font-semibold mb-3 text-green-400">آلارم‌های فعال ({alarms.length})</h2>
        {alarms.length === 0 ? (
          <p className="text-gray-500 text-sm">آلارم فعالی نیست</p>
        ) : (
          <div className="space-y-2">
            {alarms.map((a) => (
              <div key={a.id} className="flex items-center justify-between bg-gray-900 border border-green-900/40 rounded-lg px-4 py-3">
                <span className="font-medium">
                  {a.symbol} <span className="text-orange-400">{getConditionSymbol(a.condition)} {a.price}</span>
                </span>
                <div className="flex items-center gap-3 text-sm">
                  <button onClick={() => cycleCondition(a)} className={`font-medium ${getConditionColor(a.condition)} underline`}>
                    {getConditionLabel(a.condition)}
                  </button>
                  <button onClick={() => startMove(a.id, "alarm", a.price)} className="text-blue-400">جابه‌جا</button>
                  <button onClick={() => deleteAlarm(a.id)} className="text-red-400">حذف</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* خط‌ها */}
      <div className="mt-6">
        <h2 className="text-lg font-semibold mb-3 text-orange-400">خط‌های ذخیره شده ({lines.length})</h2>
        {lines.length === 0 ? (
          <p className="text-gray-500 text-sm">خطی نیست</p>
        ) : (
          <div className="space-y-2">
            {lines.map((line) => (
              <div key={line.id} className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
                <span style={{ color: line.color }}>{symbol} @ {line.price}</span>
                <div className="flex gap-3 text-sm">
                  <button onClick={() => startMove(line.id, "line", line.price)} className="text-blue-400">جابه‌جا</button>
                  <button onClick={() => convertLineToAlarm(line)} className="text-green-400">آلارم</button>
                  <button onClick={() => deleteLine(line.id)} className="text-red-400">حذف</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

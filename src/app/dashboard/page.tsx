"use client";

import { useEffect, useRef, useState, useCallback } from "react";
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

const PIVOT_TFS = [
  { label: "1H", value: "60" },
  { label: "4H", value: "240" },
  { label: "1D", value: "D" },
  { label: "1W", value: "W" },
];

const TIMEZONES = [
  { label: "تهران", value: "Asia/Tehran" },
  { label: "UTC", value: "UTC" },
  { label: "لندن", value: "Europe/London" },
  { label: "نیویورک", value: "America/New_York" },
];

function loadLS<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const v = localStorage.getItem(key);
    return v != null ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveLS(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  localStorage.setItem(key, JSON.stringify(value));
}

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

function formatTimeTZ(time: number, timeZone: string) {
  return new Date(time * 1000).toLocaleString("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function calcSMA(candles: { time: number; close: number }[], period: number) {
  const out: { time: number; value: number }[] = [];
  const p = Math.max(1, period);
  for (let i = 0; i < candles.length; i++) {
    if (i < p - 1) continue;
    let sum = 0;
    for (let j = 0; j < p; j++) sum += candles[i - j].close;
    out.push({ time: candles[i].time, value: sum / p });
  }
  return out;
}

function calcRSI(candles: { time: number; close: number }[], period = 14) {
  const out: { time: number; value: number }[] = [];
  const p = Math.max(2, period);
  if (candles.length < p + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= p; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d >= 0) gains += d; else losses -= d;
  }
  let avgGain = gains / p, avgLoss = losses / p;
  out.push({
    time: candles[p].time,
    value: 100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss)),
  });
  for (let i = p + 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    avgGain = (avgGain * (p - 1) + (d > 0 ? d : 0)) / p;
    avgLoss = (avgLoss * (p - 1) + (d < 0 ? -d : 0)) / p;
    out.push({
      time: candles[i].time,
      value: 100 - 100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss)),
    });
  }
  return out;
}

function calcDMI(
  candles: { time: number; high: number; low: number; close: number }[],
  period = 14
) {
  const plusDI: { time: number; value: number }[] = [];
  const minusDI: { time: number; value: number }[] = [];
  const adx: { time: number; value: number }[] = [];
  const p = Math.max(2, period);
  if (candles.length < p + 2) return { plusDI, minusDI, adx };

  const tr: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    const ph = candles[i - 1].high, pl = candles[i - 1].low;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, down = pl - l;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }

  let atr = tr.slice(0, p).reduce((a, b) => a + b, 0);
  let pDM = plusDM.slice(0, p).reduce((a, b) => a + b, 0);
  let mDM = minusDM.slice(0, p).reduce((a, b) => a + b, 0);
  const dxArr: number[] = [];

  for (let i = p; i < tr.length; i++) {
    if (i > p) {
      atr = atr - atr / p + tr[i];
      pDM = pDM - pDM / p + plusDM[i];
      mDM = mDM - mDM / p + minusDM[i];
    }
    const pdi = atr === 0 ? 0 : (pDM / atr) * 100;
    const mdi = atr === 0 ? 0 : (mDM / atr) * 100;
    dxArr.push(pdi + mdi === 0 ? 0 : (Math.abs(pdi - mdi) / (pdi + mdi)) * 100);
    const t = candles[i + 1].time;
    plusDI.push({ time: t, value: pdi });
    minusDI.push({ time: t, value: mdi });
  }
  if (dxArr.length >= p) {
    let adxVal = dxArr.slice(0, p).reduce((a, b) => a + b, 0) / p;
    for (let i = p; i < dxArr.length; i++) {
      adxVal = (adxVal * (p - 1) + dxArr[i]) / p;
      adx.push({ time: plusDI[i].time, value: adxVal });
    }
  }
  return { plusDI, minusDI, adx };
}

function findPivots(candles: any[], period: number) {
  const highs: { i: number; price: number; time: number }[] = [];
  const lows: { i: number; price: number; time: number }[] = [];
  for (let i = period; i < candles.length - period; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= period; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isH = false;
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) isL = false;
    }
    if (isH) highs.push({ i, price: candles[i].high, time: candles[i].time });
    if (isL) lows.push({ i, price: candles[i].low, time: candles[i].time });
  }
  return { highs, lows };
}

export default function DashboardPage() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<any>(null);
  const previewLineRef = useRef<IPriceLine | null>(null);
  const alarmLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const chartLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const smaSeriesRef = useRef<{ s1: any; s2: any; s3: any } | null>(null);
  const rsiSeriesRef = useRef<any>(null);
  const dmiSeriesRef = useRef<{ plus: any; minus: any; adx: any } | null>(null);
  const pivotSeriesRef = useRef<any[]>([]);
  const trendSeriesRef = useRef<any[]>([]);
  const candlesRef = useRef<any[]>([]);

  const [symbol, setSymbol] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem("chart_symbol") || "BTCUSDT" : "BTCUSDT"
  );
  const [interval, setIntervalTf] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem("chart_interval") || "60" : "60"
  );
  const [timeZone, setTimeZone] = useState(() => loadLS("chart_tz", "Asia/Tehran"));

  const [lines, setLines] = useState<ChartLine[]>([]);
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [mode, setMode] = useState<ToolMode>("none");
  const [previewPrice, setPreviewPrice] = useState<number | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [movingType, setMovingType] = useState<"line" | "alarm" | null>(null);
  const [condition, setCondition] = useState<"above" | "below" | "cross">("above");
  const [saving, setSaving] = useState(false);
  const [showIndicatorMenu, setShowIndicatorMenu] = useState(false);

  // SMA
  const [showSMA, setShowSMA] = useState(() => loadLS("ind_sma", false));
  const [smaVisible, setSmaVisible] = useState(true);
  const [smaSettings, setSmaSettings] = useState(false);
  const [sma1, setSma1] = useState(() => loadLS("sma1", 50));
  const [sma2, setSma2] = useState(() => loadLS("sma2", 100));
  const [sma3, setSma3] = useState(() => loadLS("sma3", 200));
  const [sma1Str, setSma1Str] = useState(() => String(loadLS("sma1", 50)));
  const [sma2Str, setSma2Str] = useState(() => String(loadLS("sma2", 100)));
  const [sma3Str, setSma3Str] = useState(() => String(loadLS("sma3", 200)));
  const [smaColor1, setSmaColor1] = useState(() => loadLS("smaC1", "#ef4444"));
  const [smaColor2, setSmaColor2] = useState(() => loadLS("smaC2", "#eab308"));
  const [smaColor3, setSmaColor3] = useState(() => loadLS("smaC3", "#a855f7"));

  // Pivot
  const [showPivot, setShowPivot] = useState(() => loadLS("ind_pivot", false));
  const [pivotVisible, setPivotVisible] = useState(true);
  const [pivotSettings, setPivotSettings] = useState(false);
  const [pivotTf, setPivotTf] = useState(() => loadLS("pivot_tf", "D"));
  const [pivotFib, setPivotFib] = useState(() => loadLS("pivot_fib", false));
  const [pivotHistory, setPivotHistory] = useState(() => loadLS("pivot_hist", false));
  const [pivotHistCount, setPivotHistCount] = useState(() => loadLS("pivot_hist_n", 2));

  // RSI
  const [showRSI, setShowRSI] = useState(() => loadLS("ind_rsi", false));
  const [rsiVisible, setRsiVisible] = useState(true);
  const [rsiSettings, setRsiSettings] = useState(false);
  const [rsiPeriod, setRsiPeriod] = useState(() => loadLS("rsi_p", 14));
  const [rsiPeriodStr, setRsiPeriodStr] = useState(() => String(loadLS("rsi_p", 14)));
  const [rsiColor, setRsiColor] = useState(() => loadLS("rsi_c", "#c084fc"));
  const [rsiHeight, setRsiHeight] = useState(() => loadLS("rsi_h", 18));

  // DMI
  const [showDMI, setShowDMI] = useState(() => loadLS("ind_dmi", false));
  const [dmiVisible, setDmiVisible] = useState(true);
  const [dmiSettings, setDmiSettings] = useState(false);
  const [dmiPeriod, setDmiPeriod] = useState(() => loadLS("dmi_p", 14));
  const [dmiPeriodStr, setDmiPeriodStr] = useState(() => String(loadLS("dmi_p", 14)));
  const [dmiPlusColor, setDmiPlusColor] = useState(() => loadLS("dmi_pc", "#22c55e"));
  const [dmiMinusColor, setDmiMinusColor] = useState(() => loadLS("dmi_mc", "#ef4444"));
  const [dmiAdxColor, setDmiAdxColor] = useState(() => loadLS("dmi_ac", "#3b82f6"));
  const [dmiHeight, setDmiHeight] = useState(() => loadLS("dmi_h", 16));

  // Volume
  const [showVol, setShowVol] = useState(() => loadLS("ind_vol", true));
  const [volVisible, setVolVisible] = useState(true);

  // Trend Line (AdamMoradi style)
  const [showTrend, setShowTrend] = useState(() => loadLS("ind_trend", false));
  const [trendVisible, setTrendVisible] = useState(true);
  const [trendSettings, setTrendSettings] = useState(false);
  const [trendPeriod, setTrendPeriod] = useState(() => loadLS("trend_p", 24));
  const [trendPeriodStr, setTrendPeriodStr] = useState(() => String(loadLS("trend_p", 24)));
  const [trendUpColor, setTrendUpColor] = useState(() => loadLS("trend_up", "#84cc16"));
  const [trendDownColor, setTrendDownColor] = useState(() => loadLS("trend_dn", "#ef4444"));
  const [trendMax, setTrendMax] = useState(() => loadLS("trend_max", 3));

  // persist
  useEffect(() => { saveLS("ind_sma", showSMA); }, [showSMA]);
  useEffect(() => { saveLS("sma1", sma1); saveLS("sma2", sma2); saveLS("sma3", sma3); }, [sma1, sma2, sma3]);
  useEffect(() => { saveLS("smaC1", smaColor1); saveLS("smaC2", smaColor2); saveLS("smaC3", smaColor3); }, [smaColor1, smaColor2, smaColor3]);
  useEffect(() => {
    saveLS("ind_pivot", showPivot);
    saveLS("pivot_tf", pivotTf);
    saveLS("pivot_fib", pivotFib);
    saveLS("pivot_hist", pivotHistory);
    saveLS("pivot_hist_n", pivotHistCount);
  }, [showPivot, pivotTf, pivotFib, pivotHistory, pivotHistCount]);
  useEffect(() => {
    saveLS("ind_rsi", showRSI);
    saveLS("rsi_p", rsiPeriod);
    saveLS("rsi_c", rsiColor);
    saveLS("rsi_h", rsiHeight);
  }, [showRSI, rsiPeriod, rsiColor, rsiHeight]);
  useEffect(() => {
    saveLS("ind_dmi", showDMI);
    saveLS("dmi_p", dmiPeriod);
    saveLS("dmi_pc", dmiPlusColor);
    saveLS("dmi_mc", dmiMinusColor);
    saveLS("dmi_ac", dmiAdxColor);
    saveLS("dmi_h", dmiHeight);
  }, [showDMI, dmiPeriod, dmiPlusColor, dmiMinusColor, dmiAdxColor, dmiHeight]);
  useEffect(() => { saveLS("ind_vol", showVol); }, [showVol]);
  useEffect(() => {
    saveLS("ind_trend", showTrend);
    saveLS("trend_p", trendPeriod);
    saveLS("trend_up", trendUpColor);
    saveLS("trend_dn", trendDownColor);
    saveLS("trend_max", trendMax);
  }, [showTrend, trendPeriod, trendUpColor, trendDownColor, trendMax]);
  useEffect(() => { saveLS("chart_tz", timeZone); }, [timeZone]);
  useEffect(() => { localStorage.setItem("chart_symbol", symbol); }, [symbol]);
  useEffect(() => { localStorage.setItem("chart_interval", interval); }, [interval]);

  const modeRef = useRef(mode);
  const previewPriceRef = useRef(previewPrice);
  const movingIdRef = useRef(movingId);
  const movingTypeRef = useRef(movingType);
  const conditionRef = useRef(condition);
  const savingRef = useRef(saving);
  const symbolRef = useRef(symbol);
  const timeZoneRef = useRef(timeZone);
  const showRSIRef = useRef(showRSI);
  const showDMIRef = useRef(showDMI);
  const showVolRef = useRef(showVol);
  const rsiHeightRef = useRef(rsiHeight);
  const dmiHeightRef = useRef(dmiHeight);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { previewPriceRef.current = previewPrice; }, [previewPrice]);
  useEffect(() => { movingIdRef.current = movingId; }, [movingId]);
  useEffect(() => { movingTypeRef.current = movingType; }, [movingType]);
  useEffect(() => { conditionRef.current = condition; }, [condition]);
  useEffect(() => { savingRef.current = saving; }, [saving]);
  useEffect(() => { symbolRef.current = symbol; }, [symbol]);
  useEffect(() => { timeZoneRef.current = timeZone; }, [timeZone]);
  useEffect(() => { showRSIRef.current = showRSI; }, [showRSI]);
  useEffect(() => { showDMIRef.current = showDMI; }, [showDMI]);
  useEffect(() => { showVolRef.current = showVol; }, [showVol]);
  useEffect(() => { rsiHeightRef.current = rsiHeight; }, [rsiHeight]);
  useEffect(() => { dmiHeightRef.current = dmiHeight; }, [dmiHeight]);

  const updateMargins = useCallback(() => {
    if (!chartRef.current) return;
    const rsiOn = showRSIRef.current;
    const dmiOn = showDMIRef.current;
    const volOn = showVolRef.current;
    const rh = rsiHeightRef.current / 100;
    const dh = dmiHeightRef.current / 100;
    let bottom = volOn ? 0.12 : 0.06;
    if (rsiOn && dmiOn) bottom = rh + dh + 0.04;
    else if (rsiOn) bottom = rh + 0.04;
    else if (dmiOn) bottom = dh + 0.04;
    if (volOn && (rsiOn || dmiOn)) bottom += 0.06;
    chartRef.current.priceScale("right").applyOptions({ scaleMargins: { top: 0.04, bottom } });
  }, []);

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
    const next =
      alarm.condition === "above" ? "below" : alarm.condition === "below" ? "cross" : "above";
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
  const getConditionLabel = (c: string) =>
    c === "above" ? "بالای قیمت" : c === "below" ? "پایین قیمت" : "برخورد";
  const getConditionColor = (c: string) =>
    c === "above" ? "text-green-400" : c === "below" ? "text-red-400" : "text-blue-400";

  // ——— SMA ———
  const removeSMA = () => {
    if (!chartRef.current || !smaSeriesRef.current) return;
    try {
      chartRef.current.removeSeries(smaSeriesRef.current.s1);
      chartRef.current.removeSeries(smaSeriesRef.current.s2);
      chartRef.current.removeSeries(smaSeriesRef.current.s3);
    } catch {}
    smaSeriesRef.current = null;
  };

  const applySMA = (candles: any[]) => {
    if (!chartRef.current) return;
    removeSMA();
    if (!showSMA || !smaVisible || !candles.length) return;
    const s1 = chartRef.current.addLineSeries({ color: smaColor1, lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    const s2 = chartRef.current.addLineSeries({ color: smaColor2, lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    const s3 = chartRef.current.addLineSeries({ color: smaColor3, lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    s1.setData(calcSMA(candles, sma1) as any);
    s2.setData(calcSMA(candles, sma2) as any);
    s3.setData(calcSMA(candles, sma3) as any);
    smaSeriesRef.current = { s1, s2, s3 };
  };

  // ——— Pivot (کوتاه + تاریخچه) ———
  const removePivot = () => {
    if (!chartRef.current) return;
    pivotSeriesRef.current.forEach((s) => {
      try { chartRef.current?.removeSeries(s); } catch {}
    });
    pivotSeriesRef.current = [];
  };

  const applyPivot = async (sym: string, candles: any[]) => {
    if (!chartRef.current || !candles.length) return;
    removePivot();
    if (!showPivot || !pivotVisible) return;

    try {
      const res = await fetch(
        `https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=${pivotTf}&limit=10`
      );
      const data = await res.json();
      const list = data.result?.list;
      if (!list || list.length < 2) return;

      const barSec =
        interval === "1" ? 60 : interval === "5" ? 300 : interval === "15" ? 900 :
        interval === "60" ? 3600 : interval === "240" ? 14400 : 86400;
      const lastT = candles[candles.length - 1].time as number;
      const periods = pivotHistory ? 1 + pivotHistCount : 1;

      for (let i = 1; i <= periods && i < list.length; i++) {
        const bar = list[i];
        const high = parseFloat(bar[2]);
        const low = parseFloat(bar[3]);
        const close = parseFloat(bar[4]);
        const range = high - low;
        const pp = (high + low + close) / 3;
        const r1 = 2 * pp - low;
        const r2 = pp + range;
        const r3 = r1 + range;
        const r4 = r3 + (r2 - r1);
        const s1 = 2 * pp - high;
        const s2 = pp - range;
        const s3 = s1 - range;
        const s4 = s3 - (s1 - s2);

        const isCurrent = i === 1;
        const alpha = isCurrent ? 1 : 0.45;
        const half = barSec * (isCurrent ? 5 : 3);
        // جابه‌جایی کمی برای دوره‌های قبلی
        const offset = (i - 1) * barSec * 8;
        const t0 = lastT - half - offset;
        const t1 = lastT + half - offset;

        let levels = [
          { price: r3, color: isCurrent ? "#67e8f9" : `rgba(103,232,249,${alpha})` },
          { price: r2, color: isCurrent ? "#22d3ee" : `rgba(34,211,238,${alpha})` },
          { price: r1, color: isCurrent ? "#06b6d4" : `rgba(6,182,212,${alpha})` },
          { price: pp, color: isCurrent ? "#ffffff" : `rgba(255,255,255,${alpha})` },
          { price: s1, color: isCurrent ? "#e879f9" : `rgba(232,121,249,${alpha})` },
          { price: s2, color: isCurrent ? "#d946ef" : `rgba(217,70,239,${alpha})` },
          { price: s3, color: isCurrent ? "#c026d3" : `rgba(192,38,211,${alpha})` },
        ];
        if (pivotFib) {
          levels.push(
            { price: r4, color: isCurrent ? "#a5f3fc" : `rgba(165,243,252,${alpha})` },
            { price: s4, color: isCurrent ? "#f0abfc" : `rgba(240,171,252,${alpha})` }
          );
        }

        levels.forEach((lv) => {
          const s = chartRef.current!.addLineSeries({
            color: lv.color,
            lineWidth: isCurrent ? 2 : 1,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          });
          s.setData([
            { time: t0 as any, value: formatPrice(lv.price) },
            { time: t1 as any, value: formatPrice(lv.price) },
          ]);
          pivotSeriesRef.current.push(s);
        });
      }
    } catch (e) {
      console.error(e);
    }
  };

  // ——— Trend Line (AdamMoradi style) ———
  const removeTrend = () => {
    if (!chartRef.current) return;
    trendSeriesRef.current.forEach((s) => {
      try { chartRef.current?.removeSeries(s); } catch {}
    });
    trendSeriesRef.current = [];
  };

  const applyTrend = (candles: any[]) => {
    if (!chartRef.current) return;
    removeTrend();
    if (!showTrend || !trendVisible || candles.length < trendPeriod * 2 + 5) return;

    const { highs, lows } = findPivots(candles, Math.max(5, trendPeriod));
    const maxL = Math.max(1, trendMax);

    // خطوط صعودی از lows
    let upCount = 0;
    for (let a = lows.length - 1; a >= 0 && upCount < maxL; a--) {
      for (let b = a - 1; b >= 0 && upCount < maxL; b--) {
        const p1 = lows[b];
        const p2 = lows[a];
        if (p2.price <= p1.price) continue;
        const slope = (p2.price - p1.price) / (p2.i - p1.i);
        let valid = true;
        for (let k = p1.i + 1; k < candles.length; k++) {
          const lineVal = p1.price + slope * (k - p1.i);
          if (candles[k].close < lineVal * 0.998) {
            valid = false;
            break;
          }
        }
        if (valid) {
          const endI = candles.length - 1;
          const endPrice = p1.price + slope * (endI - p1.i);
          const s = chartRef.current!.addLineSeries({
            color: trendUpColor,
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          });
          s.setData([
            { time: p1.time as any, value: p1.price },
            { time: candles[endI].time as any, value: endPrice },
          ]);
          trendSeriesRef.current.push(s);
          upCount++;
          break;
        }
      }
    }

    // خطوط نزولی از highs
    let dnCount = 0;
    for (let a = highs.length - 1; a >= 0 && dnCount < maxL; a--) {
      for (let b = a - 1; b >= 0 && dnCount < maxL; b--) {
        const p1 = highs[b];
        const p2 = highs[a];
        if (p2.price >= p1.price) continue;
        const slope = (p2.price - p1.price) / (p2.i - p1.i);
        let valid = true;
        for (let k = p1.i + 1; k < candles.length; k++) {
          const lineVal = p1.price + slope * (k - p1.i);
          if (candles[k].close > lineVal * 1.002) {
            valid = false;
            break;
          }
        }
        if (valid) {
          const endI = candles.length - 1;
          const endPrice = p1.price + slope * (endI - p1.i);
          const s = chartRef.current!.addLineSeries({
            color: trendDownColor,
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          });
          s.setData([
            { time: p1.time as any, value: p1.price },
            { time: candles[endI].time as any, value: endPrice },
          ]);
          trendSeriesRef.current.push(s);
          dnCount++;
          break;
        }
      }
    }
  };

  // ——— RSI ———
  const removeRSI = () => {
    if (!chartRef.current || !rsiSeriesRef.current) return;
    try { chartRef.current.removeSeries(rsiSeriesRef.current); } catch {}
    rsiSeriesRef.current = null;
  };

  const applyRSI = (candles: any[]) => {
    if (!chartRef.current) return;
    removeRSI();
    if (!showRSI || !rsiVisible || !candles.length) return;
    const both = showRSI && showDMI;
    const rh = rsiHeight / 100;
    const dh = dmiHeight / 100;
    const s = chartRef.current.addLineSeries({
      color: rsiColor,
      lineWidth: 2,
      priceScaleId: "rsi",
      priceLineVisible: false,
      lastValueVisible: true,
    });
    chartRef.current.priceScale("rsi").applyOptions({
      scaleMargins: both
        ? { top: 1 - rh - dh - 0.02, bottom: dh + 0.02 }
        : { top: 1 - rh - 0.02, bottom: 0.02 },
      borderVisible: false,
    });
    s.setData(calcRSI(candles, rsiPeriod) as any);
    try {
      s.createPriceLine({ price: 70, color: "#ffffff", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
      s.createPriceLine({ price: 30, color: "#ffffff", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
    } catch {}
    rsiSeriesRef.current = s;
    updateMargins();
  };

  // ——— DMI ———
  const removeDMI = () => {
    if (!chartRef.current || !dmiSeriesRef.current) return;
    try {
      chartRef.current.removeSeries(dmiSeriesRef.current.plus);
      chartRef.current.removeSeries(dmiSeriesRef.current.minus);
      chartRef.current.removeSeries(dmiSeriesRef.current.adx);
    } catch {}
    dmiSeriesRef.current = null;
  };

  const applyDMI = (candles: any[]) => {
    if (!chartRef.current) return;
    removeDMI();
    if (!showDMI || !dmiVisible || !candles.length) return;
    const both = showRSI && showDMI;
    const dh = dmiHeight / 100;
    const { plusDI, minusDI, adx } = calcDMI(candles, dmiPeriod);
    const plus = chartRef.current.addLineSeries({ color: dmiPlusColor, lineWidth: 1, priceScaleId: "dmi", priceLineVisible: false, lastValueVisible: false });
    const minus = chartRef.current.addLineSeries({ color: dmiMinusColor, lineWidth: 1, priceScaleId: "dmi", priceLineVisible: false, lastValueVisible: false });
    const adxS = chartRef.current.addLineSeries({ color: dmiAdxColor, lineWidth: 2, priceScaleId: "dmi", priceLineVisible: false, lastValueVisible: true });
    chartRef.current.priceScale("dmi").applyOptions({
      scaleMargins: both ? { top: 1 - dh - 0.01, bottom: 0.01 } : { top: 1 - dh - 0.02, bottom: 0.02 },
      borderVisible: false,
    });
    plus.setData(plusDI as any);
    minus.setData(minusDI as any);
    adxS.setData(adx as any);
    dmiSeriesRef.current = { plus, minus, adx: adxS };
    updateMargins();
  };

  // ——— Volume ———
  const removeVol = () => {
    if (!chartRef.current || !volumeSeriesRef.current) return;
    try { chartRef.current.removeSeries(volumeSeriesRef.current); } catch {}
    volumeSeriesRef.current = null;
  };

  const applyVol = (candles: any[]) => {
    if (!chartRef.current) return;
    removeVol();
    if (!showVol || !volVisible || !candles.length) return;
    const vol = chartRef.current.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    chartRef.current.priceScale("vol").applyOptions({
      scaleMargins: { top: 0.85, bottom: 0 },
      borderVisible: false,
    });
    vol.setData(
      candles.map((c: any) => ({
        time: c.time,
        value: c.volume || 0,
        color: c.close >= c.open ? "rgba(34,197,94,0.5)" : "rgba(239,68,68,0.5)",
      })) as any
    );
    volumeSeriesRef.current = vol;
    updateMargins();
  };

  const loadCandles = async (sym: string, tf: string) => {
    try {
      const res = await fetch(
        `https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=${tf}&limit=300`
      );
      const data = await res.json();
      if (!data.result?.list?.length || !seriesRef.current) return;

      const candles = data.result.list
        .map((item: any) => ({
          time: Number(item[0]) / 1000,
          open: parseFloat(item[1]),
          high: parseFloat(item[2]),
          low: parseFloat(item[3]),
          close: parseFloat(item[4]),
          volume: parseFloat(item[5]),
        }))
        .reverse();
      if (!candles.length) return;

      candlesRef.current = candles;
      const lastClose = candles[candles.length - 1].close;
      const { precision, minMove } = getPrecision(lastClose);
      seriesRef.current.applyOptions({
        priceFormat: { type: "price", precision, minMove },
      });
      seriesRef.current.setData(candles);
      // ریست مقیاس برای نماد جدید
      chartRef.current?.priceScale("right").applyOptions({ autoScale: true });
      chartRef.current?.timeScale().fitContent();
      updateMargins();

      applySMA(candles);
      applyRSI(candles);
      applyDMI(candles);
      applyVol(candles);
      applyPivot(sym, candles);
      applyTrend(candles);
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

  // ساخت چارت یک‌بار
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: { background: { color: "#0f0f0f" }, textColor: "#d1d5db" },
      grid: { vertLines: { color: "#1f2937" }, horzLines: { color: "#1f2937" } },
      width: chartContainerRef.current.clientWidth,
      height: 700,
      timeScale: { timeVisible: true, secondsVisible: false, borderVisible: true },
      localization: {
        locale: "en-GB",
        timeFormatter: (t: number) => formatTimeTZ(t, timeZoneRef.current),
      },
      rightPriceScale: {
        autoScale: true,
        scaleMargins: { top: 0.04, bottom: 0.12 },
        borderVisible: false,
      },
      crosshair: {
        mode: 0,
        horzLine: { visible: true, labelVisible: true, style: LineStyle.Dashed, width: 1, color: "#f97316" },
        vertLine: { visible: true, labelVisible: true, style: LineStyle.Dashed, width: 1, color: "#6b7280" },
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
      if (chartContainerRef.current)
        chart.applyOptions({ width: chartContainerRef.current.clientWidth });
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
    if (!chartRef.current) return;
    chartRef.current.applyOptions({
      localization: {
        locale: "en-GB",
        timeFormatter: (t: number) => formatTimeTZ(t, timeZone),
      },
    });
  }, [timeZone]);

  // تایم‌فریم
  useEffect(() => {
    resetMode();
    loadCandles(symbol, interval);
  }, [interval]);

  // نماد — بدون دکمه برو (با تأخیر)
  useEffect(() => {
    if (symbol.length < 5) return;
    const t = setTimeout(() => {
      resetMode();
      loadCandles(symbol, interval);
      loadLines(symbol);
      loadAlarms(symbol);
    }, 500);
    return () => clearTimeout(t);
  }, [symbol]);

  useEffect(() => {
    if (candlesRef.current.length) applySMA(candlesRef.current);
  }, [showSMA, smaVisible, sma1, sma2, sma3, smaColor1, smaColor2, smaColor3]);

  useEffect(() => {
    if (candlesRef.current.length) applyRSI(candlesRef.current);
    else updateMargins();
  }, [showRSI, rsiVisible, rsiPeriod, rsiColor, rsiHeight, showDMI, dmiHeight]);

  useEffect(() => {
    if (candlesRef.current.length) applyDMI(candlesRef.current);
    else updateMargins();
  }, [showDMI, dmiVisible, dmiPeriod, dmiPlusColor, dmiMinusColor, dmiAdxColor, dmiHeight, showRSI, rsiHeight]);

  useEffect(() => {
    if (candlesRef.current.length) applyVol(candlesRef.current);
    else updateMargins();
  }, [showVol, volVisible]);

  useEffect(() => {
    if (candlesRef.current.length) applyPivot(symbol, candlesRef.current);
  }, [showPivot, pivotVisible, pivotTf, pivotFib, pivotHistory, pivotHistCount, symbol, interval]);

  useEffect(() => {
    if (candlesRef.current.length) applyTrend(candlesRef.current);
  }, [showTrend, trendVisible, trendPeriod, trendUpColor, trendDownColor, trendMax]);

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

  const IndChip = ({
    label, visible, onToggleVisible, onSettings, onRemove,
  }: {
    label: string;
    visible: boolean;
    onToggleVisible: () => void;
    onSettings?: () => void;
    onRemove: () => void;
  }) => (
    <div className="flex items-center gap-1 bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-sm">
      <span className="text-gray-200">{label}</span>
      <button type="button" onClick={onToggleVisible} className="p-1 text-gray-400">
        {visible ? "👁" : "🚫"}
      </button>
      {onSettings && (
        <button type="button" onClick={onSettings} className="p-1 text-gray-400">⚙</button>
      )}
      <button type="button" onClick={onRemove} className="p-1 text-gray-400 hover:text-red-400">🗑</button>
    </div>
  );

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
        <h1 className="text-2xl font-bold">چارت زنده</h1>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={timeZone}
            onChange={(e) => setTimeZone(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-2 text-sm text-white"
          >
            {TIMEZONES.map((z) => (
              <option key={z.value} value={z.value}>{z.label}</option>
            ))}
          </select>
          <input
            type="text"
            value={symbol}
            onChange={(e) =>
              setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
            }
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white w-32"
            placeholder="BTCUSDT"
          />
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
            className={`px-3 py-1.5 rounded text-sm ${
              interval === tf.value ? "bg-orange-500 text-white" : "bg-gray-800 text-gray-300"
            }`}
          >
            {tf.label}
          </button>
        ))}
      </div>

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
        <div className="relative">
          <button
            onClick={() => setShowIndicatorMenu(!showIndicatorMenu)}
            className="px-3 py-2 rounded-lg text-sm bg-gray-800"
          >
            📊 اندیکاتور
          </button>
          {showIndicatorMenu && (
            <div className="absolute top-full right-0 mt-2 bg-gray-900 border border-gray-700 rounded-xl z-50 min-w-[180px] py-2 shadow-xl">
              <button onClick={() => { setShowSMA(true); setShowIndicatorMenu(false); }} className="w-full text-right px-4 py-2 hover:bg-gray-800 text-sm">3SMA</button>
              <button onClick={() => { setShowPivot(true); setShowIndicatorMenu(false); }} className="w-full text-right px-4 py-2 hover:bg-gray-800 text-sm">Pivot</button>
              <button onClick={() => { setShowTrend(true); setShowIndicatorMenu(false); }} className="w-full text-right px-4 py-2 hover:bg-gray-800 text-sm">Trend Line</button>
              <button onClick={() => { setShowRSI(true); setShowIndicatorMenu(false); }} className="w-full text-right px-4 py-2 hover:bg-gray-800 text-sm">RSI</button>
              <button onClick={() => { setShowDMI(true); setShowIndicatorMenu(false); }} className="w-full text-right px-4 py-2 hover:bg-gray-800 text-sm">DMI</button>
              <button onClick={() => { setShowVol(true); setShowIndicatorMenu(false); }} className="w-full text-right px-4 py-2 hover:bg-gray-800 text-sm">Volume</button>
            </div>
          )}
        </div>
        {mode === "alarm" && (
          <select
            value={condition}
            onChange={(e) => setCondition(e.target.value as any)}
            className="bg-gray-800 rounded-lg px-2 py-2 text-sm"
          >
            <option value="above">بالا</option>
            <option value="below">پایین</option>
            <option value="cross">برخورد</option>
          </select>
        )}
      </div>

      <div className="mb-2 flex flex-wrap gap-2">
        {showSMA && (
          <IndChip label="3SMA" visible={smaVisible} onToggleVisible={() => setSmaVisible(!smaVisible)}
            onSettings={() => setSmaSettings(!smaSettings)}
            onRemove={() => { setShowSMA(false); removeSMA(); setSmaSettings(false); }} />
        )}
        {showPivot && (
          <IndChip label="Pivot" visible={pivotVisible} onToggleVisible={() => setPivotVisible(!pivotVisible)}
            onSettings={() => setPivotSettings(!pivotSettings)}
            onRemove={() => { setShowPivot(false); removePivot(); setPivotSettings(false); }} />
        )}
        {showTrend && (
          <IndChip label="Trend" visible={trendVisible} onToggleVisible={() => setTrendVisible(!trendVisible)}
            onSettings={() => setTrendSettings(!trendSettings)}
            onRemove={() => { setShowTrend(false); removeTrend(); setTrendSettings(false); }} />
        )}
        {showRSI && (
          <IndChip label="RSI" visible={rsiVisible} onToggleVisible={() => setRsiVisible(!rsiVisible)}
            onSettings={() => setRsiSettings(!rsiSettings)}
            onRemove={() => { setShowRSI(false); removeRSI(); setRsiSettings(false); }} />
        )}
        {showDMI && (
          <IndChip label="DMI" visible={dmiVisible} onToggleVisible={() => setDmiVisible(!dmiVisible)}
            onSettings={() => setDmiSettings(!dmiSettings)}
            onRemove={() => { setShowDMI(false); removeDMI(); setDmiSettings(false); }} />
        )}
        {showVol && (
          <IndChip label="Vol" visible={volVisible} onToggleVisible={() => setVolVisible(!volVisible)}
            onRemove={() => { setShowVol(false); removeVol(); }} />
        )}
      </div>

      {/* SMA settings */}
      {smaSettings && showSMA && (
        <div className="mb-3 bg-gray-900 border border-gray-700 rounded-lg p-3 space-y-2 text-sm">
          {[
            { label: "SMA1", str: sma1Str, setStr: setSma1Str, setVal: setSma1, col: smaColor1, setCol: setSmaColor1, cur: sma1 },
            { label: "SMA2", str: sma2Str, setStr: setSma2Str, setVal: setSma2, col: smaColor2, setCol: setSmaColor2, cur: sma2 },
            { label: "SMA3", str: sma3Str, setStr: setSma3Str, setVal: setSma3, col: smaColor3, setCol: setSmaColor3, cur: sma3 },
          ].map((row) => (
            <div key={row.label} className="flex flex-wrap items-center gap-3">
              <span className="w-12">{row.label}</span>
              <input
                type="text"
                inputMode="numeric"
                value={row.str}
                onChange={(e) => row.setStr(e.target.value.replace(/[^\d]/g, ""))}
                onBlur={() => {
                  const n = parseInt(row.str, 10);
                  if (!isNaN(n) && n >= 1) { row.setVal(n); row.setStr(String(n)); }
                  else row.setStr(String(row.cur));
                }}
                className="w-20 bg-gray-800 rounded px-2 py-1.5 text-white"
              />
              <input type="color" value={row.col} onChange={(e) => row.setCol(e.target.value)} className="w-10 h-8 rounded" />
            </div>
          ))}
          <button type="button" onClick={() => setSmaSettings(false)} className="text-orange-400">بستن</button>
        </div>
      )}

      {/* Pivot settings */}
      {pivotSettings && showPivot && (
        <div className="mb-3 bg-gray-900 border border-gray-700 rounded-lg p-3 space-y-2 text-sm">
          <div className="flex flex-wrap gap-2 items-center">
            <span>تایم‌فریم:</span>
            {PIVOT_TFS.map((tf) => (
              <button
                key={tf.value}
                type="button"
                onClick={() => setPivotTf(tf.value)}
                className={`px-2 py-1 rounded ${pivotTf === tf.value ? "bg-orange-500" : "bg-gray-800"}`}
              >
                {tf.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={pivotFib} onChange={(e) => setPivotFib(e.target.checked)} />
            R4 / S4
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={pivotHistory} onChange={(e) => setPivotHistory(e.target.checked)} />
            دوره‌های قبلی
          </label>
          {pivotHistory && (
            <label className="flex items-center gap-2">
              تعداد:
              <select
                value={pivotHistCount}
                onChange={(e) => setPivotHistCount(Number(e.target.value))}
                className="bg-gray-800 rounded px-2 py-1"
              >
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </select>
            </label>
          )}
          <button type="button" onClick={() => setPivotSettings(false)} className="text-orange-400">بستن</button>
        </div>
      )}

      {/* Trend settings */}
      {trendSettings && showTrend && (
        <div className="mb-3 bg-gray-900 border border-gray-700 rounded-lg p-3 space-y-2 text-sm">
          <div className="flex flex-wrap gap-3 items-center">
            <span>دوره پیوت</span>
            <input
              type="text"
              inputMode="numeric"
              value={trendPeriodStr}
              onChange={(e) => {
                const v = e.target.value.replace(/[^\d]/g, "");
                setTrendPeriodStr(v);
                const n = parseInt(v, 10);
                if (!isNaN(n) && n >= 5) setTrendPeriod(n);
              }}
              className="w-16 bg-gray-800 rounded px-2 py-1.5"
            />
          </div>
          <div className="flex flex-wrap gap-4 items-center">
            <label className="flex items-center gap-2">
              صعودی
              <input type="color" value={trendUpColor} onChange={(e) => setTrendUpColor(e.target.value)} className="w-8 h-7 rounded" />
            </label>
            <label className="flex items-center gap-2">
              نزولی
              <input type="color" value={trendDownColor} onChange={(e) => setTrendDownColor(e.target.value)} className="w-8 h-7 rounded" />
            </label>
          </div>
          <label className="flex items-center gap-2">
            حداکثر خط:
            <select
              value={trendMax}
              onChange={(e) => setTrendMax(Number(e.target.value))}
              className="bg-gray-800 rounded px-2 py-1"
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </label>
          <button type="button" onClick={() => setTrendSettings(false)} className="text-orange-400">بستن</button>
        </div>
      )}

      {/* RSI settings */}
      {rsiSettings && showRSI && (
        <div className="mb-3 bg-gray-900 border border-gray-700 rounded-lg p-3 space-y-2 text-sm">
          <div className="flex flex-wrap gap-3 items-center">
            <span>دوره</span>
            <input
              type="text"
              inputMode="numeric"
              value={rsiPeriodStr}
              onChange={(e) => {
                const v = e.target.value.replace(/[^\d]/g, "");
                setRsiPeriodStr(v);
                const n = parseInt(v, 10);
                if (!isNaN(n) && n >= 2) setRsiPeriod(n);
              }}
              className="w-16 bg-gray-800 rounded px-2 py-1.5"
            />
            <input type="color" value={rsiColor} onChange={(e) => setRsiColor(e.target.value)} className="w-10 h-8 rounded" />
          </div>
          <label className="flex items-center gap-2">
            ارتفاع پنل
            <input type="range" min={10} max={35} value={rsiHeight} onChange={(e) => setRsiHeight(Number(e.target.value))} className="w-32" />
            <span>{rsiHeight}%</span>
          </label>
          <button type="button" onClick={() => setRsiSettings(false)} className="text-orange-400">بستن</button>
        </div>
      )}

      {/* DMI settings */}
      {dmiSettings && showDMI && (
        <div className="mb-3 bg-gray-900 border border-gray-700 rounded-lg p-3 space-y-2 text-sm">
          <div className="flex flex-wrap gap-3 items-center">
            <span>دوره</span>
            <input
              type="text"
              inputMode="numeric"
              value={dmiPeriodStr}
              onChange={(e) => {
                const v = e.target.value.replace(/[^\d]/g, "");
                setDmiPeriodStr(v);
                const n = parseInt(v, 10);
                if (!isNaN(n) && n >= 2) setDmiPeriod(n);
              }}
              className="w-16 bg-gray-800 rounded px-2 py-1.5"
            />
          </div>
          <div className="flex flex-wrap gap-4 items-center">
            <label className="flex items-center gap-2">
              +DI
              <input type="color" value={dmiPlusColor} onChange={(e) => setDmiPlusColor(e.target.value)} className="w-8 h-7 rounded" />
            </label>
            <label className="flex items-center gap-2">
              −DI
              <input type="color" value={dmiMinusColor} onChange={(e) => setDmiMinusColor(e.target.value)} className="w-8 h-7 rounded" />
            </label>
            <label className="flex items-center gap-2">
              ADX
              <input type="color" value={dmiAdxColor} onChange={(e) => setDmiAdxColor(e.target.value)} className="w-8 h-7 rounded" />
            </label>
          </div>
          <label className="flex items-center gap-2">
            ارتفاع پنل
            <input type="range" min={10} max={35} value={dmiHeight} onChange={(e) => setDmiHeight(Number(e.target.value))} className="w-32" />
            <span>{dmiHeight}%</span>
          </label>
          <button type="button" onClick={() => setDmiSettings(false)} className="text-orange-400">بستن</button>
        </div>
      )}

      <div
        ref={chartContainerRef}
        className="bg-gray-900 border border-gray-800 rounded-xl"
        style={{ height: "700px", touchAction: "none" }}
      />

      <div className="mt-6 grid md:grid-cols-2 gap-6">
        <div>
          <h2 className="text-green-400 font-semibold mb-2">آلارم‌ها ({alarms.length})</h2>
          {alarms.map((a) => (
            <div key={a.id} className="flex justify-between bg-gray-900 rounded-lg px-3 py-2 mb-2 text-sm">
              <span>
                {a.symbol} {getConditionSymbol(a.condition)} {a.price}
              </span>
              <div className="flex gap-2">
                <button onClick={() => cycleCondition(a)} className={getConditionColor(a.condition)}>
                  {getConditionLabel(a.condition)}
                </button>
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

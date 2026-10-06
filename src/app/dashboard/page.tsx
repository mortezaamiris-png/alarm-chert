"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import {
  createChart,
  IChartApi,
  ISeriesApi,
  LineStyle,
  IPriceLine,
  CrosshairMode,
} from "lightweight-charts";
import { supabase } from "@/lib/supabase";

interface ChartLine {
  id: string;
  symbol: string;
  price: number;
  color: string;
  note?: string | null;
  width?: number | null;
  style?: string | null;
  start_time?: number | null;
  dash?: string | null;
}

interface Alarm {
  id: string;
  symbol: string;
  price: number;
  condition: "above" | "below" | "cross";
  is_active: boolean;
  triggered: boolean;
  note?: string | null;
  color?: string | null;
  last_price?: number | null;
  width?: number | null;
  dash?: string | null;
}

type ToolMode = "none" | "draw" | "ray" | "alarm" | "move";

const ALL_TIMEFRAMES = [
  { label: "1m", value: "1" },
  { label: "5m", value: "5" },
  { label: "15m", value: "15" },
  { label: "1h", value: "60" },
  { label: "2h", value: "120" },
  { label: "4h", value: "240" },
  { label: "1D", value: "D" },
  { label: "1W", value: "W" },
  { label: "1M", value: "M" },
];

const PIVOT_TFS = [
  { label: "1H", value: "60" },
  { label: "4H", value: "240" },
  { label: "1D", value: "D" },
  { label: "1W", value: "W" },
];

const TIMEZONES = [
  { label: "Tehran", value: "Asia/Tehran" },
  { label: "UTC", value: "UTC" },
  { label: "London", value: "Europe/London" },
  { label: "New York", value: "America/New_York" },
];

const DEFAULT_ALARM_COLOR = "#3b82f6";
const DEFAULT_LINE_COLOR = "#f97316";
const LINE_WIDTHS = [1, 2, 3] as const;
const MOVE_STYLE = LineStyle.Dashed;

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
  if (price < 0.01) return { precision: 7, minMove: 0.0000001 };
  if (price < 1) return { precision: 6, minMove: 0.000001 };
  if (price < 100) return { precision: 5, minMove: 0.00001 };
  if (price < 1000) return { precision: 3, minMove: 0.001 };
  return { precision: 2, minMove: 0.01 };
}
function formatPrice(price: number) {
  const { precision } = getPrecision(price);
  return Number(price.toFixed(precision));
}
function snapPrice(price: number) {
  if (price < 0.01) return Math.round(price * 1e7) / 1e7;
  if (price < 1) return Math.round(price * 1e6) / 1e6;
  if (price < 100) return Math.round(price * 1e5) / 1e5;
  if (price < 1000) return Math.round(price * 1e4) / 1e4;
  return Math.round(price * 100) / 100;
}

function calcSMA(candles: { time: number; close: number }[], period: number) {
  const out: { time: number; value: number }[] = [];
  const p = Math.max(1, period);
  for (let i = p - 1; i < candles.length; i++) {
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
    if (d >= 0) gains += d;
    else losses -= d;
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
  const tr: number[] = [], plusDM: number[] = [], minusDM: number[] = [];
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

function findPivots(candles: any[], leftRight: number) {
  const highs: { index: number; time: number; price: number }[] = [];
  const lows: { index: number; time: number; price: number }[] = [];
  const lr = Math.max(2, leftRight);
  for (let i = lr; i < candles.length - lr; i++) {
    let isH = true, isL = true;
    for (let j = 1; j <= lr; j++) {
      if (candles[i].high < candles[i - j].high || candles[i].high < candles[i + j].high) isH = false;
      if (candles[i].low > candles[i - j].low || candles[i].low > candles[i + j].low) isL = false;
    }
    if (isH) highs.push({ index: i, time: candles[i].time, price: candles[i].high });
    if (isL) lows.push({ index: i, time: candles[i].time, price: candles[i].low });
  }
  return { highs, lows };
}

function playAlarmBeep() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.frequency.value = 880;
    o.type = "sine";
    g.gain.setValueAtTime(0.25, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
    o.start();
    o.stop(ctx.currentTime + 0.4);
  } catch {}
}

function showLocalNotification(title: string, body: string) {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, { body, icon: "/icon-192.png", tag: "alarm-chert" });
    }
  } catch {}
  playAlarmBeep();
  try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch {}
}

function getConditionSymbol(c: string) {
  return c === "above" ? "≥" : c === "below" ? "≤" : "≈";
}
function getConditionLabel(c: string) {
  return c === "above" ? "Above" : c === "below" ? "Below" : "Cross";
}
function didCross(condition: string, target: number, prev: number | null | undefined, price: number) {
  if (prev == null || Number.isNaN(prev)) return false;
  if (condition === "above") return prev < target && price >= target;
  if (condition === "below") return prev > target && price <= target;
  return (prev < target && price >= target) || (prev > target && price <= target);
}
function toLineStyle(dash?: string | null) {
  return dash === "dashed" ? LineStyle.Dashed : LineStyle.Solid;
}

function CoinIcon({ symbol }: { symbol: string }) {
  const base = symbol.replace(/USDT$|USD$|PERP$/i, "").toLowerCase();
  return (
    <img
      src={`https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/32/color/${base}.png`}
      alt="" width={20} height={20} className="w-5 h-5 rounded-full shrink-0"
      onError={(e) => {
        (e.target as HTMLImageElement).src = `https://ui-avatars.com/api/?name=${base}&background=374151&color=fff&size=32`;
      }}
    />
  );
}

function IndChip({
  label, visible, onToggleVisible, onSettings, onRemove,
}: {
  label: string; visible: boolean;
  onToggleVisible: () => void; onSettings?: () => void; onRemove: () => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 bg-black/50 backdrop-blur-[2px] rounded px-1 py-0.5 text-[11px] text-gray-100">
      <span className="px-0.5 font-medium whitespace-nowrap opacity-90">{label}</span>
      <button type="button" onClick={onToggleVisible} className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 text-xs">
        {visible ? "👁" : "⊘"}
      </button>
      {onSettings && (
        <button type="button" onClick={onSettings} className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 text-xs">⚙</button>
      )}
      <button type="button" onClick={onRemove} className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 text-red-400 text-xs">×</button>
    </div>
  );
}

export default function DashboardPage() {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<any>(null);
  const previewLineRef = useRef<IPriceLine | null>(null);
  const alarmLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const chartLinesRef = useRef<Map<string, any>>(new Map());
  const smaSeriesRef = useRef<{ s1: any; s2: any; s3: any } | null>(null);
  const rsiSeriesRef = useRef<any>(null);
  const dmiSeriesRef = useRef<{ plus: any; minus: any; adx: any } | null>(null);
  const pivotSeriesRef = useRef<any[]>([]);
  const trendSeriesRef = useRef<any[]>([]);
  const candlesRef = useRef<any[]>([]);
  const notifiedAlarmsRef = useRef<Set<string>>(new Set());
  const prevPricesRef = useRef<Record<string, number>>({});
  const clickLockRef = useRef(false);

  const [symbol, setSymbol] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem("chart_symbol") || "BTCUSDT" : "BTCUSDT"
  );
  const [interval, setIntervalTf] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem("chart_interval") || "60" : "60"
  );
  const [timeZone, setTimeZone] = useState(() => loadLS("chart_tz", "Asia/Tehran"));
  const [tfMenuOpen, setTfMenuOpen] = useState(false);
  const [favTfs, setFavTfs] = useState<string[]>(() =>
    loadLS("fav_tfs", ["1", "5", "15", "60", "240", "D"])
  );

  const [lines, setLines] = useState<ChartLine[]>([]);
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [mode, setMode] = useState<ToolMode>("none");
  const [previewPrice, setPreviewPrice] = useState<number | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [movingType, setMovingType] = useState<"line" | "alarm" | null>(null);
  const [condition, setCondition] = useState<"above" | "below" | "cross">("cross");
  const [saving, setSaving] = useState(false);
  const [showIndicatorMenu, setShowIndicatorMenu] = useState(false);
  const [showSideWl, setShowSideWl] = useState(true);
  const [statusMsg, setStatusMsg] = useState("");
  const [sideOrder, setSideOrder] = useState<string[]>(() => loadLS("side_order", []));
  const [draggingSym, setDraggingSym] = useState<string | null>(null);
  const [dragOverSym, setDragOverSym] = useState<string | null>(null);

  const [drawColor, setDrawColor] = useState(() => loadLS("draw_color", DEFAULT_LINE_COLOR));
  const [drawWidth, setDrawWidth] = useState<1 | 2 | 3>(() => loadLS("draw_width", 2));
  const [drawDash, setDrawDash] = useState<"solid" | "dashed">(() => loadLS("draw_dash", "solid"));

  const [showSMA, setShowSMA] = useState(() => loadLS("ind_sma", false));
  const [smaVisible, setSmaVisible] = useState(() => loadLS("vis_sma", true));
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

  const [showPivot, setShowPivot] = useState(() => loadLS("ind_pivot", false));
  const [pivotVisible, setPivotVisible] = useState(() => loadLS("vis_pivot", true));
  const [pivotSettings, setPivotSettings] = useState(false);
  const [pivotTf, setPivotTf] = useState(() => loadLS("pivot_tf", "D"));
  const [pivotFib, setPivotFib] = useState(() => loadLS("pivot_fib", false));

  const [showRSI, setShowRSI] = useState(() => loadLS("ind_rsi", false));
  const [rsiVisible, setRsiVisible] = useState(() => loadLS("vis_rsi", true));
  const [rsiSettings, setRsiSettings] = useState(false);
  const [rsiPeriod, setRsiPeriod] = useState(() => loadLS("rsi_p", 14));
  const [rsiPeriodStr, setRsiPeriodStr] = useState(() => String(loadLS("rsi_p", 14)));
  const [rsiColor, setRsiColor] = useState(() => loadLS("rsi_c", "#c084fc"));

  const [showDMI, setShowDMI] = useState(() => loadLS("ind_dmi", false));
  const [dmiVisible, setDmiVisible] = useState(() => loadLS("vis_dmi", true));
  const [dmiSettings, setDmiSettings] = useState(false);
  const [dmiPeriod, setDmiPeriod] = useState(() => loadLS("dmi_p", 14));
  const [dmiPeriodStr, setDmiPeriodStr] = useState(() => String(loadLS("dmi_p", 14)));
  const [dmiPlusColor, setDmiPlusColor] = useState(() => loadLS("dmi_pc", "#22c55e"));
  const [dmiMinusColor, setDmiMinusColor] = useState(() => loadLS("dmi_mc", "#ef4444"));
  const [dmiAdxColor, setDmiAdxColor] = useState(() => loadLS("dmi_ac", "#3b82f6"));

  const [showVol, setShowVol] = useState(() => loadLS("ind_vol", true));
  const [volVisible, setVolVisible] = useState(() => loadLS("vis_vol", true));

  const [showTrend, setShowTrend] = useState(() => loadLS("ind_trend", false));
  const [trendVisible, setTrendVisible] = useState(() => loadLS("vis_trend", true));
  const [trendSettings, setTrendSettings] = useState(false);
  const [trendPeriod, setTrendPeriod] = useState(() => loadLS("trend_p", 24));
  const [trendPeriodStr, setTrendPeriodStr] = useState(() => String(loadLS("trend_p", 24)));
  const [trendPivotCount, setTrendPivotCount] = useState(() => loadLS("trend_pivots", 6));
  const [trendPivotCountStr, setTrendPivotCountStr] = useState(() => String(loadLS("trend_pivots", 6)));
  const [trendUpColor, setTrendUpColor] = useState(() => loadLS("trend_up", "#84cc16"));
  const [trendDownColor, setTrendDownColor] = useState(() => loadLS("trend_dn", "#ef4444"));
  const [trendMax, setTrendMax] = useState(() => loadLS("trend_max", 3));

  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteType, setEditingNoteType] = useState<"line" | "alarm" | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  const modeRef = useRef(mode);
  const conditionRef = useRef(condition);
  const movingIdRef = useRef(movingId);
  const movingTypeRef = useRef(movingType);
  const drawColorRef = useRef(drawColor);
  const drawWidthRef = useRef(drawWidth);
  const drawDashRef = useRef(drawDash);
  const symbolRef = useRef(symbol);
  const alarmsRef = useRef(alarms);
  const intervalRef = useRef(interval);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { conditionRef.current = condition; }, [condition]);
  useEffect(() => { movingIdRef.current = movingId; }, [movingId]);
  useEffect(() => { movingTypeRef.current = movingType; }, [movingType]);
  useEffect(() => { drawColorRef.current = drawColor; saveLS("draw_color", drawColor); }, [drawColor]);
  useEffect(() => { drawWidthRef.current = drawWidth; saveLS("draw_width", drawWidth); }, [drawWidth]);
  useEffect(() => { drawDashRef.current = drawDash; saveLS("draw_dash", drawDash); }, [drawDash]);
  useEffect(() => { symbolRef.current = symbol; localStorage.setItem("chart_symbol", symbol); }, [symbol]);
  useEffect(() => { intervalRef.current = interval; localStorage.setItem("chart_interval", interval); }, [interval]);
  useEffect(() => { saveLS("chart_tz", timeZone); }, [timeZone]);
  useEffect(() => { saveLS("fav_tfs", favTfs); }, [favTfs]);
  useEffect(() => { alarmsRef.current = alarms; }, [alarms]);
  useEffect(() => { saveLS("side_order", sideOrder); }, [sideOrder]);

  useEffect(() => {
    saveLS("ind_sma", showSMA); saveLS("vis_sma", smaVisible);
    saveLS("sma1", sma1); saveLS("sma2", sma2); saveLS("sma3", sma3);
    saveLS("smaC1", smaColor1); saveLS("smaC2", smaColor2); saveLS("smaC3", smaColor3);
  }, [showSMA, smaVisible, sma1, sma2, sma3, smaColor1, smaColor2, smaColor3]);
  useEffect(() => {
    saveLS("ind_pivot", showPivot); saveLS("vis_pivot", pivotVisible);
    saveLS("pivot_tf", pivotTf); saveLS("pivot_fib", pivotFib);
  }, [showPivot, pivotVisible, pivotTf, pivotFib]);
  useEffect(() => {
    saveLS("ind_rsi", showRSI); saveLS("vis_rsi", rsiVisible);
    saveLS("rsi_p", rsiPeriod); saveLS("rsi_c", rsiColor);
  }, [showRSI, rsiVisible, rsiPeriod, rsiColor]);
  useEffect(() => {
    saveLS("ind_dmi", showDMI); saveLS("vis_dmi", dmiVisible);
    saveLS("dmi_p", dmiPeriod); saveLS("dmi_pc", dmiPlusColor);
    saveLS("dmi_mc", dmiMinusColor); saveLS("dmi_ac", dmiAdxColor);
  }, [showDMI, dmiVisible, dmiPeriod, dmiPlusColor, dmiMinusColor, dmiAdxColor]);
  useEffect(() => { saveLS("ind_vol", showVol); saveLS("vis_vol", volVisible); }, [showVol, volVisible]);
  useEffect(() => {
    saveLS("ind_trend", showTrend); saveLS("vis_trend", trendVisible);
    saveLS("trend_p", trendPeriod); saveLS("trend_pivots", trendPivotCount);
    saveLS("trend_up", trendUpColor); saveLS("trend_dn", trendDownColor); saveLS("trend_max", trendMax);
  }, [showTrend, trendVisible, trendPeriod, trendPivotCount, trendUpColor, trendDownColor, trendMax]);

  const favTfButtons = useMemo(
    () => ALL_TIMEFRAMES.filter((t) => favTfs.includes(t.value)),
    [favTfs]
  );
  const toggleFavTf = (v: string) => {
    setFavTfs((prev) => (prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]));
  };

  const symbolUpper = symbol.toUpperCase();
  const currentAlarms = useMemo(
    () => alarms.filter((a) => a.symbol.toUpperCase() === symbolUpper && a.is_active && !a.triggered),
    [alarms, symbolUpper]
  );
  const currentLines = useMemo(
    () => lines.filter((l) => l.symbol.toUpperCase() === symbolUpper),
    [lines, symbolUpper]
  );
  const alarmCountBySym = useMemo(() => {
    const m: Record<string, number> = {};
    alarms.forEach((a) => {
      if (a.is_active && !a.triggered) {
        const s = a.symbol.toUpperCase();
        m[s] = (m[s] || 0) + 1;
      }
    });
    return m;
  }, [alarms]);
  const lineCountBySym = useMemo(() => {
    const m: Record<string, number> = {};
    lines.forEach((l) => {
      const s = l.symbol.toUpperCase();
      m[s] = (m[s] || 0) + 1;
    });
    return m;
  }, [lines]);
  const alarmSymbolsRaw = useMemo(() => {
    const set = new Set<string>();
    alarms.forEach((a) => {
      if (a.is_active && !a.triggered) set.add(a.symbol.toUpperCase());
    });
    return Array.from(set);
  }, [alarms]);
  const alarmSymbols = useMemo(() => {
    const set = new Set(alarmSymbolsRaw);
    const ordered = sideOrder.filter((s) => set.has(s));
    const rest = alarmSymbolsRaw.filter((s) => !ordered.includes(s)).sort();
    return [...ordered, ...rest];
  }, [alarmSymbolsRaw, sideOrder]);

  const updateMargins = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    let bottom = 0.05;
    if (showVol && volVisible) {
      try { chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } }); } catch {}
      bottom = 0.2;
    }
    if (showRSI && rsiVisible) {
      try { chart.priceScale("rsi").applyOptions({ scaleMargins: { top: 0.72, bottom } }); } catch {}
    }
    if (showDMI && dmiVisible) {
      try { chart.priceScale("dmi").applyOptions({ scaleMargins: { top: 0.78, bottom } }); } catch {}
    }
    chart.priceScale("right").applyOptions({
      scaleMargins: {
        top: 0.05,
        bottom: Math.max(bottom, showRSI && rsiVisible ? 0.22 : 0.05, showVol && volVisible ? 0.2 : 0.05),
      },
      autoScale: true,
    });
  }, [showVol, volVisible, showRSI, rsiVisible, showDMI, dmiVisible]);

  const clearPreview = useCallback(() => {
    if (previewLineRef.current && seriesRef.current) {
      try { seriesRef.current.removePriceLine(previewLineRef.current); } catch {}
      previewLineRef.current = null;
    }
    setPreviewPrice(null);
  }, []);  const destroyChart = useCallback(() => {
    clearPreview();
    alarmLinesRef.current.clear();
    chartLinesRef.current.clear();
    smaSeriesRef.current = null;
    rsiSeriesRef.current = null;
    dmiSeriesRef.current = null;
    pivotSeriesRef.current = [];
    trendSeriesRef.current = [];
    volumeSeriesRef.current = null;
    seriesRef.current = null;
    if (chartRef.current) {
      try { chartRef.current.remove(); } catch {}
      chartRef.current = null;
    }
  }, [clearPreview]);

  const renderAllLinesAndAlarms = useCallback(() => {
    const series = seriesRef.current;
    if (!series) return;

    alarmLinesRef.current.forEach((pl) => {
      try { series.removePriceLine(pl); } catch {}
    });
    alarmLinesRef.current.clear();

    chartLinesRef.current.forEach((obj) => {
      try {
        if (obj.priceLine) series.removePriceLine(obj.priceLine);
        if (obj.lineSeries && chartRef.current) chartRef.current.removeSeries(obj.lineSeries);
      } catch {}
    });
    chartLinesRef.current.clear();

    currentAlarms.forEach((a) => {
      const isMoving = movingId === a.id && movingType === "alarm";
      const color = a.color || DEFAULT_ALARM_COLOR;
      const width = (a.width as 1 | 2 | 3) || 2;
      const dash = a.dash || "solid";
      try {
        const pl = series.createPriceLine({
          price: a.price,
          color: isMoving ? "#f59e0b" : color,
          lineWidth: isMoving ? 3 : width,
          lineStyle: isMoving ? MOVE_STYLE : toLineStyle(dash),
          axisLabelVisible: true,
          title: getConditionSymbol(a.condition),
        });
        alarmLinesRef.current.set(a.id, pl);
      } catch {}
    });

    currentLines.forEach((l) => {
      const isMoving = movingId === l.id && movingType === "line";
      const color = l.color || DEFAULT_LINE_COLOR;
      const width = (l.width as 1 | 2 | 3) || 2;
      const dash = l.dash || "solid";
      const style = l.style || "full";

      try {
        if (style === "ray" && l.start_time && candlesRef.current.length) {
          const last = candlesRef.current[candlesRef.current.length - 1];
          const ls = chartRef.current!.addLineSeries({
            color: isMoving ? "#f59e0b" : color,
            lineWidth: isMoving ? 3 : width,
            lineStyle: isMoving ? MOVE_STYLE : toLineStyle(dash),
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          });
          ls.setData([
            { time: l.start_time as any, value: l.price },
            { time: last.time as any, value: l.price },
          ]);
          chartLinesRef.current.set(l.id, { lineSeries: ls });
        } else {
          const pl = series.createPriceLine({
            price: l.price,
            color: isMoving ? "#f59e0b" : color,
            lineWidth: isMoving ? 3 : width,
            lineStyle: isMoving ? MOVE_STYLE : toLineStyle(dash),
            axisLabelVisible: true,
            title: "",
          });
          chartLinesRef.current.set(l.id, { priceLine: pl });
        }
      } catch {}
    });
  }, [currentAlarms, currentLines, movingId, movingType]);

  // ---------- Indicators ----------
  const removeSMA = useCallback(() => {
    if (!chartRef.current || !smaSeriesRef.current) return;
    try {
      chartRef.current.removeSeries(smaSeriesRef.current.s1);
      chartRef.current.removeSeries(smaSeriesRef.current.s2);
      chartRef.current.removeSeries(smaSeriesRef.current.s3);
    } catch {}
    smaSeriesRef.current = null;
  }, []);

  const applySMA = useCallback(() => {
    if (!chartRef.current || !candlesRef.current.length) return;
    removeSMA();
    if (!showSMA || !smaVisible) return;
    const c = candlesRef.current;
    const s1 = chartRef.current.addLineSeries({ color: smaColor1, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const s2 = chartRef.current.addLineSeries({ color: smaColor2, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const s3 = chartRef.current.addLineSeries({ color: smaColor3, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    s1.setData(calcSMA(c, sma1) as any);
    s2.setData(calcSMA(c, sma2) as any);
    s3.setData(calcSMA(c, sma3) as any);
    smaSeriesRef.current = { s1, s2, s3 };
  }, [showSMA, smaVisible, sma1, sma2, sma3, smaColor1, smaColor2, smaColor3, removeSMA]);

  const removeRSI = useCallback(() => {
    if (!chartRef.current || !rsiSeriesRef.current) return;
    try { chartRef.current.removeSeries(rsiSeriesRef.current); } catch {}
    rsiSeriesRef.current = null;
  }, []);

  const applyRSI = useCallback(() => {
    if (!chartRef.current || !candlesRef.current.length) return;
    removeRSI();
    if (!showRSI || !rsiVisible) return;
    const s = chartRef.current.addLineSeries({
      color: rsiColor, lineWidth: 1, priceScaleId: "rsi",
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false,
    });
    s.setData(calcRSI(candlesRef.current, rsiPeriod) as any);
    rsiSeriesRef.current = s;
    updateMargins();
  }, [showRSI, rsiVisible, rsiPeriod, rsiColor, removeRSI, updateMargins]);

  const removeDMI = useCallback(() => {
    if (!chartRef.current || !dmiSeriesRef.current) return;
    try {
      chartRef.current.removeSeries(dmiSeriesRef.current.plus);
      chartRef.current.removeSeries(dmiSeriesRef.current.minus);
      chartRef.current.removeSeries(dmiSeriesRef.current.adx);
    } catch {}
    dmiSeriesRef.current = null;
  }, []);

  const applyDMI = useCallback(() => {
    if (!chartRef.current || !candlesRef.current.length) return;
    removeDMI();
    if (!showDMI || !dmiVisible) return;
    const { plusDI, minusDI, adx } = calcDMI(candlesRef.current, dmiPeriod);
    const plus = chartRef.current.addLineSeries({ color: dmiPlusColor, lineWidth: 1, priceScaleId: "dmi", priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const minus = chartRef.current.addLineSeries({ color: dmiMinusColor, lineWidth: 1, priceScaleId: "dmi", priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const adxS = chartRef.current.addLineSeries({ color: dmiAdxColor, lineWidth: 1, priceScaleId: "dmi", priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    plus.setData(plusDI as any);
    minus.setData(minusDI as any);
    adxS.setData(adx as any);
    dmiSeriesRef.current = { plus, minus, adx: adxS };
    updateMargins();
  }, [showDMI, dmiVisible, dmiPeriod, dmiPlusColor, dmiMinusColor, dmiAdxColor, removeDMI, updateMargins]);

  const removePivot = useCallback(() => {
    if (!chartRef.current) return;
    pivotSeriesRef.current.forEach((s) => { try { chartRef.current!.removeSeries(s); } catch {} });
    pivotSeriesRef.current = [];
  }, []);

  const applyPivot = useCallback(async () => {
    if (!chartRef.current || !candlesRef.current.length) return;
    removePivot();
    if (!showPivot || !pivotVisible) return;
    try {
      const res = await fetch(`/api/kline?symbol=${symbolRef.current}&interval=${pivotTf}&limit=3`);
      const data = await res.json();
      const rows = Array.isArray(data) ? data : data?.data || data?.result?.list || [];
      if (!rows.length) return;
      const last = rows[rows.length - 2] || rows[rows.length - 1];
      const h = parseFloat(last.high || last[2]);
      const l = parseFloat(last.low || last[3]);
      const c = parseFloat(last.close || last[4]);
      if (!h || !l || !c) return;
      const pp = (h + l + c) / 3;
      const r1 = 2 * pp - l, s1 = 2 * pp - h;
      const r2 = pp + (h - l), s2 = pp - (h - l);
      const r3 = h + 2 * (pp - l), s3 = l - 2 * (h - pp);
      const levels = pivotFib
        ? [
            { p: pp, col: "#eab308", t: "P" },
            { p: pp + 0.382 * (h - l), col: "#22c55e", t: "R1" },
            { p: pp + 0.618 * (h - l), col: "#16a34a", t: "R2" },
            { p: pp + 1 * (h - l), col: "#15803d", t: "R3" },
            { p: pp - 0.382 * (h - l), col: "#ef4444", t: "S1" },
            { p: pp - 0.618 * (h - l), col: "#dc2626", t: "S2" },
            { p: pp - 1 * (h - l), col: "#b91c1c", t: "S3" },
          ]
        : [
            { p: pp, col: "#eab308", t: "P" },
            { p: r1, col: "#22c55e", t: "R1" },
            { p: r2, col: "#16a34a", t: "R2" },
            { p: r3, col: "#15803d", t: "R3" },
            { p: s1, col: "#ef4444", t: "S1" },
            { p: s2, col: "#dc2626", t: "S2" },
            { p: s3, col: "#b91c1c", t: "S3" },
          ];
      const times = candlesRef.current.map((x: any) => x.time);
      levels.forEach(({ p, col, t }) => {
        const ls = chartRef.current!.addLineSeries({
          color: col, lineWidth: 1, lineStyle: LineStyle.Dashed,
          priceLineVisible: false, lastValueVisible: true, title: t, crosshairMarkerVisible: false,
        });
        ls.setData(times.map((tm: number) => ({ time: tm as any, value: p })));
        pivotSeriesRef.current.push(ls);
      });
    } catch {}
  }, [showPivot, pivotVisible, pivotTf, pivotFib, removePivot]);

  const removeTrend = useCallback(() => {
    if (!chartRef.current) return;
    trendSeriesRef.current.forEach((s) => { try { chartRef.current!.removeSeries(s); } catch {} });
    trendSeriesRef.current = [];
  }, []);

  const applyTrend = useCallback(() => {
    if (!chartRef.current || !candlesRef.current.length) return;
    removeTrend();
    if (!showTrend || !trendVisible) return;

    const candles = candlesRef.current;
    const period = Math.max(10, Math.min(50, trendPeriod));
    const pivotCount = Math.max(2, Math.min(6, trendPivotCount));
    const maxLines = Math.max(1, Math.min(10, trendMax));
    const { highs, lows } = findPivots(candles, period);

    const recentLows = lows.slice(-pivotCount);
    const recentHighs = highs.slice(-pivotCount);

    let upCount = 0;
    for (let i = 0; i < recentLows.length - 1 && upCount < maxLines; i++) {
      const a = recentLows[i];
      const b = recentLows[i + 1];
      if (b.price <= a.price) continue;
      const slope = (b.price - a.price) / (b.index - a.index);
      let valid = true;
      for (let x = a.index + 1; x < candles.length; x++) {
        const linePrice = a.price + slope * (x - a.index);
        if (candles[x].low < linePrice * 0.998) { valid = false; break; }
      }
      if (!valid) continue;
      const endIdx = candles.length - 1;
      const endPrice = a.price + slope * (endIdx - a.index);
      try {
        const ls = chartRef.current!.addLineSeries({
          color: trendUpColor, lineWidth: 2, priceLineVisible: false,
          lastValueVisible: false, crosshairMarkerVisible: false,
        });
        ls.setData([
          { time: a.time as any, value: a.price },
          { time: candles[endIdx].time as any, value: endPrice },
        ]);
        trendSeriesRef.current.push(ls);
        upCount++;
      } catch {}
    }

    let dnCount = 0;
    for (let i = 0; i < recentHighs.length - 1 && dnCount < maxLines; i++) {
      const a = recentHighs[i];
      const b = recentHighs[i + 1];
      if (b.price >= a.price) continue;
      const slope = (b.price - a.price) / (b.index - a.index);
      let valid = true;
      for (let x = a.index + 1; x < candles.length; x++) {
        const linePrice = a.price + slope * (x - a.index);
        if (candles[x].high > linePrice * 1.002) { valid = false; break; }
      }
      if (!valid) continue;
      const endIdx = candles.length - 1;
      const endPrice = a.price + slope * (endIdx - a.index);
      try {
        const ls = chartRef.current!.addLineSeries({
          color: trendDownColor, lineWidth: 2, priceLineVisible: false,
          lastValueVisible: false, crosshairMarkerVisible: false,
        });
        ls.setData([
          { time: a.time as any, value: a.price },
          { time: candles[endIdx].time as any, value: endPrice },
        ]);
        trendSeriesRef.current.push(ls);
        dnCount++;
      } catch {}
    }
  }, [showTrend, trendVisible, trendPeriod, trendPivotCount, trendMax, trendUpColor, trendDownColor, removeTrend]);

  const applyVolume = useCallback(() => {
    if (!chartRef.current || !candlesRef.current.length) return;
    if (volumeSeriesRef.current) {
      try { chartRef.current.removeSeries(volumeSeriesRef.current); } catch {}
      volumeSeriesRef.current = null;
    }
    if (!showVol || !volVisible) { updateMargins(); return; }
    const vol = chartRef.current.addHistogramSeries({
      priceScaleId: "volume",
      priceLineVisible: false,
      lastValueVisible: false,
    });
    vol.setData(
      candlesRef.current.map((c: any) => ({
        time: c.time,
        value: c.volume || 0,
        color: c.close >= c.open ? "rgba(34,197,94,0.5)" : "rgba(239,68,68,0.5)",
      })) as any
    );
    volumeSeriesRef.current = vol;
    updateMargins();
  }, [showVol, volVisible, updateMargins]);

  const rebuildIndicators = useCallback(() => {
    applySMA();
    applyRSI();
    applyDMI();
    applyPivot();
    applyTrend();
    applyVolume();
  }, [applySMA, applyRSI, applyDMI, applyPivot, applyTrend, applyVolume]);

  // ---------- Load candles ----------
  const loadCandles = useCallback(async () => {
    const container = chartContainerRef.current;
    if (!container) return;
    destroyChart();
    setStatusMsg("Loading...");

    try {
      const res = await fetch(`/api/kline?symbol=${symbolRef.current}&interval=${intervalRef.current}&limit=500`);
      const raw = await res.json();
      let rows: any[] = Array.isArray(raw) ? raw : raw?.data || raw?.result?.list || raw?.candles || [];
      if (!rows.length) {
        setStatusMsg("No data");
        return;
      }

      const candles = rows
        .map((r: any) => {
          const time = Math.floor(Number(r.time || r[0] || r.openTime || r.t) / (String(r.time || r[0] || "").length > 12 ? 1000 : 1));
          return {
            time,
            open: parseFloat(r.open ?? r[1]),
            high: parseFloat(r.high ?? r[2]),
            low: parseFloat(r.low ?? r[3]),
            close: parseFloat(r.close ?? r[4]),
            volume: parseFloat(r.volume ?? r[5] ?? 0),
          };
        })
        .filter((c: any) => c.time && !Number.isNaN(c.close))
        .sort((a: any, b: any) => a.time - b.time);

      candlesRef.current = candles;
      const lastClose = candles[candles.length - 1]?.close || 1;
      const { precision, minMove } = getPrecision(lastClose);

      const chart = createChart(container, {
        layout: {
          background: { color: "#0b0e11" },
          textColor: "#d1d5db",
          fontSize: 11,
        },
        grid: {
          vertLines: { color: "rgba(42,46,57,0.5)" },
          horzLines: { color: "rgba(42,46,57,0.5)" },
        },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: {
          borderColor: "#2a2e39",
          scaleMargins: { top: 0.05, bottom: 0.05 },
        },
        timeScale: {
          borderColor: "#2a2e39",
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 5,
        },
        localization: { locale: "en-US" },
        width: container.clientWidth,
        height: container.clientHeight || 500,
      });

      chartRef.current = chart;
      const series = chart.addCandlestickSeries({
        upColor: "#22c55e",
        downColor: "#ef4444",
        borderUpColor: "#22c55e",
        borderDownColor: "#ef4444",
        wickUpColor: "#22c55e",
        wickDownColor: "#ef4444",
        priceFormat: { type: "price", precision, minMove },
      });
      series.setData(candles as any);
      seriesRef.current = series;

      chart.timeScale().fitContent();

      chart.subscribeCrosshairMove((param) => {
        if (!param.point || !seriesRef.current) return;
        const price = seriesRef.current.coordinateToPrice(param.point.y);
        if (price == null) return;
        const snapped = snapPrice(price);

        if (modeRef.current === "draw" || modeRef.current === "ray" || modeRef.current === "alarm" || movingIdRef.current) {
          setPreviewPrice(snapped);
          if (previewLineRef.current) {
            try { seriesRef.current.removePriceLine(previewLineRef.current); } catch {}
          }
          const col =
            modeRef.current === "alarm"
              ? drawColorRef.current || DEFAULT_ALARM_COLOR
              : movingIdRef.current
              ? "#f59e0b"
              : drawColorRef.current || DEFAULT_LINE_COLOR;
          previewLineRef.current = seriesRef.current.createPriceLine({
            price: snapped,
            color: col,
            lineWidth: movingIdRef.current ? 3 : drawWidthRef.current,
            lineStyle: movingIdRef.current ? MOVE_STYLE : toLineStyle(drawDashRef.current),
            axisLabelVisible: true,
            title: modeRef.current === "alarm" ? getConditionSymbol(conditionRef.current) : "",
          });
        }
      });

      chart.subscribeClick(async (param) => {
        if (!param.point || !seriesRef.current || clickLockRef.current) return;
        const price = seriesRef.current.coordinateToPrice(param.point.y);
        if (price == null) return;
        const snapped = snapPrice(price);
        const m = modeRef.current;

        if (movingIdRef.current) {
          clickLockRef.current = true;
          const id = movingIdRef.current;
          const type = movingTypeRef.current;
          clearPreview();
          if (type === "alarm") {
            setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, price: snapped } : a)));
            await supabase.from("alarms").update({ price: snapped }).eq("id", id);
          } else {
            setLines((prev) => prev.map((l) => (l.id === id ? { ...l, price: snapped } : l)));
            await supabase.from("chart_lines").update({ price: snapped }).eq("id", id);
          }
          setMovingId(null);
          setMovingType(null);
          setMode("none");
          setTimeout(() => { clickLockRef.current = false; }, 300);
          return;
        }

        if (m === "alarm") {
          clickLockRef.current = true;
          const payload: any = {
            symbol: symbolRef.current,
            price: snapped,
            condition: conditionRef.current,
            is_active: true,
            triggered: false,
            color: drawColorRef.current || DEFAULT_ALARM_COLOR,
            width: drawWidthRef.current,
            dash: drawDashRef.current,
          };
          const { data, error } = await supabase.from("alarms").insert(payload).select().single();
          if (!error && data) {
            setAlarms((prev) => [{ ...data, color: data.color || payload.color }, ...prev]);
            setStatusMsg("Alarm set");
          } else {
            const { data: d2, error: e2 } = await supabase
              .from("alarms")
              .insert({
                symbol: payload.symbol,
                price: payload.price,
                condition: payload.condition,
                is_active: true,
                triggered: false,
              })
              .select()
              .single();
            if (!e2 && d2) {
              setAlarms((prev) => [{ ...d2, color: payload.color, width: payload.width, dash: payload.dash }, ...prev]);
              setStatusMsg("Alarm set");
            } else setStatusMsg("Save failed");
          }
          clearPreview();
          setMode("none");
          setTimeout(() => { clickLockRef.current = false; }, 300);
          return;
        }

        if (m === "draw" || m === "ray") {
          clickLockRef.current = true;
          const lastCandle = candlesRef.current[candlesRef.current.length - 1];
          const payload: any = {
            symbol: symbolRef.current,
            price: snapped,
            color: drawColorRef.current || DEFAULT_LINE_COLOR,
            width: drawWidthRef.current,
            dash: drawDashRef.current,
            style: m === "ray" ? "ray" : "full",
            start_time: m === "ray" ? lastCandle?.time : null,
            note: null,
          };
          const { data, error } = await supabase.from("chart_lines").insert(payload).select().single();
          if (!error && data) {
            setLines((prev) => [{ ...data, color: data.color || payload.color }, ...prev]);
            setStatusMsg("Line saved");
          } else {
            const { data: d2, error: e2 } = await supabase
              .from("chart_lines")
              .insert({ symbol: payload.symbol, price: payload.price, color: payload.color })
              .select()
              .single();
            if (!e2 && d2) {
              setLines((prev) => [{ ...d2, ...payload }, ...prev]);
              setStatusMsg("Line saved");
            } else setStatusMsg("Save failed");
          }
          clearPreview();
          setMode("none");
          setTimeout(() => { clickLockRef.current = false; }, 300);
        }
      });

      renderAllLinesAndAlarms();
      rebuildIndicators();
      setStatusMsg("");
    } catch (e: any) {
      setStatusMsg(e?.message || "Load error");
    }
  }, [destroyChart, renderAllLinesAndAlarms, rebuildIndicators, clearPreview]);

  // ---------- Data load effects ----------
  useEffect(() => {
    loadCandles();
    const onResize = () => {
      if (chartRef.current && chartContainerRef.current) {
        chartRef.current.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight,
        });
      }
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      destroyChart();
    };
  }, [symbol, interval]);

  useEffect(() => {
    renderAllLinesAndAlarms();
  }, [currentAlarms, currentLines, movingId, movingType, renderAllLinesAndAlarms]);

  useEffect(() => {
    rebuildIndicators();
  }, [
    showSMA, smaVisible, sma1, sma2, sma3, smaColor1, smaColor2, smaColor3,
    showRSI, rsiVisible, rsiPeriod, rsiColor,
    showDMI, dmiVisible, dmiPeriod, dmiPlusColor, dmiMinusColor, dmiAdxColor,
    showPivot, pivotVisible, pivotTf, pivotFib,
    showTrend, trendVisible, trendPeriod, trendPivotCount, trendMax, trendUpColor, trendDownColor,
    showVol, volVisible,
  ]);

  // ---------- Load alarms & lines from DB ----------
  useEffect(() => {
    (async () => {
      const { data: a } = await supabase.from("alarms").select("*").order("created_at", { ascending: false });
      if (a) setAlarms(a as Alarm[]);
      const { data: l } = await supabase.from("chart_lines").select("*").order("created_at", { ascending: false });
      if (l) setLines(l as ChartLine[]);
    })();
  }, []);

  // ---------- Fast alarm check + clear on trigger (2s) ----------
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      try {
        const { data } = await supabase
          .from("alarms")
          .select("*")
          .eq("is_active", true);

        if (!data) return;

        const stillActive = data.filter((a: any) => !a.triggered);
        const justTriggered = data.filter((a: any) => a.triggered);

        // local clear for triggered
        if (justTriggered.length) {
          const ids = new Set(justTriggered.map((a: any) => a.id));
          setAlarms((prev) =>
            prev.map((a) => (ids.has(a.id) ? { ...a, triggered: true, is_active: false } : a))
          );
          justTriggered.forEach((a: any) => {
            if (!notifiedAlarmsRef.current.has(a.id)) {
              notifiedAlarmsRef.current.add(a.id);
              showLocalNotification(
                `${a.symbol}`,
                `Alarm hit @ ${a.price} (${getConditionLabel(a.condition)})`
              );
            }
          });
        }

        // also check price cross locally for faster feel
        const symbols = [...new Set(stillActive.map((a: any) => a.symbol))];
        for (const sym of symbols) {
          try {
            const res = await fetch(`/api/ticker?symbol=${sym}`);
            const j = await res.json();
            const price = parseFloat(j?.price || j?.lastPrice || j?.data?.price || 0);
            if (!price) continue;
            const prev = prevPricesRef.current[sym];
            prevPricesRef.current[sym] = price;

            for (const a of stillActive.filter((x: any) => x.symbol === sym)) {
              if (didCross(a.condition, a.price, prev, price)) {
                setAlarms((p) =>
                  p.map((x) => (x.id === a.id ? { ...x, triggered: true, is_active: false, last_price: price } : x))
                );
                await supabase
                  .from("alarms")
                  .update({ triggered: true, is_active: false, last_price: price })
                  .eq("id", a.id);
                if (!notifiedAlarmsRef.current.has(a.id)) {
                  notifiedAlarmsRef.current.add(a.id);
                  showLocalNotification(
                    `${a.symbol}`,
                    `Alarm hit @ ${a.price}  now ${price}`
                  );
                }
              }
            }
          } catch {}
        }
      } catch {}
    };
    tick();
    const id = window.setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // ---------- CRUD helpers ----------
  const deleteAlarm = async (id: string) => {
    setAlarms((prev) => prev.filter((a) => a.id !== id));
    await supabase.from("alarms").delete().eq("id", id);
  };

  const deleteLine = async (id: string) => {
    setLines((prev) => prev.filter((l) => l.id !== id));
    await supabase.from("chart_lines").delete().eq("id", id);
  };

  const convertLineToAlarm = async (line: ChartLine) => {
    const payload: any = {
      symbol: line.symbol,
      price: line.price,
      condition: "cross",
      is_active: true,
      triggered: false,
      color: line.color || DEFAULT_LINE_COLOR,
      width: line.width || 2,
      dash: line.dash || "solid",
      note: line.note || null,
    };
    const { data, error } = await supabase.from("alarms").insert(payload).select().single();
    if (!error && data) {
      setAlarms((prev) => [{ ...data, color: data.color || payload.color }, ...prev]);
      await deleteLine(line.id);
      setStatusMsg("Converted to alarm");
    } else {
      const { data: d2, error: e2 } = await supabase
        .from("alarms")
        .insert({
          symbol: payload.symbol,
          price: payload.price,
          condition: "cross",
          is_active: true,
          triggered: false,
        })
        .select()
        .single();
      if (!e2 && d2) {
        setAlarms((prev) => [{ ...d2, color: payload.color, width: payload.width, dash: payload.dash, note: payload.note }, ...prev]);
        await deleteLine(line.id);
        setStatusMsg("Converted to alarm");
      } else setStatusMsg("Convert failed");
    }
  };

  const startMove = (id: string, type: "line" | "alarm") => {
    setMovingId(id);
    setMovingType(type);
    setMode("move");
    setStatusMsg("Click on chart to set new price");
  };

  const updateAlarmField = async (id: string, fields: Partial<Alarm>) => {
    setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, ...fields } : a)));
    await supabase.from("alarms").update(fields).eq("id", id);
  };

  const updateLineField = async (id: string, fields: Partial<ChartLine>) => {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...fields } : l)));
    await supabase.from("chart_lines").update(fields).eq("id", id);
  };

  const saveNote = async () => {
    if (!editingNoteId || !editingNoteType) return;
    if (editingNoteType === "alarm") await updateAlarmField(editingNoteId, { note: noteDraft });
    else await updateLineField(editingNoteId, { note: noteDraft });
    setEditingNoteId(null);
    setEditingNoteType(null);
  };

  // ---------- Side list drag (smooth) ----------
  const onSidePointerDown = (e: React.PointerEvent, sym: string) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    setDraggingSym(sym);
  };
  const onSidePointerEnter = (sym: string) => {
    if (draggingSym && draggingSym !== sym) setDragOverSym(sym);
  };
  const onSidePointerUp = () => {
    if (draggingSym && dragOverSym && draggingSym !== dragOverSym) {
      setSideOrder((prev) => {
        const base = prev.length ? [...prev] : [...alarmSymbols];
        const from = base.indexOf(draggingSym);
        const to = base.indexOf(dragOverSym);
        if (from < 0 || to < 0) {
          const all = [...new Set([draggingSym, dragOverSym, ...base])];
          const f = all.indexOf(draggingSym);
          const t = all.indexOf(dragOverSym);
          all.splice(f, 1);
          all.splice(t, 0, draggingSym);
          return all;
        }
        base.splice(from, 1);
        base.splice(to, 0, draggingSym);
        return base;
      });
    }
    setDraggingSym(null);
    setDragOverSym(null);
  };

  // ---------- UI ----------
  return (
    <div className="min-h-screen bg-[#0b0e11] text-gray-100 flex flex-col">
      {/* Top bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800 bg-[#0f1318]">
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && loadCandles()}
          className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm w-28 font-mono"
        />
        <div className="flex items-center gap-1">
          {favTfButtons.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setIntervalTf(t.value)}
              className={`px-2 py-1 text-xs rounded ${interval === t.value ? "bg-orange-500 text-black" : "bg-gray-800 hover:bg-gray-700"}`}
            >
              {t.label}
            </button>
          ))}
          <button type="button" onClick={() => setTfMenuOpen((v) => !v)} className="px-2 py-1 text-xs rounded bg-gray-800 hover:bg-gray-700">
            TF
          </button>
        </div>
        <select
          value={timeZone}
          onChange={(e) => setTimeZone(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs"
        >
          {TIMEZONES.map((z) => (
            <option key={z.value} value={z.value}>{z.label}</option>
          ))}
        </select>
        <div className="flex-1" />
        {statusMsg && <span className="text-xs text-gray-400">{statusMsg}</span>}
        <button
          type="button"
          onClick={() => setShowSideWl((v) => !v)}
          className="px-2 py-1 text-xs rounded bg-gray-800 hover:bg-gray-700"
        >
          {showSideWl ? "Hide list" : "Show list"}
        </button>
      </div>

      {tfMenuOpen && (
        <div className="absolute z-50 top-12 left-4 bg-gray-900 border border-gray-700 rounded-lg p-2 shadow-xl">
          {ALL_TIMEFRAMES.map((t) => (
            <div key={t.value} className="flex items-center gap-2 py-1">
              <button
                type="button"
                onClick={() => { setIntervalTf(t.value); setTfMenuOpen(false); }}
                className={`flex-1 text-left px-2 py-1 rounded text-sm ${interval === t.value ? "bg-orange-500/30" : "hover:bg-gray-800"}`}
              >
                {t.label}
              </button>
              <button type="button" onClick={() => toggleFavTf(t.value)} className="text-yellow-400 text-sm">
                {favTfs.includes(t.value) ? "★" : "☆"}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* Chart area */}
        <div className="flex-1 relative min-w-0">
          {/* Vertical tools - left */}
          <div className="absolute left-1 top-12 z-20 flex flex-col gap-1">
            <button type="button" onClick={() => { setMode(mode === "draw" ? "none" : "draw"); setMovingId(null); }}
              className={`w-9 h-9 rounded-lg flex items-center justify-center text-base ${mode === "draw" ? "bg-orange-500 text-black" : "bg-gray-900/80 border border-gray-700 hover:bg-gray-800"}`} title="Line">✏️</button>
            <button type="button" onClick={() => { setMode(mode === "ray" ? "none" : "ray"); setMovingId(null); }}
              className={`w-9 h-9 rounded-lg flex items-center justify-center text-base ${mode === "ray" ? "bg-orange-500 text-black" : "bg-gray-900/80 border border-gray-700 hover:bg-gray-800"}`} title="Ray">➡️</button>
            <button type="button" onClick={() => { setMode(mode === "alarm" ? "none" : "alarm"); setMovingId(null); }}
              className={`w-9 h-9 rounded-lg flex items-center justify-center text-base ${mode === "alarm" ? "bg-orange-500 text-black" : "bg-gray-900/80 border border-gray-700 hover:bg-gray-800"}`} title="Alarm">🔔</button>
            <button type="button" onClick={() => setShowIndicatorMenu((v) => !v)}
              className={`w-9 h-9 rounded-lg flex items-center justify-center text-base ${showIndicatorMenu ? "bg-orange-500 text-black" : "bg-gray-900/80 border border-gray-700 hover:bg-gray-800"}`} title="Indicators">📊</button>
          </div>

          {/* Indicator chips - top left over chart (previous style) */}
          <div className="absolute top-2 left-12 z-20 flex flex-col gap-0.5 items-start">
            {showSMA && (
              <IndChip label={`SMA ${sma1}/${sma2}/${sma3}`} visible={smaVisible}
                onToggleVisible={() => setSmaVisible((v) => !v)}
                onSettings={() => setSmaSettings(true)}
                onRemove={() => { setShowSMA(false); removeSMA(); }} />
            )}
            {showPivot && (
              <IndChip label={`Pivot ${pivotTf}${pivotFib ? " Fib" : ""}`} visible={pivotVisible}
                onToggleVisible={() => setPivotVisible((v) => !v)}
                onSettings={() => setPivotSettings(true)}
                onRemove={() => { setShowPivot(false); removePivot(); }} />
            )}
            {showTrend && (
              <IndChip label={`Trend ${trendPeriod}`} visible={trendVisible}
                onToggleVisible={() => setTrendVisible((v) => !v)}
                onSettings={() => setTrendSettings(true)}
                onRemove={() => { setShowTrend(false); removeTrend(); }} />
            )}
            {showRSI && (
              <IndChip label={`RSI ${rsiPeriod}`} visible={rsiVisible}
                onToggleVisible={() => setRsiVisible((v) => !v)}
                onSettings={() => setRsiSettings(true)}
                onRemove={() => { setShowRSI(false); removeRSI(); }} />
            )}
            {showDMI && (
              <IndChip label={`DMI ${dmiPeriod}`} visible={dmiVisible}
                onToggleVisible={() => setDmiVisible((v) => !v)}
                onSettings={() => setDmiSettings(true)}
                onRemove={() => { setShowDMI(false); removeDMI(); }} />
            )}
            {showVol && (
              <IndChip label="Vol" visible={volVisible}
                onToggleVisible={() => setVolVisible((v) => !v)}
                onRemove={() => { setShowVol(false); applyVolume(); }} />
            )}
          </div>

          {/* Indicator menu */}
          {showIndicatorMenu && (
            <div className="absolute left-12 top-12 z-30 bg-gray-900 border border-gray-700 rounded-lg p-2 shadow-xl w-40">
              {[
                { key: "sma", label: "3SMA", on: showSMA, set: setShowSMA },
                { key: "pivot", label: "Pivot", on: showPivot, set: setShowPivot },
                { key: "trend", label: "Trend", on: showTrend, set: setShowTrend },
                { key: "rsi", label: "RSI", on: showRSI, set: setShowRSI },
                { key: "dmi", label: "DMI", on: showDMI, set: setShowDMI },
                { key: "vol", label: "Volume", on: showVol, set: setShowVol },
              ].map((it) => (
                <button key={it.key} type="button"
                  onClick={() => it.set((v: boolean) => !v)}
                  className={`w-full text-left px-2 py-1.5 rounded text-sm mb-0.5 ${it.on ? "bg-orange-500/20 text-orange-300" : "hover:bg-gray-800"}`}>
                  {it.on ? "✓ " : ""}{it.label}
                </button>
              ))}
            </div>
          )}

          {/* Draw options when tool active */}
          {(mode === "draw" || mode === "ray" || mode === "alarm") && (
            <div className="absolute left-12 bottom-4 z-20 flex items-center gap-2 bg-gray-900/90 border border-gray-700 rounded-lg px-2 py-1.5">
              <input type="color" value={drawColor} onChange={(e) => setDrawColor(e.target.value)} className="w-7 h-7 rounded cursor-pointer bg-transparent" />
              <div className="flex gap-1">
                {LINE_WIDTHS.map((w) => (
                  <button key={w} type="button" onClick={() => setDrawWidth(w)}
                    className={`w-7 h-7 rounded text-xs ${drawWidth === w ? "bg-orange-500 text-black" : "bg-gray-800"}`}>{w}</button>
                ))}
              </div>
              <button type="button" onClick={() => setDrawDash((d) => (d === "solid" ? "dashed" : "solid"))}
                className="px-2 py-1 text-xs rounded bg-gray-800 hover:bg-gray-700">
                {drawDash === "solid" ? "━" : "┅"}
              </button>
              {mode === "alarm" && (
                <div className="flex gap-1">
                  {(["cross", "above", "below"] as const).map((c) => (
                    <button key={c} type="button" onClick={() => setCondition(c)}
                      className={`px-2 py-1 text-xs rounded ${condition === c ? "bg-orange-500 text-black" : "bg-gray-800"}`}>
                      {c === "cross" ? "Cross" : c === "above" ? "Above" : "Below"}
                    </button>
                  ))}
                </div>
              )}
              {previewPrice != null && (
                <span className="text-xs text-orange-300 font-mono">{previewPrice}</span>
              )}
            </div>
          )}

          <div ref={chartContainerRef} className="absolute inset-0" />
        </div>

        {/* Side watchlist */}
        {showSideWl && (
          <div className="w-44 border-l border-gray-800 bg-[#0f1318] flex flex-col overflow-hidden">
            <div className="px-2 py-2 text-xs text-gray-400 border-b border-gray-800">With alarms</div>
            <div className="flex-1 overflow-y-auto" onPointerUp={onSidePointerUp} onPointerLeave={onSidePointerUp}>
              {alarmSymbols.map((sym) => {
                const isDrag = draggingSym === sym;
                const isOver = dragOverSym === sym && draggingSym !== sym;
                return (
                  <div key={sym}>
                    {isOver && (
                      <div className="h-8 mx-1 my-0.5 border border-dashed border-orange-500/60 rounded bg-orange-500/10" />
                    )}
                    <div
                      onPointerDown={(e) => onSidePointerDown(e, sym)}
                      onPointerEnter={() => onSidePointerEnter(sym)}
                      onClick={() => { if (!draggingSym) setSymbol(sym); }}
                      className={`flex items-center gap-2 px-2 py-2 cursor-grab active:cursor-grabbing select-none transition-transform duration-100
                        ${isDrag ? "opacity-40 scale-[0.96] bg-gray-800" : "hover:bg-gray-800/80"}
                        ${symbol === sym ? "bg-gray-800/60" : ""}`}
                      style={{ willChange: "transform" }}
                    >
                      <CoinIcon symbol={sym} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium truncate">{sym}</div>
                        <div className="text-[10px] text-gray-500">
                          A:{alarmCountBySym[sym] || 0} L:{lineCountBySym[sym] || 0}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
              {!alarmSymbols.length && (
                <p className="text-gray-600 text-xs p-3">No active alarms</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom lists */}
      <div className="border-t border-gray-800 bg-[#0f1318] max-h-52 overflow-y-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-0">
          {/* Alarms */}
          <div className="p-3 border-r border-gray-800">
            <div className="text-sm font-medium mb-2 text-gray-300">
              Alarms — {symbol} ({currentAlarms.length})
            </div>
            {currentAlarms.map((a) => (
              <div key={a.id} className="flex items-center gap-2 py-1.5 border-b border-gray-800/50 text-sm">
                <span className="font-mono text-xs w-24 shrink-0" style={{ color: a.color || DEFAULT_ALARM_COLOR }}>
                  {a.price}
                </span>
                <button type="button" onClick={() => updateAlarmField(a.id, {
                  condition: a.condition === "cross" ? "above" : a.condition === "above" ? "below" : "cross",
                })}
                  className="text-[11px] px-1.5 py-0.5 rounded bg-gray-800 hover:bg-gray-700 shrink-0">
                  {getConditionLabel(a.condition)}
                </button>
                <input type="color" value={a.color || DEFAULT_ALARM_COLOR}
                  onChange={(e) => updateAlarmField(a.id, { color: e.target.value })}
                  className="w-5 h-5 rounded cursor-pointer bg-transparent shrink-0" />
                <div className="flex gap-0.5 shrink-0">
                  {LINE_WIDTHS.map((w) => (
                    <button key={w} type="button"
                      onClick={() => updateAlarmField(a.id, { width: w })}
                      className={`w-5 h-5 text-[10px] rounded ${(a.width || 2) === w ? "bg-orange-500 text-black" : "bg-gray-800"}`}>{w}</button>
                  ))}
                </div>
                <button type="button"
                  onClick={() => updateAlarmField(a.id, { dash: a.dash === "dashed" ? "solid" : "dashed" })}
                  className="text-xs px-1 bg-gray-800 rounded shrink-0">{a.dash === "dashed" ? "┅" : "━"}</button>
                <button type="button" onClick={() => { setEditingNoteId(a.id); setEditingNoteType("alarm"); setNoteDraft(a.note || ""); }}
                  className="text-[11px] text-gray-400 hover:text-white shrink-0">Note</button>
                <button type="button" onClick={() => startMove(a.id, "alarm")}
                  className="text-[11px] text-blue-400 hover:text-blue-300 shrink-0">Move</button>
                <button type="button" onClick={() => deleteAlarm(a.id)}
                  className="text-[11px] text-red-400 hover:text-red-300 ml-auto shrink-0">Delete</button>
              </div>
            ))}
            {!currentAlarms.length && <p className="text-gray-600 text-xs">No alarms</p>}
          </div>

          {/* Lines */}
          <div className="p-3">
            <div className="text-sm font-medium mb-2 text-gray-300">
              Lines — {symbol} ({currentLines.length})
            </div>
            {currentLines.map((l) => (
              <div key={l.id} className="flex items-center gap-2 py-1.5 border-b border-gray-800/50 text-sm">
                <span className="font-mono text-xs w-24 shrink-0" style={{ color: l.color || DEFAULT_LINE_COLOR }}>
                  {l.price}
                </span>
                <input type="color" value={l.color || DEFAULT_LINE_COLOR}
                  onChange={(e) => updateLineField(l.id, { color: e.target.value })}
                  className="w-5 h-5 rounded cursor-pointer bg-transparent shrink-0" />
                <div className="flex gap-0.5 shrink-0">
                  {LINE_WIDTHS.map((w) => (
                    <button key={w} type="button"
                      onClick={() => updateLineField(l.id, { width: w })}
                      className={`w-5 h-5 text-[10px] rounded ${(l.width || 2) === w ? "bg-orange-500 text-black" : "bg-gray-800"}`}>{w}</button>
                  ))}
                </div>
                <button type="button"
                  onClick={() => updateLineField(l.id, { dash: l.dash === "dashed" ? "solid" : "dashed" })}
                  className="text-xs px-1 bg-gray-800 rounded shrink-0">{l.dash === "dashed" ? "┅" : "━"}</button>
                <button type="button" onClick={() => { setEditingNoteId(l.id); setEditingNoteType("line"); setNoteDraft(l.note || ""); }}
                  className="text-[11px] text-gray-400 hover:text-white shrink-0">Note</button>
                <button type="button" onClick={() => startMove(l.id, "line")}
                  className="text-[11px] text-blue-400 hover:text-blue-300 shrink-0">Move</button>
                <button type="button" onClick={() => convertLineToAlarm(l)}
                  className="text-[11px] text-orange-400 hover:text-orange-300 shrink-0">Alarm</button>
                <button type="button" onClick={() => deleteLine(l.id)}
                  className="text-[11px] text-red-400 hover:text-red-300 ml-auto shrink-0">Delete</button>
              </div>
            ))}
            {!currentLines.length && <p className="text-gray-600 text-xs">No lines</p>}
          </div>
        </div>

        {editingNoteId && (
          <div className="px-3 pb-3 flex gap-2">
            <input value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)}
              className="flex-1 bg-gray-800 rounded px-2 py-1 text-sm" placeholder="Note..." />
            <button type="button" onClick={saveNote} className="text-green-400 text-sm px-2">Save</button>
            <button type="button" onClick={() => { setEditingNoteId(null); setEditingNoteType(null); }}
              className="text-gray-500 text-sm px-2">Cancel</button>
          </div>
        )}
      </div>

      {/* Settings modals */}
      {smaSettings && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={() => setSmaSettings(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 w-72" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-medium mb-3">SMA Settings</div>
            {[
              { str: sma1Str, setStr: setSma1Str, set: setSma1, col: smaColor1, setCol: setSmaColor1, label: "SMA 1" },
              { str: sma2Str, setStr: setSma2Str, set: setSma2, col: smaColor2, setCol: setSmaColor2, label: "SMA 2" },
              { str: sma3Str, setStr: setSma3Str, set: setSma3, col: smaColor3, setCol: setSmaColor3, label: "SMA 3" },
            ].map((row) => (
              <div key={row.label} className="flex items-center gap-2 mb-2">
                <span className="text-xs w-14">{row.label}</span>
                <input value={row.str} onChange={(e) => row.setStr(e.target.value)}
                  onBlur={() => { const n = parseInt(row.str, 10); if (!Number.isNaN(n) && n > 0) row.set(n); }}
                  className="bg-gray-800 rounded px-2 py-1 text-sm w-16" />
                <input type="color" value={row.col} onChange={(e) => row.setCol(e.target.value)} className="w-7 h-7 bg-transparent" />
              </div>
            ))}
            <button type="button" onClick={() => setSmaSettings(false)} className="mt-2 w-full py-1.5 bg-orange-500 text-black rounded text-sm">OK</button>
          </div>
        </div>
      )}

      {pivotSettings && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={() => setPivotSettings(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 w-72" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-medium mb-3">Pivot Settings</div>
            <div className="flex gap-1 mb-3">
              {PIVOT_TFS.map((t) => (
                <button key={t.value} type="button" onClick={() => setPivotTf(t.value)}
                  className={`px-2 py-1 text-xs rounded ${pivotTf === t.value ? "bg-orange-500 text-black" : "bg-gray-800"}`}>{t.label}</button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-sm mb-3">
              <input type="checkbox" checked={pivotFib} onChange={(e) => setPivotFib(e.target.checked)} />
              Fibonacci
            </label>
            <button type="button" onClick={() => setPivotSettings(false)} className="w-full py-1.5 bg-orange-500 text-black rounded text-sm">OK</button>
          </div>
        </div>
      )}

      {rsiSettings && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={() => setRsiSettings(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 w-72" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-medium mb-3">RSI Settings</div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs w-14">Period</span>
              <input value={rsiPeriodStr} onChange={(e) => setRsiPeriodStr(e.target.value)}
                onBlur={() => { const n = parseInt(rsiPeriodStr, 10); if (!Number.isNaN(n) && n > 1) setRsiPeriod(n); }}
                className="bg-gray-800 rounded px-2 py-1 text-sm w-16" />
              <input type="color" value={rsiColor} onChange={(e) => setRsiColor(e.target.value)} className="w-7 h-7 bg-transparent" />
            </div>
            <button type="button" onClick={() => setRsiSettings(false)} className="mt-2 w-full py-1.5 bg-orange-500 text-black rounded text-sm">OK</button>
          </div>
        </div>
      )}

      {dmiSettings && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={() => setDmiSettings(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 w-72" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-medium mb-3">DMI Settings</div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs w-14">Period</span>
              <input value={dmiPeriodStr} onChange={(e) => setDmiPeriodStr(e.target.value)}
                onBlur={() => { const n = parseInt(dmiPeriodStr, 10); if (!Number.isNaN(n) && n > 1) setDmiPeriod(n); }}
                className="bg-gray-800 rounded px-2 py-1 text-sm w-16" />
            </div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs">+DI</span>
              <input type="color" value={dmiPlusColor} onChange={(e) => setDmiPlusColor(e.target.value)} className="w-7 h-7 bg-transparent" />
              <span className="text-xs">-DI</span>
              <input type="color" value={dmiMinusColor} onChange={(e) => setDmiMinusColor(e.target.value)} className="w-7 h-7 bg-transparent" />
              <span className="text-xs">ADX</span>
              <input type="color" value={dmiAdxColor} onChange={(e) => setDmiAdxColor(e.target.value)} className="w-7 h-7 bg-transparent" />
            </div>
            <button type="button" onClick={() => setDmiSettings(false)} className="mt-2 w-full py-1.5 bg-orange-500 text-black rounded text-sm">OK</button>
          </div>
        </div>
      )}

      {trendSettings && (
        <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center" onClick={() => setTrendSettings(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 w-72" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm font-medium mb-3">Trend Settings</div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs w-20">Period</span>
              <input value={trendPeriodStr} onChange={(e) => setTrendPeriodStr(e.target.value)}
                onBlur={() => { const n = parseInt(trendPeriodStr, 10); if (!Number.isNaN(n) && n >= 10) setTrendPeriod(n); }}
                className="bg-gray-800 rounded px-2 py-1 text-sm w-16" />
            </div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs w-20">Pivots</span>
              <input value={trendPivotCountStr} onChange={(e) => setTrendPivotCountStr(e.target.value)}
                onBlur={() => { const n = parseInt(trendPivotCountStr, 10); if (!Number.isNaN(n) && n >= 2) setTrendPivotCount(Math.min(6, n)); }}
                className="bg-gray-800 rounded px-2 py-1 text-sm w-16" />
            </div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs w-20">Max lines</span>
              <input type="number" min={1} max={10} value={trendMax}
                onChange={(e) => setTrendMax(Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1)))}
                className="bg-gray-800 rounded px-2 py-1 text-sm w-16" />
            </div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs">Up</span>
              <input type="color" value={trendUpColor} onChange={(e) => setTrendUpColor(e.target.value)} className="w-7 h-7 bg-transparent" />
              <span className="text-xs">Down</span>
              <input type="color" value={trendDownColor} onChange={(e) => setTrendDownColor(e.target.value)} className="w-7 h-7 bg-transparent" />
            </div>
            <button type="button" onClick={() => setTrendSettings(false)} className="mt-2 w-full py-1.5 bg-orange-500 text-black rounded text-sm">OK</button>
          </div>
        </div>
      )}
    </div>
  );
}

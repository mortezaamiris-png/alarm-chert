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
function barSeconds(tf: string) {
  if (tf === "1") return 60;
  if (tf === "5") return 300;
  if (tf === "15") return 900;
  if (tf === "60") return 3600;
  if (tf === "120") return 7200;
  if (tf === "240") return 14400;
  if (tf === "D") return 86400;
  if (tf === "W") return 604800;
  if (tf === "M") return 2592000;
  return 3600;
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
  let gains = 0,
    losses = 0;
  for (let i = 1; i <= p; i++) {
    const d = candles[i].close - candles[i - 1].close;
    if (d >= 0) gains += d;
    else losses -= d;
  }
  let avgGain = gains / p,
    avgLoss = losses / p;
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
    const h = candles[i].high,
      l = candles[i].low,
      pc = candles[i - 1].close;
    const ph = candles[i - 1].high,
      pl = candles[i - 1].low;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph,
      down = pl - l;
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
  const highs: { time: number; price: number }[] = [];
  const lows: { time: number; price: number }[] = [];
  const lr = Math.max(2, leftRight);
  for (let i = lr; i < candles.length - lr; i++) {
    let isH = true,
      isL = true;
    for (let j = 1; j <= lr; j++) {
      if (candles[i].high < candles[i - j].high || candles[i].high < candles[i + j].high)
        isH = false;
      if (candles[i].low > candles[i - j].low || candles[i].low > candles[i + j].low)
        isL = false;
    }
    if (isH) highs.push({ time: candles[i].time, price: candles[i].high });
    if (isL) lows.push({ time: candles[i].time, price: candles[i].low });
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
}

function getConditionSymbol(c: string) {
  return c === "above" ? "≥" : c === "below" ? "≤" : "≈";
}
function getConditionLabel(c: string) {
  return c === "above" ? "Above" : c === "below" ? "Below" : "Cross";
}
function didCross(
  condition: string,
  target: number,
  prev: number | null | undefined,
  price: number
) {
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
      alt=""
      width={20}
      height={20}
      className="w-5 h-5 rounded-full shrink-0"
      onError={(e) => {
        (e.target as HTMLImageElement).src = `https://ui-avatars.com/api/?name=${base}&background=374151&color=fff&size=32`;
      }}
    />
  );
}

function IndChip({
  label,
  visible,
  onToggleVisible,
  onSettings,
  onRemove,
}: {
  label: string;
  visible: boolean;
  onToggleVisible: () => void;
  onSettings?: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 bg-[#1c1c1c]/95 border border-gray-700 rounded-md px-1.5 py-0.5 text-[11px] text-gray-200 shadow-md">
      <span className="px-1 font-medium whitespace-nowrap">{label}</span>
      <button type="button" onClick={onToggleVisible} className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-700">
        {visible ? "👁" : "⊘"}
      </button>
      {onSettings && (
        <button type="button" onClick={onSettings} className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-700">
          ⚙
        </button>
      )}
      <button type="button" onClick={onRemove} className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-700 text-red-400">
        🗑
      </button>
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
  const [condition, setCondition] = useState<"above" | "below" | "cross">("above");
  const [saving, setSaving] = useState(false);
  const [showIndicatorMenu, setShowIndicatorMenu] = useState(false);
  const [showSideWl, setShowSideWl] = useState(true);
  const [statusMsg, setStatusMsg] = useState("");

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
  const [trendPeriod, setTrendPeriod] = useState(() => loadLS("trend_p", 5));
  const [trendPeriodStr, setTrendPeriodStr] = useState(() => String(loadLS("trend_p", 5)));
  const [trendUpColor, setTrendUpColor] = useState(() => loadLS("trend_up", "#84cc16"));
  const [trendDownColor, setTrendDownColor] = useState(() => loadLS("trend_dn", "#ef4444"));
  const [trendMax, setTrendMax] = useState(() => loadLS("trend_max", 4));

  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteType, setEditingNoteType] = useState<"line" | "alarm" | null>(null);
  const [noteDraft, setNoteDraft] = useState("");

  const modeRef = useRef(mode);
  const previewPriceRef = useRef(previewPrice);
  const conditionRef = useRef(condition);
  const movingIdRef = useRef(movingId);
  const movingTypeRef = useRef(movingType);
  const drawColorRef = useRef(drawColor);
  const drawWidthRef = useRef(drawWidth);
  const drawDashRef = useRef(drawDash);
  const symbolRef = useRef(symbol);
  const alarmsRef = useRef(alarms);
  const linesRef = useRef(lines);
  const intervalRef = useRef(interval);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { previewPriceRef.current = previewPrice; }, [previewPrice]);
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
  useEffect(() => { linesRef.current = lines; }, [lines]);

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
    saveLS("trend_p", trendPeriod); saveLS("trend_up", trendUpColor);
    saveLS("trend_dn", trendDownColor); saveLS("trend_max", trendMax);
  }, [showTrend, trendVisible, trendPeriod, trendUpColor, trendDownColor, trendMax]);

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
  const alarmSymbols = useMemo(() => {
    const set = new Set<string>();
    alarms.forEach((a) => {
      if (a.is_active && !a.triggered) set.add(a.symbol.toUpperCase());
    });
    return Array.from(set).sort();
  }, [alarms]);

  const updateMargins = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    let bottom = 0.05;
    if (showVol && volVisible) {
      try {
        chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      } catch {}
      bottom = 0.2;
    }
    if (showRSI && rsiVisible) {
      try {
        chart.priceScale("rsi").applyOptions({ scaleMargins: { top: 0.72, bottom } });
      } catch {}
    }
    if (showDMI && dmiVisible) {
      try {
        chart.priceScale("dmi").applyOptions({ scaleMargins: { top: 0.78, bottom } });
      } catch {}
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
  }, []);  const clearAllDrawings = useCallback(() => {
    if (seriesRef.current) {
      alarmLinesRef.current.forEach((pl) => {
        try { seriesRef.current!.removePriceLine(pl); } catch {}
      });
    }
    alarmLinesRef.current.clear();
    if (chartRef.current) {
      chartLinesRef.current.forEach((s) => {
        try { chartRef.current!.removeSeries(s); } catch {}
      });
    }
    chartLinesRef.current.clear();
    clearPreview();
  }, [clearPreview]);

  const renderAllLinesAndAlarms = useCallback(() => {
    if (!seriesRef.current || !chartRef.current) return;
    const series = seriesRef.current;
    const chart = chartRef.current;
    const sym = symbolRef.current.toUpperCase();
    const candles = candlesRef.current;

    clearAllDrawings();

    linesRef.current
      .filter((l) => l.symbol.toUpperCase() === sym)
      .forEach((l) => {
        try {
          if (l.style === "ray" && l.start_time && candles.length) {
            const lastT = candles[candles.length - 1].time as number;
            const ray = chart.addLineSeries({
              color: l.color || DEFAULT_LINE_COLOR,
              lineWidth: (l.width as any) || 2,
              lineStyle: toLineStyle(l.dash),
              priceLineVisible: false,
              lastValueVisible: true,
              crosshairMarkerVisible: false,
            });
            ray.setData([
              { time: l.start_time as any, value: l.price },
              { time: (lastT + barSeconds(intervalRef.current) * 80) as any, value: l.price },
            ]);
            chartLinesRef.current.set(l.id, ray);
          } else {
            const pl = series.createPriceLine({
              price: l.price,
              color: l.color || DEFAULT_LINE_COLOR,
              lineWidth: (l.width as any) || 2,
              lineStyle: toLineStyle(l.dash),
              axisLabelVisible: true,
              title: l.note ? String(l.note) : `Line ${formatPrice(l.price)}`,
            });
            alarmLinesRef.current.set(`line-${l.id}`, pl);
          }
        } catch (e) {
          console.error("render line", e);
        }
      });

    alarmsRef.current
      .filter((a) => a.symbol.toUpperCase() === sym && a.is_active && !a.triggered)
      .forEach((a) => {
        try {
          const pl = series.createPriceLine({
            price: a.price,
            color: a.color || DEFAULT_ALARM_COLOR,
            lineWidth: (a.width as any) || 2,
            lineStyle: toLineStyle(a.dash),
            axisLabelVisible: true,
            title: `Alarm ${getConditionSymbol(a.condition)} ${formatPrice(a.price)}`,
          });
          alarmLinesRef.current.set(a.id, pl);
        } catch (e) {
          console.error("render alarm", e);
        }
      });
  }, [clearAllDrawings]);

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
    if (!chartRef.current || !smaVisible) return;
    removeSMA();
    const c = chartRef.current;
    const s1 = c.addLineSeries({ color: smaColor1, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const s2 = c.addLineSeries({ color: smaColor2, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const s3 = c.addLineSeries({ color: smaColor3, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    s1.setData(calcSMA(candles, sma1) as any);
    s2.setData(calcSMA(candles, sma2) as any);
    s3.setData(calcSMA(candles, sma3) as any);
    smaSeriesRef.current = { s1, s2, s3 };
  };

  const removeRSI = () => {
    if (!chartRef.current || !rsiSeriesRef.current) return;
    try { chartRef.current.removeSeries(rsiSeriesRef.current); } catch {}
    rsiSeriesRef.current = null;
  };
  const applyRSI = (candles: any[]) => {
    if (!chartRef.current || !rsiVisible) return;
    removeRSI();
    const s = chartRef.current.addLineSeries({
      color: rsiColor, lineWidth: 2, priceScaleId: "rsi",
      priceLineVisible: false, lastValueVisible: true,
    });
    s.setData(calcRSI(candles, rsiPeriod) as any);
    rsiSeriesRef.current = s;
    updateMargins();
  };

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
    if (!chartRef.current || !dmiVisible) return;
    removeDMI();
    const { plusDI, minusDI, adx } = calcDMI(candles, dmiPeriod);
    const plus = chartRef.current.addLineSeries({ color: dmiPlusColor, lineWidth: 1, priceScaleId: "dmi", priceLineVisible: false, lastValueVisible: false });
    const minus = chartRef.current.addLineSeries({ color: dmiMinusColor, lineWidth: 1, priceScaleId: "dmi", priceLineVisible: false, lastValueVisible: false });
    const adxS = chartRef.current.addLineSeries({ color: dmiAdxColor, lineWidth: 2, priceScaleId: "dmi", priceLineVisible: false, lastValueVisible: true });
    plus.setData(plusDI as any);
    minus.setData(minusDI as any);
    adxS.setData(adx as any);
    dmiSeriesRef.current = { plus, minus, adx: adxS };
    updateMargins();
  };

  const removePivot = () => {
    if (!chartRef.current) return;
    pivotSeriesRef.current.forEach((s) => { try { chartRef.current!.removeSeries(s); } catch {} });
    pivotSeriesRef.current = [];
  };
  const applyPivot = (candles: any[]) => {
    if (!chartRef.current || !pivotVisible || !candles.length) return;
    removePivot();
    const last = candles[candles.length - 1];
    const lookback = pivotTf === "W" ? 30 : pivotTf === "D" ? 15 : 8;
    const slice = candles.slice(-lookback * 3);
    const hi = Math.max(...slice.map((c: any) => c.high));
    const lo = Math.min(...slice.map((c: any) => c.low));
    const cl = last.close;
    const pp = (hi + lo + cl) / 3;
    const levels = [
      { p: pp, c: "#eab308", t: "PP" },
      { p: 2 * pp - lo, c: "#ef4444", t: "R1" },
      { p: 2 * pp - hi, c: "#22c55e", t: "S1" },
      { p: pp + (hi - lo), c: "#f97316", t: "R2" },
      { p: pp - (hi - lo), c: "#14b8a6", t: "S2" },
    ];
    if (pivotFib) {
      levels.push(
        { p: hi + 2 * (pp - lo), c: "#dc2626", t: "R3" },
        { p: lo - 2 * (hi - pp), c: "#16a34a", t: "S3" }
      );
    }
    const t0 = candles[Math.max(0, candles.length - 80)].time;
    const t1 = last.time;
    levels.forEach((lv) => {
      const s = chartRef.current!.addLineSeries({
        color: lv.c, lineWidth: 1, lineStyle: LineStyle.Dashed,
        priceLineVisible: false, lastValueVisible: true, title: lv.t,
      });
      s.setData([
        { time: t0 as any, value: lv.p },
        { time: t1 as any, value: lv.p },
      ]);
      pivotSeriesRef.current.push(s);
    });
  };

  const removeTrend = () => {
    if (!chartRef.current) return;
    trendSeriesRef.current.forEach((s) => { try { chartRef.current!.removeSeries(s); } catch {} });
    trendSeriesRef.current = [];
  };
  // Trend ساده: فقط آخرین ۲ سقف و ۲ کف را وصل کن
  const applyTrend = (candles: any[]) => {
    if (!chartRef.current || !trendVisible || candles.length < 30) return;
    removeTrend();
    const lr = Math.max(2, Math.min(12, trendPeriod));
    const { highs, lows } = findPivots(candles, lr);
    const up = highs.slice(-Math.max(2, trendMax));
    const dn = lows.slice(-Math.max(2, trendMax));
    if (up.length >= 2) {
      const a = up[up.length - 2];
      const b = up[up.length - 1];
      const s = chartRef.current.addLineSeries({
        color: trendUpColor, lineWidth: 2,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      s.setData([
        { time: a.time as any, value: a.price },
        { time: b.time as any, value: b.price },
      ]);
      trendSeriesRef.current.push(s);
    }
    if (dn.length >= 2) {
      const a = dn[dn.length - 2];
      const b = dn[dn.length - 1];
      const s = chartRef.current.addLineSeries({
        color: trendDownColor, lineWidth: 2,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      s.setData([
        { time: a.time as any, value: a.price },
        { time: b.time as any, value: b.price },
      ]);
      trendSeriesRef.current.push(s);
    }
  };

  const destroyChart = () => {
    clearAllDrawings();
    removeSMA(); removeRSI(); removeDMI(); removePivot(); removeTrend();
    if (chartRef.current) {
      try { chartRef.current.remove(); } catch {}
    }
    chartRef.current = null;
    seriesRef.current = null;
    volumeSeriesRef.current = null;
    if (chartContainerRef.current) chartContainerRef.current.innerHTML = "";
  };

  const loadCandles = useCallback(async () => {
    if (!chartContainerRef.current) return;
    try {
      const res = await fetch(
        `/api/kline?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=500`
      );
      const json = await res.json();
      const raw = json?.data || json;
      if (!Array.isArray(raw) || !raw.length) {
        setStatusMsg("No candle data");
        return;
      }

      const processed = raw.map((item: any) => ({
        time: item.time,
        open: Number(item.open),
        high: Number(item.high),
        low: Number(item.low),
        close: Number(item.close),
        volume: Number(item.volume ?? 0),
      }));
      candlesRef.current = processed;
      const last = processed[processed.length - 1]?.close || 1;
      const { precision, minMove } = getPrecision(last);

      // همیشه چارت را از نو بساز تا مقیاس قیمت درست شود
      destroyChart();

      const chart = createChart(chartContainerRef.current, {
        width: chartContainerRef.current.clientWidth,
        height: 700,
        layout: { background: { color: "#111111" }, textColor: "#ccc" },
        grid: { vertLines: { color: "#222" }, horzLines: { color: "#222" } },
        // بدون آهن‌ربا
        crosshair: { mode: CrosshairMode.Normal },
        timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#333" },
        rightPriceScale: { borderColor: "#333", autoScale: true },
      });
      chartRef.current = chart;

      const candleSeries = chart.addCandlestickSeries({
        upColor: "#22c55e",
        downColor: "#ef4444",
        borderUpColor: "#22c55e",
        borderDownColor: "#ef4444",
        wickUpColor: "#22c55e",
        wickDownColor: "#ef4444",
        priceFormat: { type: "price", precision, minMove },
      });
      seriesRef.current = candleSeries;
      candleSeries.setData(processed as any);

      const volSeries = chart.addHistogramSeries({
        color: "#666",
        priceFormat: { type: "volume" },
        priceScaleId: "volume",
        lastValueVisible: false,
        priceLineVisible: false,
        visible: showVol && volVisible,
      });
      volumeSeriesRef.current = volSeries;
      volSeries.setData(
        processed.map((c: any) => ({
          time: c.time,
          value: c.volume,
          color: c.close >= c.open ? "rgba(34,197,94,0.45)" : "rgba(239,68,68,0.45)",
        })) as any
      );
      chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

      chart.timeScale().fitContent();
      chart.priceScale("right").applyOptions({ autoScale: true });

      chart.subscribeCrosshairMove((param) => {
        const m = modeRef.current;
        if (m !== "draw" && m !== "ray" && m !== "alarm" && m !== "move") return;
        if (!param.point || param.point.y < 0 || !seriesRef.current) return;
        const price = seriesRef.current.coordinateToPrice(param.point.y);
        if (price == null || Number.isNaN(price as number)) return;
        setPreviewPrice(price as number);

        if (previewLineRef.current) {
          try { seriesRef.current.removePriceLine(previewLineRef.current); } catch {}
        }
        const col = m === "alarm" ? DEFAULT_ALARM_COLOR : drawColorRef.current;
        previewLineRef.current = seriesRef.current.createPriceLine({
          price: price as number,
          color: col,
          lineWidth: drawWidthRef.current,
          lineStyle: toLineStyle(drawDashRef.current),
          axisLabelVisible: true,
          title:
            m === "alarm"
              ? `Alarm ${getConditionSymbol(conditionRef.current)}`
              : m === "ray"
              ? "Ray"
              : m === "move"
              ? "Move"
              : "Line",
        });
      });

      chart.subscribeClick(async (param) => {
        if (clickLockRef.current) return;
        if (!param.point || !seriesRef.current) return;
        const priceRaw = seriesRef.current.coordinateToPrice(param.point.y);
        if (priceRaw == null) return;
        const p = formatPrice(priceRaw as number);
        const m = modeRef.current;

        clickLockRef.current = true;
        try {
          if (m === "move" && movingIdRef.current && movingTypeRef.current) {
            await updateMoved(movingIdRef.current, movingTypeRef.current, p);
            setMovingId(null);
            setMovingType(null);
            setMode("none");
            clearPreview();
            return;
          }
          if (m === "draw" || m === "ray") {
            const t = param.time != null ? Number(param.time) : candlesRef.current[candlesRef.current.length - 1]?.time;
            await saveLine(p, m === "ray" ? "ray" : "line", t);
            setMode("none");
            clearPreview();
            return;
          }
          if (m === "alarm") {
            await saveAlarm(p);
            setMode("none");
            clearPreview();
            return;
          }
        } finally {
          setTimeout(() => { clickLockRef.current = false; }, 300);
        }
      });

      if (showSMA && smaVisible) applySMA(processed);
      if (showRSI && rsiVisible) applyRSI(processed);
      if (showDMI && dmiVisible) applyDMI(processed);
      if (showPivot && pivotVisible) applyPivot(processed);
      if (showTrend && trendVisible) applyTrend(processed);
      updateMargins();
      renderAllLinesAndAlarms();
      setStatusMsg("");
    } catch (e: any) {
      console.error(e);
      setStatusMsg(e?.message || "Load failed");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, interval]);

  const loadAllLines = useCallback(async () => {
    const { data, error } = await supabase
      .from("chart_lines")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) console.error("lines", error);
    setLines((data as ChartLine[]) || []);
  }, []);

  const loadAllAlarms = useCallback(async () => {
    const { data, error } = await supabase
      .from("alarms")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) console.error("alarms", error);
    setAlarms((data as Alarm[]) || []);
  }, []);

  useEffect(() => {
    loadAllLines();
    loadAllAlarms();
  }, [loadAllLines, loadAllAlarms]);

  useEffect(() => {
    loadCandles();
  }, [loadCandles]);

  useEffect(() => {
    renderAllLinesAndAlarms();
  }, [lines, alarms, symbol, renderAllLinesAndAlarms]);

  useEffect(() => {
    const onResize = () => {
      if (chartContainerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      if (chartContainerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    }, 320);
    return () => clearTimeout(t);
  }, [showSideWl]);

  // re-apply indicators when toggled
  useEffect(() => {
    const c = candlesRef.current;
    if (!c.length || !chartRef.current) return;
    if (showSMA && smaVisible) applySMA(c); else removeSMA();
    if (showRSI && rsiVisible) applyRSI(c); else removeRSI();
    if (showDMI && dmiVisible) applyDMI(c); else removeDMI();
    if (showPivot && pivotVisible) applyPivot(c); else removePivot();
    if (showTrend && trendVisible) applyTrend(c); else removeTrend();
    if (volumeSeriesRef.current) {
      volumeSeriesRef.current.applyOptions({ visible: showVol && volVisible });
    }
    updateMargins();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSMA, smaVisible, sma1, sma2, sma3, smaColor1, smaColor2, smaColor3,
      showRSI, rsiVisible, rsiPeriod, rsiColor,
      showDMI, dmiVisible, dmiPeriod, dmiPlusColor, dmiMinusColor, dmiAdxColor,
      showPivot, pivotVisible, pivotTf, pivotFib,
      showTrend, trendVisible, trendPeriod, trendUpColor, trendDownColor, trendMax,
      showVol, volVisible]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const active = alarmsRef.current.filter((a) => a.is_active && !a.triggered);
      if (!active.length) return;
      const symbols = [...new Set(active.map((a) => a.symbol.toUpperCase()))];
      try {
        const res = await fetch(`/api/ticker?symbols=${encodeURIComponent(symbols.join(","))}`);
        const json = await res.json();
        if (!json?.ok || !json.data || cancelled) return;
        for (const a of active) {
          const row = json.data[a.symbol.toUpperCase()];
          const price = row?.lastPrice;
          if (price == null) continue;
          const prev = prevPricesRef.current[a.symbol.toUpperCase()];
          prevPricesRef.current[a.symbol.toUpperCase()] = price;
          if (!didCross(a.condition, a.price, prev, price)) continue;
          if (notifiedAlarmsRef.current.has(a.id)) continue;
          notifiedAlarmsRef.current.add(a.id);
          showLocalNotification(
            `${a.symbol} ${formatPrice(price)}`,
            `Alarm ${getConditionLabel(a.condition)} ${formatPrice(a.price)}`
          );
          await supabase
            .from("alarms")
            .update({ triggered: true, is_active: false, last_price: price })
            .eq("id", a.id);
        }
        if (!cancelled) loadAllAlarms();
      } catch {}
    };
    tick();
    const id = setInterval(tick, 12000);
    return () => { cancelled = true; clearInterval(id); };
  }, [loadAllAlarms]);

  // --- ذخیره خط: اول با فیلدهای اصلی، اگر dash خطا داد بدون dash ---
  const saveLine = async (price: number, style: string, startTime?: number) => {
    setSaving(true);
    setStatusMsg("Saving line…");
    try {
      const base: any = {
        symbol: symbolUpper,
        price,
        color: drawColor,
        style,
        note: null,
      };
      if (style === "ray" && startTime) base.start_time = startTime;

      // اول با width + dash
      let payload = { ...base, width: drawWidth, dash: drawDash };
      let { data, error } = await supabase.from("chart_lines").insert([payload]).select().single();

      if (error) {
        // بدون dash
        payload = { ...base, width: drawWidth };
        ({ data, error } = await supabase.from("chart_lines").insert([payload]).select().single());
      }
      if (error) {
        // فقط فیلدهای پایه
        payload = { ...base };
        ({ data, error } = await supabase.from("chart_lines").insert([payload]).select().single());
      }
      if (error) {
        setStatusMsg("Save failed: " + error.message);
        console.error(error);
        return;
      }
      if (data) {
        setLines((prev) => [data as ChartLine, ...prev]);
        setStatusMsg("Line saved");
      } else {
        await loadAllLines();
      }
    } finally {
      setSaving(false);
      setTimeout(() => setStatusMsg(""), 2000);
    }
  };

  const saveAlarm = async (price: number) => {
    setSaving(true);
    setStatusMsg("Saving alarm…");
    try {
      const base: any = {
        symbol: symbolUpper,
        price,
        condition,
        is_active: true,
        triggered: false,
        color: DEFAULT_ALARM_COLOR,
      };
      let payload = { ...base, width: drawWidth, dash: drawDash };
      let { data, error } = await supabase.from("alarms").insert([payload]).select().single();
      if (error) {
        payload = { ...base };
        ({ data, error } = await supabase.from("alarms").insert([payload]).select().single());
      }
      if (error) {
        setStatusMsg("Alarm save failed: " + error.message);
        return;
      }
      if (data) setAlarms((prev) => [data as Alarm, ...prev]);
      else await loadAllAlarms();
      setStatusMsg("Alarm saved");
    } finally {
      setSaving(false);
      setTimeout(() => setStatusMsg(""), 2000);
    }
  };

  const updateMoved = async (id: string, type: "line" | "alarm", price: number) => {
    if (type === "line") {
      await supabase.from("chart_lines").update({ price }).eq("id", id);
      await loadAllLines();
    } else {
      await supabase.from("alarms").update({ price }).eq("id", id);
      await loadAllAlarms();
    }
  };

  const deleteLine = async (id: string) => {
    await supabase.from("chart_lines").delete().eq("id", id);
    setLines((prev) => prev.filter((l) => l.id !== id));
  };
  const deleteAlarm = async (id: string) => {
    await supabase.from("alarms").delete().eq("id", id);
    setAlarms((prev) => prev.filter((a) => a.id !== id));
  };

  const convertLineToAlarm = async (line: ChartLine) => {
    setSaving(true);
    try {
      await supabase.from("alarms").insert([{
        symbol: line.symbol,
        price: line.price,
        condition: "cross",
        is_active: true,
        triggered: false,
        color: line.color || DEFAULT_ALARM_COLOR,
        note: line.note,
      }]);
      await supabase.from("chart_lines").delete().eq("id", line.id);
      await loadAllLines();
      await loadAllAlarms();
    } finally {
      setSaving(false);
    }
  };

  const updateAlarmCondition = async (id: string, c: "above" | "below" | "cross") => {
    await supabase.from("alarms").update({ condition: c }).eq("id", id);
    setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, condition: c } : a)));
  };

  const updateLineMeta = async (id: string, patch: Partial<ChartLine>) => {
    const { error } = await supabase.from("chart_lines").update(patch).eq("id", id);
    if (!error) setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
    else {
      // اگر dash ستون ندارد، فقط state محلی
      setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
    }
  };

  const updateAlarmMeta = async (id: string, patch: Partial<Alarm>) => {
    const { error } = await supabase.from("alarms").update(patch).eq("id", id);
    if (!error) setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    else setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  };

  const saveNote = async () => {
    if (!editingNoteId || !editingNoteType) return;
    if (editingNoteType === "line") await updateLineMeta(editingNoteId, { note: noteDraft });
    else await updateAlarmMeta(editingNoteId, { note: noteDraft });
    setEditingNoteId(null);
    setEditingNoteType(null);
    setNoteDraft("");
  };

  const goToSymbol = (sym: string) => {
    setSymbol(sym.toUpperCase().trim());
  };

  const startMove = (id: string, type: "line" | "alarm") => {
    setMovingId(id);
    setMovingType(type);
    setMode("move");
  };

  const commitSymbol = () => {
    const s = symbol.trim().toUpperCase();
    if (s) setSymbol(s);
  };

  // ---------------- JSX ----------------
  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white">
      <div className="max-w-[1600px] mx-auto px-3 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <h1 className="text-2xl font-bold">Live Chart</h1>
          <div className="flex items-center gap-2">
            <select
              value={timeZone}
              onChange={(e) => setTimeZone(e.target.value)}
              className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm"
            >
              {TIMEZONES.map((tz) => (
                <option key={tz.value} value={tz.value}>{tz.label}</option>
              ))}
            </select>
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              onBlur={commitSymbol}
              onKeyDown={(e) => { if (e.key === "Enter") commitSymbol(); }}
              className="bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm w-36"
            />
            {/* دکمه لیست همیشه در نوار ابزار */}
            <button
              type="button"
              onClick={() => setShowSideWl((v) => !v)}
              className="px-3 py-1.5 rounded-lg text-sm bg-gray-800 border border-gray-600"
            >
              {showSideWl ? "Hide List" : "Show List"}
            </button>
          </div>
        </div>

        {/* TF سمت راست */}
        <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
          {favTfButtons.map((tf) => (
            <button
              key={tf.value}
              type="button"
              onClick={() => setIntervalTf(tf.value)}
              className={`px-3 py-1.5 rounded text-sm ${
                interval === tf.value ? "bg-orange-500 text-white" : "bg-gray-800 text-gray-300"
              }`}
            >
              {tf.label}
            </button>
          ))}
          <div className="relative">
            <button
              type="button"
              onClick={() => setTfMenuOpen(!tfMenuOpen)}
              className="px-3 py-1.5 rounded text-sm bg-gray-800 border border-gray-600"
            >
              ⏱ TF ▾
            </button>
            {tfMenuOpen && (
              <div className="absolute top-full right-0 mt-2 bg-gray-900 border border-gray-700 rounded-xl z-50 min-w-[220px] p-3 shadow-xl">
                <p className="text-xs text-gray-400 mb-2">Star = quick button</p>
                <div className="grid grid-cols-3 gap-2">
                  {ALL_TIMEFRAMES.map((tf) => (
                    <div key={tf.value} className="flex items-center gap-1">
                      <button type="button" onClick={() => toggleFavTf(tf.value)} className="text-yellow-400 text-sm">
                        {favTfs.includes(tf.value) ? "★" : "☆"}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setIntervalTf(tf.value); setTfMenuOpen(false); }}
                        className={`flex-1 px-2 py-1 rounded text-sm ${
                          interval === tf.value ? "bg-orange-500" : "bg-gray-800"
                        }`}
                      >
                        {tf.label}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Tools */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => { setMode(mode === "draw" ? "none" : "draw"); clearPreview(); }}
            className={`px-3 py-1.5 rounded-lg text-sm ${mode === "draw" ? "bg-orange-500 text-white" : "bg-gray-800"}`}>
            ✏ Line
          </button>
          <button type="button" onClick={() => { setMode(mode === "ray" ? "none" : "ray"); clearPreview(); }}
            className={`px-3 py-1.5 rounded-lg text-sm ${mode === "ray" ? "bg-orange-500 text-white" : "bg-gray-800"}`}>
            → Ray
          </button>
          <button type="button" onClick={() => { setMode(mode === "alarm" ? "none" : "alarm"); clearPreview(); }}
            className={`px-3 py-1.5 rounded-lg text-sm ${mode === "alarm" ? "bg-orange-500 text-white" : "bg-gray-800"}`}>
            🔔 Alarm
          </button>
          <button type="button" onClick={() => setShowIndicatorMenu(!showIndicatorMenu)}
            className="px-3 py-1.5 rounded-lg text-sm bg-gray-800">
            ▦ Indicators
          </button>

          {(mode === "draw" || mode === "ray" || mode === "alarm") && (
            <>
              <input type="color" value={drawColor} onChange={(e) => setDrawColor(e.target.value)}
                className="w-8 h-8 rounded cursor-pointer bg-transparent" />
              {LINE_WIDTHS.map((w) => (
                <button key={w} type="button" onClick={() => setDrawWidth(w)}
                  className={`px-2 py-1 rounded text-xs ${drawWidth === w ? "bg-orange-500" : "bg-gray-700"}`}>
                  {w}px
                </button>
              ))}
              <button type="button" onClick={() => setDrawDash("solid")}
                className={`px-2 py-1 rounded text-xs ${drawDash === "solid" ? "bg-orange-500" : "bg-gray-700"}`}>
                ——
              </button>
              <button type="button" onClick={() => setDrawDash("dashed")}
                className={`px-2 py-1 rounded text-xs ${drawDash === "dashed" ? "bg-orange-500" : "bg-gray-700"}`}>
                - - -
              </button>
              {mode === "alarm" && (
                <select value={condition} onChange={(e) => setCondition(e.target.value as any)}
                  className="bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm">
                  <option value="above">Above</option>
                  <option value="below">Below</option>
                  <option value="cross">Cross</option>
                </select>
              )}
            </>
          )}
          {mode === "move" && <span className="text-sm text-yellow-400">Click chart to set new price…</span>}
          {(saving || statusMsg) && <span className="text-xs text-gray-400">{statusMsg || "Saving…"}</span>}
        </div>

        {showIndicatorMenu && (
          <div className="mb-3 flex flex-wrap gap-2 p-3 bg-gray-900 border border-gray-800 rounded-xl">
            {[
              { label: "3SMA", on: showSMA, set: setShowSMA },
              { label: "Pivot", on: showPivot, set: setShowPivot },
              { label: "Trend", on: showTrend, set: setShowTrend },
              { label: "RSI", on: showRSI, set: setShowRSI },
              { label: "DMI", on: showDMI, set: setShowDMI },
              { label: "Vol", on: showVol, set: setShowVol },
            ].map((x) => (
              <button key={x.label} type="button" onClick={() => x.set(!x.on)}
                className={`px-3 py-1.5 rounded text-sm ${x.on ? "bg-orange-500 text-white" : "bg-gray-800"}`}>
                {x.label}
              </button>
            ))}
          </div>
        )}

        {/* Chart + side */}
        <div className="relative flex gap-0">
          <div className={`transition-all duration-300 ${showSideWl ? "flex-1" : "w-full"}`}>
            <div className="relative bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden">
              <div ref={chartContainerRef} className="w-full" style={{ height: 700 }} />

              <div className="absolute top-3 left-3 z-30 flex flex-col gap-1 pointer-events-auto">
                {showSMA && (
                  <IndChip label="3SMA" visible={smaVisible}
                    onToggleVisible={() => setSmaVisible(!smaVisible)}
                    onSettings={() => setSmaSettings(true)}
                    onRemove={() => { setShowSMA(false); removeSMA(); }} />
                )}
                {showPivot && (
                  <IndChip label="Pivot" visible={pivotVisible}
                    onToggleVisible={() => setPivotVisible(!pivotVisible)}
                    onSettings={() => setPivotSettings(true)}
                    onRemove={() => { setShowPivot(false); removePivot(); }} />
                )}
                {showTrend && (
                  <IndChip label="Trend" visible={trendVisible}
                    onToggleVisible={() => setTrendVisible(!trendVisible)}
                    onSettings={() => setTrendSettings(true)}
                    onRemove={() => { setShowTrend(false); removeTrend(); }} />
                )}
                {showRSI && (
                  <IndChip label="RSI" visible={rsiVisible}
                    onToggleVisible={() => setRsiVisible(!rsiVisible)}
                    onSettings={() => setRsiSettings(true)}
                    onRemove={() => { setShowRSI(false); removeRSI(); }} />
                )}
                {showDMI && (
                  <IndChip label="DMI" visible={dmiVisible}
                    onToggleVisible={() => setDmiVisible(!dmiVisible)}
                    onSettings={() => setDmiSettings(true)}
                    onRemove={() => { setShowDMI(false); removeDMI(); }} />
                )}
                {showVol && (
                  <IndChip label="Vol" visible={volVisible}
                    onToggleVisible={() => {
                      const n = !volVisible;
                      setVolVisible(n);
                      volumeSeriesRef.current?.applyOptions({ visible: n });
                    }}
                    onRemove={() => {
                      setShowVol(false);
                      volumeSeriesRef.current?.applyOptions({ visible: false });
                    }} />
                )}
              </div>

              {!showSideWl && (
                <button type="button" onClick={() => setShowSideWl(true)}
                  className="absolute top-3 right-3 z-40 bg-gray-900 border border-orange-500 px-3 py-1.5 rounded-lg text-xs hover:bg-gray-800 shadow-lg">
                  » Show List
                </button>
              )}
            </div>
          </div>

          <div className={`overflow-hidden transition-all duration-300 ease-in-out ${
            showSideWl ? "w-44 ml-3 opacity-100" : "w-0 ml-0 opacity-0"
          }`}>
            <div className="w-44 h-[700px] bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden flex flex-col">
              <div className="px-3 py-2 border-b border-gray-800 text-xs text-gray-400 flex justify-between items-center">
                <span>With alarms</span>
                <button type="button" onClick={() => setShowSideWl(false)} className="text-red-400 hover:text-red-300">
                  « Hide
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {alarmSymbols.length === 0 ? (
                  <div className="text-center text-gray-600 py-8 text-xs">No active alarms</div>
                ) : (
                  alarmSymbols.map((sym) => {
                    const aCnt = alarmCountBySym[sym] || 0;
                    const lCnt = lineCountBySym[sym] || 0;
                    return (
                      <button key={sym} type="button" onClick={() => goToSymbol(sym)}
                        className={`w-full flex items-center gap-2 px-2 py-2 rounded-xl text-left transition-all ${
                          symbolUpper === sym
                            ? "bg-orange-500/20 border border-orange-400"
                            : "hover:bg-gray-800 border border-transparent"
                        }`}>
                        <CoinIcon symbol={sym} />
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-xs truncate">{sym}</div>
                          <div className="text-[10px] text-gray-500 flex gap-1 flex-wrap">
                            {aCnt > 0 && <span className="text-blue-400">{aCnt} alarm</span>}
                            {lCnt > 0 && <span className="text-orange-400">{lCnt} line</span>}
                          </div>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Bottom lists */}
        <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <h3 className="text-sm text-green-400 mb-2">Alarms — {symbolUpper} ({currentAlarms.length})</h3>
            <div className="space-y-2">
              {currentAlarms.map((a) => (
                <div key={a.id} className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{getConditionSymbol(a.condition)} {formatPrice(a.price)}</span>
                    {a.note && <span className="text-gray-500 text-xs">{a.note}</span>}
                    <div className="flex-1" />
                    <input type="color" value={a.color || DEFAULT_ALARM_COLOR}
                      onChange={(e) => updateAlarmMeta(a.id, { color: e.target.value })}
                      className="w-6 h-6 rounded cursor-pointer bg-transparent" />
                    <select value={a.condition} onChange={(e) => updateAlarmCondition(a.id, e.target.value as any)}
                      className="bg-gray-800 rounded px-1 py-0.5 text-xs">
                      <option value="above">Above</option>
                      <option value="below">Below</option>
                      <option value="cross">Cross</option>
                    </select>
                    <button type="button" onClick={() => updateAlarmMeta(a.id, { dash: a.dash === "dashed" ? "solid" : "dashed" })}
                      className="text-xs px-1.5 py-0.5 bg-gray-800 rounded">
                      {a.dash === "dashed" ? "- - -" : "——"}
                    </button>
                    <button type="button" onClick={() => { setEditingNoteId(a.id); setEditingNoteType("alarm"); setNoteDraft(a.note || ""); }}
                      className="text-xs text-gray-400">Note</button>
                    <button type="button" onClick={() => startMove(a.id, "alarm")} className="text-xs text-blue-400">Move</button>
                    <button type="button" onClick={() => deleteAlarm(a.id)} className="text-xs text-red-400">Delete</button>
                  </div>
                  {editingNoteId === a.id && editingNoteType === "alarm" && (
                    <div className="mt-2 flex gap-2">
                      <input value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)}
                        className="flex-1 bg-gray-800 rounded px-2 py-1 text-sm" placeholder="Note..." />
                      <button type="button" onClick={saveNote} className="text-green-400 text-sm">Save</button>
                      <button type="button" onClick={() => { setEditingNoteId(null); setEditingNoteType(null); }}
                        className="text-gray-500 text-sm">Cancel</button>
                    </div>
                  )}
                </div>
              ))}
              {!currentAlarms.length && <p className="text-gray-500 text-sm">No alarms for this symbol</p>}
            </div>
          </div>

          <div>
            <h3 className="text-sm text-orange-400 mb-2">Lines — {symbolUpper} ({currentLines.length})</h3>
            <div className="space-y-2">
              {currentLines.map((l) => (
                <div key={l.id} className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{formatPrice(l.price)}</span>
                    {l.note && <span className="text-gray-500 text-xs">{l.note}</span>}
                    <div className="flex-1" />
                    <input type="color" value={l.color || DEFAULT_LINE_COLOR}
                      onChange={(e) => updateLineMeta(l.id, { color: e.target.value })}
                      className="w-6 h-6 rounded cursor-pointer bg-transparent" />
                    <select value={String(l.width || 2)}
                      onChange={(e) => updateLineMeta(l.id, { width: parseInt(e.target.value, 10) })}
                      className="bg-gray-800 rounded px-1 py-0.5 text-xs">
                      <option value="1">W1</option>
                      <option value="2">W2</option>
                      <option value="3">W3</option>
                    </select>
                    <button type="button" onClick={() => updateLineMeta(l.id, { dash: l.dash === "dashed" ? "solid" : "dashed" })}
                      className="text-xs px-1.5 py-0.5 bg-gray-800 rounded">
                      {l.dash === "dashed" ? "- - -" : "——"}
                    </button>
                    <button type="button" onClick={() => convertLineToAlarm(l)} className="text-xs text-blue-400">Alarm</button>
                    <button type="button" onClick={() => { setEditingNoteId(l.id); setEditingNoteType("line"); setNoteDraft(l.note || ""); }}
                      className="text-xs text-gray-400">Note</button>
                    <button type="button" onClick={() => startMove(l.id, "line")} className="text-xs text-blue-400">Move</button>
                    <button type="button" onClick={() => deleteLine(l.id)} className="text-xs text-red-400">Delete</button>
                  </div>
                  {editingNoteId === l.id && editingNoteType === "line" && (
                    <div className="mt-2 flex gap-2">
                      <input value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)}
                        className="flex-1 bg-gray-800 rounded px-2 py-1 text-sm" placeholder="Note..." />
                      <button type="button" onClick={saveNote} className="text-green-400 text-sm">Save</button>
                      <button type="button" onClick={() => { setEditingNoteId(null); setEditingNoteType(null); }}
                        className="text-gray-500 text-sm">Cancel</button>
                    </div>
                  )}
                </div>
              ))}
              {!currentLines.length && <p className="text-gray-500 text-sm">No lines for this symbol</p>}
            </div>
          </div>
        </div>

        {/* Settings modals */}
        {smaSettings && (
          <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 w-full max-w-sm space-y-3">
              <h4 className="font-bold">3SMA Settings</h4>
              {([[sma1Str, setSma1Str, setSma1, smaColor1, setSmaColor1],
                 [sma2Str, setSma2Str, setSma2, smaColor2, setSmaColor2],
                 [sma3Str, setSma3Str, setSma3, smaColor3, setSmaColor3]] as const).map((row, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <span className="text-xs w-8">#{i + 1}</span>
                  <input value={row[0]} onChange={(e) => row[1](e.target.value)}
                    onBlur={() => { const n = parseInt(row[0], 10); if (!Number.isNaN(n) && n > 0) row[2](n); }}
                    className="flex-1 bg-gray-800 rounded px-2 py-1 text-sm" />
                  <input type="color" value={row[3]} onChange={(e) => row[4](e.target.value)} className="w-8 h-8" />
                </div>
              ))}
              <button type="button" onClick={() => setSmaSettings(false)} className="w-full bg-orange-500 rounded py-2 text-sm">Done</button>
            </div>
          </div>
        )}
        {rsiSettings && (
          <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 w-full max-w-sm space-y-3">
              <h4 className="font-bold">RSI Settings</h4>
              <input value={rsiPeriodStr} onChange={(e) => setRsiPeriodStr(e.target.value)}
                onBlur={() => { const n = parseInt(rsiPeriodStr, 10); if (!Number.isNaN(n) && n > 1) setRsiPeriod(n); }}
                className="w-full bg-gray-800 rounded px-2 py-1 text-sm" placeholder="Period" />
              <input type="color" value={rsiColor} onChange={(e) => setRsiColor(e.target.value)} className="w-10 h-10" />
              <button type="button" onClick={() => setRsiSettings(false)} className="w-full bg-orange-500 rounded py-2 text-sm">Done</button>
            </div>
          </div>
        )}
        {dmiSettings && (
          <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 w-full max-w-sm space-y-3">
              <h4 className="font-bold">DMI Settings</h4>
              <input value={dmiPeriodStr} onChange={(e) => setDmiPeriodStr(e.target.value)}
                onBlur={() => { const n = parseInt(dmiPeriodStr, 10); if (!Number.isNaN(n) && n > 1) setDmiPeriod(n); }}
                className="w-full bg-gray-800 rounded px-2 py-1 text-sm" placeholder="Period" />
              <div className="flex gap-2">
                <input type="color" value={dmiPlusColor} onChange={(e) => setDmiPlusColor(e.target.value)} className="w-10 h-10" />
                <input type="color" value={dmiMinusColor} onChange={(e) => setDmiMinusColor(e.target.value)} className="w-10 h-10" />
                <input type="color" value={dmiAdxColor} onChange={(e) => setDmiAdxColor(e.target.value)} className="w-10 h-10" />
              </div>
              <button type="button" onClick={() => setDmiSettings(false)} className="w-full bg-orange-500 rounded py-2 text-sm">Done</button>
            </div>
          </div>
        )}
        {pivotSettings && (
          <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 w-full max-w-sm space-y-3">
              <h4 className="font-bold">Pivot Settings</h4>
              <select value={pivotTf} onChange={(e) => setPivotTf(e.target.value)}
                className="w-full bg-gray-800 rounded px-2 py-1 text-sm">
                {PIVOT_TFS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={pivotFib} onChange={(e) => setPivotFib(e.target.checked)} />
                Fib R3/S3
              </label>
              <button type="button" onClick={() => setPivotSettings(false)} className="w-full bg-orange-500 rounded py-2 text-sm">Done</button>
            </div>
          </div>
        )}
        {trendSettings && (
          <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
            <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 w-full max-w-sm space-y-3">
              <h4 className="font-bold">Trend Settings</h4>
              <p className="text-xs text-gray-400">Pivot strength (2–12)</p>
              <input value={trendPeriodStr} onChange={(e) => setTrendPeriodStr(e.target.value)}
                onBlur={() => { const n = parseInt(trendPeriodStr, 10); if (!Number.isNaN(n) && n > 1) setTrendPeriod(n); }}
                className="w-full bg-gray-800 rounded px-2 py-1 text-sm" />
              <div className="flex gap-2">
                <input type="color" value={trendUpColor} onChange={(e) => setTrendUpColor(e.target.value)} className="w-10 h-10" />
                <input type="color" value={trendDownColor} onChange={(e) => setTrendDownColor(e.target.value)} className="w-10 h-10" />
              </div>
              <button type="button" onClick={() => setTrendSettings(false)} className="w-full bg-orange-500 rounded py-2 text-sm">Done</button>
            </div>
          </div>
        )}

        <p className="text-center text-xs text-gray-600 mt-8">© 2026 Alarm Chert</p>
      </div>
    </div>
  );
}

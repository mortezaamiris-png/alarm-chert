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

function buildValidTrends(candles: any[], period: number, maxLines: number) {
  const { highs, lows } = findPivots(candles, period);
  const upLines: { t1: number; p1: number; t2: number; p2: number }[] = [];
  const dnLines: { t1: number; p1: number; t2: number; p2: number }[] = [];

  for (let i = 0; i < lows.length - 1 && upLines.length < maxLines; i++) {
    for (let j = i + 1; j < lows.length && upLines.length < maxLines; j++) {
      const a = lows[i], b = lows[j];
      if (a.price <= b.price) continue;
      const diff = (a.price - b.price) / (a.index - b.index);
      let valid = true;
      let endIdx = a.index;
      for (let x = b.index + 1; x <= a.index; x++) {
        const lineY = b.price + diff * (x - b.index);
        if (candles[x].close < lineY) { valid = false; break; }
        endIdx = x;
      }
      if (valid) {
        upLines.push({
          t1: b.time, p1: b.price,
          t2: candles[endIdx].time,
          p2: b.price + diff * (endIdx - b.index),
        });
      }
    }
  }

  for (let i = 0; i < highs.length - 1 && dnLines.length < maxLines; i++) {
    for (let j = i + 1; j < highs.length && dnLines.length < maxLines; j++) {
      const a = highs[i], b = highs[j];
      if (a.price >= b.price) continue;
      const diff = (b.price - a.price) / (a.index - b.index);
      let valid = true;
      let endIdx = a.index;
      for (let x = b.index + 1; x <= a.index; x++) {
        const lineY = b.price - diff * (x - b.index);
        if (candles[x].close > lineY) { valid = false; break; }
        endIdx = x;
      }
      if (valid) {
        dnLines.push({
          t1: b.time, p1: b.price,
          t2: candles[endIdx].time,
          p2: b.price - diff * (endIdx - b.index),
        });
      }
    }
  }
  return { upLines, dnLines };
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
    <div className="inline-flex items-center gap-0.5 bg-black/40 backdrop-blur-[2px] rounded px-1 py-0.5 text-[11px] text-gray-100">
      <span className="px-0.5 font-medium whitespace-nowrap opacity-90">{label}</span>
      <button type="button" onClick={onToggleVisible} className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 text-xs">
        {visible ? "👁" : "⊘"}
      </button>
      {onSettings && (
        <button type="button" onClick={onSettings} className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 text-xs">
          ⚙
        </button>
      )}
      <button type="button" onClick={onRemove} className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 text-red-400 text-xs">
        ×
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
  const [trendPeriod, setTrendPeriod] = useState(() => loadLS("trend_p", 12));
  const [trendPeriodStr, setTrendPeriodStr] = useState(() => String(loadLS("trend_p", 12)));
  const [trendUpColor, setTrendUpColor] = useState(() => loadLS("trend_up", "#84cc16"));
  const [trendDownColor, setTrendDownColor] = useState(() => loadLS("trend_dn", "#ef4444"));
  const [trendMax, setTrendMax] = useState(() => loadLS("trend_max", 3));

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
    try {
      alarmLinesRef.current.forEach((pl) => {
        try { seriesRef.current?.removePriceLine(pl); } catch {}
      });
      alarmLinesRef.current.clear();
      chartLinesRef.current.forEach((s) => {
        try { chartRef.current?.removeSeries(s); } catch {}
      });
      chartLinesRef.current.clear();
      if (smaSeriesRef.current) {
        try {
          chartRef.current?.removeSeries(smaSeriesRef.current.s1);
          chartRef.current?.removeSeries(smaSeriesRef.current.s2);
          chartRef.current?.removeSeries(smaSeriesRef.current.s3);
        } catch {}
        smaSeriesRef.current = null;
      }
      if (rsiSeriesRef.current) {
        try { chartRef.current?.removeSeries(rsiSeriesRef.current); } catch {}
        rsiSeriesRef.current = null;
      }
      if (dmiSeriesRef.current) {
        try {
          chartRef.current?.removeSeries(dmiSeriesRef.current.plus);
          chartRef.current?.removeSeries(dmiSeriesRef.current.minus);
          chartRef.current?.removeSeries(dmiSeriesRef.current.adx);
        } catch {}
        dmiSeriesRef.current = null;
      }
      pivotSeriesRef.current.forEach((s) => {
        try { chartRef.current?.removeSeries(s); } catch {}
      });
      pivotSeriesRef.current = [];
      trendSeriesRef.current.forEach((s) => {
        try { chartRef.current?.removeSeries(s); } catch {}
      });
      trendSeriesRef.current = [];
      if (volumeSeriesRef.current) {
        try { chartRef.current?.removeSeries(volumeSeriesRef.current); } catch {}
        volumeSeriesRef.current = null;
      }
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
      seriesRef.current = null;
      if (chartContainerRef.current) chartContainerRef.current.innerHTML = "";
    } catch {}
  }, []);

  const renderAllLinesAndAlarms = useCallback(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;

    alarmLinesRef.current.forEach((pl) => {
      try { series.removePriceLine(pl); } catch {}
    });
    alarmLinesRef.current.clear();
    chartLinesRef.current.forEach((s) => {
      try { chart.removeSeries(s); } catch {}
    });
    chartLinesRef.current.clear();

    const candles = candlesRef.current;
    if (!candles.length) return;
    const firstTime = candles[0].time;
    const lastTime = candles[candles.length - 1].time;
    const extend = Math.max(1, Math.floor((lastTime - firstTime) * 0.15));

    currentLines.forEach((l) => {
      try {
        const color = l.color || DEFAULT_LINE_COLOR;
        const width = (l.width as 1 | 2 | 3) || 2;
        const style = toLineStyle(l.dash || l.style);
        if (l.start_time != null) {
          const ls: any = chart.addLineSeries({
            color, lineWidth: width, lineStyle: style,
            priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
          });
          ls.setData([
            { time: l.start_time as any, value: l.price },
            { time: (lastTime + extend) as any, value: l.price },
          ]);
          chartLinesRef.current.set(l.id, ls);
        } else {
          const pl = series.createPriceLine({
            price: l.price, color, lineWidth: width, lineStyle: style,
            axisLabelVisible: true,
            title: l.note ? `L ${l.note}` : `Line ${formatPrice(l.price)}`,
          });
          alarmLinesRef.current.set(`line-${l.id}`, pl);
        }
      } catch {}
    });

    currentAlarms.forEach((a) => {
      try {
        const color = a.color || DEFAULT_ALARM_COLOR;
        const width = (a.width as 1 | 2 | 3) || 2;
        const style = toLineStyle(a.dash);
        const pl = series.createPriceLine({
          price: a.price, color, lineWidth: width, lineStyle: style,
          axisLabelVisible: true,
          title: `Alarm ${getConditionSymbol(a.condition)} ${formatPrice(a.price)}`,
        });
        alarmLinesRef.current.set(`alarm-${a.id}`, pl);
      } catch {}
    });
  }, [currentLines, currentAlarms]);

  const removeSMA = useCallback(() => {
    if (smaSeriesRef.current && chartRef.current) {
      try {
        chartRef.current.removeSeries(smaSeriesRef.current.s1);
        chartRef.current.removeSeries(smaSeriesRef.current.s2);
        chartRef.current.removeSeries(smaSeriesRef.current.s3);
      } catch {}
      smaSeriesRef.current = null;
    }
  }, []);
  const applySMA = useCallback(() => {
    removeSMA();
    if (!showSMA || !smaVisible || !chartRef.current || !candlesRef.current.length) return;
    const c = candlesRef.current;
    const s1 = chartRef.current.addLineSeries({ color: smaColor1, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const s2 = chartRef.current.addLineSeries({ color: smaColor2, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const s3 = chartRef.current.addLineSeries({ color: smaColor3, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    s1.setData(calcSMA(c, sma1) as any);
    s2.setData(calcSMA(c, sma2) as any);
    s3.setData(calcSMA(c, sma3) as any);
    smaSeriesRef.current = { s1, s2, s3 };
  }, [showSMA, smaVisible, sma1, sma2, sma3, smaColor1, smaColor2, smaColor3, removeSMA]);

  const removeRSI = useCallback(() => {
    if (rsiSeriesRef.current && chartRef.current) {
      try { chartRef.current.removeSeries(rsiSeriesRef.current); } catch {}
      rsiSeriesRef.current = null;
    }
  }, []);
  const applyRSI = useCallback(() => {
    removeRSI();
    if (!showRSI || !rsiVisible || !chartRef.current || !candlesRef.current.length) return;
    const data = calcRSI(candlesRef.current, rsiPeriod);
    const s = chartRef.current.addLineSeries({
      color: rsiColor, lineWidth: 1, priceScaleId: "rsi",
      priceLineVisible: false, lastValueVisible: true,
    });
    s.setData(data as any);
    rsiSeriesRef.current = s;
    try {
      chartRef.current.priceScale("rsi").applyOptions({ scaleMargins: { top: 0.75, bottom: 0.05 }, borderVisible: false });
    } catch {}
    updateMargins();
  }, [showRSI, rsiVisible, rsiPeriod, rsiColor, removeRSI, updateMargins]);

  const removeDMI = useCallback(() => {
    if (dmiSeriesRef.current && chartRef.current) {
      try {
        chartRef.current.removeSeries(dmiSeriesRef.current.plus);
        chartRef.current.removeSeries(dmiSeriesRef.current.minus);
        chartRef.current.removeSeries(dmiSeriesRef.current.adx);
      } catch {}
      dmiSeriesRef.current = null;
    }
  }, []);
  const applyDMI = useCallback(() => {
    removeDMI();
    if (!showDMI || !dmiVisible || !chartRef.current || !candlesRef.current.length) return;
    const { plusDI, minusDI, adx } = calcDMI(candlesRef.current, dmiPeriod);
    const plus = chartRef.current.addLineSeries({ color: dmiPlusColor, lineWidth: 1, priceScaleId: "dmi", priceLineVisible: false, lastValueVisible: false });
    const minus = chartRef.current.addLineSeries({ color: dmiMinusColor, lineWidth: 1, priceScaleId: "dmi", priceLineVisible: false, lastValueVisible: false });
    const adxS = chartRef.current.addLineSeries({ color: dmiAdxColor, lineWidth: 1, priceScaleId: "dmi", priceLineVisible: false, lastValueVisible: true });
    plus.setData(plusDI as any);
    minus.setData(minusDI as any);
    adxS.setData(adx as any);
    dmiSeriesRef.current = { plus, minus, adx: adxS };
    try {
      chartRef.current.priceScale("dmi").applyOptions({ scaleMargins: { top: 0.78, bottom: 0.05 }, borderVisible: false });
    } catch {}
    updateMargins();
  }, [showDMI, dmiVisible, dmiPeriod, dmiPlusColor, dmiMinusColor, dmiAdxColor, removeDMI, updateMargins]);

  const removePivot = useCallback(() => {
    pivotSeriesRef.current.forEach((s) => { try { chartRef.current?.removeSeries(s); } catch {} });
    pivotSeriesRef.current = [];
  }, []);
  const applyPivot = useCallback(async () => {
    removePivot();
    if (!showPivot || !pivotVisible || !chartRef.current || !candlesRef.current.length) return;
    try {
      const res = await fetch(`/api/kline?symbol=${symbolRef.current}&interval=${pivotTf}&limit=5`);
      const data = await res.json();
      const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
      if (list.length < 2) return;
      const prev = list[list.length - 2];
      const h = Number(prev.high ?? prev[2]), l = Number(prev.low ?? prev[3]), c = Number(prev.close ?? prev[4]);
      const pp = (h + l + c) / 3;
      const r1 = 2 * pp - l, s1 = 2 * pp - h;
      const r2 = pp + (h - l), s2 = pp - (h - l);
      const r3 = h + 2 * (pp - l), s3 = l - 2 * (h - pp);
      const levels: { price: number; color: string; title: string }[] = [
        { price: pp, color: "#eab308", title: "P" },
        { price: r1, color: "#22c55e", title: "R1" },
        { price: s1, color: "#ef4444", title: "S1" },
        { price: r2, color: "#16a34a", title: "R2" },
        { price: s2, color: "#dc2626", title: "S2" },
        { price: r3, color: "#15803d", title: "R3" },
        { price: s3, color: "#b91c1c", title: "S3" },
      ];
      if (pivotFib) {
        levels.push(
          { price: pp + 0.382 * (h - l), color: "#86efac", title: "R0.382" },
          { price: pp - 0.382 * (h - l), color: "#fca5a5", title: "S0.382" },
          { price: pp + 0.618 * (h - l), color: "#4ade80", title: "R0.618" },
          { price: pp - 0.618 * (h - l), color: "#f87171", title: "S0.618" }
        );
      }
      const firstTime = candlesRef.current[0].time;
      const lastTime = candlesRef.current[candlesRef.current.length - 1].time;
      levels.forEach((lv) => {
        const s: any = chartRef.current!.addLineSeries({
          color: lv.color, lineWidth: 1, lineStyle: LineStyle.Dashed,
          priceLineVisible: false, lastValueVisible: true, title: lv.title,
        });
        s.setData([{ time: firstTime, value: lv.price }, { time: lastTime, value: lv.price }]);
        pivotSeriesRef.current.push(s);
      });
    } catch {}
  }, [showPivot, pivotVisible, pivotTf, pivotFib, removePivot]);

  const removeTrend = useCallback(() => {
    trendSeriesRef.current.forEach((s) => { try { chartRef.current?.removeSeries(s); } catch {} });
    trendSeriesRef.current = [];
  }, []);
  const applyTrend = useCallback(() => {
    removeTrend();
    if (!showTrend || !trendVisible || !chartRef.current || candlesRef.current.length < 30) return;
    const { upLines, dnLines } = buildValidTrends(candlesRef.current, trendPeriod, trendMax);
    upLines.forEach((ln) => {
      try {
        const s: any = chartRef.current!.addLineSeries({
          color: trendUpColor, lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
        });
        s.setData([{ time: ln.t1 as any, value: ln.p1 }, { time: ln.t2 as any, value: ln.p2 }]);
        trendSeriesRef.current.push(s);
      } catch {}
    });
    dnLines.forEach((ln) => {
      try {
        const s: any = chartRef.current!.addLineSeries({
          color: trendDownColor, lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
        });
        s.setData([{ time: ln.t1 as any, value: ln.p1 }, { time: ln.t2 as any, value: ln.p2 }]);
        trendSeriesRef.current.push(s);
      } catch {}
    });
  }, [showTrend, trendVisible, trendPeriod, trendMax, trendUpColor, trendDownColor, removeTrend]);

  const applyVolume = useCallback(() => {
    if (!chartRef.current || !candlesRef.current.length) return;
    if (volumeSeriesRef.current) {
      try { chartRef.current.removeSeries(volumeSeriesRef.current); } catch {}
      volumeSeriesRef.current = null;
    }
    if (!showVol || !volVisible) { updateMargins(); return; }
    const volData = candlesRef.current.map((c: any) => ({
      time: c.time,
      value: c.volume || 0,
      color: c.close >= c.open ? "rgba(34,197,94,0.45)" : "rgba(239,68,68,0.45)",
    }));
    const vs: any = chartRef.current.addHistogramSeries({
      priceScaleId: "volume", priceFormat: { type: "volume" },
      lastValueVisible: false, priceLineVisible: false,
    });
    vs.setData(volData);
    volumeSeriesRef.current = vs;
    try {
      chartRef.current.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, borderVisible: false });
    } catch {}
    updateMargins();
  }, [showVol, volVisible, updateMargins]);

  const rebuildIndicators = useCallback(() => {
    applySMA(); applyRSI(); applyDMI(); applyPivot(); applyTrend(); applyVolume();
  }, [applySMA, applyRSI, applyDMI, applyPivot, applyTrend, applyVolume]);

  const loadCandles = useCallback(async () => {
    if (!chartContainerRef.current) return;
    setStatusMsg("Loading...");
    try {
      const url = `/api/kline?symbol=${encodeURIComponent(symbolRef.current)}&interval=${encodeURIComponent(intervalRef.current)}&limit=1000`;
      console.log("[kline] fetch", url);
      const res = await fetch(url, { cache: "no-store" });
      console.log("[kline] status", res.status);
      const raw = await res.json();
      console.log("[kline] sample", Array.isArray(raw) ? raw.slice(0, 2) : raw);

      let list: any[] = [];
      if (Array.isArray(raw)) list = raw;
      else if (Array.isArray(raw?.data)) list = raw.data;
      else if (Array.isArray(raw?.result?.list)) list = raw.result.list;
      else if (Array.isArray(raw?.candles)) list = raw.candles;

      if (!list.length) {
        setStatusMsg(`No data (${res.status})`);
        return;
      }

      const candles = list
        .map((c: any) => {
          if (c && (c.time != null || c.open != null)) {
            let t = Number(c.time);
            if (t > 1e12) t = Math.floor(t / 1000);
            return {
              time: t,
              open: Number(c.open),
              high: Number(c.high),
              low: Number(c.low),
              close: Number(c.close),
              volume: Number(c.volume ?? c.value ?? 0),
            };
          }
          if (Array.isArray(c)) {
            let t = Number(c[0]);
            if (t > 1e12) t = Math.floor(t / 1000);
            return {
              time: t,
              open: Number(c[1]),
              high: Number(c[2]),
              low: Number(c[3]),
              close: Number(c[4]),
              volume: Number(c[5] ?? 0),
            };
          }
          return null;
        })
        .filter(Boolean)
        .sort((a: any, b: any) => a.time - b.time) as any[];

      if (!candles.length) {
        setStatusMsg("No valid candles");
        return;
      }

      candlesRef.current = candles;
      const lastClose = candles[candles.length - 1].close;
      const prec = getPrecision(lastClose);

      destroyChart();

      const chart = createChart(chartContainerRef.current, {
        layout: { background: { color: "#0a0a0a" }, textColor: "#9ca3af", fontSize: 11 },
        grid: {
          vertLines: { color: "rgba(42,46,57,0.5)" },
          horzLines: { color: "rgba(42,46,57,0.5)" },
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          vertLine: { color: "rgba(156,163,175,0.4)", width: 1, style: LineStyle.Dashed },
          horzLine: { color: "rgba(156,163,175,0.4)", width: 1, style: LineStyle.Dashed },
        },
        rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.05, bottom: 0.1 }, autoScale: true },
        timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 8 },
        width: chartContainerRef.current.clientWidth,
        height: 640,
      });
      chartRef.current = chart;

      const series = chart.addCandlestickSeries({
        upColor: "#22c55e", downColor: "#ef4444",
        borderUpColor: "#22c55e", borderDownColor: "#ef4444",
        wickUpColor: "#22c55e", wickDownColor: "#ef4444",
        priceFormat: { type: "price", precision: prec.precision, minMove: prec.minMove },
      });
      series.setData(candles as any);
      seriesRef.current = series;
      chart.timeScale().fitContent();
      chart.priceScale("right").applyOptions({ autoScale: true });

      chart.subscribeCrosshairMove((param) => {
        if (modeRef.current === "none" || modeRef.current === "move") return;
        if (!param.point || param.point.x < 0 || param.point.y < 0) return;
        const price = series.coordinateToPrice(param.point.y);
        if (price == null || Number.isNaN(price)) return;
        setPreviewPrice(price);
        if (previewLineRef.current) {
          try { series.removePriceLine(previewLineRef.current); } catch {}
        }
        previewLineRef.current = series.createPriceLine({
          price,
          color: modeRef.current === "alarm" ? DEFAULT_ALARM_COLOR : drawColorRef.current,
          lineWidth: drawWidthRef.current,
          lineStyle: toLineStyle(drawDashRef.current),
          axisLabelVisible: true,
          title: "",
        });
      });

      chart.subscribeClick(async (param) => {
        if (clickLockRef.current) return;
        if (!param.point || param.point.x < 0 || param.point.y < 0) return;
        const price = series.coordinateToPrice(param.point.y);
        if (price == null || Number.isNaN(price)) return;
        const fp = formatPrice(price);
        const m = modeRef.current;

        if (m === "move" && movingIdRef.current) {
          clickLockRef.current = true;
          const id = movingIdRef.current;
          const typ = movingTypeRef.current;
          if (typ === "line") {
            await supabase.from("chart_lines").update({ price: fp }).eq("id", id);
            setLines((prev) => prev.map((l) => (l.id === id ? { ...l, price: fp } : l)));
          } else if (typ === "alarm") {
            await supabase.from("alarms").update({ price: fp }).eq("id", id);
            setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, price: fp } : a)));
          }
          setMovingId(null); setMovingType(null); setMode("none"); clearPreview();
          setTimeout(() => { clickLockRef.current = false; }, 300);
          return;
        }

        if (m === "draw" || m === "ray") {
          clickLockRef.current = true;
          setSaving(true);
          const base: any = {
            symbol: symbolRef.current.toUpperCase(),
            price: fp,
            color: drawColorRef.current,
            width: drawWidthRef.current,
            dash: drawDashRef.current,
          };
          if (m === "ray") {
            const t = param.time ? Number(param.time) : candlesRef.current[candlesRef.current.length - 1]?.time;
            if (t) base.start_time = t;
          }
          let payload = { ...base };
          let { data, error } = await supabase.from("chart_lines").insert([payload]).select().single();
          if (error) {
            payload = { symbol: base.symbol, price: base.price, color: base.color, width: base.width };
            ({ data, error } = await supabase.from("chart_lines").insert([payload]).select().single());
          }
          if (error) {
            payload = { symbol: base.symbol, price: base.price, color: base.color };
            ({ data, error } = await supabase.from("chart_lines").insert([payload]).select().single());
          }
          if (!error && data) {
            setLines((prev) => [...prev, data as ChartLine]);
            setStatusMsg("Line saved");
          } else {
            setStatusMsg("Save failed");
          }
          setSaving(false); clearPreview(); setMode("none");
          setTimeout(() => { clickLockRef.current = false; }, 300);
          return;
        }

        if (m === "alarm") {
          clickLockRef.current = true;
          setSaving(true);
          const payload: any = {
            symbol: symbolRef.current.toUpperCase(),
            price: fp,
            condition: conditionRef.current,
            is_active: true,
            triggered: false,
            color: DEFAULT_ALARM_COLOR,
            width: drawWidthRef.current,
            dash: drawDashRef.current,
          };
          let { data, error } = await supabase.from("alarms").insert([payload]).select().single();
          if (error) {
            const minimal = {
              symbol: payload.symbol, price: payload.price, condition: payload.condition,
              is_active: true, triggered: false,
            };
            ({ data, error } = await supabase.from("alarms").insert([minimal]).select().single());
          }
          if (!error && data) {
            setAlarms((prev) => [...prev, data as Alarm]);
            setStatusMsg("Alarm saved");
          } else {
            setStatusMsg("Alarm save failed");
          }
          setSaving(false); clearPreview(); setMode("none");
          setTimeout(() => { clickLockRef.current = false; }, 300);
        }
      });

      rebuildIndicators();
      renderAllLinesAndAlarms();
      setStatusMsg("");
    } catch (e: any) {
      console.error("[kline] error", e);
      setStatusMsg("Load error: " + (e?.message || "unknown"));
    }
  }, [destroyChart, rebuildIndicators, renderAllLinesAndAlarms, clearPreview]);

  useEffect(() => { loadCandles(); }, [symbol, interval]); // eslint-disable-line

  useEffect(() => {
    if (seriesRef.current && chartRef.current) renderAllLinesAndAlarms();
  }, [currentLines, currentAlarms, renderAllLinesAndAlarms]);

  useEffect(() => {
    rebuildIndicators();
  }, [
    showSMA, smaVisible, sma1, sma2, sma3, smaColor1, smaColor2, smaColor3,
    showRSI, rsiVisible, rsiPeriod, rsiColor,
    showDMI, dmiVisible, dmiPeriod, dmiPlusColor, dmiMinusColor, dmiAdxColor,
    showPivot, pivotVisible, pivotTf, pivotFib,
    showTrend, trendVisible, trendPeriod, trendMax, trendUpColor, trendDownColor,
    showVol, volVisible,
  ]); // eslint-disable-line

  useEffect(() => {
    const onResize = () => {
      if (chartRef.current && chartContainerRef.current) {
        chartRef.current.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (chartRef.current && chartContainerRef.current) {
      setTimeout(() => {
        chartRef.current?.applyOptions({ width: chartContainerRef.current!.clientWidth });
        chartRef.current?.timeScale().fitContent();
      }, 320);
    }
  }, [showSideWl]);

  useEffect(() => {
    const load = async () => {
      const { data: a } = await supabase
        .from("alarms").select("*")
        .eq("is_active", true).eq("triggered", false)
        .order("created_at", { ascending: false });
      if (a) setAlarms(a as Alarm[]);
      const { data: l } = await supabase
        .from("chart_lines").select("*")
        .order("created_at", { ascending: false });
      if (l) setLines(l as ChartLine[]);
    };
    load();
  }, []);

  useEffect(() => {
    const tick = async () => {
      const active = alarmsRef.current.filter((a) => a.is_active && !a.triggered);
      if (!active.length) return;
      const syms = [...new Set(active.map((a) => a.symbol.toUpperCase()))];
      try {
        const res = await fetch(`/api/ticker?symbols=${syms.join(",")}`, { cache: "no-store" });
        const data = await res.json();
        const prices: Record<string, number> = {};
        if (Array.isArray(data)) {
          data.forEach((t: any) => {
            if (t.symbol && t.lastPrice != null) prices[t.symbol.toUpperCase()] = parseFloat(t.lastPrice);
          });
        } else if (data && typeof data === "object") {
          Object.entries(data).forEach(([k, v]: any) => { prices[k.toUpperCase()] = parseFloat(v); });
        }
        for (const a of active) {
          const price = prices[a.symbol.toUpperCase()];
          if (price == null) continue;
          const prev = prevPricesRef.current[a.symbol.toUpperCase()] ?? a.last_price;
          if (didCross(a.condition, a.price, prev, price)) {
            if (!notifiedAlarmsRef.current.has(a.id)) {
              notifiedAlarmsRef.current.add(a.id);
              showLocalNotification(
                `${a.symbol} ${formatPrice(price)}`,
                `Alarm ${getConditionLabel(a.condition)} ${formatPrice(a.price)}`
              );
              await supabase.from("alarms")
                .update({ triggered: true, is_active: false, last_price: price })
                .eq("id", a.id);
              setAlarms((prev) =>
                prev.map((x) => x.id === a.id ? { ...x, triggered: true, is_active: false } : x)
              );
            }
          }
          prevPricesRef.current[a.symbol.toUpperCase()] = price;
        }
      } catch {}
    };
    const id = setInterval(tick, 8000);
    tick();
    return () => clearInterval(id);
  }, []);

  const deleteLine = async (id: string) => {
    await supabase.from("chart_lines").delete().eq("id", id);
    setLines((prev) => prev.filter((l) => l.id !== id));
  };
  const deleteAlarm = async (id: string) => {
    await supabase.from("alarms").delete().eq("id", id);
    setAlarms((prev) => prev.filter((a) => a.id !== id));
  };
  const updateAlarmCondition = async (id: string, condition: "above" | "below" | "cross") => {
    await supabase.from("alarms").update({ condition }).eq("id", id);
    setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, condition } : a)));
  };
  const updateAlarmColor = async (id: string, color: string) => {
    await supabase.from("alarms").update({ color }).eq("id", id);
    setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, color } : a)));
  };
  const updateAlarmWidth = async (id: string, width: number) => {
    await supabase.from("alarms").update({ width }).eq("id", id);
    setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, width } : a)));
  };
  const updateAlarmDash = async (id: string, dash: string) => {
    await supabase.from("alarms").update({ dash }).eq("id", id);
    setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, dash } : a)));
  };
  const updateLineColor = async (id: string, color: string) => {
    await supabase.from("chart_lines").update({ color }).eq("id", id);
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, color } : l)));
  };
  const updateLineWidth = async (id: string, width: number) => {
    await supabase.from("chart_lines").update({ width }).eq("id", id);
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, width } : l)));
  };
  const updateLineDash = async (id: string, dash: string) => {
    await supabase.from("chart_lines").update({ dash }).eq("id", id);
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, dash } : l)));
  };
  const convertLineToAlarm = async (line: ChartLine) => {
    const payload: any = {
      symbol: line.symbol, price: line.price, condition: "cross",
      is_active: true, triggered: false,
      color: line.color || DEFAULT_ALARM_COLOR,
      width: line.width || 2, dash: line.dash || "solid", note: line.note,
    };
    const { data, error } = await supabase.from("alarms").insert([payload]).select().single();
    if (!error && data) {
      setAlarms((prev) => [...prev, data as Alarm]);
      await deleteLine(line.id);
    }
  };
  const saveNote = async () => {
    if (!editingNoteId || !editingNoteType) return;
    if (editingNoteType === "line") {
      await supabase.from("chart_lines").update({ note: noteDraft }).eq("id", editingNoteId);
      setLines((prev) => prev.map((l) => (l.id === editingNoteId ? { ...l, note: noteDraft } : l)));
    } else {
      await supabase.from("alarms").update({ note: noteDraft }).eq("id", editingNoteId);
      setAlarms((prev) => prev.map((a) => (a.id === editingNoteId ? { ...a, note: noteDraft } : a)));
    }
    setEditingNoteId(null); setEditingNoteType(null);
  };
  const goToSymbol = (sym: string) => { setSymbol(sym.toUpperCase()); };

  return (
    <div className="max-w-[1600px] mx-auto px-2 sm:px-4 py-3 text-gray-100">
      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h1 className="text-xl font-bold">Live Chart</h1>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={timeZone}
            onChange={(e) => setTimeZone(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-sm"
          >
            {TIMEZONES.map((z) => (
              <option key={z.value} value={z.value}>{z.label}</option>
            ))}
          </select>
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") goToSymbol((e.target as HTMLInputElement).value);
            }}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1 text-sm w-28 font-mono"
          />
          <button
            type="button"
            onClick={() => setShowSideWl((v) => !v)}
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1 text-sm hover:bg-gray-700"
          >
            {showSideWl ? "Hide List" : "Show List"}
          </button>
        </div>
      </div>

      {/* Timeframes */}
      <div className="flex justify-end flex-wrap gap-1 mb-2">
        {favTfButtons.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setIntervalTf(t.value)}
            className={`px-2.5 py-1 rounded text-xs font-medium ${
              interval === t.value ? "bg-orange-500 text-white" : "bg-gray-800 text-gray-300 hover:bg-gray-700"
            }`}
          >
            {t.label}
          </button>
        ))}
        <div className="relative">
          <button
            type="button"
            onClick={() => setTfMenuOpen((v) => !v)}
            className="px-2.5 py-1 rounded text-xs bg-gray-800 text-gray-300 hover:bg-gray-700"
          >
            TF ▾
          </button>
          {tfMenuOpen && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-gray-900 border border-gray-700 rounded-lg p-2 shadow-xl min-w-[140px]">
              {ALL_TIMEFRAMES.map((t) => (
                <div key={t.value} className="flex items-center justify-between gap-2 py-1">
                  <button
                    type="button"
                    className={`text-sm ${interval === t.value ? "text-orange-400" : "text-gray-300"}`}
                    onClick={() => { setIntervalTf(t.value); setTfMenuOpen(false); }}
                  >
                    {t.label}
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleFavTf(t.value)}
                    className={favTfs.includes(t.value) ? "text-yellow-400" : "text-gray-600"}
                  >
                    ★
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Chart + side list */}
      <div className="flex gap-0 relative">
        {/* Vertical tools */}
        <div className="flex flex-col gap-1 mr-1.5 pt-1 shrink-0">
          {[
            { id: "draw" as ToolMode, label: "Line", icon: "✏️" },
            { id: "ray" as ToolMode, label: "Ray", icon: "→" },
            { id: "alarm" as ToolMode, label: "Alarm", icon: "🔔" },
          ].map((t) => (
            <button
              key={t.id}
              type="button"
              title={t.label}
              onClick={() => {
                setMode((m) => (m === t.id ? "none" : t.id));
                setMovingId(null);
                clearPreview();
              }}
              className={`w-9 h-9 rounded-lg flex flex-col items-center justify-center text-[10px] border ${
                mode === t.id
                  ? "bg-orange-500/20 border-orange-500 text-orange-300"
                  : "bg-gray-900 border-gray-700 text-gray-400 hover:bg-gray-800"
              }`}
            >
              <span className="text-sm leading-none">{t.icon}</span>
              <span className="leading-none mt-0.5">{t.label}</span>
            </button>
          ))}
          <button
            type="button"
            title="Indicators"
            onClick={() => setShowIndicatorMenu((v) => !v)}
            className={`w-9 h-9 rounded-lg flex flex-col items-center justify-center text-[10px] border ${
              showIndicatorMenu
                ? "bg-blue-500/20 border-blue-500 text-blue-300"
                : "bg-gray-900 border-gray-700 text-gray-400 hover:bg-gray-800"
            }`}
          >
            <span className="text-sm leading-none">📊</span>
            <span className="leading-none mt-0.5">Ind</span>
          </button>

          {(mode === "draw" || mode === "ray" || mode === "alarm") && (
            <div className="mt-1 flex flex-col gap-1 items-center">
              <div className="flex flex-col gap-0.5">
                {LINE_WIDTHS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setDrawWidth(w)}
                    className={`w-8 h-6 rounded text-[10px] ${
                      drawWidth === w ? "bg-orange-500 text-white" : "bg-gray-800 text-gray-400"
                    }`}
                  >
                    W{w}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setDrawDash((d) => (d === "solid" ? "dashed" : "solid"))}
                className="w-8 h-6 rounded text-[10px] bg-gray-800 text-gray-300"
              >
                {drawDash === "solid" ? "——" : "- -"}
              </button>
              <input
                type="color"
                value={drawColor}
                onChange={(e) => setDrawColor(e.target.value)}
                className="w-8 h-6 rounded cursor-pointer bg-transparent border-0"
              />
              {mode === "alarm" && (
                <select
                  value={condition}
                  onChange={(e) => setCondition(e.target.value as any)}
                  className="w-full text-[10px] bg-gray-800 rounded py-1"
                >
                  <option value="above">Above</option>
                  <option value="below">Below</option>
                  <option value="cross">Cross</option>
                </select>
              )}
            </div>
          )}
        </div>

        {/* Chart area */}
        <div className="flex-1 min-w-0 relative">
          <div
            ref={chartContainerRef}
            className="w-full rounded-xl border border-gray-800 bg-black overflow-hidden"
            style={{ height: 640 }}
          />
          <div className="absolute top-2 left-2 z-10 flex flex-col gap-1 pointer-events-auto">
            {showSMA && (
              <IndChip label="3SMA" visible={smaVisible} onToggleVisible={() => setSmaVisible((v) => !v)}
                onSettings={() => setSmaSettings((v) => !v)} onRemove={() => { setShowSMA(false); removeSMA(); }} />
            )}
            {showPivot && (
              <IndChip label="Pivot" visible={pivotVisible} onToggleVisible={() => setPivotVisible((v) => !v)}
                onSettings={() => setPivotSettings((v) => !v)} onRemove={() => { setShowPivot(false); removePivot(); }} />
            )}
            {showTrend && (
              <IndChip label="Trend" visible={trendVisible} onToggleVisible={() => setTrendVisible((v) => !v)}
                onSettings={() => setTrendSettings((v) => !v)} onRemove={() => { setShowTrend(false); removeTrend(); }} />
            )}
            {showRSI && (
              <IndChip label="RSI" visible={rsiVisible} onToggleVisible={() => setRsiVisible((v) => !v)}
                onSettings={() => setRsiSettings((v) => !v)} onRemove={() => { setShowRSI(false); removeRSI(); }} />
            )}
            {showDMI && (
              <IndChip label="DMI" visible={dmiVisible} onToggleVisible={() => setDmiVisible((v) => !v)}
                onSettings={() => setDmiSettings((v) => !v)} onRemove={() => { setShowDMI(false); removeDMI(); }} />
            )}
            {showVol && (
              <IndChip label="Vol" visible={volVisible} onToggleVisible={() => setVolVisible((v) => !v)}
                onRemove={() => { setShowVol(false); applyVolume(); }} />
            )}
          </div>

          {showIndicatorMenu && (
            <div className="absolute top-2 left-14 z-20 bg-gray-900/95 border border-gray-700 rounded-xl p-2 shadow-xl w-40">
              {[
                { key: "sma", label: "3SMA", on: showSMA, set: setShowSMA },
                { key: "pivot", label: "Pivot", on: showPivot, set: setShowPivot },
                { key: "trend", label: "Trend", on: showTrend, set: setShowTrend },
                { key: "rsi", label: "RSI", on: showRSI, set: setShowRSI },
                { key: "dmi", label: "DMI", on: showDMI, set: setShowDMI },
                { key: "vol", label: "Volume", on: showVol, set: setShowVol },
              ].map((it) => (
                <button
                  key={it.key}
                  type="button"
                  onClick={() => it.set((v: boolean) => !v)}
                  className={`w-full text-left px-2 py-1.5 rounded text-sm mb-0.5 ${
                    it.on ? "bg-orange-500/20 text-orange-300" : "text-gray-300 hover:bg-gray-800"
                  }`}
                >
                  {it.on ? "✓ " : ""}{it.label}
                </button>
              ))}
            </div>
          )}

          {smaSettings && showSMA && (
            <div className="absolute top-2 left-28 z-20 bg-gray-900 border border-gray-700 rounded-xl p-3 shadow-xl w-52 text-sm">
              <p className="font-medium mb-2">3SMA Settings</p>
              {[
                { str: sma1Str, setStr: setSma1Str, set: setSma1, color: smaColor1, setC: setSmaColor1, label: "SMA1", val: sma1 },
                { str: sma2Str, setStr: setSma2Str, set: setSma2, color: smaColor2, setC: setSmaColor2, label: "SMA2", val: sma2 },
                { str: sma3Str, setStr: setSma3Str, set: setSma3, color: smaColor3, setC: setSmaColor3, label: "SMA3", val: sma3 },
              ].map((row) => (
                <div key={row.label} className="flex items-center gap-2 mb-1.5">
                  <span className="w-10 text-xs text-gray-400">{row.label}</span>
                  <input
                    value={row.str}
                    onChange={(e) => row.setStr(e.target.value)}
                    onBlur={() => {
                      const n = parseInt(row.str, 10);
                      if (!Number.isNaN(n) && n > 0) row.set(n);
                      else row.setStr(String(row.val));
                    }}
                    className="w-14 bg-gray-800 rounded px-1 py-0.5 text-xs"
                  />
                  <input type="color" value={row.color} onChange={(e) => row.setC(e.target.value)} className="w-6 h-6" />
                </div>
              ))}
              <button type="button" onClick={() => setSmaSettings(false)} className="text-xs text-gray-400 mt-1">Close</button>
            </div>
          )}
          {pivotSettings && showPivot && (
            <div className="absolute top-2 left-28 z-20 bg-gray-900 border border-gray-700 rounded-xl p-3 shadow-xl w-44 text-sm">
              <p className="font-medium mb-2">Pivot TF</p>
              <div className="flex flex-wrap gap-1 mb-2">
                {PIVOT_TFS.map((t) => (
                  <button key={t.value} type="button" onClick={() => setPivotTf(t.value)}
                    className={`px-2 py-0.5 rounded text-xs ${pivotTf === t.value ? "bg-orange-500" : "bg-gray-800"}`}>
                    {t.label}
                  </button>
                ))}
              </div>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={pivotFib} onChange={(e) => setPivotFib(e.target.checked)} />
                Fib levels
              </label>
              <button type="button" onClick={() => setPivotSettings(false)} className="text-xs text-gray-400 mt-2 block">Close</button>
            </div>
          )}
          {trendSettings && showTrend && (
            <div className="absolute top-2 left-28 z-20 bg-gray-900 border border-gray-700 rounded-xl p-3 shadow-xl w-48 text-sm">
              <p className="font-medium mb-2">Trend Settings</p>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs w-14">Period</span>
                <input value={trendPeriodStr} onChange={(e) => setTrendPeriodStr(e.target.value)}
                  onBlur={() => {
                    const n = parseInt(trendPeriodStr, 10);
                    if (!Number.isNaN(n) && n >= 4) setTrendPeriod(n);
                    else setTrendPeriodStr(String(trendPeriod));
                  }}
                  className="w-14 bg-gray-800 rounded px-1 py-0.5 text-xs" />
              </div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs w-14">Max</span>
                <input type="number" min={1} max={5} value={trendMax}
                  onChange={(e) => setTrendMax(Math.min(5, Math.max(1, parseInt(e.target.value, 10) || 3)))}
                  className="w-14 bg-gray-800 rounded px-1 py-0.5 text-xs" />
              </div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs w-14">Up</span>
                <input type="color" value={trendUpColor} onChange={(e) => setTrendUpColor(e.target.value)} className="w-6 h-6" />
              </div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs w-14">Down</span>
                <input type="color" value={trendDownColor} onChange={(e) => setTrendDownColor(e.target.value)} className="w-6 h-6" />
              </div>
              <button type="button" onClick={() => setTrendSettings(false)} className="text-xs text-gray-400 mt-1">Close</button>
            </div>
          )}
          {rsiSettings && showRSI && (
            <div className="absolute top-2 left-28 z-20 bg-gray-900 border border-gray-700 rounded-xl p-3 shadow-xl w-44 text-sm">
              <p className="font-medium mb-2">RSI</p>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs w-12">Period</span>
                <input value={rsiPeriodStr} onChange={(e) => setRsiPeriodStr(e.target.value)}
                  onBlur={() => {
                    const n = parseInt(rsiPeriodStr, 10);
                    if (!Number.isNaN(n) && n >= 2) setRsiPeriod(n);
                    else setRsiPeriodStr(String(rsiPeriod));
                  }}
                  className="w-14 bg-gray-800 rounded px-1 py-0.5 text-xs" />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs w-12">Color</span>
                <input type="color" value={rsiColor} onChange={(e) => setRsiColor(e.target.value)} className="w-6 h-6" />
              </div>
              <button type="button" onClick={() => setRsiSettings(false)} className="text-xs text-gray-400 mt-2">Close</button>
            </div>
          )}
          {dmiSettings && showDMI && (
            <div className="absolute top-2 left-28 z-20 bg-gray-900 border border-gray-700 rounded-xl p-3 shadow-xl w-48 text-sm">
              <p className="font-medium mb-2">DMI</p>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs w-12">Period</span>
                <input value={dmiPeriodStr} onChange={(e) => setDmiPeriodStr(e.target.value)}
                  onBlur={() => {
                    const n = parseInt(dmiPeriodStr, 10);
                    if (!Number.isNaN(n) && n >= 2) setDmiPeriod(n);
                    else setDmiPeriodStr(String(dmiPeriod));
                  }}
                  className="w-14 bg-gray-800 rounded px-1 py-0.5 text-xs" />
              </div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs w-12">+DI</span>
                <input type="color" value={dmiPlusColor} onChange={(e) => setDmiPlusColor(e.target.value)} className="w-6 h-6" />
              </div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs w-12">-DI</span>
                <input type="color" value={dmiMinusColor} onChange={(e) => setDmiMinusColor(e.target.value)} className="w-6 h-6" />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs w-12">ADX</span>
                <input type="color" value={dmiAdxColor} onChange={(e) => setDmiAdxColor(e.target.value)} className="w-6 h-6" />
              </div>
              <button type="button" onClick={() => setDmiSettings(false)} className="text-xs text-gray-400 mt-2">Close</button>
            </div>
          )}

          {saving && (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-black/70 text-orange-300 text-sm px-3 py-1 rounded-full z-20">
              Saving...
            </div>
          )}
          {statusMsg && (
            <div className="absolute bottom-3 right-3 bg-black/70 text-gray-300 text-xs px-2 py-1 rounded z-20">
              {statusMsg}
            </div>
          )}
          {previewPrice != null && (mode === "draw" || mode === "ray" || mode === "alarm") && (
            <div className="absolute top-2 right-2 bg-black/60 text-xs px-2 py-1 rounded z-10">
              {formatPrice(previewPrice)}
            </div>
          )}
        </div>

        {/* Side list with pointer drag */}
        {showSideWl && (
          <div className="w-44 shrink-0 ml-2 bg-gray-900/80 border border-gray-800 rounded-xl overflow-hidden flex flex-col" style={{ maxHeight: 640 }}>
            <div className="px-2 py-1.5 border-b border-gray-800 flex items-center justify-between">
              <span className="text-xs text-gray-400">With alarms</span>
              <button type="button" onClick={() => setShowSideWl(false)} className="text-xs text-gray-500 hover:text-white">
                « Hide
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-1.5 space-y-1">
              {alarmSymbols.map((sym) => {
                const isDrag = draggingSym === sym;
                const isOver = dragOverSym === sym && draggingSym != null && draggingSym !== sym;
                return (
                  <div
                    key={sym}
                    data-sym={sym}
                    onPointerDown={(e) => {
                      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                      setDraggingSym(sym);
                    }}
                    onPointerMove={(e) => {
                      if (!draggingSym) return;
                      const el = document.elementFromPoint(e.clientX, e.clientY);
                      const row = el?.closest?.("[data-sym]") as HTMLElement | null;
                      if (row?.dataset?.sym) setDragOverSym(row.dataset.sym);
                    }}
                    onPointerUp={() => {
                      if (draggingSym && dragOverSym && draggingSym !== dragOverSym) {
                        setSideOrder((prev) => {
                          const base = (prev.length ? prev : alarmSymbols).filter((s) => s !== draggingSym);
                          const idx = base.indexOf(dragOverSym);
                          if (idx < 0) return prev;
                          const next = [...base];
                          next.splice(idx, 0, draggingSym);
                          return next;
                        });
                      }
                      setDraggingSym(null);
                      setDragOverSym(null);
                    }}
                    onPointerCancel={() => { setDraggingSym(null); setDragOverSym(null); }}
                    onClick={() => { if (!draggingSym) goToSymbol(sym); }}
                    className={`flex items-center gap-1.5 px-1.5 py-1.5 rounded-lg cursor-grab active:cursor-grabbing text-xs select-none transition-all ${
                      isDrag
                        ? "opacity-50 scale-95 bg-orange-500/30 border border-orange-500"
                        : isOver
                        ? "bg-orange-500/20 border border-orange-400/60"
                        : symbolUpper === sym
                        ? "bg-orange-500/20 border border-orange-500/50"
                        : "hover:bg-gray-800 border border-transparent"
                    }`}
                    style={{ touchAction: "none" }}
                  >
                    <CoinIcon symbol={sym} />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium truncate">{sym.replace("USDT", "")}</div>
                      <div className="text-[10px] text-gray-500">
                        {alarmCountBySym[sym] || 0} alarm
                        {(lineCountBySym[sym] || 0) > 0 ? ` · ${lineCountBySym[sym]} line` : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
              {!alarmSymbols.length && (
                <p className="text-gray-600 text-xs text-center py-4">No active alarms</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom lists */}
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <h3 className="text-sm font-medium text-green-400 mb-2">
            Alarms — {symbolUpper} ({currentAlarms.length})
          </h3>
          <div className="space-y-1.5">
            {currentAlarms.map((a) => (
              <div key={a.id} className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-mono font-medium min-w-[110px] shrink-0">
                    {getConditionSymbol(a.condition)} {formatPrice(a.price)}
                  </span>
                  {a.note && <span className="text-gray-500 text-xs truncate max-w-[70px]">{a.note}</span>}
                  <div className="ml-auto flex flex-wrap items-center gap-1.5 justify-end">
                    <select
                      value={a.condition}
                      onChange={(e) => updateAlarmCondition(a.id, e.target.value as any)}
                      className="bg-gray-800 rounded px-1.5 py-0.5 text-xs"
                    >
                      <option value="above">Above</option>
                      <option value="below">Below</option>
                      <option value="cross">Cross</option>
                    </select>
                    <input type="color" value={a.color || DEFAULT_ALARM_COLOR}
                      onChange={(e) => updateAlarmColor(a.id, e.target.value)} className="w-6 h-6 rounded cursor-pointer" />
                    <div className="flex gap-0.5">
                      {LINE_WIDTHS.map((w) => (
                        <button key={w} type="button" onClick={() => updateAlarmWidth(a.id, w)}
                          className={`px-1.5 py-0.5 rounded text-[10px] ${
                            (a.width || 2) === w ? "bg-orange-500 text-white" : "bg-gray-800 text-gray-400"
                          }`}>W{w}</button>
                      ))}
                    </div>
                    <button type="button"
                      onClick={() => updateAlarmDash(a.id, a.dash === "dashed" ? "solid" : "dashed")}
                      className="px-1.5 py-0.5 rounded text-[10px] bg-gray-800 text-gray-300">
                      {a.dash === "dashed" ? "- -" : "——"}
                    </button>
                    <button type="button" onClick={() => { setEditingNoteId(a.id); setEditingNoteType("alarm"); setNoteDraft(a.note || ""); }}
                      className="text-xs text-gray-400 hover:text-white">Note</button>
                    <button type="button" onClick={() => { setMode("move"); setMovingId(a.id); setMovingType("alarm"); }}
                      className="text-xs text-blue-400">Move</button>
                    <button type="button" onClick={() => deleteAlarm(a.id)} className="text-xs text-red-400">Delete</button>
                  </div>
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
            {!currentAlarms.length && <p className="text-gray-600 text-sm">No alarms</p>}
          </div>
        </div>

        <div>
          <h3 className="text-sm font-medium text-orange-400 mb-2">
            Lines — {symbolUpper} ({currentLines.length})
          </h3>
          <div className="space-y-1.5">
            {currentLines.map((l) => (
              <div key={l.id} className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-mono font-medium min-w-[110px] shrink-0">{formatPrice(l.price)}</span>
                  {l.note && <span className="text-gray-500 text-xs truncate max-w-[70px]">{l.note}</span>}
                  <div className="ml-auto flex flex-wrap items-center gap-1.5 justify-end">
                    <input type="color" value={l.color || DEFAULT_LINE_COLOR}
                      onChange={(e) => updateLineColor(l.id, e.target.value)} className="w-6 h-6 rounded cursor-pointer" />
                    <div className="flex gap-0.5">
                      {LINE_WIDTHS.map((w) => (
                        <button key={w} type="button" onClick={() => updateLineWidth(l.id, w)}
                          className={`px-1.5 py-0.5 rounded text-[10px] ${
                            (l.width || 2) === w ? "bg-orange-500 text-white" : "bg-gray-800 text-gray-400"
                          }`}>W{w}</button>
                      ))}
                    </div>
                    <button type="button"
                      onClick={() => updateLineDash(l.id, (l.dash || l.style) === "dashed" ? "solid" : "dashed")}
                      className="px-1.5 py-0.5 rounded text-[10px] bg-gray-800 text-gray-300">
                      {(l.dash || l.style) === "dashed" ? "- -" : "——"}
                    </button>
                    <button type="button" onClick={() => convertLineToAlarm(l)} className="text-xs text-green-400">Alarm</button>
                    <button type="button" onClick={() => { setEditingNoteId(l.id); setEditingNoteType("line"); setNoteDraft(l.note || ""); }}
                      className="text-xs text-gray-400 hover:text-white">Note</button>
                    <button type="button" onClick={() => { setMode("move"); setMovingId(l.id); setMovingType("line"); }}
                      className="text-xs text-blue-400">Move</button>
                    <button type="button" onClick={() => deleteLine(l.id)} className="text-xs text-red-400">Delete</button>
                  </div>
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
            {!currentLines.length && <p className="text-gray-600 text-sm">No lines</p>}
          </div>
        </div>
      </div>

      <p className="text-center text-gray-600 text-xs mt-6">© 2026 Alarm Chert</p>
    </div>
  );
}

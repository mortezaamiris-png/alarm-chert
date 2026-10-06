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

/** interval value → seconds */
function intervalToSeconds(iv: string): number {
  if (iv === "D") return 86400;
  if (iv === "W") return 604800;
  if (iv === "M") return 2592000;
  const n = parseInt(iv, 10);
  return Number.isNaN(n) ? 3600 : n * 60;
}

/** seconds left until next candle close */
function getCountdown(lastCandleTime: number, iv: string): string {
  const sec = intervalToSeconds(iv);
  const now = Math.floor(Date.now() / 1000);
  const next = (Math.floor(lastCandleTime / sec) + 1) * sec;
  let left = next - now;
  if (left < 0) left = 0;
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatTzTime(ts: number, tz: string): string {
  try {
    return new Date(ts * 1000).toLocaleString("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "short",
    });
  } catch {
    return new Date(ts * 1000).toISOString().slice(0, 16);
  }
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
}

function getConditionSymbol(c: string) {
  return c === "above" ? "≥" : c === "below" ? "≤" : "≈";
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
      alt="" width={20} height={20} className="w-5 h-5 rounded-full shrink-0"
      onError={(e) => {
        (e.target as HTMLImageElement).src =
          `https://ui-avatars.com/api/?name=${base}&background=374151&color=fff&size=32`;
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
    <div className="inline-flex items-center gap-0.5 bg-black/40 backdrop-blur-[2px] rounded px-1 py-0.5 text-[11px] text-gray-100">
      <span className="px-0.5 font-medium whitespace-nowrap opacity-90">{label}</span>
      <button type="button" onClick={onToggleVisible} className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 text-xs">
        {visible ? "👁" : "⊘"}
      </button>
      {onSettings && (
        <button type="button" onClick={onSettings} className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 text-xs">⚙</button>
      )}
      <button type="button" onClick={onRemove} className="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 text-xs text-red-400">×</button>
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
  const tfMenuRef = useRef<HTMLDivElement>(null);
  const tzMenuRef = useRef<HTMLDivElement>(null);

  const [symbol, setSymbol] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem("chart_symbol") || "BTCUSDT" : "BTCUSDT"
  );
  const [interval, setIntervalTf] = useState(() =>
    typeof window !== "undefined" ? localStorage.getItem("chart_interval") || "60" : "60"
  );
  const [timeZone, setTimeZone] = useState(() => loadLS("chart_tz", "Asia/Tehran"));
  const [tfMenuOpen, setTfMenuOpen] = useState(false);
  const [tzMenuOpen, setTzMenuOpen] = useState(false);
  const [favTfs, setFavTfs] = useState<string[]>(() =>
    loadLS("fav_tfs", ["1", "5", "15", "60", "240", "D"])
  );
  const [countdown, setCountdown] = useState("--:--");
  const [lastPrice, setLastPrice] = useState<number | null>(null);

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
  const [trendPeriod, setTrendPeriod] = useState(() => loadLS("trend_p", 12));
  const [trendPeriodStr, setTrendPeriodStr] = useState(() => String(loadLS("trend_p", 12)));
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
  const intervalRef = useRef(interval);
  const timeZoneRef = useRef(timeZone);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { conditionRef.current = condition; }, [condition]);
  useEffect(() => { movingIdRef.current = movingId; }, [movingId]);
  useEffect(() => { movingTypeRef.current = movingType; }, [movingType]);
  useEffect(() => { drawColorRef.current = drawColor; saveLS("draw_color", drawColor); }, [drawColor]);
  useEffect(() => { drawWidthRef.current = drawWidth; saveLS("draw_width", drawWidth); }, [drawWidth]);
  useEffect(() => { drawDashRef.current = drawDash; saveLS("draw_dash", drawDash); }, [drawDash]);
  useEffect(() => { symbolRef.current = symbol; localStorage.setItem("chart_symbol", symbol); }, [symbol]);
  useEffect(() => { intervalRef.current = interval; localStorage.setItem("chart_interval", interval); }, [interval]);
  useEffect(() => { timeZoneRef.current = timeZone; saveLS("chart_tz", timeZone); }, [timeZone]);
  useEffect(() => { saveLS("fav_tfs", favTfs); }, [favTfs]);
  useEffect(() => { saveLS("side_order", sideOrder); }, [sideOrder]);

  // فیکس ۱: بستن منوی TF و TZ با کلیک هرجا
  useEffect(() => {
    if (!tfMenuOpen && !tzMenuOpen) return;
    const onDoc = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (tfMenuOpen && tfMenuRef.current && !tfMenuRef.current.contains(t)) setTfMenuOpen(false);
      if (tzMenuOpen && tzMenuRef.current && !tzMenuRef.current.contains(t)) setTzMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("touchstart", onDoc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("touchstart", onDoc);
    };
  }, [tfMenuOpen, tzMenuOpen]);

  // فیکس ۴: شمارش معکوس هر ۱ ثانیه
  useEffect(() => {
    const tick = () => {
      const candles = candlesRef.current;
      if (!candles.length) return;
      const last = candles[candles.length - 1];
      setCountdown(getCountdown(last.time, intervalRef.current));
      setLastPrice(last.close);
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [symbol, interval]);

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
  }, []);

  /** apply timezone formatter to existing chart without full reload */
  const applyTimezone = useCallback((tz: string) => {
    if (!chartRef.current) return;
    try {
      chartRef.current.applyOptions({
        localization: {
          locale: "en-US",
          timeFormatter: (ts: number) => formatTzTime(ts, tz),
        },
      });
    } catch {}
  }, []);  const destroyChart = useCallback(() => {
    clearPreview();
    alarmLinesRef.current.forEach((pl) => {
      try { seriesRef.current?.removePriceLine(pl); } catch {}
    });
    alarmLinesRef.current.clear();
    chartLinesRef.current.forEach((obj) => {
      try {
        if (obj.line) chartRef.current?.removeSeries(obj.line);
        else if (obj.pl) seriesRef.current?.removePriceLine(obj.pl);
      } catch {}
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
      try { chartRef.current.remove(); } catch {}
      chartRef.current = null;
    }
    seriesRef.current = null;
  }, [clearPreview]);

  const renderAllLinesAndAlarms = useCallback(() => {
    if (!seriesRef.current || !chartRef.current) return;

    alarmLinesRef.current.forEach((pl) => {
      try { seriesRef.current?.removePriceLine(pl); } catch {}
    });
    alarmLinesRef.current.clear();
    chartLinesRef.current.forEach((obj) => {
      try {
        if (obj.line) chartRef.current?.removeSeries(obj.line);
        else if (obj.pl) seriesRef.current?.removePriceLine(obj.pl);
      } catch {}
    });
    chartLinesRef.current.clear();

    currentLines.forEach((l) => {
      const isMoving = movingId === l.id && movingType === "line";
      const color = isMoving ? "#f59e0b" : l.color || DEFAULT_LINE_COLOR;
      const width = isMoving ? 3 : l.width || 2;
      const style = isMoving ? MOVE_STYLE : toLineStyle(l.dash || l.style);
      const title = isMoving
        ? "MOVING"
        : l.note
        ? `L ${l.note}`
        : `Line ${formatPrice(l.price)}`;

      if (l.start_time != null) {
        try {
          const lineSeries = chartRef.current!.addLineSeries({
            color,
            lineWidth: width as any,
            lineStyle: style,
            priceLineVisible: false,
            lastValueVisible: true,
            title,
          });
          const lastT = candlesRef.current.length
            ? candlesRef.current[candlesRef.current.length - 1].time
            : Math.floor(Date.now() / 1000);
          lineSeries.setData([
            { time: l.start_time as any, value: l.price },
            { time: lastT as any, value: l.price },
          ]);
          chartLinesRef.current.set(l.id, { line: lineSeries });
        } catch {}
      } else {
        try {
          const pl = seriesRef.current!.createPriceLine({
            price: l.price,
            color,
            lineWidth: width as any,
            lineStyle: style,
            axisLabelVisible: true,
            title,
          });
          chartLinesRef.current.set(l.id, { pl });
        } catch {}
      }
    });

    currentAlarms.forEach((a) => {
      const isMoving = movingId === a.id && movingType === "alarm";
      const color = isMoving ? "#f59e0b" : a.color || DEFAULT_ALARM_COLOR;
      const width = isMoving ? 3 : a.width || 2;
      const style = isMoving ? MOVE_STYLE : toLineStyle(a.dash);
      const title = isMoving
        ? "MOVING"
        : a.note
        ? `${getConditionSymbol(a.condition)} ${a.note}`
        : `Alarm ${getConditionSymbol(a.condition)} ${formatPrice(a.price)}`;

      try {
        const pl = seriesRef.current!.createPriceLine({
          price: a.price,
          color,
          lineWidth: width as any,
          lineStyle: style,
          axisLabelVisible: true,
          title,
        });
        alarmLinesRef.current.set(a.id, pl);
      } catch {}
    });
  }, [currentLines, currentAlarms, movingId, movingType]);

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
    if (!chartRef.current || !candlesRef.current.length || !showSMA) return;
    removeSMA();
    if (!smaVisible) return;
    try {
      const s1 = chartRef.current.addLineSeries({ color: smaColor1, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      const s2 = chartRef.current.addLineSeries({ color: smaColor2, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      const s3 = chartRef.current.addLineSeries({ color: smaColor3, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
      s1.setData(calcSMA(candlesRef.current, sma1) as any);
      s2.setData(calcSMA(candlesRef.current, sma2) as any);
      s3.setData(calcSMA(candlesRef.current, sma3) as any);
      smaSeriesRef.current = { s1, s2, s3 };
    } catch {}
  }, [showSMA, smaVisible, sma1, sma2, sma3, smaColor1, smaColor2, smaColor3, removeSMA]);

  const removeRSI = useCallback(() => {
    if (rsiSeriesRef.current && chartRef.current) {
      try { chartRef.current.removeSeries(rsiSeriesRef.current); } catch {}
      rsiSeriesRef.current = null;
    }
  }, []);
  const applyRSI = useCallback(() => {
    if (!chartRef.current || !candlesRef.current.length || !showRSI) return;
    removeRSI();
    if (!rsiVisible) return;
    try {
      const s = chartRef.current.addLineSeries({
        color: rsiColor, lineWidth: 1, priceLineVisible: false, lastValueVisible: true,
        priceScaleId: "rsi",
      });
      s.setData(calcRSI(candlesRef.current, rsiPeriod) as any);
      rsiSeriesRef.current = s;
      updateMargins();
    } catch {}
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
    if (!chartRef.current || !candlesRef.current.length || !showDMI) return;
    removeDMI();
    if (!dmiVisible) return;
    try {
      const { plusDI, minusDI, adx } = calcDMI(candlesRef.current, dmiPeriod);
      const plus = chartRef.current.addLineSeries({ color: dmiPlusColor, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, priceScaleId: "dmi" });
      const minus = chartRef.current.addLineSeries({ color: dmiMinusColor, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, priceScaleId: "dmi" });
      const adxS = chartRef.current.addLineSeries({ color: dmiAdxColor, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, priceScaleId: "dmi" });
      plus.setData(plusDI as any);
      minus.setData(minusDI as any);
      adxS.setData(adx as any);
      dmiSeriesRef.current = { plus, minus, adx: adxS };
      updateMargins();
    } catch {}
  }, [showDMI, dmiVisible, dmiPeriod, dmiPlusColor, dmiMinusColor, dmiAdxColor, removeDMI, updateMargins]);

  const removePivot = useCallback(() => {
    pivotSeriesRef.current.forEach((s) => {
      try { chartRef.current?.removeSeries(s); } catch {}
    });
    pivotSeriesRef.current = [];
  }, []);
  const applyPivot = useCallback(() => {
    if (!chartRef.current || !candlesRef.current.length || !showPivot || !pivotVisible) return;
    removePivot();
    try {
      const c = candlesRef.current;
      const last = c[c.length - 1];
      const lookback = pivotTf === "D" ? 24 : pivotTf === "W" ? 48 : pivotTf === "60" ? 12 : 6;
      const slice = c.slice(-Math.max(lookback, 5));
      const hi = Math.max(...slice.map((x: any) => x.high));
      const lo = Math.min(...slice.map((x: any) => x.low));
      const cl = last.close;
      const pp = (hi + lo + cl) / 3;
      const r1 = 2 * pp - lo, s1 = 2 * pp - hi;
      const r2 = pp + (hi - lo), s2 = pp - (hi - lo);
      const levels = pivotFib
        ? [
            { p: pp, c: "#eab308" },
            { p: pp + 0.382 * (hi - lo), c: "#f97316" },
            { p: pp + 0.618 * (hi - lo), c: "#ef4444" },
            { p: pp - 0.382 * (hi - lo), c: "#22c55e" },
            { p: pp - 0.618 * (hi - lo), c: "#3b82f6" },
          ]
        : [
            { p: pp, c: "#eab308" },
            { p: r1, c: "#f97316" },
            { p: r2, c: "#ef4444" },
            { p: s1, c: "#22c55e" },
            { p: s2, c: "#3b82f6" },
          ];
      levels.forEach(({ p, c: col }) => {
        const s = chartRef.current!.addLineSeries({
          color: col, lineWidth: 1, lineStyle: LineStyle.Dashed,
          priceLineVisible: false, lastValueVisible: true,
        });
        s.setData([
          { time: c[0].time as any, value: p },
          { time: last.time as any, value: p },
        ]);
        pivotSeriesRef.current.push(s);
      });
    } catch {}
  }, [showPivot, pivotVisible, pivotTf, pivotFib, removePivot]);

  const removeTrend = useCallback(() => {
    trendSeriesRef.current.forEach((s) => {
      try { chartRef.current?.removeSeries(s); } catch {}
    });
    trendSeriesRef.current = [];
  }, []);
  const applyTrend = useCallback(() => {
    if (!chartRef.current || !candlesRef.current.length || !showTrend || !trendVisible) return;
    removeTrend();
    try {
      const c = candlesRef.current;
      const { highs, lows } = findPivots(c, Math.max(3, Math.floor(trendPeriod / 2)));
      const maxL = Math.max(1, trendMax);
      const recentH = highs.slice(-maxL - 1);
      const recentL = lows.slice(-maxL - 1);

      for (let i = 1; i < recentH.length && trendSeriesRef.current.length < maxL; i++) {
        const a = recentH[i - 1], b = recentH[i];
        const s = chartRef.current!.addLineSeries({
          color: trendDownColor, lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
        });
        s.setData([
          { time: a.time as any, value: a.price },
          { time: b.time as any, value: b.price },
        ]);
        trendSeriesRef.current.push(s);
      }
      for (let i = 1; i < recentL.length && trendSeriesRef.current.length < maxL * 2; i++) {
        const a = recentL[i - 1], b = recentL[i];
        const s = chartRef.current!.addLineSeries({
          color: trendUpColor, lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
        });
        s.setData([
          { time: a.time as any, value: a.price },
          { time: b.time as any, value: b.price },
        ]);
        trendSeriesRef.current.push(s);
      }
    } catch {}
  }, [showTrend, trendVisible, trendPeriod, trendUpColor, trendDownColor, trendMax, removeTrend]);

  const applyVolume = useCallback(() => {
    if (!chartRef.current || !candlesRef.current.length) return;
    if (volumeSeriesRef.current) {
      try { chartRef.current.removeSeries(volumeSeriesRef.current); } catch {}
      volumeSeriesRef.current = null;
    }
    if (!showVol || !volVisible) {
      updateMargins();
      return;
    }
    try {
      const vol = chartRef.current.addHistogramSeries({
        priceFormat: { type: "volume" },
        priceScaleId: "volume",
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
    } catch {}
  }, [showVol, volVisible, updateMargins]);

  const rebuildIndicators = useCallback(() => {
    applySMA();
    applyRSI();
    applyDMI();
    applyPivot();
    applyTrend();
    applyVolume();
    updateMargins();
  }, [applySMA, applyRSI, applyDMI, applyPivot, applyTrend, applyVolume, updateMargins]);

  const loadCandles = useCallback(async () => {
    const sym = symbolRef.current.toUpperCase();
    const iv = intervalRef.current;
    const tz = timeZoneRef.current;
    if (!chartContainerRef.current) return;

    destroyChart();
    if (chartContainerRef.current) chartContainerRef.current.innerHTML = "";

    try {
      const res = await fetch(
        `https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=${iv}&limit=500`
      );
      const json = await res.json();
      const list = json?.result?.list || [];
      if (!list.length) {
        setStatusMsg("No data");
        return;
      }
      const candles = list
        .map((d: any) => ({
          time: Math.floor(Number(d[0]) / 1000),
          open: parseFloat(d[1]),
          high: parseFloat(d[2]),
          low: parseFloat(d[3]),
          close: parseFloat(d[4]),
          volume: parseFloat(d[5]),
        }))
        .reverse();
      candlesRef.current = candles;
      setLastPrice(candles[candles.length - 1]?.close ?? null);

      const lastClose = candles[candles.length - 1].close;
      const { precision, minMove } = getPrecision(lastClose);

      const chart = createChart(chartContainerRef.current, {
        autoSize: true,
        layout: {
          background: { color: "#0b0e11" },
          textColor: "#d1d5db",
        },
        grid: {
          vertLines: { color: "rgba(42,46,57,0.5)" },
          horzLines: { color: "rgba(42,46,57,0.5)" },
        },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: { borderColor: "#2a2e39", autoScale: true },
        timeScale: {
          borderColor: "#2a2e39",
          timeVisible: true,
          secondsVisible: false,
          rightOffset: 6,
        },
        localization: {
          locale: "en-US",
          timeFormatter: (ts: number) => formatTzTime(ts, tz),
        },
        handleScroll: { vertTouchDrag: true },
        handleScale: { axisPressedMouseMove: true },
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

      rebuildIndicators();
      renderAllLinesAndAlarms();

      chart.subscribeCrosshairMove((param) => {
        if (modeRef.current === "none" || modeRef.current === "move") return;
        if (!param.point || param.point.x < 0 || param.point.y < 0) {
          clearPreview();
          return;
        }
        const price = series.coordinateToPrice(param.point.y);
        if (price == null) return;
        const snapped = formatPrice(price);
        setPreviewPrice(snapped);
        if (previewLineRef.current) {
          try { series.removePriceLine(previewLineRef.current); } catch {}
        }
        const isAlarm = modeRef.current === "alarm";
        previewLineRef.current = series.createPriceLine({
          price: snapped,
          color: isAlarm ? drawColorRef.current : drawColorRef.current,
          lineWidth: (drawWidthRef.current || 2) as any,
          lineStyle: toLineStyle(drawDashRef.current),
          axisLabelVisible: true,
          title: isAlarm ? "New Alarm" : "New Line",
        });
      });

      chart.subscribeClick(async (param) => {
        if (clickLockRef.current) return;
        if (!param.point || !seriesRef.current) return;
        const priceRaw = series.coordinateToPrice(param.point.y);
        if (priceRaw == null) return;
        const price = formatPrice(priceRaw);
        const m = modeRef.current;

        if (m === "move" && movingIdRef.current) {
          clickLockRef.current = true;
          try {
            if (movingTypeRef.current === "alarm") {
              const { error } = await supabase
                .from("alarms")
                .update({ price })
                .eq("id", movingIdRef.current);
              if (!error) {
                setAlarms((prev) =>
                  prev.map((a) => (a.id === movingIdRef.current ? { ...a, price } : a))
                );
                setStatusMsg("Alarm moved");
              }
            } else if (movingTypeRef.current === "line") {
              const { error } = await supabase
                .from("chart_lines")
                .update({ price })
                .eq("id", movingIdRef.current);
              if (!error) {
                setLines((prev) =>
                  prev.map((l) => (l.id === movingIdRef.current ? { ...l, price } : l))
                );
                setStatusMsg("Line moved");
              }
            }
          } finally {
            setMovingId(null);
            setMovingType(null);
            setMode("none");
            clearPreview();
            setTimeout(() => { clickLockRef.current = false; }, 300);
          }
          return;
        }

        if (m === "draw" || m === "ray") {
          clickLockRef.current = true;
          setSaving(true);
          try {
            const payload: any = {
              symbol: symbolRef.current.toUpperCase(),
              price,
              color: drawColorRef.current,
              width: drawWidthRef.current,
              style: drawDashRef.current,
              dash: drawDashRef.current,
              note: null,
            };
            if (m === "ray") {
              const t = param.time
                ? typeof param.time === "number"
                  ? param.time
                  : Math.floor(Date.now() / 1000)
                : Math.floor(Date.now() / 1000);
              payload.start_time = t;
            }
            const { data, error } = await supabase
              .from("chart_lines")
              .insert(payload)
              .select()
              .single();
            if (!error && data) {
              setLines((prev) => [data as ChartLine, ...prev]);
              setStatusMsg("Line saved");
            } else {
              setStatusMsg("Save failed");
            }
          } finally {
            setMode("none");
            clearPreview();
            setSaving(false);
            setTimeout(() => { clickLockRef.current = false; }, 300);
          }
          return;
        }

        if (m === "alarm") {
          clickLockRef.current = true;
          setSaving(true);
          try {
            const payload = {
              symbol: symbolRef.current.toUpperCase(),
              price,
              condition: conditionRef.current,
              is_active: true,
              triggered: false,
              color: drawColorRef.current,
              width: drawWidthRef.current,
              dash: drawDashRef.current,
              note: null,
            };
            const { data, error } = await supabase
              .from("alarms")
              .insert(payload)
              .select()
              .single();
            if (!error && data) {
              setAlarms((prev) => [data as Alarm, ...prev]);
              setStatusMsg("Alarm saved");
            } else {
              setStatusMsg("Save failed");
            }
          } finally {
            setMode("none");
            clearPreview();
            setSaving(false);
            setTimeout(() => { clickLockRef.current = false; }, 300);
          }
        }
      });
    } catch (e: any) {
      setStatusMsg(e?.message || "Load error");
    }
  }, [destroyChart, rebuildIndicators, renderAllLinesAndAlarms, clearPreview]);

  useEffect(() => {
    loadCandles();
    return () => destroyChart();
  }, [symbol, interval]);

  // فیکس ۲: وقتی تایم‌زون عوض شد فقط formatter را آپدیت کن (بدون ریلود کامل)
  useEffect(() => {
    applyTimezone(timeZone);
  }, [timeZone, applyTimezone]);

  useEffect(() => {
    renderAllLinesAndAlarms();
  }, [currentLines, currentAlarms, movingId, movingType, renderAllLinesAndAlarms]);

  useEffect(() => {
    rebuildIndicators();
  }, [
    showSMA, smaVisible, sma1, sma2, sma3, smaColor1, smaColor2, smaColor3,
    showRSI, rsiVisible, rsiPeriod, rsiColor,
    showDMI, dmiVisible, dmiPeriod, dmiPlusColor, dmiMinusColor, dmiAdxColor,
    showPivot, pivotVisible, pivotTf, pivotFib,
    showTrend, trendVisible, trendPeriod, trendUpColor, trendDownColor, trendMax,
    showVol, volVisible, rebuildIndicators,
  ]);

  // load alarms & lines
  useEffect(() => {
    (async () => {
      const { data: a } = await supabase
        .from("alarms")
        .select("*")
        .eq("is_active", true)
        .eq("triggered", false)
        .order("created_at", { ascending: false });
      if (a) setAlarms(a as Alarm[]);
      const { data: l } = await supabase
        .from("chart_lines")
        .select("*")
        .order("created_at", { ascending: false });
      if (l) setLines(l as ChartLine[]);
    })();
  }, []);

  // realtime poll + local clear
  useEffect(() => {
    const tick = async () => {
      try {
        const symbols = [
          ...new Set(
            alarms.filter((a) => a.is_active && !a.triggered).map((a) => a.symbol.toUpperCase())
          ),
        ];
        if (!symbols.length) return;
        for (const sym of symbols) {
          try {
            const res = await fetch(
              `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${sym}`
            );
            const json = await res.json();
            const price = parseFloat(json?.result?.list?.[0]?.lastPrice);
            if (!price) continue;
            const prev = prevPricesRef.current[sym];
            prevPricesRef.current[sym] = price;

            const toTrigger = alarms.filter(
              (a) =>
                a.symbol.toUpperCase() === sym &&
                a.is_active &&
                !a.triggered &&
                !notifiedAlarmsRef.current.has(a.id) &&
                didCross(a.condition, a.price, prev, price)
            );
            for (const a of toTrigger) {
              notifiedAlarmsRef.current.add(a.id);
              await supabase
                .from("alarms")
                .update({ triggered: true, is_active: false, last_price: price })
                .eq("id", a.id);
              setAlarms((prev) => prev.filter((x) => x.id !== a.id));
              showLocalNotification(
                `${a.symbol} Alarm`,
                `Price ${price} | Target ${a.price} | ${a.condition}`
              );
              setStatusMsg(`Triggered: ${a.symbol} @ ${price}`);
            }
          } catch {}
        }
      } catch {}
    };
    const id = window.setInterval(tick, 2000);
    return () => clearInterval(id);
  }, [alarms]);

  const deleteAlarm = async (id: string) => {
    await supabase.from("alarms").delete().eq("id", id);
    setAlarms((prev) => prev.filter((a) => a.id !== id));
  };
  const deleteLine = async (id: string) => {
    await supabase.from("chart_lines").delete().eq("id", id);
    setLines((prev) => prev.filter((l) => l.id !== id));
  };
  const convertLineToAlarm = async (line: ChartLine) => {
    const payload = {
      symbol: line.symbol,
      price: line.price,
      condition: "cross" as const,
      is_active: true,
      triggered: false,
      color: line.color || drawColorRef.current,
      width: line.width || 2,
      dash: line.dash || line.style || "solid",
      note: line.note || null,
    };
    const { data, error } = await supabase.from("alarms").insert(payload).select().single();
    if (!error && data) {
      setAlarms((prev) => [data as Alarm, ...prev]);
      await deleteLine(line.id);
      setStatusMsg("Converted to alarm");
    }
  };
  const updateAlarmField = async (id: string, fields: Partial<Alarm>) => {
    await supabase.from("alarms").update(fields).eq("id", id);
    setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, ...fields } : a)));
  };
  const updateLineField = async (id: string, fields: Partial<ChartLine>) => {
    await supabase.from("chart_lines").update(fields).eq("id", id);
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...fields } : l)));
  };
  const saveNote = async () => {
    if (!editingNoteId || !editingNoteType) return;
    if (editingNoteType === "alarm") {
      await updateAlarmField(editingNoteId, { note: noteDraft || null });
    } else {
      await updateLineField(editingNoteId, { note: noteDraft || null });
    }
    setEditingNoteId(null);
    setEditingNoteType(null);
    setNoteDraft("");
  };

  // side list drag
  const onSidePointerDown = (sym: string, e: React.PointerEvent) => {
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
        const without = base.filter((s) => s !== draggingSym);
        const idx = without.indexOf(dragOverSym);
        if (idx === -1) return [...without, draggingSym];
        without.splice(idx, 0, draggingSym);
        return without;
      });
    }
    setDraggingSym(null);
    setDragOverSym(null);
  };

  // فیکس ۳: جلوگیری از اسکرول صفحه وقتی روی چارت هستیم
  useEffect(() => {
    const el = chartContainerRef.current;
    if (!el) return;
    const prevent = (e: TouchEvent | WheelEvent) => {
      if (el.contains(e.target as Node)) {
        e.stopPropagation();
      }
    };
    el.addEventListener("wheel", prevent as any, { passive: false });
    el.addEventListener("touchmove", prevent as any, { passive: false });
    return () => {
      el.removeEventListener("wheel", prevent as any);
      el.removeEventListener("touchmove", prevent as any);
    };
  }, []);

  const startMove = (id: string, type: "line" | "alarm") => {
    setMovingId(id);
    setMovingType(type);
    setMode("move");
    setStatusMsg("Click on chart to set new price");
  };

  return (
    <div className="min-h-screen bg-[#0b0e11] text-gray-200">
      <div className="max-w-[1600px] mx-auto px-2 sm:px-4 py-3">
        {/* Header: Live Chart left — controls right */}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <h1 className="text-lg font-semibold text-gray-200 mr-2">Live Chart</h1>
          <div className="flex-1" />
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === "Enter") loadCandles();
            }}
            className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm w-28"
          />
          <div className="flex items-center gap-1">
            {favTfButtons.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setIntervalTf(t.value)}
                className={`px-2 py-1 rounded text-xs ${
                  interval === t.value
                    ? "bg-orange-500 text-white"
                    : "bg-gray-800 text-gray-300 hover:bg-gray-700"
                }`}
              >
                {t.label}
              </button>
            ))}
            <div className="relative" ref={tfMenuRef}>
              <button
                type="button"
                onClick={() => setTfMenuOpen((v) => !v)}
                className="px-2 py-1 rounded text-xs bg-gray-800 hover:bg-gray-700"
              >
                TF ▾
              </button>
              {tfMenuOpen && (
                <div className="absolute right-0 top-full mt-1 z-50 bg-gray-900 border border-gray-700 rounded shadow-xl py-1 min-w-[120px]">
                  {ALL_TIMEFRAMES.map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => {
                        setIntervalTf(t.value);
                        setTfMenuOpen(false);
                      }}
                      className="w-full text-left px-3 py-1.5 text-xs hover:bg-gray-800 flex items-center justify-between gap-2"
                    >
                      <span>{t.label}</span>
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavTf(t.value);
                        }}
                        className="text-yellow-400 cursor-pointer"
                      >
                        {favTfs.includes(t.value) ? "★" : "☆"}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {statusMsg && (
            <span className="text-xs text-orange-400 ml-2">{statusMsg}</span>
          )}
        </div>

        <div className="flex gap-2">
          {/* Chart area */}
          <div className="flex-1 min-w-0 relative">
            {/* Left tools */}
            <div className="absolute left-1 top-10 z-20 flex flex-col gap-1">
              {(
                [
                  ["draw", "Line", "✏️"],
                  ["ray", "Ray", "➡️"],
                  ["alarm", "Alarm", "🔔"],
                ] as const
              ).map(([m, label, icon]) => (
                <button
                  key={m}
                  type="button"
                  title={label}
                  onClick={() => {
                    setMode((prev) => (prev === m ? "none" : m));
                    setMovingId(null);
                    setMovingType(null);
                  }}
                  className={`w-9 h-9 rounded-lg flex items-center justify-center text-sm border ${
                    mode === m
                      ? "bg-orange-500 border-orange-400 text-white"
                      : "bg-gray-900/80 border-gray-700 text-gray-300 hover:bg-gray-800"
                  }`}
                >
                  {icon}
                </button>
              ))}
              <button
                type="button"
                title="Indicators"
                onClick={() => setShowIndicatorMenu((v) => !v)}
                className="w-9 h-9 rounded-lg flex items-center justify-center text-sm border bg-gray-900/80 border-gray-700 text-gray-300 hover:bg-gray-800"
              >
                📊
              </button>
            </div>

            {/* Indicator chips top-left */}
            <div className="absolute top-2 left-12 z-20 flex flex-col gap-1">
              {showSMA && (
                <IndChip
                  label="3SMA"
                  visible={smaVisible}
                  onToggleVisible={() => setSmaVisible((v) => !v)}
                  onSettings={() => setSmaSettings(true)}
                  onRemove={() => {
                    setShowSMA(false);
                    removeSMA();
                  }}
                />
              )}
              {showPivot && (
                <IndChip
                  label="Pivot"
                  visible={pivotVisible}
                  onToggleVisible={() => setPivotVisible((v) => !v)}
                  onSettings={() => setPivotSettings(true)}
                  onRemove={() => {
                    setShowPivot(false);
                    removePivot();
                  }}
                />
              )}
              {showTrend && (
                <IndChip
                  label="Trend"
                  visible={trendVisible}
                  onToggleVisible={() => setTrendVisible((v) => !v)}
                  onSettings={() => setTrendSettings(true)}
                  onRemove={() => {
                    setShowTrend(false);
                    removeTrend();
                  }}
                />
              )}
              {showRSI && (
                <IndChip
                  label="RSI"
                  visible={rsiVisible}
                  onToggleVisible={() => setRsiVisible((v) => !v)}
                  onSettings={() => setRsiSettings(true)}
                  onRemove={() => {
                    setShowRSI(false);
                    removeRSI();
                  }}
                />
              )}
              {showDMI && (
                <IndChip
                  label="DMI"
                  visible={dmiVisible}
                  onToggleVisible={() => setDmiVisible((v) => !v)}
                  onSettings={() => setDmiSettings(true)}
                  onRemove={() => {
                    setShowDMI(false);
                    removeDMI();
                  }}
                />
              )}
              {showVol && (
                <IndChip
                  label="Vol"
                  visible={volVisible}
                  onToggleVisible={() => setVolVisible((v) => !v)}
                  onRemove={() => {
                    setShowVol(false);
                    if (volumeSeriesRef.current) {
                      try { chartRef.current?.removeSeries(volumeSeriesRef.current); } catch {}
                      volumeSeriesRef.current = null;
                    }
                  }}
                />
              )}
            </div>

            {/* Indicator menu */}
            {showIndicatorMenu && (
              <div className="absolute left-12 top-24 z-30 bg-gray-900 border border-gray-700 rounded-lg shadow-xl p-2 text-xs w-40">
                {[
                  ["3SMA", showSMA, () => setShowSMA(true)],
                  ["Pivot", showPivot, () => setShowPivot(true)],
                  ["Trend", showTrend, () => setShowTrend(true)],
                  ["RSI", showRSI, () => setShowRSI(true)],
                  ["DMI", showDMI, () => setShowDMI(true)],
                  ["Volume", showVol, () => setShowVol(true)],
                ].map(([label, on, fn]) => (
                  <button
                    key={label as string}
                    type="button"
                    disabled={!!on}
                    onClick={() => {
                      (fn as () => void)();
                      setShowIndicatorMenu(false);
                    }}
                    className="w-full text-left px-2 py-1.5 rounded hover:bg-gray-800 disabled:opacity-40"
                  >
                    {label as string}
                  </button>
                ))}
              </div>
            )}

            {/* Style panel — bottom LEFT */}
            {(mode === "draw" || mode === "ray" || mode === "alarm" || mode === "move") && (
              <div className="absolute bottom-10 left-3 z-30 flex items-center gap-1 bg-gray-900/95 border border-gray-700 rounded-lg px-2 py-1.5 shadow-xl">
                <input
                  type="color"
                  value={drawColor}
                  onChange={(e) => setDrawColor(e.target.value)}
                  className="w-7 h-7 rounded cursor-pointer bg-transparent border-0"
                />
                {LINE_WIDTHS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setDrawWidth(w)}
                    className={`w-7 h-7 rounded text-xs ${
                      drawWidth === w ? "bg-orange-500 text-white" : "bg-gray-800"
                    }`}
                  >
                    W{w}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setDrawDash((d) => (d === "solid" ? "dashed" : "solid"))}
                  className="px-2 h-7 rounded text-xs bg-gray-800"
                >
                  {drawDash === "solid" ? "—" : "- -"}
                </button>
                {mode === "alarm" && (
                  <select
                    value={condition}
                    onChange={(e) => setCondition(e.target.value as any)}
                    className="bg-gray-800 rounded text-xs px-1 h-7"
                  >
                    <option value="cross">Cross</option>
                    <option value="above">Above</option>
                    <option value="below">Below</option>
                  </select>
                )}
              </div>
            )}

            {/* فیکس ۲ + ۴: شمارش معکوس + تایم‌زون پایین‌راست چارت */}
            <div className="absolute bottom-10 right-3 z-30 flex items-center gap-2">
              {lastPrice != null && (
                <div className="bg-gray-900/90 border border-gray-700 rounded px-2 py-1 text-xs flex items-center gap-2">
                  <span className="text-gray-400">{symbolUpper}</span>
                  <span className="text-white font-medium">{formatPrice(lastPrice)}</span>
                  <span className="text-orange-400 font-mono">{countdown}</span>
                </div>
              )}
              <div className="relative" ref={tzMenuRef}>
                <button
                  type="button"
                  onClick={() => setTzMenuOpen((v) => !v)}
                  className="bg-gray-900/90 border border-gray-700 rounded px-2 py-1 text-xs hover:bg-gray-800"
                >
                  {TIMEZONES.find((t) => t.value === timeZone)?.label || "UTC"} ▾
                </button>
                {tzMenuOpen && (
                  <div className="absolute right-0 bottom-full mb-1 z-50 bg-gray-900 border border-gray-700 rounded shadow-xl py-1 min-w-[120px]">
                    {TIMEZONES.map((t) => (
                      <button
                        key={t.value}
                        type="button"
                        onClick={() => {
                          setTimeZone(t.value);
                          setTzMenuOpen(false);
                        }}
                        className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-800 ${
                          timeZone === t.value ? "text-orange-400" : ""
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Chart canvas — فیکس ۳: touch-action + overscroll */}
            <div
              ref={chartContainerRef}
              className="w-full rounded-lg border border-gray-800 bg-[#0b0e11]"
              style={{
                height: 640,
                touchAction: "none",
                overscrollBehavior: "none",
              }}
            />
          </div>

          {/* Side watchlist */}
          {showSideWl && (
            <div className="w-44 shrink-0 bg-gray-900/60 border border-gray-800 rounded-lg p-2 max-h-[640px] overflow-y-auto">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-400">With alarms</span>
                <button
                  type="button"
                  onClick={() => setShowSideWl(false)}
                  className="text-[10px] text-gray-500 hover:text-gray-300"
                >
                  Hide
                </button>
              </div>
              {alarmSymbols.map((s) => (
                <div
                  key={s}
                  onPointerDown={(e) => onSidePointerDown(s, e)}
                  onPointerEnter={() => onSidePointerEnter(s)}
                  onPointerUp={onSidePointerUp}
                  onClick={() => setSymbol(s)}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded mb-1 cursor-grab active:cursor-grabbing select-none transition-transform duration-100 ${
                    symbolUpper === s ? "bg-orange-500/20 border border-orange-500/40" : "hover:bg-gray-800"
                  } ${draggingSym === s ? "scale-[0.96] opacity-80" : ""} ${
                    dragOverSym === s ? "border-t-2 border-orange-400" : ""
                  }`}
                  style={{ willChange: "transform" }}
                >
                  <CoinIcon symbol={s} />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium truncate">{s.replace("USDT", "")}</div>
                    <div className="text-[10px] text-gray-500">
                      {(alarmCountBySym[s] || 0)} alarm
                      {(lineCountBySym[s] || 0) > 0 ? ` · ${lineCountBySym[s]} line` : ""}
                    </div>
                  </div>
                </div>
              ))}
              {!alarmSymbols.length && (
                <p className="text-[11px] text-gray-600">No active alarms</p>
              )}
            </div>
          )}
          {!showSideWl && (
            <button
              type="button"
              onClick={() => setShowSideWl(true)}
              className="w-8 shrink-0 bg-gray-900 border border-gray-800 rounded text-xs text-gray-400"
            >
              »
            </button>
          )}
        </div>

        {/* Bottom lists */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
          {/* Alarms list */}
          <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-3">
            <h3 className="text-sm font-medium text-green-400 mb-2">
              Alarms — {symbolUpper} ({currentAlarms.length})
            </h3>
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {currentAlarms.map((a) => (
                <div key={a.id} className="bg-gray-800/60 rounded px-2 py-1.5 text-xs">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-gray-200 w-24 shrink-0">
                      ≈ {formatPrice(a.price)}
                    </span>
                    <select
                      value={a.condition}
                      onChange={(e) =>
                        updateAlarmField(a.id, { condition: e.target.value as any })
                      }
                      className="bg-gray-900 rounded px-1 py-0.5"
                    >
                      <option value="cross">Cross</option>
                      <option value="above">Above</option>
                      <option value="below">Below</option>
                    </select>
                    <input
                      type="color"
                      value={a.color || DEFAULT_ALARM_COLOR}
                      onChange={(e) => updateAlarmField(a.id, { color: e.target.value })}
                      className="w-6 h-6 rounded cursor-pointer bg-transparent border-0"
                    />
                    {LINE_WIDTHS.map((w) => (
                      <button
                        key={w}
                        type="button"
                        onClick={() => updateAlarmField(a.id, { width: w })}
                        className={`px-1.5 py-0.5 rounded ${
                          (a.width || 2) === w ? "bg-orange-500" : "bg-gray-700"
                        }`}
                      >
                        W{w}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        updateAlarmField(a.id, {
                          dash: a.dash === "dashed" ? "solid" : "dashed",
                        })
                      }
                      className="px-1.5 py-0.5 rounded bg-gray-700"
                    >
                      {a.dash === "dashed" ? "- -" : "—"}
                    </button>
                    <div className="flex-1" />
                    <button
                      type="button"
                      onClick={() => {
                        setEditingNoteId(a.id);
                        setEditingNoteType("alarm");
                        setNoteDraft(a.note || "");
                      }}
                      className="text-gray-400 hover:text-white"
                    >
                      Note
                    </button>
                    <button
                      type="button"
                      onClick={() => startMove(a.id, "alarm")}
                      className="text-blue-400 hover:text-blue-300"
                    >
                      Move
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteAlarm(a.id)}
                      className="text-red-400 hover:text-red-300"
                    >
                      Delete
                    </button>
                  </div>
                  {editingNoteId === a.id && editingNoteType === "alarm" && (
                    <div className="mt-1.5 flex gap-2">
                      <input
                        value={noteDraft}
                        onChange={(e) => setNoteDraft(e.target.value)}
                        className="flex-1 bg-gray-900 rounded px-2 py-1"
                        placeholder="Note..."
                        autoFocus
                      />
                      <button type="button" onClick={saveNote} className="text-green-400">
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingNoteId(null);
                          setEditingNoteType(null);
                        }}
                        className="text-gray-500"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {!currentAlarms.length && (
                <p className="text-gray-500 text-sm">No alarms</p>
              )}
            </div>
          </div>

          {/* Lines list */}
          <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-3">
            <h3 className="text-sm font-medium text-orange-400 mb-2">
              Lines — {symbolUpper} ({currentLines.length})
            </h3>
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {currentLines.map((l) => (
                <div key={l.id} className="bg-gray-800/60 rounded px-2 py-1.5 text-xs">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-gray-200 w-24 shrink-0">
                      {formatPrice(l.price)}
                    </span>
                    <input
                      type="color"
                      value={l.color || DEFAULT_LINE_COLOR}
                      onChange={(e) => updateLineField(l.id, { color: e.target.value })}
                      className="w-6 h-6 rounded cursor-pointer bg-transparent border-0"
                    />
                    {LINE_WIDTHS.map((w) => (
                      <button
                        key={w}
                        type="button"
                        onClick={() => updateLineField(l.id, { width: w })}
                        className={`px-1.5 py-0.5 rounded ${
                          (l.width || 2) === w ? "bg-orange-500" : "bg-gray-700"
                        }`}
                      >
                        W{w}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() =>
                        updateLineField(l.id, {
                          dash: (l.dash || l.style) === "dashed" ? "solid" : "dashed",
                          style: (l.dash || l.style) === "dashed" ? "solid" : "dashed",
                        })
                      }
                      className="px-1.5 py-0.5 rounded bg-gray-700"
                    >
                      {(l.dash || l.style) === "dashed" ? "- -" : "—"}
                    </button>
                    <div className="flex-1" />
                    <button
                      type="button"
                      onClick={() => {
                        setEditingNoteId(l.id);
                        setEditingNoteType("line");
                        setNoteDraft(l.note || "");
                      }}
                      className="text-gray-400 hover:text-white"
                    >
                      Note
                    </button>
                    <button
                      type="button"
                      onClick={() => startMove(l.id, "line")}
                      className="text-blue-400 hover:text-blue-300"
                    >
                      Move
                    </button>
                    <button
                      type="button"
                      onClick={() => convertLineToAlarm(l)}
                      className="text-green-400 hover:text-green-300"
                    >
                      Alarm
                    </button>
                    <button
                      type="button"
                      onClick={() => deleteLine(l.id)}
                      className="text-red-400 hover:text-red-300"
                    >
                      Delete
                    </button>
                  </div>
                  {editingNoteId === l.id && editingNoteType === "line" && (
                    <div className="mt-1.5 flex gap-2">
                      <input
                        value={noteDraft}
                        onChange={(e) => setNoteDraft(e.target.value)}
                        className="flex-1 bg-gray-900 rounded px-2 py-1"
                        placeholder="Note..."
                        autoFocus
                      />
                      <button type="button" onClick={saveNote} className="text-green-400">
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingNoteId(null);
                          setEditingNoteType(null);
                        }}
                        className="text-gray-500"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {!currentLines.length && (
                <p className="text-gray-500 text-sm">No lines</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Settings modals */}
      {smaSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setSmaSettings(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 w-72" onClick={(e) => e.stopPropagation()}>
            <h4 className="text-sm font-medium mb-3">3SMA Settings</h4>
            {[
              [sma1Str, setSma1Str, setSma1, smaColor1, setSmaColor1, "SMA1"],
              [sma2Str, setSma2Str, setSma2, smaColor2, setSmaColor2, "SMA2"],
              [sma3Str, setSma3Str, setSma3, smaColor3, setSmaColor3, "SMA3"],
            ].map(([str, setStr, setNum, col, setCol, label]: any) => (
              <div key={label} className="flex items-center gap-2 mb-2">
                <span className="text-xs w-10">{label}</span>
                <input
                  value={str}
                  onChange={(e) => setStr(e.target.value)}
                  onBlur={() => {
                    const n = parseInt(str, 10);
                    if (!Number.isNaN(n) && n > 0) setNum(n);
                  }}
                  className="flex-1 bg-gray-800 rounded px-2 py-1 text-xs"
                />
                <input type="color" value={col} onChange={(e) => setCol(e.target.value)} className="w-7 h-7" />
              </div>
            ))}
            <button type="button" onClick={() => setSmaSettings(false)} className="mt-2 w-full bg-orange-500 rounded py-1.5 text-xs">OK</button>
          </div>
        </div>
      )}
      {rsiSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setRsiSettings(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 w-64" onClick={(e) => e.stopPropagation()}>
            <h4 className="text-sm font-medium mb-3">RSI Settings</h4>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs w-14">Period</span>
              <input
                value={rsiPeriodStr}
                onChange={(e) => setRsiPeriodStr(e.target.value)}
                onBlur={() => {
                  const n = parseInt(rsiPeriodStr, 10);
                  if (!Number.isNaN(n) && n > 1) setRsiPeriod(n);
                }}
                className="flex-1 bg-gray-800 rounded px-2 py-1 text-xs"
              />
            </div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs w-14">Color</span>
              <input type="color" value={rsiColor} onChange={(e) => setRsiColor(e.target.value)} className="w-7 h-7" />
            </div>
            <button type="button" onClick={() => setRsiSettings(false)} className="mt-2 w-full bg-orange-500 rounded py-1.5 text-xs">OK</button>
          </div>
        </div>
      )}
      {dmiSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setDmiSettings(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 w-64" onClick={(e) => e.stopPropagation()}>
            <h4 className="text-sm font-medium mb-3">DMI Settings</h4>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs w-14">Period</span>
              <input
                value={dmiPeriodStr}
                onChange={(e) => setDmiPeriodStr(e.target.value)}
                onBlur={() => {
                  const n = parseInt(dmiPeriodStr, 10);
                  if (!Number.isNaN(n) && n > 1) setDmiPeriod(n);
                }}
                className="flex-1 bg-gray-800 rounded px-2 py-1 text-xs"
              />
            </div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs w-14">+DI</span>
              <input type="color" value={dmiPlusColor} onChange={(e) => setDmiPlusColor(e.target.value)} className="w-7 h-7" />
            </div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs w-14">-DI</span>
              <input type="color" value={dmiMinusColor} onChange={(e) => setDmiMinusColor(e.target.value)} className="w-7 h-7" />
            </div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs w-14">ADX</span>
              <input type="color" value={dmiAdxColor} onChange={(e) => setDmiAdxColor(e.target.value)} className="w-7 h-7" />
            </div>
            <button type="button" onClick={() => setDmiSettings(false)} className="mt-2 w-full bg-orange-500 rounded py-1.5 text-xs">OK</button>
          </div>
        </div>
      )}
      {pivotSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setPivotSettings(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 w-64" onClick={(e) => e.stopPropagation()}>
            <h4 className="text-sm font-medium mb-3">Pivot Settings</h4>
            <div className="flex flex-wrap gap-1 mb-2">
              {PIVOT_TFS.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setPivotTf(t.value)}
                  className={`px-2 py-1 rounded text-xs ${pivotTf === t.value ? "bg-orange-500" : "bg-gray-800"}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs mb-2">
              <input type="checkbox" checked={pivotFib} onChange={(e) => setPivotFib(e.target.checked)} />
              Fibonacci
            </label>
            <button type="button" onClick={() => setPivotSettings(false)} className="mt-2 w-full bg-orange-500 rounded py-1.5 text-xs">OK</button>
          </div>
        </div>
      )}
      {trendSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setTrendSettings(false)}>
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-4 w-64" onClick={(e) => e.stopPropagation()}>
            <h4 className="text-sm font-medium mb-3">Trend Settings</h4>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs w-14">Period</span>
              <input
                value={trendPeriodStr}
                onChange={(e) => setTrendPeriodStr(e.target.value)}
                onBlur={() => {
                  const n = parseInt(trendPeriodStr, 10);
                  if (!Number.isNaN(n) && n > 2) setTrendPeriod(n);
                }}
                className="flex-1 bg-gray-800 rounded px-2 py-1 text-xs"
              />
            </div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs w-14">Max</span>
              <input
                type="number"
                min={1}
                max={6}
                value={trendMax}
                onChange={(e) => setTrendMax(Math.max(1, Math.min(6, parseInt(e.target.value, 10) || 1)))}
                className="flex-1 bg-gray-800 rounded px-2 py-1 text-xs"
              />
            </div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs w-14">Up</span>
              <input type="color" value={trendUpColor} onChange={(e) => setTrendUpColor(e.target.value)} className="w-7 h-7" />
            </div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs w-14">Down</span>
              <input type="color" value={trendDownColor} onChange={(e) => setTrendDownColor(e.target.value)} className="w-7 h-7" />
            </div>
            <button type="button" onClick={() => setTrendSettings(false)} className="mt-2 w-full bg-orange-500 rounded py-1.5 text-xs">OK</button>
          </div>
        </div>
      )}
    </div>
  );
}

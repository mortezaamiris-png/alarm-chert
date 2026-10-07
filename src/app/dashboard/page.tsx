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

interface WatchList {
  id: string;
  name: string;
  created_at?: string;
}

interface WatchItem {
  id: string;
  list_id: string;
  symbol: string;
  note?: string | null;
  sort_order?: number | null;
  created_at?: string;
}

/** Built-in side-panel view: symbols that currently have active alarms */
const SIDE_VIEW_ALARMS = "__alarms__";

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
  { label: "Japan", value: "Asia/Tokyo" },
  { label: "Sydney", value: "Australia/Sydney" },
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

/** Format unix seconds in a given IANA timezone */
function formatInTz(
  unixSec: number,
  tz: string,
  opts: Intl.DateTimeFormatOptions
): string {
  try {
    return new Date(unixSec * 1000).toLocaleString("en-GB", {
      timeZone: tz,
      hour12: false,
      ...opts,
    });
  } catch {
    return new Date(unixSec * 1000).toLocaleString("en-GB", {
      hour12: false,
      ...opts,
    });
  }
}

function makeLocalization(tz: string) {
  return {
    locale: "en-US",
    timeFormatter: (time: number) => {
      const t = typeof time === "number" ? time : 0;
      return formatInTz(t, tz, {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    },
  };
}

function makeTickMarkFormatter(tz: string) {
  // TickMarkType: Year=0, Month=1, DayOfMonth=2, Time=3, TimeWithSeconds=4
  return (time: number, tickMarkType: number) => {
    const t = typeof time === "number" ? time : 0;
    if (tickMarkType <= 0) {
      return formatInTz(t, tz, { year: "numeric" });
    }
    if (tickMarkType === 1) {
      return formatInTz(t, tz, { month: "short", year: "2-digit" });
    }
    if (tickMarkType === 2) {
      return formatInTz(t, tz, { day: "2-digit", month: "short" });
    }
    if (tickMarkType === 4) {
      return formatInTz(t, tz, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    }
    return formatInTz(t, tz, { hour: "2-digit", minute: "2-digit" });
  };
}

function formatBarClock(unixSec: number, tz: string, withSeconds: boolean) {
  return formatInTz(
    unixSec,
    tz,
    withSeconds
      ? { hour: "2-digit", minute: "2-digit", second: "2-digit" }
      : { hour: "2-digit", minute: "2-digit" }
  );
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
  const lastPriceLineRef = useRef<IPriceLine | null>(null);
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
  const [showSideWl, setShowSideWl] = useState(() => loadLS("show_side_wl", true));
  const [statusMsg, setStatusMsg] = useState("");
  const [sideOrder, setSideOrder] = useState<string[]>(() => loadLS("side_order", []));
  const [draggingSym, setDraggingSym] = useState<string | null>(null);
  const [dragOverSym, setDragOverSym] = useState<string | null>(null);
  const [lastBarTime, setLastBarTime] = useState<number | null>(null);
  const [lastBarClose, setLastBarClose] = useState<number | null>(null);
  const [watchLists, setWatchLists] = useState<WatchList[]>([]);
  const [watchItems, setWatchItems] = useState<WatchItem[]>([]);
  const [sideViewId, setSideViewId] = useState<string>(() =>
    loadLS("side_view_id", SIDE_VIEW_ALARMS)
  );
  const tfMenuRef = useRef<HTMLDivElement>(null);

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
  useEffect(() => { saveLS("show_side_wl", showSideWl); }, [showSideWl]);
  useEffect(() => { saveLS("side_view_id", sideViewId); }, [sideViewId]);

  // If selected watchlist was deleted, fall back to alarms view
  useEffect(() => {
    if (sideViewId === SIDE_VIEW_ALARMS) return;
    if (watchLists.length && !watchLists.some((l) => l.id === sideViewId)) {
      setSideViewId(SIDE_VIEW_ALARMS);
    }
  }, [watchLists, sideViewId]);

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

  /** Symbols shown in the right side panel (alarms view or selected watchlist) */
  const sidePanelSymbols = useMemo(() => {
    if (sideViewId === SIDE_VIEW_ALARMS) return alarmSymbols;
    const listItems = watchItems
      .filter((i) => i.list_id === sideViewId)
      .sort((a, b) => (a.sort_order ?? 9999) - (b.sort_order ?? 9999));
    return listItems.map((i) => i.symbol.toUpperCase());
  }, [sideViewId, alarmSymbols, watchItems]);

  const sideViewLabel = useMemo(() => {
    if (sideViewId === SIDE_VIEW_ALARMS) return "With alarms";
    return watchLists.find((l) => l.id === sideViewId)?.name || "Watchlist";
  }, [sideViewId, watchLists]);

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

  const destroyChart = useCallback(() => {
    clearPreview();
    if (lastPriceLineRef.current && seriesRef.current) {
      try { seriesRef.current.removePriceLine(lastPriceLineRef.current); } catch {}
      lastPriceLineRef.current = null;
    }
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

  /** Last price + time on the native price axis (TradingView-style, stays fixed while scrolling) */
  const applyLastPriceLabel = useCallback(() => {
    const series = seriesRef.current;
    const candles = candlesRef.current;
    if (!series || !candles.length) return;
    const last = candles[candles.length - 1];
    if (!last || last.close == null || last.time == null) return;
    const up = last.close >= last.open;
    const color = up ? "#26a69a" : "#ef5350";
    const withSec = ["1", "5"].includes(String(intervalRef.current));
    const clock = formatBarClock(Number(last.time), timeZoneRef.current, withSec);
    try {
      if (lastPriceLineRef.current) {
        try { series.removePriceLine(lastPriceLineRef.current); } catch {}
        lastPriceLineRef.current = null;
      }
      lastPriceLineRef.current = series.createPriceLine({
        price: Number(last.close),
        color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: clock,
      });
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
    const lastTime = candles[candles.length - 1].time;
    const firstTime = candles[0].time;
    const extend = Math.max(1, Math.floor((lastTime - firstTime) * 0.15));

    currentLines.forEach((l) => {
      try {
        const isMoving = movingId === l.id && movingType === "line";
        const color = isMoving ? "#f59e0b" : l.color || DEFAULT_LINE_COLOR;
        const width = isMoving ? 3 : ((l.width as 1 | 2 | 3) || 2);
        const style = isMoving ? MOVE_STYLE : toLineStyle(l.dash || l.style);
        const title = isMoving
          ? "MOVING"
          : l.note
          ? `L ${l.note}`
          : `Line ${formatPrice(l.price)}`;
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
            axisLabelVisible: true, title,
          });
          alarmLinesRef.current.set(`line-${l.id}`, pl);
        }
      } catch {}
    });

    // فیکس ۳: نوت الارم روی چارت
    currentAlarms.forEach((a) => {
      try {
        const isMoving = movingId === a.id && movingType === "alarm";
        const color = isMoving ? "#f59e0b" : a.color || DEFAULT_ALARM_COLOR;
        const width = isMoving ? 3 : ((a.width as 1 | 2 | 3) || 2);
        const style = isMoving ? MOVE_STYLE : toLineStyle(a.dash);
        const title = isMoving
          ? "MOVING"
          : a.note
          ? `${getConditionSymbol(a.condition)} ${a.note}`
          : `Alarm ${getConditionSymbol(a.condition)} ${formatPrice(a.price)}`;
        const pl = series.createPriceLine({
          price: a.price, color, lineWidth: width, lineStyle: style,
          axisLabelVisible: true, title,
        });
        alarmLinesRef.current.set(`alarm-${a.id}`, pl);
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
    const s = chartRef.current.addLineSeries({
      color: rsiColor, lineWidth: 1, priceScaleId: "rsi",
      priceLineVisible: false, lastValueVisible: true,
    });
    s.setData(calcRSI(candlesRef.current, rsiPeriod) as any);
    rsiSeriesRef.current = s;
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
    const adxS = chartRef.current.addLineSeries({ color: dmiAdxColor, lineWidth: 1, priceScaleId: "dmi", priceLineVisible: false, lastValueVisible: false });
    plus.setData(plusDI as any);
    minus.setData(minusDI as any);
    adxS.setData(adx as any);
    dmiSeriesRef.current = { plus, minus, adx: adxS };
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
            { p: pp + (h - l), col: "#15803d", t: "R3" },
            { p: pp - 0.382 * (h - l), col: "#ef4444", t: "S1" },
            { p: pp - 0.618 * (h - l), col: "#dc2626", t: "S2" },
            { p: pp - (h - l), col: "#b91c1c", t: "S3" },
          ]
        : [
            { p: pp, col: "#eab308", t: "P" },
            { p: r1, col: "#22c55e", t: "R1" }, { p: r2, col: "#16a34a", t: "R2" }, { p: r3, col: "#15803d", t: "R3" },
            { p: s1, col: "#ef4444", t: "S1" }, { p: s2, col: "#dc2626", t: "S2" }, { p: s3, col: "#b91c1c", t: "S3" },
          ];
      const times = candlesRef.current.map((x: any) => x.time);
      levels.forEach(({ p, col, t }) => {
        const ls = chartRef.current!.addLineSeries({
          color: col, lineWidth: 1, lineStyle: LineStyle.Dashed,
          priceLineVisible: false, lastValueVisible: true, title: t,
        });
        ls.setData(times.map((tm: number) => ({ time: tm as any, value: p })));
        pivotSeriesRef.current.push(ls);
      });
    } catch {}
  }, [showPivot, pivotVisible, pivotTf, pivotFib, removePivot]);

  const removeTrend = useCallback(() => {
    trendSeriesRef.current.forEach((s) => { try { chartRef.current?.removeSeries(s); } catch {} });
    trendSeriesRef.current = [];
  }, []);
  const applyTrend = useCallback(() => {
    removeTrend();
    if (!showTrend || !trendVisible || !chartRef.current || !candlesRef.current.length) return;
    const candles = candlesRef.current;
    const period = Math.max(4, trendPeriod);
    const maxLines = Math.max(1, Math.min(5, trendMax));
    const { highs, lows } = findPivots(candles, period);
    const recentLows = lows.slice(-6);
    const recentHighs = highs.slice(-6);
    let upCount = 0;
    for (let i = 0; i < recentLows.length - 1 && upCount < maxLines; i++) {
      const a = recentLows[i], b = recentLows[i + 1];
      if (b.price <= a.price) continue;
      const slope = (b.price - a.price) / (b.index - a.index);
      let valid = true;
      for (let x = a.index + 1; x < candles.length; x++) {
        if (candles[x].low < (a.price + slope * (x - a.index)) * 0.998) { valid = false; break; }
      }
      if (!valid) continue;
      const endIdx = candles.length - 1;
      try {
        const ls = chartRef.current!.addLineSeries({ color: trendUpColor, lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
        ls.setData([
          { time: a.time as any, value: a.price },
          { time: candles[endIdx].time as any, value: a.price + slope * (endIdx - a.index) },
        ]);
        trendSeriesRef.current.push(ls);
        upCount++;
      } catch {}
    }
    let dnCount = 0;
    for (let i = 0; i < recentHighs.length - 1 && dnCount < maxLines; i++) {
      const a = recentHighs[i], b = recentHighs[i + 1];
      if (b.price >= a.price) continue;
      const slope = (b.price - a.price) / (b.index - a.index);
      let valid = true;
      for (let x = a.index + 1; x < candles.length; x++) {
        if (candles[x].high > (a.price + slope * (x - a.index)) * 1.002) { valid = false; break; }
      }
      if (!valid) continue;
      const endIdx = candles.length - 1;
      try {
        const ls = chartRef.current!.addLineSeries({ color: trendDownColor, lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
        ls.setData([
          { time: a.time as any, value: a.price },
          { time: candles[endIdx].time as any, value: a.price + slope * (endIdx - a.index) },
        ]);
        trendSeriesRef.current.push(ls);
        dnCount++;
      } catch {}
    }
  }, [showTrend, trendVisible, trendPeriod, trendMax, trendUpColor, trendDownColor, removeTrend]);

  const applyVolume = useCallback(() => {
    if (volumeSeriesRef.current && chartRef.current) {
      try { chartRef.current.removeSeries(volumeSeriesRef.current); } catch {}
      volumeSeriesRef.current = null;
    }
    if (!showVol || !volVisible || !chartRef.current || !candlesRef.current.length) {
      updateMargins();
      return;
    }
    const vol = chartRef.current.addHistogramSeries({
      priceScaleId: "volume", priceLineVisible: false, lastValueVisible: false,
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
    applySMA(); applyRSI(); applyDMI(); applyPivot(); applyTrend(); applyVolume();
  }, [applySMA, applyRSI, applyDMI, applyPivot, applyTrend, applyVolume]);

  const loadCandles = useCallback(async () => {
    const container = chartContainerRef.current;
    if (!container) return;
    destroyChart();
    setStatusMsg("Loading...");
    try {
      const res = await fetch(`/api/kline?symbol=${symbolRef.current}&interval=${intervalRef.current}&limit=500`);
      const raw = await res.json();
      let rows: any[] = Array.isArray(raw) ? raw : raw?.data || raw?.result?.list || raw?.candles || [];
      if (!rows.length) { setStatusMsg("No data"); return; }

      const candles = rows
        .map((r: any) => {
          const time = Math.floor(
            Number(r.time || r[0] || r.openTime || r.t) /
              (String(r.time || r[0] || "").length > 12 ? 1000 : 1)
          );
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
      const lastTime = candles[candles.length - 1]?.time ?? null;
      setLastBarClose(lastClose);
      setLastBarTime(lastTime);
      const { precision, minMove } = getPrecision(lastClose);
      const tz = timeZoneRef.current;
      const isIntraday = ["1", "5", "15"].includes(String(intervalRef.current));

      const chart = createChart(container, {
        layout: { background: { color: "#0b0e11" }, textColor: "#d1d5db", fontSize: 11 },
        grid: {
          vertLines: { color: "rgba(42,46,57,0.5)" },
          horzLines: { color: "rgba(42,46,57,0.5)" },
        },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: {
          borderColor: "#2a2e39",
          scaleMargins: { top: 0.05, bottom: 0.05 },
          entireTextOnly: false,
        },
        timeScale: {
          borderColor: "#2a2e39",
          timeVisible: true,
          secondsVisible: isIntraday,
          rightOffset: 18,
          barSpacing: 7,
          minBarSpacing: 3,
          fixLeftEdge: false,
          fixRightEdge: false,
          lockVisibleTimeRangeOnResize: true,
          tickMarkFormatter: makeTickMarkFormatter(tz) as any,
        },
        localization: makeLocalization(tz),
        width: container.clientWidth,
        height: container.clientHeight || 640,
      });
      chartRef.current = chart;
      const series = chart.addCandlestickSeries({
        upColor: "#22c55e", downColor: "#ef4444",
        borderUpColor: "#22c55e", borderDownColor: "#ef4444",
        wickUpColor: "#22c55e", wickDownColor: "#ef4444",
        priceFormat: { type: "price", precision, minMove },
        // Hide default last-value label; we render TradingView-style price+time badge ourselves
        lastValueVisible: false,
        priceLineVisible: true,
      });
      series.setData(candles as any);
      seriesRef.current = series;
      // Leave space on the right so time axis labels are fully visible (like TradingView)
      chart.timeScale().fitContent();
      try {
        chart.timeScale().scrollToRealTime();
      } catch {}
      // Extra right padding via visible logical range
      try {
        const lr = chart.timeScale().getVisibleLogicalRange();
        if (lr) {
          chart.timeScale().setVisibleLogicalRange({
            from: lr.from,
            to: lr.to + 8,
          });
        }
      } catch {}

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
          color: drawColorRef.current,
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
          try {
            if (typ === "line") {
              await supabase.from("chart_lines").update({ price: fp }).eq("id", id);
              setLines((prev) => prev.map((l) => (l.id === id ? { ...l, price: fp } : l)));
              setStatusMsg("Line moved");
            } else if (typ === "alarm") {
              await supabase.from("alarms").update({ price: fp }).eq("id", id);
              setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, price: fp } : a)));
              setStatusMsg("Alarm moved");
            }
          } catch {
            setStatusMsg("Move failed");
          }
          setMovingId(null);
          setMovingType(null);
          setMode("none");
          clearPreview();
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
            setLines((prev) => [{ ...(data as ChartLine), color: (data as any).color || base.color }, ...prev]);
            setStatusMsg("Line saved");
          } else setStatusMsg("Save failed");
          setSaving(false); clearPreview(); setMode("none");
          setTimeout(() => { clickLockRef.current = false; }, 300);
          return;
        }

        if (m === "alarm") {
          clickLockRef.current = true;
          setSaving(true);
          const chosenColor = drawColorRef.current || DEFAULT_ALARM_COLOR;
          const payload: any = {
            symbol: symbolRef.current.toUpperCase(),
            price: fp,
            condition: conditionRef.current,
            is_active: true,
            triggered: false,
            color: chosenColor,
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
            const saved = {
              ...(data as Alarm),
              color: (data as any).color || chosenColor,
              width: (data as any).width || payload.width,
              dash: (data as any).dash || payload.dash,
            };
            setAlarms((prev) => [saved, ...prev]);
            setStatusMsg("Alarm saved");
          } else setStatusMsg("Alarm save failed");
          setSaving(false); clearPreview(); setMode("none");
          setTimeout(() => { clickLockRef.current = false; }, 300);
        }
      });

      renderAllLinesAndAlarms();
      rebuildIndicators();
      // Native axis label for last price + bar time (does not float on scroll)
      applyLastPriceLabel();
      setStatusMsg("");
    } catch (e: any) {
      setStatusMsg(e?.message || "Load error");
    }
  }, [destroyChart, rebuildIndicators, renderAllLinesAndAlarms, clearPreview, applyLastPriceLabel]);

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

  // Apply timezone change live (without full reload)
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const isIntraday = ["1", "5", "15"].includes(String(intervalRef.current));
    try {
      chart.applyOptions({
        localization: makeLocalization(timeZone),
        timeScale: {
          secondsVisible: isIntraday,
          tickMarkFormatter: makeTickMarkFormatter(timeZone) as any,
        },
      });
    } catch {}
  }, [timeZone]);

  // Resize chart when side list is shown/hidden
  useEffect(() => {
    const t = setTimeout(() => {
      if (chartRef.current && chartContainerRef.current) {
        chartRef.current.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight || 640,
        });
      }
    }, 50);
    return () => clearTimeout(t);
  }, [showSideWl]);

  // Close TF/Time menu when clicking outside
  useEffect(() => {
    if (!tfMenuOpen) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const el = tfMenuRef.current;
      if (el && !el.contains(e.target as Node)) setTfMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [tfMenuOpen]);

  // Refresh last-price axis label when timezone changes (time text reformatted)
  useEffect(() => {
    applyLastPriceLabel();
  }, [timeZone, applyLastPriceLabel]);

  useEffect(() => {
    if (seriesRef.current && chartRef.current) renderAllLinesAndAlarms();
  }, [currentLines, currentAlarms, movingId, movingType, renderAllLinesAndAlarms]);

  useEffect(() => {
    rebuildIndicators();
  }, [
    showSMA, smaVisible, sma1, sma2, sma3, smaColor1, smaColor2, smaColor3,
    showRSI, rsiVisible, rsiPeriod, rsiColor,
    showDMI, dmiVisible, dmiPeriod, dmiPlusColor, dmiMinusColor, dmiAdxColor,
    showPivot, pivotVisible, pivotTf, pivotFib,
    showTrend, trendVisible, trendPeriod, trendMax, trendUpColor, trendDownColor,
    showVol, volVisible,
  ]);

  useEffect(() => {
    (async () => {
      const { data: a } = await supabase.from("alarms").select("*").order("created_at", { ascending: false });
      if (a) setAlarms(a as Alarm[]);
      const { data: l } = await supabase.from("chart_lines").select("*").order("created_at", { ascending: false });
      if (l) setLines(l as ChartLine[]);
      // Load all watchlists + items for the side panel
      const { data: wl } = await supabase
        .from("watchlist_lists")
        .select("*")
        .order("created_at", { ascending: true });
      if (wl) setWatchLists(wl as WatchList[]);
      const { data: wi } = await supabase
        .from("watchlist_items")
        .select("*")
        .order("sort_order", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: true });
      if (wi) setWatchItems(wi as WatchItem[]);
    })();
  }, []);

  // Refresh watchlist items periodically (in case user edits on Watchlist page)
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const { data: wl } = await supabase
          .from("watchlist_lists")
          .select("*")
          .order("created_at", { ascending: true });
        if (alive && wl) setWatchLists(wl as WatchList[]);
        const { data: wi } = await supabase
          .from("watchlist_items")
          .select("*")
          .order("sort_order", { ascending: true, nullsFirst: false })
          .order("created_at", { ascending: true });
        if (alive && wi) setWatchItems(wi as WatchItem[]);
      } catch {}
    };
    const id = window.setInterval(refresh, 15000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  /** Parse kline API rows into candle objects */
  const parseKlineRows = useCallback((rows: any[]) => {
    return rows
      .map((r: any) => {
        const time = Math.floor(
          Number(r.time || r[0] || r.openTime || r.t) /
            (String(r.time || r[0] || "").length > 12 ? 1000 : 1)
        );
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
  }, []);

  /** Live candle update without destroying the chart */
  const refreshLiveCandles = useCallback(async () => {
    const series = seriesRef.current;
    if (!series) return;
    try {
      const res = await fetch(
        `/api/kline?symbol=${symbolRef.current}&interval=${intervalRef.current}&limit=5`
      );
      const raw = await res.json();
      const rows: any[] = Array.isArray(raw) ? raw : raw?.data || raw?.result?.list || raw?.candles || [];
      if (!rows.length) return;
      const fresh = parseKlineRows(rows);
      if (!fresh.length) return;

      const candles = candlesRef.current;
      for (const c of fresh) {
        const idx = candles.findIndex((x: any) => x.time === c.time);
        if (idx >= 0) candles[idx] = c;
        else if (!candles.length || c.time > candles[candles.length - 1].time) candles.push(c);
        try {
          series.update(c as any);
        } catch {
          // if update fails (e.g. time gap), ignore; full reload on TF change handles it
        }
      }
      candlesRef.current = candles;

      const last = candles[candles.length - 1];
      if (last) {
        setLastBarClose(last.close);
        setLastBarTime(last.time);
        applyLastPriceLabel();
        // feed price into alarm cross check
        const sym = symbolRef.current.toUpperCase();
        const prev = prevPricesRef.current[sym];
        prevPricesRef.current[sym] = last.close;
        // also use high/low for more accurate cross detection on current bar
        return { last, prev, high: last.high, low: last.low };
      }
    } catch {}
    return null;
  }, [parseKlineRows, applyLastPriceLabel]);

  /** Mark alarm triggered in DB + local state (removes line from chart via currentAlarms filter) */
  const triggerAlarmLocal = useCallback(async (a: Alarm, price: number) => {
    setAlarms((p) =>
      p.map((x) =>
        x.id === a.id ? { ...x, triggered: true, is_active: false, last_price: price } : x
      )
    );
    try {
      await supabase
        .from("alarms")
        .update({ triggered: true, is_active: false, last_price: price })
        .eq("id", a.id);
    } catch {}
    if (!notifiedAlarmsRef.current.has(a.id)) {
      notifiedAlarmsRef.current.add(a.id);
      showLocalNotification(`${a.symbol}`, `Alarm hit @ ${a.price}  now ${price}`);
    }
  }, []);

  // Sync alarms from DB (Telegram / server triggers) + price cross + live candles
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      try {
        // 1) Sync ALL recent alarms from DB so Telegram-triggered ones clear on chart
        const { data: allAlarms } = await supabase
          .from("alarms")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(200);
        if (allAlarms && alive) {
          setAlarms((prev) => {
            const byId = new Map(allAlarms.map((a: any) => [a.id, a as Alarm]));
            // merge: prefer DB state for is_active / triggered
            const merged = prev.map((local) => {
              const db = byId.get(local.id);
              if (!db) return local;
              if (db.triggered && !local.triggered) {
                if (!notifiedAlarmsRef.current.has(local.id)) {
                  notifiedAlarmsRef.current.add(local.id);
                  showLocalNotification(`${db.symbol}`, `Alarm hit @ ${db.price}`);
                }
              }
              return {
                ...local,
                ...db,
                triggered: !!db.triggered,
                is_active: !!db.is_active && !db.triggered,
              };
            });
            // add any new alarms from DB not in local
            for (const db of allAlarms as Alarm[]) {
              if (!merged.some((m) => m.id === db.id)) merged.push(db);
            }
            return merged;
          });
        }

        // 2) Live candle for current symbol (no full chart rebuild)
        const live = await refreshLiveCandles();

        // 3) Cross-check active alarms vs ticker / last candle
        const { data: activeRows } = await supabase
          .from("alarms")
          .select("*")
          .eq("is_active", true)
          .eq("triggered", false);
        const stillActive = (activeRows || []) as Alarm[];
        const symbols = [...new Set(stillActive.map((a) => a.symbol.toUpperCase()))];

        for (const sym of symbols) {
          try {
            let price = 0;
            let high = 0;
            let low = 0;
            if (sym === symbolRef.current.toUpperCase() && live?.last) {
              price = live.last.close;
              high = live.high;
              low = live.low;
            } else {
              const res = await fetch(`/api/ticker?symbol=${sym}`);
              const j = await res.json();
              price = parseFloat(j?.price || j?.lastPrice || j?.data?.price || 0);
              high = price;
              low = price;
            }
            if (!price) continue;
            const prev = prevPricesRef.current[sym];
            prevPricesRef.current[sym] = price;

            for (const a of stillActive.filter((x) => x.symbol.toUpperCase() === sym)) {
              // cross on close OR candle wicked through the level
              const hitClose = didCross(a.condition, a.price, prev, price);
              const hitWick =
                a.condition === "above" || a.condition === "cross"
                  ? high >= a.price && (prev == null || prev < a.price || low <= a.price)
                  : a.condition === "below"
                  ? low <= a.price && (prev == null || prev > a.price || high >= a.price)
                  : false;
              const hitCrossWick =
                a.condition === "cross" &&
                ((high >= a.price && low <= a.price) || hitClose);

              if (hitClose || (a.condition === "cross" ? hitCrossWick : hitWick)) {
                await triggerAlarmLocal(a, price);
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
  }, [refreshLiveCandles, triggerAlarmLocal]);

  const deleteAlarm = async (id: string) => {
    setAlarms((prev) => prev.filter((a) => a.id !== id));
    await supabase.from("alarms").delete().eq("id", id);
  };
  const deleteLine = async (id: string) => {
    setLines((prev) => prev.filter((l) => l.id !== id));
    await supabase.from("chart_lines").delete().eq("id", id);
  };
  const updateAlarmCondition = async (id: string, condition: Alarm["condition"]) => {
    setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, condition } : a)));
    await supabase.from("alarms").update({ condition }).eq("id", id);
  };
  const updateAlarmColor = async (id: string, color: string) => {
    setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, color } : a)));
    await supabase.from("alarms").update({ color }).eq("id", id);
  };
  const updateAlarmWidth = async (id: string, width: number) => {
    setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, width } : a)));
    await supabase.from("alarms").update({ width }).eq("id", id);
  };
  const updateAlarmDash = async (id: string, dash: string) => {
    setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, dash } : a)));
    await supabase.from("alarms").update({ dash }).eq("id", id);
  };
  const updateLineColor = async (id: string, color: string) => {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, color } : l)));
    await supabase.from("chart_lines").update({ color }).eq("id", id);
  };
  const updateLineWidth = async (id: string, width: number) => {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, width } : l)));
    await supabase.from("chart_lines").update({ width }).eq("id", id);
  };
  const updateLineDash = async (id: string, dash: string) => {
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, dash } : l)));
    await supabase.from("chart_lines").update({ dash }).eq("id", id);
  };

  const convertLineToAlarm = async (line: ChartLine) => {
    try {
      const chosenColor = line.color || DEFAULT_LINE_COLOR;
      const payload: any = {
        symbol: line.symbol,
        price: line.price,
        condition: "cross",
        is_active: true,
        triggered: false,
        color: chosenColor,
        width: line.width || 2,
        dash: line.dash || "solid",
        note: line.note || null,
      };
      let { data, error } = await supabase.from("alarms").insert([payload]).select().single();
      if (error) {
        const minimal = {
          symbol: line.symbol, price: line.price, condition: "cross",
          is_active: true, triggered: false,
        };
        ({ data, error } = await supabase.from("alarms").insert([minimal]).select().single());
      }
      if (error || !data) {
        setStatusMsg("Convert failed");
        return;
      }
      const saved = {
        ...(data as Alarm),
        color: (data as any).color || chosenColor,
        width: (data as any).width || payload.width,
        dash: (data as any).dash || payload.dash,
        note: (data as any).note || payload.note,
      };
      setAlarms((prev) => [saved, ...prev]);
      await supabase.from("chart_lines").delete().eq("id", line.id);
      setLines((prev) => prev.filter((l) => l.id !== line.id));
      setStatusMsg("Converted to alarm");
    } catch {
      setStatusMsg("Convert error");
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
    setEditingNoteId(null);
    setEditingNoteType(null);
  };

  const goToSymbol = (sym: string) => setSymbol(sym);

  return (
    <div className="min-h-screen bg-[#0b0e11] text-gray-100 p-3">
      {/* Header — title left, controls right */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <h1 className="text-lg font-semibold text-gray-200 mr-2">Live Chart</h1>
        <div className="flex-1" />
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && loadCandles()}
          className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm w-28 font-mono"
        />
        <div className="flex items-center gap-1">
          {favTfButtons.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setIntervalTf(t.value)}
              className={`px-2 py-1 text-xs rounded ${
                interval === t.value ? "bg-orange-500 text-black" : "bg-gray-800 hover:bg-gray-700"
              }`}
            >
              {t.label}
            </button>
          ))}
          <div className="relative" ref={tfMenuRef}>
            <button
              type="button"
              onClick={() => setTfMenuOpen((v) => !v)}
              className={`px-2 py-1 text-xs rounded inline-flex items-center gap-1 transition-all duration-200 ${
                tfMenuOpen
                  ? "bg-orange-500 text-black shadow-md scale-105"
                  : "bg-gray-800 hover:bg-gray-700 text-gray-200"
              }`}
              title="Timeframes"
            >
              <span aria-hidden className="text-sm leading-none">🕐</span>
              <span>Time</span>
              <span className={`transition-transform duration-200 ${tfMenuOpen ? "rotate-180" : ""}`}>▾</span>
            </button>
            {tfMenuOpen && (
              <div
                className="absolute z-50 top-full right-0 mt-1 bg-gray-900 border border-gray-700 rounded-lg p-2 shadow-xl min-w-[140px] animate-in fade-in zoom-in-95 duration-150"
                style={{
                  animation: "tfPop 0.15s ease-out",
                }}
              >
                <style>{`@keyframes tfPop{from{opacity:0;transform:translateY(-6px) scale(0.96)}to{opacity:1;transform:translateY(0) scale(1)}}`}</style>
                {ALL_TIMEFRAMES.map((t) => (
                  <div key={t.value} className="flex items-center gap-2 py-1">
                    <button
                      type="button"
                      onClick={() => { setIntervalTf(t.value); setTfMenuOpen(false); }}
                      className={`flex-1 text-left px-2 py-1 rounded text-sm transition-colors ${
                        interval === t.value ? "bg-orange-500/30 text-orange-200" : "hover:bg-gray-800"
                      }`}
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
          </div>
        </div>
        {statusMsg && <span className="text-xs text-gray-400 ml-2">{statusMsg}</span>}
      </div>

      <div className="flex gap-2">
        {/* Left tools */}
        <div className="flex flex-col gap-1 shrink-0">
          {(
            [
              { mode: "draw" as ToolMode, icon: "✏️", label: "Line" },
              { mode: "ray" as ToolMode, icon: "➡️", label: "Ray" },
              { mode: "alarm" as ToolMode, icon: "🔔", label: "Alarm" },
            ] as const
          ).map((t) => (
            <button
              key={t.mode}
              type="button"
              title={t.label}
              onClick={() => {
                setMode(mode === t.mode ? "none" : t.mode);
                setMovingId(null);
                setMovingType(null);
              }}
              className={`w-9 h-9 rounded-lg flex flex-col items-center justify-center text-[10px] border ${
                mode === t.mode
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
        </div>

        {/* Chart */}
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
                    it.on ? "bg-orange-500/20 text-orange-300" : "hover:bg-gray-800"
                  }`}
                >
                  {it.on ? "✓ " : ""}{it.label}
                </button>
              ))}
            </div>
          )}

          {/* فیکس ۲: پنل رنگ/ضخامت — پایین چپ چارت */}
          {(mode === "draw" || mode === "ray" || mode === "alarm" || mode === "move") && (
            <div className="absolute bottom-10 left-3 z-20 bg-gray-900/95 border border-gray-700 rounded-xl px-3 py-2 shadow-xl flex items-center gap-2">
              <input
                type="color"
                value={drawColor}
                onChange={(e) => setDrawColor(e.target.value)}
                className="w-8 h-8 rounded cursor-pointer bg-transparent border-0"
                title="Color"
              />
              <div className="flex gap-1">
                {LINE_WIDTHS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => setDrawWidth(w)}
                    className={`w-7 h-7 rounded text-xs ${
                      drawWidth === w ? "bg-orange-500 text-black" : "bg-gray-800 text-gray-300"
                    }`}
                  >
                    {w}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setDrawDash((d) => (d === "solid" ? "dashed" : "solid"))}
                className="px-2 py-1 rounded text-xs bg-gray-800 text-gray-300"
              >
                {drawDash === "solid" ? "——" : "- -"}
              </button>
              {mode === "alarm" && (
                <select
                  value={condition}
                  onChange={(e) => setCondition(e.target.value as any)}
                  className="bg-gray-800 rounded px-1.5 py-1 text-xs"
                >
                  <option value="above">Above</option>
                  <option value="below">Below</option>
                  <option value="cross">Cross</option>
                </select>
              )}
              {previewPrice != null && (
                <span className="text-xs text-orange-300 font-mono">{formatPrice(previewPrice)}</span>
              )}
              {mode === "move" && (
                <span className="text-xs text-amber-400">Click chart</span>
              )}
            </div>
          )}

          {smaSettings && showSMA && (
            <div className="absolute top-2 left-28 z-20 bg-gray-900 border border-gray-700 rounded-xl p-3 shadow-xl w-52 text-sm">
              <p className="font-medium mb-2">SMA Settings</p>
              {[
                { str: sma1Str, setStr: setSma1Str, set: setSma1, col: smaColor1, setCol: setSmaColor1, label: "SMA1" },
                { str: sma2Str, setStr: setSma2Str, set: setSma2, col: smaColor2, setCol: setSmaColor2, label: "SMA2" },
                { str: sma3Str, setStr: setSma3Str, set: setSma3, col: smaColor3, setCol: setSmaColor3, label: "SMA3" },
              ].map((row) => (
                <div key={row.label} className="flex items-center gap-2 mb-1">
                  <span className="text-xs w-10">{row.label}</span>
                  <input value={row.str} onChange={(e) => row.setStr(e.target.value)}
                    onBlur={() => { const n = parseInt(row.str, 10); if (!Number.isNaN(n) && n > 0) row.set(n); }}
                    className="w-14 bg-gray-800 rounded px-1 py-0.5 text-xs" />
                  <input type="color" value={row.col} onChange={(e) => row.setCol(e.target.value)} className="w-6 h-6" />
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

          {/* Timezone selector under price scale (bottom-right of chart) */}
          <div className="absolute bottom-1 right-1 z-20">
            <select
              value={timeZone}
              onChange={(e) => setTimeZone(e.target.value)}
              className="bg-gray-900/95 border border-gray-600 rounded px-1.5 py-0.5 text-[10px] text-gray-200 cursor-pointer shadow"
              title="Chart timezone"
            >
              {TIMEZONES.map((z) => (
                <option key={z.value} value={z.value}>
                  {z.label}
                </option>
              ))}
            </select>
          </div>

          {/* Floating Show list when side panel is hidden */}
          {!showSideWl && (
            <button
              type="button"
              onClick={() => setShowSideWl(true)}
              className="absolute top-2 right-2 z-30 px-2.5 py-1.5 text-xs rounded-lg bg-orange-500 text-black font-medium shadow-lg hover:bg-orange-400 border border-orange-300"
              title="Show alarm list"
            >
              Show list »
            </button>
          )}
        </div>

        {showSideWl && (
          <div className="w-48 shrink-0 bg-gray-900/80 border border-gray-800 rounded-xl overflow-hidden flex flex-col" style={{ maxHeight: 640 }}>
            <div className="px-2 py-1.5 border-b border-gray-800 flex items-center justify-between gap-1">
              <select
                value={sideViewId}
                onChange={(e) => setSideViewId(e.target.value)}
                className="flex-1 min-w-0 bg-transparent text-xs text-gray-300 outline-none cursor-pointer truncate"
                title={sideViewLabel}
              >
                <option value={SIDE_VIEW_ALARMS}>With alarms</option>
                {watchLists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => setShowSideWl(false)} className="text-xs text-gray-500 hover:text-white shrink-0">
                « Hide
              </button>
            </div>
            <div className="overflow-y-auto flex-1 p-1.5">
              {sidePanelSymbols.map((sym) => {
                const isDrag = draggingSym === sym;
                const isOver = dragOverSym === sym && draggingSym != null && draggingSym !== sym;
                const canDrag = sideViewId === SIDE_VIEW_ALARMS;
                return (
                  <div key={sym}>
                    {isOver && canDrag && (
                      <div className="h-10 mb-1 rounded-lg border-2 border-dashed border-orange-500/60 bg-orange-500/10" />
                    )}
                    <div
                      data-sym={sym}
                      onPointerDown={(e) => {
                        if (!canDrag) return;
                        e.preventDefault();
                        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                        setDraggingSym(sym);
                        setDragOverSym(null);
                      }}
                      onPointerMove={(e) => {
                        if (!canDrag || !draggingSym) return;
                        const el = document.elementFromPoint(e.clientX, e.clientY);
                        const row = el?.closest?.("[data-sym]") as HTMLElement | null;
                        const target = row?.dataset?.sym || null;
                        if (target && target !== draggingSym) setDragOverSym(target);
                      }}
                      onPointerUp={() => {
                        if (canDrag && draggingSym && dragOverSym && draggingSym !== dragOverSym) {
                          setSideOrder((prev) => {
                            const base = (prev.length ? prev : alarmSymbols).filter((s) => s !== draggingSym);
                            const idx = base.indexOf(dragOverSym);
                            if (idx < 0) return [...base, draggingSym];
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
                      className={`flex items-center gap-1.5 px-1.5 py-1.5 mb-1 rounded-lg text-xs select-none transition-all duration-150 ${
                        canDrag ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
                      } ${
                        isDrag
                          ? "opacity-40 scale-[0.97] bg-orange-500/20 border border-orange-500 shadow-lg"
                          : symbolUpper === sym
                          ? "bg-orange-500/20 border border-orange-500/50"
                          : "hover:bg-gray-800 border border-transparent"
                      }`}
                      style={{ touchAction: canDrag ? "none" : "auto" }}
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
                  </div>
                );
              })}
              {!sidePanelSymbols.length && (
                <p className="text-gray-600 text-xs text-center py-4">
                  {sideViewId === SIDE_VIEW_ALARMS
                    ? "No active alarms"
                    : "Empty list — add symbols on Watchlist page"}
                </p>
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
                  <span className="font-mono font-medium min-w-[110px] shrink-0" style={{ color: a.color || DEFAULT_ALARM_COLOR }}>
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
                    <button
                      type="button"
                      onClick={() => {
                        setMode("move");
                        setMovingId(a.id);
                        setMovingType("alarm");
                        setStatusMsg("Click on chart to move alarm");
                      }}
                      className="text-xs text-blue-400"
                    >
                      Move
                    </button>
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
                  <span className="font-mono font-medium min-w-[110px] shrink-0" style={{ color: l.color || DEFAULT_LINE_COLOR }}>
                    {formatPrice(l.price)}
                  </span>
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
                    <button
                      type="button"
                      onClick={() => {
                        setMode("move");
                        setMovingId(l.id);
                        setMovingType("line");
                        setStatusMsg("Click on chart to move line");
                      }}
                      className="text-xs text-blue-400"
                    >
                      Move
                    </button>
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

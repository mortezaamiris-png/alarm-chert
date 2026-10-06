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
const MOVE_STYLE = LineStyle.SparseDotted;

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
/** گرد کردن قیمت برای قرار دادن دقیق‌تر آلارم */
function snapPrice(price: number) {
  const { precision } = getPrecision(price);
  const factor = Math.pow(10, precision);
  return Math.round(price * factor) / factor;
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

function playAlarmBeep() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.frequency.value = 880;
    o.type = "sine";
    g.gain.setValueAtTime(0.3, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
    o.start();
    o.stop(ctx.currentTime + 0.5);
    // beep دوم
    setTimeout(() => {
      try {
        const o2 = ctx.createOscillator();
        const g2 = ctx.createGain();
        o2.connect(g2);
        g2.connect(ctx.destination);
        o2.frequency.value = 1100;
        o2.type = "sine";
        g2.gain.setValueAtTime(0.3, ctx.currentTime);
        g2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
        o2.start();
        o2.stop(ctx.currentTime + 0.4);
      } catch {}
    }, 200);
  } catch {}
  try {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  } catch {}
}

function showLocalNotification(title: string, body: string) {
  playAlarmBeep();
  try {
    if (typeof Notification !== "undefined") {
      if (Notification.permission === "granted") {
        new Notification(title, {
          body,
          icon: "/icon-192.png",
          badge: "/icon-192.png",
          tag: "alarm-chert-" + Date.now(),
          requireInteraction: true,
        });
      }
    }
  } catch {}
}

function requestNotifyPermission() {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }
  } catch {}
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
  const [condition, setCondition] = useState<"above" | "below" | "cross">("cross");
  const [saving, setSaving] = useState(false);
  const [showIndicatorMenu, setShowIndicatorMenu] = useState(false);
  const [showSideWl, setShowSideWl] = useState(true);
  const [statusMsg, setStatusMsg] = useState("");
  const [sideOrder, setSideOrder] = useState<string[]>(() => loadLS("side_order", []));
  const [draggingSym, setDraggingSym] = useState<string | null>(null);
  const [dragOverSym, setDragOverSym] = useState<string | null>(null);
  const [notifyOn, setNotifyOn] = useState(false);

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
  const [trendMax, setTrendMax] = useState(() => loadLS("trend_max", 3));
  const [trendUpColor, setTrendUpColor] = useState(() => loadLS("trend_up", "#84cc16"));
  const [trendDownColor, setTrendDownColor] = useState(() => loadLS("trend_dn", "#ef4444"));

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
    saveLS("trend_p", trendPeriod); saveLS("trend_pivots", trendPivotCount);
    saveLS("trend_max", trendMax); saveLS("trend_up", trendUpColor);
    saveLS("trend_dn", trendDownColor);
  }, [showTrend, trendVisible, trendPeriod, trendPivotCount, trendMax, trendUpColor, trendDownColor]);

  // وضعیت نوتیفیکیشن
  useEffect(() => {
    try {
      if (typeof Notification !== "undefined") {
        setNotifyOn(Notification.permission === "granted");
      }
    } catch {}
  }, []);

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
      try { chartRef.current.remove(); } catch {}
      chartRef.current = null;
    }
    seriesRef.current = null;
    if (chartContainerRef.current) chartContainerRef.current.innerHTML = "";
  }, [clearPreview]);

  const renderAllLinesAndAlarms = useCallback(() => {
    if (!seriesRef.current || !chartRef.current) return;
    const series = seriesRef.current;
    const chart = chartRef.current;
    const candles = candlesRef.current;
    const lastTime = candles.length ? candles[candles.length - 1].time : undefined;
    const firstTime = candles.length ? candles[0].time : undefined;

    alarmLinesRef.current.forEach((pl) => {
      try { series.removePriceLine(pl); } catch {}
    });
    alarmLinesRef.current.clear();
    chartLinesRef.current.forEach((s) => {
      try { chart.removeSeries(s); } catch {}
    });
    chartLinesRef.current.clear();

    currentAlarms.forEach((a) => {
      const isMoving = movingId === a.id && movingType === "alarm";
      const color = a.color || DEFAULT_ALARM_COLOR;
      const width = isMoving ? 3 : (a.width || 2);
      const style = isMoving ? MOVE_STYLE : toLineStyle(a.dash);
      try {
        const pl = series.createPriceLine({
          price: a.price,
          color,
          lineWidth: width as any,
          lineStyle: style,
          axisLabelVisible: true,
          title: `Alarm ${getConditionSymbol(a.condition)} ${formatPrice(a.price)}`,
        });
        alarmLinesRef.current.set(a.id, pl);
      } catch {}
    });

    currentLines.forEach((l) => {
      const isMoving = movingId === l.id && movingType === "line";
      const color = l.color || DEFAULT_LINE_COLOR;
      const width = isMoving ? 3 : (l.width || 2);
      const style = isMoving ? MOVE_STYLE : toLineStyle(l.dash || l.style);
      try {
        if (l.start_time != null && lastTime != null) {
          const ls = chart.addLineSeries({
            color,
            lineWidth: width as any,
            lineStyle: style,
            priceLineVisible: false,
            lastValueVisible: true,
            crosshairMarkerVisible: false,
          });
          const startT = Math.max(l.start_time, firstTime || l.start_time);
          ls.setData([
            { time: startT as any, value: l.price },
            { time: lastTime as any, value: l.price },
          ]);
          chartLinesRef.current.set(l.id, ls);
        } else {
          const pl = series.createPriceLine({
            price: l.price,
            color,
            lineWidth: width as any,
            lineStyle: style,
            axisLabelVisible: true,
            title: `Line ${formatPrice(l.price)}`,
          });
          chartLinesRef.current.set(l.id, pl);
        }
      } catch {}
    });
  }, [currentAlarms, currentLines, movingId, movingType]);

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
    const c = candlesRef.current.map((x) => ({ time: x.time, close: x.close }));
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
    const c = candlesRef.current.map((x) => ({ time: x.time, close: x.close }));
    const data = calcRSI(c, rsiPeriod);
    const s = chartRef.current.addLineSeries({
      color: rsiColor, lineWidth: 1, priceScaleId: "rsi",
      priceLineVisible: false, lastValueVisible: true,
    });
    s.setData(data as any);
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
    const adxS = chartRef.current.addLineSeries({ color: dmiAdxColor, lineWidth: 1, priceScaleId: "dmi", priceLineVisible: false, lastValueVisible: true });
    plus.setData(plusDI as any);
    minus.setData(minusDI as any);
    adxS.setData(adx as any);
    dmiSeriesRef.current = { plus, minus, adx: adxS };
    updateMargins();
  }, [showDMI, dmiVisible, dmiPeriod, dmiPlusColor, dmiMinusColor, dmiAdxColor, removeDMI, updateMargins]);

  const removePivot = useCallback(() => {
    pivotSeriesRef.current.forEach((s) => {
      try { chartRef.current?.removeSeries(s); } catch {}
    });
    pivotSeriesRef.current = [];
  }, []);

  const applyPivot = useCallback(async () => {
    removePivot();
    if (!showPivot || !pivotVisible || !chartRef.current || !candlesRef.current.length) return;
    try {
      const res = await fetch(`/api/kline?symbol=${symbolRef.current}&interval=${pivotTf}&limit=5`);
      const raw = await res.json();
      let arr: any[] = Array.isArray(raw) ? raw : raw?.data || raw?.result?.list || [];
      if (!arr.length) return;
      const last = arr[arr.length - 2] || arr[arr.length - 1];
      const h = parseFloat(last.high ?? last[2]);
      const l = parseFloat(last.low ?? last[3]);
      const c = parseFloat(last.close ?? last[4]);
      if (!h || !l || !c) return;
      const pp = (h + l + c) / 3;
      const r1 = 2 * pp - l, s1 = 2 * pp - h;
      const r2 = pp + (h - l), s2 = pp - (h - l);
      const r3 = h + 2 * (pp - l), s3 = l - 2 * (h - pp);
      const levels = pivotFib
        ? [
            { p: pp, col: "#eab308" }, { p: r1, col: "#22c55e" }, { p: s1, col: "#ef4444" },
            { p: pp + 0.382 * (h - l), col: "#86efac" }, { p: pp - 0.382 * (h - l), col: "#fca5a5" },
            { p: r2, col: "#16a34a" }, { p: s2, col: "#dc2626" },
          ]
        : [
            { p: pp, col: "#eab308" }, { p: r1, col: "#22c55e" }, { p: s1, col: "#ef4444" },
            { p: r2, col: "#16a34a" }, { p: s2, col: "#dc2626" },
            { p: r3, col: "#15803d" }, { p: s3, col: "#b91c1c" },
          ];
      const times = candlesRef.current.map((x: any) => x.time);
      levels.forEach(({ p, col }) => {
        const s = chartRef.current!.addLineSeries({
          color: col, lineWidth: 1, lineStyle: LineStyle.Dashed,
          priceLineVisible: false, lastValueVisible: true,
        });
        s.setData(times.map((t: number) => ({ time: t as any, value: p })));
        pivotSeriesRef.current.push(s);
      });
    } catch (e) {
      console.error("pivot error", e);
    }
  }, [showPivot, pivotVisible, pivotTf, pivotFib, removePivot]);

  const removeTrend = useCallback(() => {
    trendSeriesRef.current.forEach((s) => {
      try { chartRef.current?.removeSeries(s); } catch {}
    });
    trendSeriesRef.current = [];
  }, []);

  const applyTrend = useCallback(() => {
    removeTrend();
    if (!showTrend || !trendVisible || !chartRef.current || candlesRef.current.length < 50) return;
    const candles = candlesRef.current;
    const period = Math.max(10, Math.min(50, trendPeriod || 24));
    const pivotCount = Math.max(2, Math.min(10, trendPivotCount || 6));
    const maxLines = Math.max(1, Math.min(6, trendMax || 3));
    const { highs, lows } = findPivots(candles, period);
    const topPivots = highs.slice(-pivotCount);
    const botPivots = lows.slice(-pivotCount);
    const lastIdx = candles.length - 1;
    let drawnUp = 0, drawnDn = 0;

    for (let i = 0; i < botPivots.length - 1 && drawnUp < maxLines; i++) {
      for (let j = i + 1; j < botPivots.length && drawnUp < maxLines; j++) {
        const p1 = botPivots[i], p2 = botPivots[j];
        if (p1.price >= p2.price) continue;
        const slope = (p2.price - p1.price) / (p2.index - p1.index);
        const endPrice = p2.price + slope * (lastIdx - p2.index);
        try {
          const s = chartRef.current!.addLineSeries({
            color: trendUpColor, lineWidth: 2,
            priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
          });
          s.setData([
            { time: p1.time as any, value: p1.price },
            { time: candles[lastIdx].time as any, value: endPrice },
          ]);
          trendSeriesRef.current.push(s);
          drawnUp++;
        } catch {}
      }
    }
    for (let i = 0; i < topPivots.length - 1 && drawnDn < maxLines; i++) {
      for (let j = i + 1; j < topPivots.length && drawnDn < maxLines; j++) {
        const p1 = topPivots[i], p2 = topPivots[j];
        if (p1.price <= p2.price) continue;
        const slope = (p2.price - p1.price) / (p2.index - p1.index);
        const endPrice = p2.price + slope * (lastIdx - p2.index);
        try {
          const s = chartRef.current!.addLineSeries({
            color: trendDownColor, lineWidth: 2,
            priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
          });
          s.setData([
            { time: p1.time as any, value: p1.price },
            { time: candles[lastIdx].time as any, value: endPrice },
          ]);
          trendSeriesRef.current.push(s);
          drawnDn++;
        } catch {}
      }
    }
  }, [showTrend, trendVisible, trendPeriod, trendPivotCount, trendMax, trendUpColor, trendDownColor, removeTrend]);

  const removeVolume = useCallback(() => {
    if (volumeSeriesRef.current && chartRef.current) {
      try { chartRef.current.removeSeries(volumeSeriesRef.current); } catch {}
      volumeSeriesRef.current = null;
    }
  }, []);

  const applyVolume = useCallback(() => {
    removeVolume();
    if (!showVol || !volVisible || !chartRef.current || !candlesRef.current.length) return;
    const data = candlesRef.current.map((c: any) => ({
      time: c.time,
      value: c.volume || 0,
      color: c.close >= c.open ? "rgba(34,197,94,0.5)" : "rgba(239,68,68,0.5)",
    }));
    const s = chartRef.current.addHistogramSeries({
      priceScaleId: "volume", priceLineVisible: false, lastValueVisible: false,
    });
    s.setData(data as any);
    volumeSeriesRef.current = s;
    updateMargins();
  }, [showVol, volVisible, removeVolume, updateMargins]);

  const rebuildIndicators = useCallback(() => {
    applySMA(); applyRSI(); applyDMI(); applyPivot(); applyTrend(); applyVolume();
  }, [applySMA, applyRSI, applyDMI, applyPivot, applyTrend, applyVolume]);

  const loadCandles = useCallback(async () => {
    if (!chartContainerRef.current) return;
    destroyChart();
    setStatusMsg("Loading...");
    try {
      const res = await fetch(`/api/kline?symbol=${symbolRef.current}&interval=${intervalRef.current}&limit=300`);
      const raw = await res.json();
      let arr: any[] = [];
      if (Array.isArray(raw)) arr = raw;
      else if (Array.isArray(raw?.data)) arr = raw.data;
      else if (Array.isArray(raw?.result?.list)) arr = raw.result.list;
      else if (Array.isArray(raw?.candles)) arr = raw.candles;
      if (!arr.length) { setStatusMsg("No data"); return; }

      const candles = arr
        .map((item: any) => {
          const t = item.time ?? item[0];
          const time = typeof t === "number" ? (t > 1e12 ? Math.floor(t / 1000) : t) : Math.floor(new Date(t).getTime() / 1000);
          return {
            time,
            open: parseFloat(item.open ?? item[1]),
            high: parseFloat(item.high ?? item[2]),
            low: parseFloat(item.low ?? item[3]),
            close: parseFloat(item.close ?? item[4]),
            volume: parseFloat(item.volume ?? item[5] ?? 0),
          };
        })
        .filter((c: any) => !isNaN(c.open) && !isNaN(c.close))
        .sort((a: any, b: any) => a.time - b.time);

      if (!candles.length) { setStatusMsg("No data"); return; }
      candlesRef.current = candles;
      const lastPrice = candles[candles.length - 1].close;
      const { precision, minMove } = getPrecision(lastPrice);

      const chart = createChart(chartContainerRef.current, {
        autoSize: true,
        layout: { background: { color: "#0f0f0f" }, textColor: "#d1d5db" },
        grid: {
          vertLines: { color: "rgba(42,46,57,0.6)" },
          horzLines: { color: "rgba(42,46,57,0.6)" },
        },
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: { borderColor: "#2a2e39", scaleMargins: { top: 0.05, bottom: 0.15 } },
        timeScale: { borderColor: "#2a2e39", timeVisible: true, secondsVisible: false },
        localization: { locale: "en-US" },
      });
      chartRef.current = chart;
      const series = chart.addCandlestickSeries({
        upColor: "#22c55e", downColor: "#ef4444",
        borderUpColor: "#22c55e", borderDownColor: "#ef4444",
        wickUpColor: "#22c55e", wickDownColor: "#ef4444",
        priceFormat: { type: "price", precision, minMove },
      });
      seriesRef.current = series;
      series.setData(candles as any);
      chart.timeScale().fitContent();

      chart.subscribeCrosshairMove((param) => {
        if (modeRef.current === "none" || modeRef.current === "move") return;
        if (!param.point || !seriesRef.current) return;
        const rawPrice = seriesRef.current.coordinateToPrice(param.point.y);
        if (rawPrice == null) return;
        const price = snapPrice(rawPrice);
        setPreviewPrice(price);
        if (previewLineRef.current) {
          try { seriesRef.current.removePriceLine(previewLineRef.current); } catch {}
        }
        previewLineRef.current = seriesRef.current.createPriceLine({
          price,
          color: modeRef.current === "alarm" ? drawColorRef.current : drawColorRef.current,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: formatPrice(price).toString(),
        });
      });

      chart.subscribeClick(async (param) => {
        if (clickLockRef.current) return;
        if (!param.point || !seriesRef.current) return;
        const rawPrice = seriesRef.current.coordinateToPrice(param.point.y);
        if (rawPrice == null) return;
        const price = snapPrice(rawPrice);
        const m = modeRef.current;

        if (m === "move" && movingIdRef.current && movingTypeRef.current) {
          clickLockRef.current = true;
          setSaving(true);
          const id = movingIdRef.current;
          const type = movingTypeRef.current;
          try {
            if (type === "alarm") {
              await supabase.from("alarms").update({ price }).eq("id", id);
              setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, price } : a)));
              setStatusMsg("Alarm moved");
            } else {
              await supabase.from("chart_lines").update({ price }).eq("id", id);
              setLines((prev) => prev.map((l) => (l.id === id ? { ...l, price } : l)));
              setStatusMsg("Line moved");
            }
          } catch (e) {
            console.error(e);
            setStatusMsg("Move failed");
          }
          setMovingId(null);
          setMovingType(null);
          setMode("none");
          clearPreview();
          setSaving(false);
          setTimeout(() => { clickLockRef.current = false; }, 300);
          return;
        }

        if (m === "draw" || m === "ray") {
          clickLockRef.current = true;
          setSaving(true);
          const payload: any = {
            symbol: symbolRef.current,
            price,
            color: drawColorRef.current,
            width: drawWidthRef.current,
            dash: drawDashRef.current,
            style: drawDashRef.current,
          };
          if (m === "ray" && param.time) {
            payload.start_time = typeof param.time === "number" ? param.time : Math.floor(Date.now() / 1000);
          }
          try {
            const { data, error } = await supabase.from("chart_lines").insert(payload).select().single();
            if (error) throw error;
            setLines((prev) => [...prev, data as ChartLine]);
            setStatusMsg("Line saved");
          } catch (e) {
            console.error(e);
            setStatusMsg("Save failed");
          }
          setMode("none");
          clearPreview();
          setSaving(false);
          setTimeout(() => { clickLockRef.current = false; }, 300);
          return;
        }

        if (m === "alarm") {
          clickLockRef.current = true;
          setSaving(true);
          const payload = {
            symbol: symbolRef.current,
            price,
            condition: conditionRef.current,
            is_active: true,
            triggered: false,
            color: drawColorRef.current,
            width: drawWidthRef.current,
            dash: drawDashRef.current,
          };
          try {
            const { data, error } = await supabase.from("alarms").insert(payload).select().single();
            if (error) throw error;
            setAlarms((prev) => [data as Alarm, ...prev]);
            setStatusMsg("Alarm saved");
          } catch (e) {
            console.error(e);
            setStatusMsg("Save failed");
          }
          setMode("none");
          clearPreview();
          setSaving(false);
          setTimeout(() => { clickLockRef.current = false; }, 300);
        }
      });

      renderAllLinesAndAlarms();
      rebuildIndicators();
      setStatusMsg("");
    } catch (e: any) {
      console.error(e);
      setStatusMsg("Load error");
    }
  }, [destroyChart, clearPreview, renderAllLinesAndAlarms, rebuildIndicators]);

  useEffect(() => {
    loadCandles();
    return () => destroyChart();
  }, [symbol, interval]); // eslint-disable-line

  useEffect(() => {
    renderAllLinesAndAlarms();
  }, [currentAlarms, currentLines, movingId, movingType, renderAllLinesAndAlarms]);

  useEffect(() => {
    rebuildIndicators();
  }, [showSMA, smaVisible, sma1, sma2, sma3, smaColor1, smaColor2, smaColor3,
      showRSI, rsiVisible, rsiPeriod, rsiColor,
      showDMI, dmiVisible, dmiPeriod, dmiPlusColor, dmiMinusColor, dmiAdxColor,
      showPivot, pivotVisible, pivotTf, pivotFib,
      showTrend, trendVisible, trendPeriod, trendPivotCount, trendMax, trendUpColor, trendDownColor,
      showVol, volVisible, rebuildIndicators]);

  // بارگذاری اولیه از Supabase
  useEffect(() => {
    (async () => {
      const { data: a } = await supabase.from("alarms").select("*").order("created_at", { ascending: false });
      if (a) setAlarms(a as Alarm[]);
      const { data: l } = await supabase.from("chart_lines").select("*").order("created_at", { ascending: false });
      if (l) setLines(l as ChartLine[]);
    })();
  }, []);

  // چک آلارم — سریع‌تر (هر ۴ ثانیه) + همگام‌سازی با دیتابیس بعد از تریگر تلگرام
  useEffect(() => {
    const tick = async () => {
      // همگام‌سازی با دیتابیس برای آلارم‌هایی که از تلگرام تریگر شده‌اند
      try {
        const { data: fresh } = await supabase
          .from("alarms")
          .select("id, triggered, is_active")
          .eq("is_active", true);
        if (fresh) {
          const triggeredIds = new Set(
            fresh.filter((r: any) => r.triggered || !r.is_active).map((r: any) => r.id)
          );
          // همچنین آلارم‌هایی که در دیتابیس دیگر active نیستند
          const { data: allActive } = await supabase
            .from("alarms")
            .select("id")
            .eq("is_active", true)
            .eq("triggered", false);
          const stillActive = new Set((allActive || []).map((r: any) => r.id));
          setAlarms((prev) =>
            prev.map((a) => {
              if (a.is_active && !a.triggered && !stillActive.has(a.id)) {
                return { ...a, triggered: true, is_active: false };
              }
              return a;
            })
          );
        }
      } catch {}

      const active = alarmsRef.current.filter((a) => a.is_active && !a.triggered);
      if (!active.length) return;
      const symbols = [...new Set(active.map((a) => a.symbol))];
      for (const sym of symbols) {
        try {
          const res = await fetch(`/api/ticker?symbol=${sym}`);
          const data = await res.json();
          const price = parseFloat(data?.price ?? data?.lastPrice ?? data?.result?.list?.[0]?.lastPrice);
          if (!price || isNaN(price)) continue;
          const prev = prevPricesRef.current[sym];
          prevPricesRef.current[sym] = price;
          for (const alarm of active.filter((a) => a.symbol === sym)) {
            if (notifiedAlarmsRef.current.has(alarm.id)) continue;
            if (didCross(alarm.condition, alarm.price, prev, price)) {
              notifiedAlarmsRef.current.add(alarm.id);
              showLocalNotification(
                `${sym} Alarm`,
                `Price ${formatPrice(price)} → Target ${formatPrice(alarm.price)} (${getConditionLabel(alarm.condition)})`
              );
              await supabase.from("alarms").update({ triggered: true, is_active: false }).eq("id", alarm.id);
              setAlarms((prev) =>
                prev.map((a) => (a.id === alarm.id ? { ...a, triggered: true, is_active: false } : a))
              );
            }
          }
        } catch {}
      }
    };
    const id = setInterval(tick, 4000);
    tick();
    return () => clearInterval(id);
  }, []);

  const convertLineToAlarm = async (line: ChartLine) => {
    setSaving(true);
    try {
      const payload = {
        symbol: line.symbol,
        price: line.price,
        condition: "cross" as const,
        is_active: true,
        triggered: false,
        color: line.color || DEFAULT_LINE_COLOR,
        width: line.width || 2,
        dash: line.dash || line.style || "solid",
        note: line.note || null,
      };
      const { data, error } = await supabase.from("alarms").insert(payload).select().single();
      if (error) throw error;
      setAlarms((prev) => [data as Alarm, ...prev]);
      await supabase.from("chart_lines").delete().eq("id", line.id);
      setLines((prev) => prev.filter((l) => l.id !== line.id));
      setStatusMsg("Converted to alarm");
    } catch (e) {
      console.error(e);
      setStatusMsg("Convert failed");
    }
    setSaving(false);
  };

  const startMove = (id: string, type: "line" | "alarm") => {
    setMovingId(id);
    setMovingType(type);
    setMode("move");
    setStatusMsg("Click on chart to set new price");
  };

  const deleteAlarm = async (id: string) => {
    await supabase.from("alarms").delete().eq("id", id);
    setAlarms((prev) => prev.filter((a) => a.id !== id));
  };
  const deleteLine = async (id: string) => {
    await supabase.from("chart_lines").delete().eq("id", id);
    setLines((prev) => prev.filter((l) => l.id !== id));
  };

  const updateAlarmField = async (id: string, fields: Partial<Alarm>) => {
    await supabase.from("alarms").update(fields).eq("id", id);
    setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, ...fields } : a)));
  };
  const updateLineField = async (id: string, fields: Partial<ChartLine>) => {
    await supabase.from("chart_lines").update(fields).eq("id", id);
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...fields } : l)));
  };

  const startEditNote = (id: string, type: "line" | "alarm", current?: string | null) => {
    setEditingNoteId(id);
    setEditingNoteType(type);
    setNoteDraft(current || "");
  };
  const saveNote = async () => {
    if (!editingNoteId || !editingNoteType) return;
    if (editingNoteType === "alarm") await updateAlarmField(editingNoteId, { note: noteDraft });
    else await updateLineField(editingNoteId, { note: noteDraft });
    setEditingNoteId(null);
    setEditingNoteType(null);
  };

  const onSidePointerDown = (e: React.PointerEvent, sym: string) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDraggingSym(sym);
  };
  const onSidePointerMove = (e: React.PointerEvent) => {
    if (!draggingSym) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const row = el?.closest("[data-sym]") as HTMLElement | null;
    if (row?.dataset.sym) setDragOverSym(row.dataset.sym);
  };
  const onSidePointerUp = () => {
    if (draggingSym && dragOverSym && draggingSym !== dragOverSym) {
      setSideOrder((prev) => {
        const list = [...(prev.length ? prev : alarmSymbols)];
        const from = list.indexOf(draggingSym);
        const to = list.indexOf(dragOverSym);
        if (from === -1 || to === -1) return prev;
        list.splice(from, 1);
        list.splice(to, 0, draggingSym);
        return list;
      });
    }
    setDraggingSym(null);
    setDragOverSym(null);
  };

  const handleNotifyClick = () => {
    requestNotifyPermission();
    try {
      if (typeof Notification !== "undefined") {
        if (Notification.permission === "granted") {
          setNotifyOn(true);
          showLocalNotification("Alarm Chert", "Notifications enabled");
        } else {
          Notification.requestPermission().then((p) => {
            setNotifyOn(p === "granted");
            if (p === "granted") showLocalNotification("Alarm Chert", "Notifications enabled");
          });
        }
      }
    } catch {}
  };

  return (
    <div className="min-h-screen bg-[#0f0f0f] text-gray-100">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
        <div className="flex items-center gap-2">
          <span className="text-lg font-semibold">Live Chart</span>
          {statusMsg && <span className="text-xs text-orange-400">{statusMsg}</span>}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleNotifyClick}
            className={`text-xs rounded px-2 py-1 border ${notifyOn ? "bg-green-700 border-green-600" : "bg-gray-800 border-gray-700"}`}
          >
            {notifyOn ? "🔔 On" : "🔔 Notify"}
          </button>
          <select
            value={timeZone}
            onChange={(e) => setTimeZone(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs"
          >
            {TIMEZONES.map((tz) => (
              <option key={tz.value} value={tz.value}>{tz.label}</option>
            ))}
          </select>
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && loadCandles()}
            className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-sm w-28"
          />
          <button
            type="button"
            onClick={() => setShowSideWl((v) => !v)}
            className="text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1"
          >
            {showSideWl ? "Hide List" : "Show List"}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-800 flex-wrap">
        {favTfButtons.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => setIntervalTf(t.value)}
            className={`px-2 py-0.5 rounded text-xs ${interval === t.value ? "bg-orange-500 text-white" : "bg-gray-800 text-gray-300"}`}
          >
            {t.label}
          </button>
        ))}
        <div className="relative">
          <button type="button" onClick={() => setTfMenuOpen((v) => !v)} className="px-2 py-0.5 rounded text-xs bg-gray-800">
            TF ▾
          </button>
          {tfMenuOpen && (
            <div className="absolute top-full left-0 mt-1 bg-gray-900 border border-gray-700 rounded shadow-xl z-50 p-2 min-w-[120px]">
              {ALL_TIMEFRAMES.map((t) => (
                <div key={t.value} className="flex items-center justify-between gap-2 py-0.5">
                  <button type="button" onClick={() => { setIntervalTf(t.value); setTfMenuOpen(false); }} className="text-xs hover:text-orange-400">
                    {t.label}
                  </button>
                  <button type="button" onClick={() => toggleFavTf(t.value)} className="text-xs">
                    {favTfs.includes(t.value) ? "★" : "☆"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex" style={{ height: "calc(100vh - 110px)" }}>
        <div className="flex flex-col items-center gap-1 p-1.5 border-r border-gray-800 bg-[#111] w-11">
          {(["draw", "ray", "alarm"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(mode === m ? "none" : m); clearPreview(); }}
              className={`w-9 h-9 rounded flex items-center justify-center text-[10px] ${mode === m ? "bg-orange-500 text-white" : "bg-gray-800 text-gray-300"}`}
              title={m}
            >
              {m === "draw" ? "Line" : m === "ray" ? "Ray" : "Alarm"}
            </button>
          ))}
          <div className="w-full border-t border-gray-700 my-1" />
          <button
            type="button"
            onClick={() => setShowIndicatorMenu((v) => !v)}
            className={`w-9 h-9 rounded flex items-center justify-center text-[10px] ${showIndicatorMenu ? "bg-orange-500 text-white" : "bg-gray-800 text-gray-300"}`}
          >
            Ind
          </button>
          <div className="flex flex-col gap-0.5 mt-1">
            {LINE_WIDTHS.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setDrawWidth(w)}
                className={`w-9 h-5 rounded text-[10px] ${drawWidth === w ? "bg-orange-600" : "bg-gray-800"}`}
              >
                W{w}
              </button>
            ))}
          </div>
          <input
            type="color"
            value={drawColor}
            onChange={(e) => setDrawColor(e.target.value)}
            className="w-8 h-6 mt-1 cursor-pointer bg-transparent border-0"
          />
          <button
            type="button"
            onClick={() => setDrawDash((d) => (d === "solid" ? "dashed" : "solid"))}
            className="w-9 h-6 mt-1 rounded text-[10px] bg-gray-800"
            title="Dash"
          >
            {drawDash === "dashed" ? "---" : "━━"}
          </button>
          {/* شرط آلارم */}
          <select
            value={condition}
            onChange={(e) => setCondition(e.target.value as any)}
            className="w-9 mt-1 bg-gray-800 text-[9px] rounded py-0.5"
            title="Condition"
          >
            <option value="cross">≈</option>
            <option value="above">≥</option>
            <option value="below">≤</option>
          </select>
        </div>

        <div className="flex-1 relative min-w-0">
          <div className="absolute top-2 right-2 z-20 flex flex-wrap gap-1 justify-end max-w-[70%]">
            {showSMA && (
              <IndChip label="3SMA" visible={smaVisible} onToggleVisible={() => setSmaVisible((v) => !v)}
                onSettings={() => setSmaSettings(true)} onRemove={() => { setShowSMA(false); removeSMA(); }} />
            )}
            {showPivot && (
              <IndChip label="Pivot" visible={pivotVisible} onToggleVisible={() => setPivotVisible((v) => !v)}
                onSettings={() => setPivotSettings(true)} onRemove={() => { setShowPivot(false); removePivot(); }} />
            )}
            {showTrend && (
              <IndChip label="Trend" visible={trendVisible} onToggleVisible={() => setTrendVisible((v) => !v)}
                onSettings={() => setTrendSettings(true)} onRemove={() => { setShowTrend(false); removeTrend(); }} />
            )}
            {showRSI && (
              <IndChip label="RSI" visible={rsiVisible} onToggleVisible={() => setRsiVisible((v) => !v)}
                onSettings={() => setRsiSettings(true)} onRemove={() => { setShowRSI(false); removeRSI(); }} />
            )}
            {showDMI && (
              <IndChip label="DMI" visible={dmiVisible} onToggleVisible={() => setDmiVisible((v) => !v)}
                onSettings={() => setDmiSettings(true)} onRemove={() => { setShowDMI(false); removeDMI(); }} />
            )}
            {showVol && (
              <IndChip label="Vol" visible={volVisible} onToggleVisible={() => setVolVisible((v) => !v)}
                onRemove={() => { setShowVol(false); removeVolume(); }} />
            )}
          </div>

          {showIndicatorMenu && (
            <div className="absolute top-10 left-2 z-30 bg-gray-900 border border-gray-700 rounded-lg p-2 shadow-xl text-sm space-y-1 min-w-[140px]">
              {[
                { k: "sma", label: "3SMA", show: showSMA, set: setShowSMA },
                { k: "pivot", label: "Pivot", show: showPivot, set: setShowPivot },
                { k: "trend", label: "Trend", show: showTrend, set: setShowTrend },
                { k: "rsi", label: "RSI", show: showRSI, set: setShowRSI },
                { k: "dmi", label: "DMI", show: showDMI, set: setShowDMI },
                { k: "vol", label: "Volume", show: showVol, set: setShowVol },
              ].map((item) => (
                <button key={item.k} type="button" onClick={() => item.set((v) => !v)}
                  className={`w-full text-left px-2 py-1 rounded ${item.show ? "bg-orange-600/40" : "hover:bg-gray-800"}`}>
                  {item.show ? "✓ " : ""}{item.label}
                </button>
              ))}
            </div>
          )}

          {trendSettings && (
            <div className="absolute top-12 right-2 z-40 bg-gray-900 border border-gray-700 rounded-lg p-3 shadow-xl text-sm w-52">
              <div className="font-medium mb-2">Trend Settings</div>
              <label className="block text-xs text-gray-400 mb-1">Period (Pivot)</label>
              <input type="number" value={trendPeriodStr}
                onChange={(e) => setTrendPeriodStr(e.target.value)}
                onBlur={() => { const n = parseInt(trendPeriodStr) || 24; setTrendPeriod(Math.max(10, Math.min(50, n))); setTrendPeriodStr(String(Math.max(10, Math.min(50, n)))); }}
                className="w-full bg-gray-800 rounded px-2 py-1 mb-2 text-sm" />
              <label className="block text-xs text-gray-400 mb-1">Number of Pivots</label>
              <input type="number" value={trendPivotCountStr}
                onChange={(e) => setTrendPivotCountStr(e.target.value)}
                onBlur={() => { const n = parseInt(trendPivotCountStr) || 6; setTrendPivotCount(Math.max(2, Math.min(10, n))); setTrendPivotCountStr(String(Math.max(2, Math.min(10, n)))); }}
                className="w-full bg-gray-800 rounded px-2 py-1 mb-2 text-sm" />
              <label className="block text-xs text-gray-400 mb-1">Max Lines</label>
              <input type="number" value={trendMax}
                onChange={(e) => setTrendMax(Math.max(1, Math.min(6, parseInt(e.target.value) || 3)))}
                className="w-full bg-gray-800 rounded px-2 py-1 mb-2 text-sm" />
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs">Up</span>
                <input type="color" value={trendUpColor} onChange={(e) => setTrendUpColor(e.target.value)} className="w-8 h-6" />
                <span className="text-xs">Down</span>
                <input type="color" value={trendDownColor} onChange={(e) => setTrendDownColor(e.target.value)} className="w-8 h-6" />
              </div>
              <button type="button" onClick={() => setTrendSettings(false)} className="w-full bg-gray-700 rounded py-1 text-xs">Close</button>
            </div>
          )}

          {smaSettings && (
            <div className="absolute top-12 right-2 z-40 bg-gray-900 border border-gray-700 rounded-lg p-3 shadow-xl text-sm w-52">
              <div className="font-medium mb-2">SMA Settings</div>
              {[
                { str: sma1Str, setStr: setSma1Str, set: setSma1, col: smaColor1, setCol: setSmaColor1, label: "SMA1" },
                { str: sma2Str, setStr: setSma2Str, set: setSma2, col: smaColor2, setCol: setSmaColor2, label: "SMA2" },
                { str: sma3Str, setStr: setSma3Str, set: setSma3, col: smaColor3, setCol: setSmaColor3, label: "SMA3" },
              ].map((x) => (
                <div key={x.label} className="flex items-center gap-2 mb-2">
                  <span className="text-xs w-10">{x.label}</span>
                  <input value={x.str} onChange={(e) => x.setStr(e.target.value)}
                    onBlur={() => { const n = parseInt(x.str) || 50; x.set(n); x.setStr(String(n)); }}
                    className="flex-1 bg-gray-800 rounded px-1 py-0.5 text-xs" />
                  <input type="color" value={x.col} onChange={(e) => x.setCol(e.target.value)} className="w-6 h-6" />
                </div>
              ))}
              <button type="button" onClick={() => setSmaSettings(false)} className="w-full bg-gray-700 rounded py-1 text-xs">Close</button>
            </div>
          )}

          {rsiSettings && (
            <div className="absolute top-12 right-2 z-40 bg-gray-900 border border-gray-700 rounded-lg p-3 shadow-xl text-sm w-44">
              <div className="font-medium mb-2">RSI Settings</div>
              <input value={rsiPeriodStr} onChange={(e) => setRsiPeriodStr(e.target.value)}
                onBlur={() => { const n = parseInt(rsiPeriodStr) || 14; setRsiPeriod(n); setRsiPeriodStr(String(n)); }}
                className="w-full bg-gray-800 rounded px-2 py-1 mb-2 text-sm" />
              <input type="color" value={rsiColor} onChange={(e) => setRsiColor(e.target.value)} className="w-8 h-6 mb-2" />
              <button type="button" onClick={() => setRsiSettings(false)} className="w-full bg-gray-700 rounded py-1 text-xs">Close</button>
            </div>
          )}

          {dmiSettings && (
            <div className="absolute top-12 right-2 z-40 bg-gray-900 border border-gray-700 rounded-lg p-3 shadow-xl text-sm w-48">
              <div className="font-medium mb-2">DMI Settings</div>
              <input value={dmiPeriodStr} onChange={(e) => setDmiPeriodStr(e.target.value)}
                onBlur={() => { const n = parseInt(dmiPeriodStr) || 14; setDmiPeriod(n); setDmiPeriodStr(String(n)); }}
                className="w-full bg-gray-800 rounded px-2 py-1 mb-2 text-sm" />
              <div className="flex gap-2 mb-2">
                <input type="color" value={dmiPlusColor} onChange={(e) => setDmiPlusColor(e.target.value)} className="w-7 h-6" title="+DI" />
                <input type="color" value={dmiMinusColor} onChange={(e) => setDmiMinusColor(e.target.value)} className="w-7 h-6" title="-DI" />
                <input type="color" value={dmiAdxColor} onChange={(e) => setDmiAdxColor(e.target.value)} className="w-7 h-6" title="ADX" />
              </div>
              <button type="button" onClick={() => setDmiSettings(false)} className="w-full bg-gray-700 rounded py-1 text-xs">Close</button>
            </div>
          )}

          {pivotSettings && (
            <div className="absolute top-12 right-2 z-40 bg-gray-900 border border-gray-700 rounded-lg p-3 shadow-xl text-sm w-44">
              <div className="font-medium mb-2">Pivot Settings</div>
              <select value={pivotTf} onChange={(e) => setPivotTf(e.target.value)} className="w-full bg-gray-800 rounded px-2 py-1 mb-2 text-sm">
                {PIVOT_TFS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
              <label className="flex items-center gap-2 text-xs mb-2">
                <input type="checkbox" checked={pivotFib} onChange={(e) => setPivotFib(e.target.checked)} /> Fibonacci
              </label>
              <button type="button" onClick={() => setPivotSettings(false)} className="w-full bg-gray-700 rounded py-1 text-xs">Close</button>
            </div>
          )}

          <div ref={chartContainerRef} className="w-full h-full" />
        </div>

        {showSideWl && (
          <div className="w-44 border-l border-gray-800 bg-[#111] overflow-y-auto shrink-0"
            onPointerMove={onSidePointerMove} onPointerUp={onSidePointerUp}>
            <div className="px-2 py-1.5 text-xs text-gray-400 border-b border-gray-800 sticky top-0 bg-[#111]">
              With alarms
            </div>
            {alarmSymbols.map((sym) => (
              <div key={sym}>
                {dragOverSym === sym && draggingSym && draggingSym !== sym && (
                  <div className="h-8 bg-orange-500/20 border border-dashed border-orange-500 mx-1 my-0.5 rounded" />
                )}
                <div data-sym={sym}
                  onPointerDown={(e) => onSidePointerDown(e, sym)}
                  onClick={() => setSymbol(sym)}
                  className={`flex items-center gap-1.5 px-2 py-1.5 cursor-grab active:cursor-grabbing text-sm border-b border-gray-800/50 ${
                    symbol === sym ? "bg-orange-500/20" : "hover:bg-gray-800/60"
                  } ${draggingSym === sym ? "opacity-40" : ""}`}>
                  <CoinIcon symbol={sym} />
                  <span className="truncate flex-1">{sym.replace("USDT", "")}</span>
                  <span className="text-[10px] text-gray-500">
                    {alarmCountBySym[sym] || 0}A {lineCountBySym[sym] || 0}L
                  </span>
                </div>
              </div>
            ))}
            {!alarmSymbols.length && <p className="text-xs text-gray-600 p-2">No alarms</p>}
          </div>
        )}
      </div>

      <div className="border-t border-gray-800 grid grid-cols-1 md:grid-cols-2 gap-0 max-h-[28vh] overflow-y-auto">
        <div className="p-2 border-r border-gray-800">
          <div className="text-xs text-green-400 mb-1 font-medium">
            Alarms — {symbolUpper} ({currentAlarms.length})
          </div>
          <div className="space-y-1">
            {currentAlarms.map((a) => (
              <div key={a.id} className="bg-gray-900/80 rounded-lg px-2 py-1.5">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-mono min-w-[72px]">{formatPrice(a.price)}</span>
                  <div className="ml-auto flex items-center gap-1.5 flex-wrap">
                    <select value={a.condition}
                      onChange={(e) => updateAlarmField(a.id, { condition: e.target.value as any })}
                      className="bg-gray-800 rounded px-1 py-0.5 text-xs">
                      <option value="cross">Cross</option>
                      <option value="above">Above</option>
                      <option value="below">Below</option>
                    </select>
                    <input type="color" value={a.color || DEFAULT_ALARM_COLOR}
                      onChange={(e) => updateAlarmField(a.id, { color: e.target.value })}
                      className="w-5 h-5 cursor-pointer bg-transparent border-0" />
                    {LINE_WIDTHS.map((w) => (
                      <button key={w} type="button" onClick={() => updateAlarmField(a.id, { width: w })}
                        className={`text-[10px] px-1 rounded ${(a.width || 2) === w ? "bg-orange-600" : "bg-gray-800"}`}>
                        W{w}
                      </button>
                    ))}
                    <button type="button"
                      onClick={() => updateAlarmField(a.id, { dash: a.dash === "dashed" ? "solid" : "dashed" })}
                      className="text-[10px] px-1 rounded bg-gray-800">
                      {a.dash === "dashed" ? "---" : "━━"}
                    </button>
                    <button type="button" onClick={() => startEditNote(a.id, "alarm", a.note)} className="text-xs text-gray-400 hover:text-white">Note</button>
                    <button type="button" onClick={() => startMove(a.id, "alarm")} className="text-xs text-blue-400 hover:text-blue-300">Move</button>
                    <button type="button" onClick={() => deleteAlarm(a.id)} className="text-xs text-red-400 hover:text-red-300">Delete</button>
                  </div>
                </div>
                {a.note && <div className="text-[11px] text-gray-500 mt-0.5">{a.note}</div>}
                {editingNoteId === a.id && editingNoteType === "alarm" && (
                  <div className="mt-1 flex gap-1">
                    <input value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} className="flex-1 bg-gray-800 rounded px-2 py-0.5 text-xs" />
                    <button type="button" onClick={saveNote} className="text-green-400 text-xs">Save</button>
                    <button type="button" onClick={() => { setEditingNoteId(null); setEditingNoteType(null); }} className="text-gray-500 text-xs">Cancel</button>
                  </div>
                )}
              </div>
            ))}
            {!currentAlarms.length && <p className="text-gray-600 text-xs">No alarms</p>}
          </div>
        </div>

        <div className="p-2">
          <div className="text-xs text-orange-400 mb-1 font-medium">
            Lines — {symbolUpper} ({currentLines.length})
          </div>
          <div className="space-y-1">
            {currentLines.map((l) => (
              <div key={l.id} className="bg-gray-900/80 rounded-lg px-2 py-1.5">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-mono min-w-[72px]">{formatPrice(l.price)}</span>
                  <div className="ml-auto flex items-center gap-1.5 flex-wrap">
                    <input type="color" value={l.color || DEFAULT_LINE_COLOR}
                      onChange={(e) => updateLineField(l.id, { color: e.target.value })}
                      className="w-5 h-5 cursor-pointer bg-transparent border-0" />
                    {LINE_WIDTHS.map((w) => (
                      <button key={w} type="button" onClick={() => updateLineField(l.id, { width: w })}
                        className={`text-[10px] px-1 rounded ${(l.width || 2) === w ? "bg-orange-600" : "bg-gray-800"}`}>
                        W{w}
                      </button>
                    ))}
                    <button type="button"
                      onClick={() => updateLineField(l.id, { dash: (l.dash || l.style) === "dashed" ? "solid" : "dashed" })}
                      className="text-[10px] px-1 rounded bg-gray-800">
                      {(l.dash || l.style) === "dashed" ? "---" : "━━"}
                    </button>
                    <button type="button" onClick={() => convertLineToAlarm(l)} className="text-xs text-green-400 hover:text-green-300">Alarm</button>
                    <button type="button" onClick={() => startEditNote(l.id, "line", l.note)} className="text-xs text-gray-400 hover:text-white">Note</button>
                    <button type="button" onClick={() => startMove(l.id, "line")} className="text-xs text-blue-400 hover:text-blue-300">Move</button>
                    <button type="button" onClick={() => deleteLine(l.id)} className="text-xs text-red-400 hover:text-red-300">Delete</button>
                  </div>
                </div>
                {l.note && <div className="text-[11px] text-gray-500 mt-0.5">{l.note}</div>}
                {editingNoteId === l.id && editingNoteType === "line" && (
                  <div className="mt-1 flex gap-1">
                    <input value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} className="flex-1 bg-gray-800 rounded px-2 py-0.5 text-xs" />
                    <button type="button" onClick={saveNote} className="text-green-400 text-xs">Save</button>
                    <button type="button" onClick={() => { setEditingNoteId(null); setEditingNoteType(null); }} className="text-gray-500 text-xs">Cancel</button>
                  </div>
                )}
              </div>
            ))}
            {!currentLines.length && <p className="text-gray-600 text-xs">No lines</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

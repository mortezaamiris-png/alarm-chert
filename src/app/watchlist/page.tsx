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
  /** Diagonal / trend line end point (unix sec). When set with end_price → slanted line. */
  end_time?: number | null;
  end_price?: number | null;
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
  triggered_at?: string | null;
  created_at?: string | null;
  /** Diagonal alarm: start_time + price is first point; end_time + end_price is second. */
  start_time?: number | null;
  end_time?: number | null;
  end_price?: number | null;
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

type ToolMode =
  | "none"
  | "draw"
  | "ray"
  | "diag"
  | "alarm"
  | "alarm-ray"
  | "alarm-diag"
  | "move"
  | "measure";

/** Project price on a diagonal line at unix time t (extends beyond end). */
function projectedPriceOnDiag(
  startTime: number,
  startPrice: number,
  endTime: number,
  endPrice: number,
  t: number
): number {
  const dt = endTime - startTime;
  if (Math.abs(dt) < 1e-9) return startPrice;
  const slope = (endPrice - startPrice) / dt;
  return startPrice + slope * (t - startTime);
}

function isDiagonalLine(l: { start_time?: number | null; end_time?: number | null; end_price?: number | null }) {
  return (
    l.start_time != null &&
    l.end_time != null &&
    l.end_price != null &&
    Number(l.end_time) !== Number(l.start_time)
  );
}

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

/** Color palette for floating pickers (same dark popover effect as timezone menu) */
const PRESET_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6",
  "#3b82f6", "#6366f1", "#8b5cf6", "#ec4899", "#f472b6",
  "#ffffff", "#94a3b8", "#fb923c", "#a3e635", "#38bdf8",
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

/** Desktop gets a longer multi-tone; mobile a short beep */
function playAlarmBeep() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    const notes = isMobile ? [880] : [660, 880, 1100, 880, 1320];
    const gap = isMobile ? 0.35 : 0.28;
    notes.forEach((freq, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g);
      g.connect(ctx.destination);
      o.type = isMobile ? "sine" : "square";
      o.frequency.value = freq;
      const t0 = ctx.currentTime + i * gap;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(isMobile ? 0.28 : 0.18, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + gap * 0.85);
      o.start(t0);
      o.stop(t0 + gap);
    });
  } catch {}
}

function showLocalNotification(title: string, body: string) {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, { body, icon: "/icon-192.png", tag: "alarm-chert-" + Date.now() });
    }
  } catch {}
  playAlarmBeep();
}

function formatRelativeTime(iso: string | null | undefined) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function formatAlarmDate(iso: string | null | undefined) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/** Convert VAPID public key (base64url) to Uint8Array for pushManager.subscribe */
function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Register service worker + subscribe to Web Push (works when PWA is closed on iOS 16.4+).
 * Saves subscription to Supabase table `push_subscriptions`.
 */
/** Public VAPID key (safe in client). Must match VAPID_PRIVATE_KEY on server/Supabase. */
const VAPID_PUBLIC_KEY_FALLBACK =
  "BNxMii5i6PgIObzAV3J3V0RHCKZMcsuraoOisgNXJL58IL9IzWKAClubnW8QFYtNFL07-D32iZctMZGGNw7LVpg";

async function ensurePushSubscription(): Promise<"ok" | "denied" | "unsupported" | "no-key" | "error"> {
  if (typeof window === "undefined") return "unsupported";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return "unsupported";
  }

  const vapid =
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_VAPID_PUBLIC_KEY) ||
    (typeof window !== "undefined" && (window as any).__VAPID_PUBLIC_KEY) ||
    VAPID_PUBLIC_KEY_FALLBACK;

  if (!vapid) return "no-key";

  try {
    // Register SW at site root (file must live in /public/sw.js)
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;

    let permission = Notification.permission;
    if (permission === "default") {
      permission = await Notification.requestPermission();
    }
    if (permission !== "granted") return "denied";

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid),
      });
    }

    const json = sub.toJSON();
    const endpoint = json.endpoint || "";
    const p256dh = json.keys?.p256dh || "";
    const auth = json.keys?.auth || "";
    if (!endpoint || !p256dh || !auth) return "error";

    // Upsert subscription so the server can send pushes when alarms fire
    const { data: existing } = await supabase
      .from("push_subscriptions")
      .select("id")
      .eq("endpoint", endpoint)
      .maybeSingle();

    if (existing?.id) {
      await supabase
        .from("push_subscriptions")
        .update({
          p256dh,
          auth,
          user_agent: navigator.userAgent,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
    } else {
      await supabase.from("push_subscriptions").insert([
        {
          endpoint,
          p256dh,
          auth,
          user_agent: navigator.userAgent,
        },
      ]);
    }
    return "ok";
  } catch (e) {
    console.warn("Push subscribe failed", e);
    return "error";
  }
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

/** Dense points along a diagonal so LWC never shows visual gaps on higher TFs */
function denseDiagPoints(
  t0: number,
  t1: number,
  v0: number,
  v1: number,
  barSec: number
): { time: any; value: number }[] {
  const bs = Math.max(1, barSec || 60);
  if (t1 <= t0) {
    return [
      { time: t0 as any, value: v0 },
      { time: (t0 + bs) as any, value: v1 },
    ];
  }
  const steps = Math.max(2, Math.min(80, Math.ceil((t1 - t0) / bs) + 1));
  const pts: { time: any; value: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const tt = t0 + ((t1 - t0) * i) / steps;
    const vv = v0 + ((v1 - v0) * i) / steps;
    pts.push({ time: Math.round(tt) as any, value: vv });
  }
  // Ensure strictly increasing times (LWC requirement)
  for (let i = 1; i < pts.length; i++) {
    if (Number(pts[i].time) <= Number(pts[i - 1].time)) {
      pts[i].time = (Number(pts[i - 1].time) + 1) as any;
    }
  }
  return pts;
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

/** Interval value → seconds (Bybit open-time based candles) */
function intervalToSeconds(iv: string): number {
  if (iv === "D") return 86400;
  if (iv === "W") return 604800;
  if (iv === "M") return 2592000;
  const n = parseInt(iv, 10);
  return Number.isNaN(n) ? 3600 : n * 60;
}

/** Empty bars after last candle so time axis continues into the future (TradingView-style).
 *  Large buffer so user can scroll/draw far past the last price bar. */
const FUTURE_BARS = 300;
/** How many future bars are visible on first load (rest remains scrollable) */
const FUTURE_VISIBLE = 60;
function appendFutureWhitespace(candles: any[], interval: string, count = FUTURE_BARS): any[] {
  if (!candles.length) return candles;
  const barSec = intervalToSeconds(String(interval));
  if (barSec <= 0) return candles;
  const lastT = Number(candles[candles.length - 1].time);
  const out = candles.slice();
  for (let i = 1; i <= count; i++) {
    // WhitespaceData: time only — LWC draws empty slot + tick mark
    out.push({ time: lastT + i * barSec });
  }
  return out;
}

/** Remaining time until current candle closes — counts DOWN like TradingView */
function formatCountdownRemaining(openTime: number, iv: string): string {
  const sec = intervalToSeconds(String(iv));
  const closeTime = Number(openTime) + sec;
  let left = closeTime - Math.floor(Date.now() / 1000);
  if (left < 0) left = 0;
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
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
    <div
      data-ind-panel
      className="inline-flex items-center gap-0.5 bg-black/40 backdrop-blur-[2px] rounded px-1 py-0.5 text-[11px] text-gray-100"
    >
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
  /** Temporary line series while drawing diagonal (start → cursor) */
  const previewDiagSeriesRef = useRef<any>(null);
  /** AbortController to remove pointer listeners on chart rebuild */
  const pointerAbortRef = useRef<AbortController | null>(null);
  /** rAF throttle for pointermove (prevents desktop freeze) */
  const moveRafRef = useRef<number>(0);
  /** Hollow circle handle DOM nodes (move mode) */
  const handleAElRef = useRef<HTMLDivElement | null>(null);
  const handleBElRef = useRef<HTMLDivElement | null>(null);
  /** Diagonal move: pick a handle (A/B) then place it */
  const moveDiagRef = useRef<{
    id: string;
    phase: "pick" | "drag-a" | "drag-b";
    pointA: { time: number; price: number };
    pointB: { time: number; price: number };
    color: string;
    width: number;
    dash: string;
  } | null>(null);
  /** True when moving a horizontal ray (origin can shift in time) */
  const movingRayRef = useRef(false);
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
  const [tzMenuOpen, setTzMenuOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [favTfs, setFavTfs] = useState<string[]>(() =>
    loadLS("fav_tfs", ["1", "5", "15", "60", "240", "D"])
  );

  const [lines, setLines] = useState<ChartLine[]>([]);
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [highlightAlarmId, setHighlightAlarmId] = useState<string | null>(null);
  const [highlightPrice, setHighlightPrice] = useState<number | null>(null);
  /** Temporary dashed diagonal flash from History click */
  const [highlightDiag, setHighlightDiag] = useState<{
    start_time: number;
    end_time: number;
    price: number;
    end_price: number;
  } | null>(null);
  /** Temporary half-line (ray) flash from History click */
  const [highlightRay, setHighlightRay] = useState<{
    start_time: number;
    price: number;
  } | null>(null);
  const [mode, setMode] = useState<ToolMode>("none");
  const [previewPrice, setPreviewPrice] = useState<number | null>(null);
  /** First click of diagonal tool: { time, price } */
  const [diagStart, setDiagStart] = useState<{ time: number; price: number } | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [movingType, setMovingType] = useState<"line" | "alarm" | null>(null);
  const [condition, setCondition] = useState<"above" | "below" | "cross">("cross");
  const [saving, setSaving] = useState(false);
  const [showIndicatorMenu, setShowIndicatorMenu] = useState(false);
  /** Collapsible left drawing tools panel (TradingView-style) */
  const [showToolsPanel, setShowToolsPanel] = useState(() => loadLS("show_tools_panel", true));
  /** Alarm sub-menu: full / ray / diag placement */
  const [alarmMenuOpen, setAlarmMenuOpen] = useState(false);
  /** Eye menu: hide lines / indicators */
  const [hideMenuOpen, setHideMenuOpen] = useState(false);
  const [hideLines, setHideLines] = useState(false);
  const [hideIndicators, setHideIndicators] = useState(false);
  const [hideAlarms, setHideAlarms] = useState(false);
  const [trashMenuOpen, setTrashMenuOpen] = useState(false);
  /** Measure: first → second → third tap clears */
  const [measureStart, setMeasureStart] = useState<{ time: number; price: number } | null>(null);
  const [measureEnd, setMeasureEnd] = useState<{ time: number; price: number } | null>(null);
  const measureStartRef = useRef<{ time: number; price: number } | null>(null);
  const measureDoneRef = useRef(false);
  const measureSeriesRef = useRef<any>(null);
  /** Live measure HUD (DOM-only — avoids React re-render lag) */
  const measureHudRef = useRef<HTMLDivElement | null>(null);
  const measureLastHudTs = useRef(0);
  /** Keep chart focused on history hit area across re-renders */
  const historyFocusRef = useRef<{ from: number; to: number } | null>(null);
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
  /** pushStatus: idle | ok | denied | unsupported | no-key | error */
  const [pushStatus, setPushStatus] = useState<string>("idle");
  const tfMenuRef = useRef<HTMLDivElement>(null);
  const tzMenuRef = useRef<HTMLDivElement>(null);

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
  const diagStartRef = useRef(diagStart);

  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { conditionRef.current = condition; }, [condition]);
  useEffect(() => { movingIdRef.current = movingId; }, [movingId]);
  useEffect(() => { movingTypeRef.current = movingType; }, [movingType]);
  useEffect(() => { diagStartRef.current = diagStart; }, [diagStart]);
  useEffect(() => {
    if (mode !== "diag") setDiagStart(null);
  }, [mode]);
  useEffect(() => { drawColorRef.current = drawColor; saveLS("draw_color", drawColor); }, [drawColor]);
  useEffect(() => { drawWidthRef.current = drawWidth; saveLS("draw_width", drawWidth); }, [drawWidth]);
  useEffect(() => { drawDashRef.current = drawDash; saveLS("draw_dash", drawDash); }, [drawDash]);
  useEffect(() => { symbolRef.current = symbol; localStorage.setItem("chart_symbol", symbol); }, [symbol]);
  // Highlight a specific alarm when navigating from Alerts page (horizontal or diagonal)
  useEffect(() => {
    try {
      const hid = localStorage.getItem("chart_highlight_alarm_id");
      const hp = localStorage.getItem("chart_highlight_price");
      const hd = localStorage.getItem("chart_highlight_diag");
      let hasAny = false;
      if (hid) {
        setHighlightAlarmId(hid);
        hasAny = true;
      }
      if (hd) {
        try {
          const d = JSON.parse(hd);
          if (d && d.start_time != null && d.end_time != null && d.end_price != null) {
            setHighlightDiag({
              start_time: Number(d.start_time),
              end_time: Number(d.end_time),
              price: Number(d.price ?? d.start_price ?? 0),
              end_price: Number(d.end_price),
            });
            setHighlightPrice(null);
            hasAny = true;
          }
        } catch {}
      } else if (hp) {
        const n = parseFloat(hp);
        if (!Number.isNaN(n)) {
          setHighlightPrice(n);
          hasAny = true;
        }
      }
      localStorage.removeItem("chart_highlight_alarm_id");
      localStorage.removeItem("chart_highlight_price");
      localStorage.removeItem("chart_highlight_diag");
      if (hasAny) {
        const t = setTimeout(() => {
          setHighlightAlarmId(null);
          setHighlightPrice(null);
          setHighlightDiag(null);
        }, 6000);
        return () => clearTimeout(t);
      }
    } catch {}
  }, []);

  // Auto-clear history flash (horizontal / ray / diagonal) after a few seconds
  useEffect(() => {
    if (highlightPrice == null && !highlightAlarmId && !highlightDiag && !highlightRay) return;
    const t = setTimeout(() => {
      setHighlightPrice(null);
      setHighlightAlarmId(null);
      setHighlightDiag(null);
      setHighlightRay(null);
    }, 5000);
    return () => clearTimeout(t);
  }, [highlightPrice, highlightAlarmId, highlightDiag, highlightRay]);

  useEffect(() => { intervalRef.current = interval; localStorage.setItem("chart_interval", interval); }, [interval]);
  useEffect(() => { timeZoneRef.current = timeZone; saveLS("chart_tz", timeZone); }, [timeZone]);
  useEffect(() => { saveLS("fav_tfs", favTfs); }, [favTfs]);
  useEffect(() => { saveLS("side_order", sideOrder); }, [sideOrder]);
  useEffect(() => { saveLS("show_side_wl", showSideWl); }, [showSideWl]);
  useEffect(() => { saveLS("show_tools_panel", showToolsPanel); }, [showToolsPanel]);
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

  const hideHandles = useCallback(() => {
    try {
      if (handleAElRef.current) handleAElRef.current.style.display = "none";
      if (handleBElRef.current) handleBElRef.current.style.display = "none";
    } catch {}
  }, []);

  /** Position hollow circle handles; supports times beyond last candle */
  const positionHandles = useCallback((
    pointA: { time: number; price: number },
    pointB: { time: number; price: number },
    active?: "a" | "b" | null
  ) => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const elA = handleAElRef.current;
    const elB = handleBElRef.current;
    if (!chart || !series || !elA || !elB) return;
    const candles = candlesRef.current;
    const barSec = intervalToSeconds(String(intervalRef.current));
    const timeToX = (t: number): number | null => {
      let x = chart.timeScale().timeToCoordinate(t as any);
      if (x != null) return x;
      // Extrapolate past last bar (empty / future area)
      if (candles.length >= 2 && barSec > 0) {
        const last = candles[candles.length - 1];
        const prev = candles[candles.length - 2];
        const lastX = chart.timeScale().timeToCoordinate(last.time as any);
        const prevX = chart.timeScale().timeToCoordinate(prev.time as any);
        if (lastX != null && prevX != null) {
          const pxPerBar = lastX - prevX;
          return lastX + ((t - last.time) / barSec) * pxPerBar;
        }
      }
      return null;
    };
    const place = (el: HTMLDivElement, pt: { time: number; price: number }, isActive: boolean) => {
      const x = timeToX(pt.time);
      const y = series.priceToCoordinate(pt.price);
      if (x == null || y == null) {
        el.style.display = "none";
        return;
      }
      el.style.display = "block";
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.borderColor = isActive ? "#f97316" : "#ffffff";
      el.style.width = isActive ? "18px" : "14px";
      el.style.height = isActive ? "18px" : "14px";
    };
    place(elA, pointA, active === "a");
    place(elB, pointB, active === "b");
  }, []);

  const clearPreview = useCallback(() => {
    if (previewLineRef.current && seriesRef.current) {
      try { seriesRef.current.removePriceLine(previewLineRef.current); } catch {}
      previewLineRef.current = null;
    }
    if (previewDiagSeriesRef.current && chartRef.current) {
      try { chartRef.current.removeSeries(previewDiagSeriesRef.current); } catch {}
      previewDiagSeriesRef.current = null;
    }
    hideHandles();
    // Restore chart pan/zoom (never touch page overflow)
    try {
      chartRef.current?.applyOptions({
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
        handleScale: { axisPressedMouseMove: true, axisDoubleClickReset: true, mouseWheel: true, pinch: true },
      });
    } catch {}
    try {
      if (chartContainerRef.current) chartContainerRef.current.style.touchAction = "";
      document.body.style.overflow = "";
      document.documentElement.style.overflow = "";
    } catch {}
    moveDiagRef.current = null;
    setPreviewPrice(null);
  }, [hideHandles]);

  const destroyChart = useCallback(() => {
    clearPreview();
    try { pointerAbortRef.current?.abort(); } catch {}
    pointerAbortRef.current = null;
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
    previewDiagSeriesRef.current = null;
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
    // Countdown remaining until candle close (TradingView style)
    const title = formatCountdownRemaining(Number(last.time), String(intervalRef.current));
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
        title,
      });
    } catch {}
  }, []);

  const renderAllLinesAndAlarms = useCallback(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;

    // Freeze visible window — adding line series with future times must not scroll the chart
    let savedRange: { from: number; to: number } | null = null;
    try {
      const lr = chart.timeScale().getVisibleLogicalRange();
      if (lr) savedRange = { from: lr.from, to: lr.to };
    } catch {}

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
        // Title only when note exists (no "Line xxx" label)
        const noteClean =
          l.note &&
          !String(l.note).startsWith("__diag:") &&
          !String(l.note).startsWith("__ray:")
            ? String(l.note)
            : "";
        const title = isMoving ? "MOVING" : noteClean;
        if (hideLines) {
          // skip drawing lines when eye-hide is on
        } else if (isDiagonalLine(l)) {
          // Segment only: exactly point A → point B (no extension / no ray)
          const st = Number(l.start_time);
          const et = Number(l.end_time);
          const sp = Number(l.price);
          const ep = Number(l.end_price);
          const t0 = Math.min(st, et);
          const t1 = Math.max(st, et);
          const v0 = st <= et ? sp : ep;
          const v1 = st <= et ? ep : sp;
          // Diagonals always solid continuous segment (dash looks like "gaps" on higher TF)
          const ls: any = chart.addLineSeries({
            color,
            lineWidth: width,
            lineStyle: LineStyle.Solid,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            title: title || "",
          });
          ls.setData(
            denseDiagPoints(t0, t1, v0, v1, intervalToSeconds(String(intervalRef.current)))
          );
          chartLinesRef.current.set(l.id, ls);
        } else if (l.start_time != null) {
          // Horizontal ray from start_time → far into future (to price scale edge)
          const barSec = intervalToSeconds(String(intervalRef.current));
          const rayEnd = lastTime + FUTURE_BARS * barSec;
          const ls: any = chart.addLineSeries({
            color, lineWidth: width, lineStyle: style,
            priceLineVisible: false,
            lastValueVisible: true,
            crosshairMarkerVisible: false,
            title: title || "",
          });
          ls.setData([
            { time: l.start_time as any, value: l.price },
            { time: rayEnd as any, value: l.price },
          ]);
          chartLinesRef.current.set(l.id, ls);
        } else {
          const pl = series.createPriceLine({
            price: l.price, color, lineWidth: width, lineStyle: style,
            axisLabelVisible: true, title: title || "",
          });
          alarmLinesRef.current.set(`line-${l.id}`, pl);
        }
      } catch {}
    });

    // Alarms: horizontal price lines OR diagonal trend alarms
    let hlDrawnOnActive = false;
    if (hideAlarms) {
      // skip drawing alarms when eye-hide alarms is on
    } else currentAlarms.forEach((a) => {
      try {
        const isMoving = movingId === a.id && movingType === "alarm";
        const isHL = highlightAlarmId === a.id ||
          (highlightPrice != null && Math.abs(a.price - highlightPrice) < a.price * 1e-9 + 1e-8);
        if (isHL) hlDrawnOnActive = true;
        const color = isMoving
          ? "#f59e0b"
          : isHL
          ? "#eab308"
          : a.color || DEFAULT_ALARM_COLOR;
        const width = (isMoving || isHL ? 3 : ((a.width as 1 | 2 | 3) || 2)) as 1 | 2 | 3;
        const style = isMoving || isHL ? LineStyle.Dashed : toLineStyle(a.dash);
        const noteCleanA =
          a.note &&
          !String(a.note).startsWith("__diag:") &&
          !String(a.note).startsWith("__ray:") &&
          a.note !== "Diag"
            ? String(a.note)
            : null;
        const title = isMoving
          ? "MOVING"
          : isHL
          ? "◀ SELECTED"
          : noteCleanA || "";

        if (isDiagonalLine(a)) {
          // Diagonal alarm: ONLY the slanted segment — no horizontal helper line
          const st = Number(a.start_time);
          const et = Number(a.end_time);
          const sp = Number(a.price);
          const ep = Number(a.end_price);
          const t0 = Math.min(st, et);
          const t1 = Math.max(st, et);
          const v0 = st <= et ? sp : ep;
          const v1 = st <= et ? ep : sp;
          // Diag alarms: solid continuous (no dashed gaps on higher TF)
          const ls: any = chart.addLineSeries({
            color,
            lineWidth: width,
            lineStyle: isMoving || isHL ? LineStyle.Dashed : LineStyle.Solid,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            title: title || "",
          });
          // Dense points — continuous on any TF (hit detection still uses projectedPriceOnDiag)
          ls.setData(
            denseDiagPoints(t0, t1, v0, v1, intervalToSeconds(String(intervalRef.current)))
          );
          chartLinesRef.current.set(`alarm-diag-${a.id}`, ls);
        } else if (a.start_time != null) {
          // Horizontal ray alarm: from start_time → far future (to price scale)
          const barSec = intervalToSeconds(String(intervalRef.current));
          const rayEnd = lastTime + FUTURE_BARS * barSec;
          const ls: any = chart.addLineSeries({
            color, lineWidth: width, lineStyle: style,
            priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false,
            title: title || "",
          });
          ls.setData([
            { time: Number(a.start_time) as any, value: a.price },
            { time: rayEnd as any, value: a.price },
          ]);
          chartLinesRef.current.set(`alarm-ray-${a.id}`, ls);
        } else {
          const pl = series.createPriceLine({
            price: a.price, color, lineWidth: width,
            lineStyle: style,
            axisLabelVisible: true, title: title || "",
          });
          alarmLinesRef.current.set(`alarm-${a.id}`, pl);
        }
      } catch {}
    });

    // History / temp highlight: yellow dashed HORIZONTAL line (full)
    if (highlightPrice != null && !hlDrawnOnActive && !highlightDiag && !highlightRay) {
      try {
        const pl = series.createPriceLine({
          price: highlightPrice,
          color: "#eab308",
          lineWidth: 3,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "◀ HISTORY",
        });
        alarmLinesRef.current.set("highlight-temp", pl);
      } catch {}
    }

    // History / temp highlight: yellow HALF-LINE (ray) from start_time → future
    if (highlightRay) {
      try {
        const barSec = intervalToSeconds(String(intervalRef.current));
        const candles = candlesRef.current;
        const lastT = candles.length ? candles[candles.length - 1].time : highlightRay.start_time;
        const rayStartT = Number(highlightRay.start_time);
        // Ensure end is clearly after start so LWC draws a segment
        const rayEnd = Math.max(lastT + FUTURE_BARS * barSec, rayStartT + barSec * 8);
        const ls: any = chart.addLineSeries({
          color: "#eab308",
          lineWidth: 3,
          lineStyle: LineStyle.Dashed,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerVisible: false,
          title: "◀ HISTORY",
        });
        // Marker at origin so user sees where the half-line begins
        try {
          ls.setMarkers([
            {
              time: rayStartT as any,
              position: "inBar",
              color: "#eab308",
              shape: "circle",
              size: 1,
              text: "RAY",
            },
          ]);
        } catch {}
        ls.setData([
          { time: rayStartT as any, value: highlightRay.price },
          { time: rayEnd as any, value: highlightRay.price },
        ]);
        chartLinesRef.current.set("highlight-ray-temp", ls);
      } catch {}
    }

    // History / temp highlight: continuous yellow DIAGONAL (solid — no dashed gaps)
    if (highlightDiag) {
      try {
        const st = Number(highlightDiag.start_time);
        const et = Number(highlightDiag.end_time);
        const sp = Number(highlightDiag.price);
        const ep = Number(highlightDiag.end_price);
        const t0 = Math.min(st, et);
        const t1 = Math.max(st, et);
        const v0 = st <= et ? sp : ep;
        const v1 = st <= et ? ep : sp;
        const ls: any = chart.addLineSeries({
          color: "#eab308",
          lineWidth: 3,
          lineStyle: LineStyle.Solid,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          title: "◀ HISTORY",
        });
        ls.setData(
          denseDiagPoints(t0, t1, v0, v1, intervalToSeconds(String(intervalRef.current)))
        );
        chartLinesRef.current.set("highlight-diag-temp", ls);
      } catch {}
    }

    // Restore exact visible range so future-endpoint diags don't push the chart right
    // BUT if user just tapped History, force-focus that region instead
    if (historyFocusRef.current) {
      try {
        const f = historyFocusRef.current;
        (chart.timeScale() as any).setVisibleRange({
          from: f.from as any,
          to: f.to as any,
        });
      } catch {
        try {
          chart.timeScale().setVisibleLogicalRange(savedRange as any);
        } catch {}
      }
    } else if (savedRange) {
      try {
        chart.timeScale().setVisibleLogicalRange(savedRange);
      } catch {}
    }
  }, [currentLines, currentAlarms, movingId, movingType, highlightAlarmId, highlightPrice, highlightDiag, highlightRay, hideLines, hideAlarms]);

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
    if (!showSMA || !smaVisible || hideIndicators || !chartRef.current || !candlesRef.current.length) return;
    const c = candlesRef.current;
    const s1 = chartRef.current.addLineSeries({ color: smaColor1, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const s2 = chartRef.current.addLineSeries({ color: smaColor2, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    const s3 = chartRef.current.addLineSeries({ color: smaColor3, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
    s1.setData(calcSMA(c, sma1) as any);
    s2.setData(calcSMA(c, sma2) as any);
    s3.setData(calcSMA(c, sma3) as any);
    smaSeriesRef.current = { s1, s2, s3 };
  }, [showSMA, smaVisible, hideIndicators, sma1, sma2, sma3, smaColor1, smaColor2, smaColor3, removeSMA]);

  const removeRSI = useCallback(() => {
    if (rsiSeriesRef.current && chartRef.current) {
      try { chartRef.current.removeSeries(rsiSeriesRef.current); } catch {}
      rsiSeriesRef.current = null;
    }
  }, []);
  const applyRSI = useCallback(() => {
    removeRSI();
    if (!showRSI || !rsiVisible || hideIndicators || !chartRef.current || !candlesRef.current.length) return;
    const s = chartRef.current.addLineSeries({
      color: rsiColor, lineWidth: 1, priceScaleId: "rsi",
      priceLineVisible: false, lastValueVisible: true,
    });
    s.setData(calcRSI(candlesRef.current, rsiPeriod) as any);
    rsiSeriesRef.current = s;
    updateMargins();
  }, [showRSI, rsiVisible, hideIndicators, rsiPeriod, rsiColor, removeRSI, updateMargins]);

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
    if (!showDMI || !dmiVisible || hideIndicators || !chartRef.current || !candlesRef.current.length) return;
    const { plusDI, minusDI, adx } = calcDMI(candlesRef.current, dmiPeriod);
    const plus = chartRef.current.addLineSeries({ color: dmiPlusColor, lineWidth: 1, priceScaleId: "dmi", priceLineVisible: false, lastValueVisible: false });
    const minus = chartRef.current.addLineSeries({ color: dmiMinusColor, lineWidth: 1, priceScaleId: "dmi", priceLineVisible: false, lastValueVisible: false });
    const adxS = chartRef.current.addLineSeries({ color: dmiAdxColor, lineWidth: 1, priceScaleId: "dmi", priceLineVisible: false, lastValueVisible: false });
    plus.setData(plusDI as any);
    minus.setData(minusDI as any);
    adxS.setData(adx as any);
    dmiSeriesRef.current = { plus, minus, adx: adxS };
    updateMargins();
  }, [showDMI, dmiVisible, hideIndicators, dmiPeriod, dmiPlusColor, dmiMinusColor, dmiAdxColor, removeDMI, updateMargins]);

  const removePivot = useCallback(() => {
    pivotSeriesRef.current.forEach((s) => { try { chartRef.current?.removeSeries(s); } catch {} });
    pivotSeriesRef.current = [];
  }, []);
  const applyPivot = useCallback(async () => {
    removePivot();
    if (!showPivot || !pivotVisible || hideIndicators || !chartRef.current || !candlesRef.current.length) return;
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
  }, [showPivot, pivotVisible, hideIndicators, pivotTf, pivotFib, removePivot]);

  const removeTrend = useCallback(() => {
    trendSeriesRef.current.forEach((s) => { try { chartRef.current?.removeSeries(s); } catch {} });
    trendSeriesRef.current = [];
  }, []);
  const applyTrend = useCallback(() => {
    removeTrend();
    if (!showTrend || !trendVisible || hideIndicators || !chartRef.current || !candlesRef.current.length) return;
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
  }, [showTrend, trendVisible, hideIndicators, trendPeriod, trendMax, trendUpColor, trendDownColor, removeTrend]);

  const applyVolume = useCallback(() => {
    if (volumeSeriesRef.current && chartRef.current) {
      try { chartRef.current.removeSeries(volumeSeriesRef.current); } catch {}
      volumeSeriesRef.current = null;
    }
    if (!showVol || !volVisible || hideIndicators || !chartRef.current || !candlesRef.current.length) {
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
  }, [showVol, volVisible, hideIndicators, updateMargins]);

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
        layout: {
          background: { color: "#0b0e11" },
          textColor: "#d1d5db",
          fontSize: 11,
          // Hide default TradingView watermark (library is Apache-2.0)
          attributionLogo: false as any,
        },
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
          // Empty bars to the right of last candle (TradingView-style future area)
          rightOffset: 30,
          barSpacing: 8,
          minBarSpacing: 2,
          fixLeftEdge: false,
          fixRightEdge: false,
          lockVisibleTimeRangeOnResize: false,
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
        // Custom last-price badge via lastPriceLineRef — hide built-in (avoids double dashed line)
        lastValueVisible: false,
        priceLineVisible: false,
      });
      // Real candles + trailing whitespace so time labels continue past last bar
      series.setData(appendFutureWhitespace(candles, String(intervalRef.current)) as any);
      seriesRef.current = series;

      /** Frame last ~70 real bars + a wide visible future strip (more is scrollable) */
      const ensureFutureTimeSpace = () => {
        try {
          const bars = candlesRef.current.length || candles.length; // real bars only
          if (bars < 2) return;
          chart.timeScale().applyOptions({ rightOffset: 4 });
          const past = Math.min(70, bars);
          chart.timeScale().setVisibleLogicalRange({
            from: bars - past,
            to: bars - 1 + FUTURE_VISIBLE,
          });
        } catch {}
      };
      ensureFutureTimeSpace();
      requestAnimationFrame(() => {
        ensureFutureTimeSpace();
        setTimeout(ensureFutureTimeSpace, 150);
        setTimeout(ensureFutureTimeSpace, 500);
      });

      /** Resolve unix time from click/crosshair — works on empty area (no candle) too */
      const resolveTime = (param: any): number | null => {
        if (!param.point) {
          if (param.time != null) {
            const n = Number(param.time);
            if (!Number.isNaN(n) && n > 0) return n;
          }
          return null;
        }
        try {
          const candles = candlesRef.current;
          const barSec = intervalToSeconds(String(intervalRef.current));
          // Prefer logical coordinate so clicks in the empty RIGHT area (past last candle) work
          const logical = chart.timeScale().coordinateToLogical(param.point.x);
          if (logical != null && candles.length && barSec > 0) {
            const lastIdx = candles.length - 1;
            if (logical > lastIdx + 0.05) {
              // Future / empty area past last bar
              return candles[lastIdx].time + Math.round(logical - lastIdx) * barSec;
            }
            if (logical < -0.05) {
              return candles[0].time + Math.round(logical) * barSec;
            }
            const idx = Math.max(0, Math.min(lastIdx, Math.round(logical)));
            return candles[idx].time;
          }
          // Fallback: library time (only when inside data range)
          if (param.time != null) {
            const n = Number(param.time);
            if (!Number.isNaN(n) && n > 0) return n;
          }
          const ct = chart.timeScale().coordinateToTime(param.point.x);
          if (typeof ct === "number" && !Number.isNaN(ct)) return ct;
        } catch {}
        const candles = candlesRef.current;
        return candles.length ? candles[candles.length - 1].time : null;
      };

      /** Update rubber-band diagonal preview (start → current). No React state — no freeze. */
      const updateDiagPreview = (tCursor: number, price: number) => {
        const start = diagStartRef.current;
        if (!start || tCursor == null || Number.isNaN(price)) return;
        const t0 = Math.min(start.time, tCursor);
        const t1 = Math.max(start.time, tCursor);
        if (t1 === t0) return;
        const v0 = start.time <= tCursor ? start.price : price;
        const v1 = start.time <= tCursor ? price : start.price;
        try {
          if (!previewDiagSeriesRef.current) {
            previewDiagSeriesRef.current = chart.addLineSeries({
              color: drawColorRef.current,
              lineWidth: Math.max(2, drawWidthRef.current) as 1 | 2 | 3 | 4,
              lineStyle: LineStyle.Dashed,
              priceLineVisible: false,
              lastValueVisible: false,
              crosshairMarkerVisible: true,
            });
          }
          previewDiagSeriesRef.current.setData([
            { time: t0 as any, value: v0 },
            { time: t1 as any, value: v1 },
          ]);
        } catch {}
      };

      /** Soft chart lock only — NEVER freeze the whole page/app */
      const lockChartInteraction = (lock: boolean) => {
        try {
          chart.applyOptions({
            handleScroll: lock
              ? { mouseWheel: true, pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false }
              : { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
            handleScale: lock
              ? { axisPressedMouseMove: false, axisDoubleClickReset: false, mouseWheel: true, pinch: false }
              : { axisPressedMouseMove: true, axisDoubleClickReset: true, mouseWheel: true, pinch: true },
          });
        } catch {}
        // Only block touch-pan on the chart canvas — rest of app stays usable
        try {
          container.style.touchAction = lock ? "none" : "";
        } catch {}
        // Always clear any leftover full-page locks from older builds
        try {
          document.body.style.overflow = "";
          document.documentElement.style.overflow = "";
        } catch {}
      };

      // Pointer move on container — works for mouse AND touch (iPad)
      try { pointerAbortRef.current?.abort(); } catch {}
      pointerAbortRef.current = new AbortController();
      const pSignal = pointerAbortRef.current.signal;

      // Double-click / double-tap on price axis (right edge) → same view as fresh chart open
      let lastPriceTapTs = 0;
      const goToLatest = () => {
        try {
          const bars = candlesRef.current.length;
          if (bars < 2) {
            chart.timeScale().scrollToRealTime();
            return;
          }
          // Same framing as initial load: last ~70 real bars + future strip
          chart.timeScale().applyOptions({ rightOffset: 4 });
          const past = Math.min(70, bars);
          chart.timeScale().setVisibleLogicalRange({
            from: bars - past,
            to: bars - 1 + FUTURE_VISIBLE,
          });
        } catch {
          try { chart.timeScale().scrollToRealTime(); } catch {}
        }
      };
      const onDblNearPrice = (clientX: number) => {
        const rect = container.getBoundingClientRect();
        // Right price scale ~60–80px
        if (clientX >= rect.right - 80) goToLatest();
      };
      container.addEventListener(
        "dblclick",
        (e) => onDblNearPrice(e.clientX),
        { signal: pSignal }
      );
      container.addEventListener(
        "pointerup",
        (e) => {
          const rect = container.getBoundingClientRect();
          if (e.clientX < rect.right - 80) return;
          const now = Date.now();
          if (now - lastPriceTapTs < 320) {
            goToLatest();
            lastPriceTapTs = 0;
          } else {
            lastPriceTapTs = now;
          }
        },
        { signal: pSignal }
      );

      // Block page scroll while drawing diagonal
      const onTouchMoveBlock = (e: TouchEvent) => {
        // Only block page scroll while actively drawing / dragging an endpoint
        const md = moveDiagRef.current;
        const dragging =
          ((modeRef.current === "diag" || modeRef.current === "alarm-diag") &&
            !!diagStartRef.current) ||
          (modeRef.current === "move" && md && (md.phase === "drag-a" || md.phase === "drag-b")) ||
          (modeRef.current === "measure" && !!measureStartRef.current);
        if (dragging) {
          e.preventDefault();
        }
      };
      container.addEventListener("touchmove", onTouchMoveBlock, { passive: false, signal: pointerAbortRef.current.signal });
      const onPointerMove = (e: PointerEvent) => {
        const m0 = modeRef.current;
        const isDiagDraw =
          (m0 === "diag" || m0 === "alarm-diag") && !!diagStartRef.current;
        const isDiagMove = m0 === "move" && !!moveDiagRef.current;
        const isRayPreview = m0 === "ray" || m0 === "alarm-ray";
        const isMeasure =
          m0 === "measure" && !!measureStartRef.current && !measureEnd;
        // measureEnd is state — use measureStartRef only for live drag
        if (!isDiagDraw && !isDiagMove && !isRayPreview && !(m0 === "measure" && measureStartRef.current)) return;
        if (isDiagDraw || isDiagMove) {
          try { e.preventDefault(); } catch {}
        }
        // Throttle to one update per animation frame (critical — prevents freeze)
        if (moveRafRef.current) return;
        const cx = e.clientX;
        const cy = e.clientY;
        moveRafRef.current = requestAnimationFrame(() => {
          moveRafRef.current = 0;
          // Re-check mode inside rAF — prevents ghost ray/line after mode cleared
          const modeNow = modeRef.current;
          if (
            modeNow !== "diag" &&
            modeNow !== "alarm-diag" &&
            modeNow !== "ray" &&
            modeNow !== "alarm-ray" &&
            modeNow !== "measure" &&
            modeNow !== "move"
          ) {
            return;
          }
          const rect = container.getBoundingClientRect();
          const x = cx - rect.left;
          const y = cy - rect.top;
          if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
          const price = series.coordinateToPrice(y);
          if (price == null || Number.isNaN(price)) return;
          let tCursor: number | null = null;
          try {
            const logical = chart.timeScale().coordinateToLogical(x);
            const candles = candlesRef.current;
            if (logical != null && candles.length) {
              const barSec = intervalToSeconds(String(intervalRef.current));
              if (logical > candles.length - 1) {
                tCursor = candles[candles.length - 1].time + Math.round(logical - (candles.length - 1)) * barSec;
              } else if (logical < 0) {
                tCursor = candles[0].time + Math.round(logical) * barSec;
              } else {
                const idx = Math.max(0, Math.min(candles.length - 1, Math.round(logical)));
                tCursor = candles[idx].time;
              }
            }
          } catch {}
          if (tCursor == null) return;

          // Measure live preview — DOM only (no setState → no lag)
          if (modeNow === "measure" && measureStartRef.current) {
            const a = measureStartRef.current;
            try {
              if (!measureSeriesRef.current) {
                measureSeriesRef.current = chart.addLineSeries({
                  color: "#60a5fa",
                  lineWidth: 2,
                  lineStyle: LineStyle.Dashed,
                  priceLineVisible: false,
                  lastValueVisible: false,
                  crosshairMarkerVisible: false,
                });
              }
              if (Math.abs(a.time - tCursor) < 1) return;
              const pts = [
                { time: a.time as any, value: a.price },
                { time: tCursor as any, value: price },
              ].sort((p, q) => Number(p.time) - Number(q.time));
              measureSeriesRef.current.setData(pts);
              // hollow dots at A and cursor
              const xA = chart.timeScale().timeToCoordinate(a.time as any);
              const yA = series.priceToCoordinate(a.price);
              const xB = chart.timeScale().timeToCoordinate(tCursor as any);
              const yB = series.priceToCoordinate(price);
              if (handleAElRef.current && xA != null && yA != null) {
                handleAElRef.current.style.display = "block";
                handleAElRef.current.style.left = `${xA}px`;
                handleAElRef.current.style.top = `${yA}px`;
                handleAElRef.current.style.borderColor = "#60a5fa";
              }
              if (handleBElRef.current && xB != null && yB != null) {
                handleBElRef.current.style.display = "block";
                handleBElRef.current.style.left = `${xB}px`;
                handleBElRef.current.style.top = `${yB}px`;
                handleBElRef.current.style.borderColor = "#60a5fa";
              }
              // HUD text (throttled ~8fps)
              const now = performance.now();
              if (measureHudRef.current && now - measureLastHudTs.current > 120) {
                measureLastHudTs.current = now;
                const dp = price - a.price;
                const pct = (dp / a.price) * 100;
                const sec = Math.abs(tCursor - a.time);
                const barSec = intervalToSeconds(String(intervalRef.current));
                const bars = barSec > 0 ? Math.max(1, Math.round(sec / barSec)) : 0;
                const h = Math.floor(sec / 3600);
                const m = Math.floor((sec % 3600) / 60);
                const timeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
                measureHudRef.current.style.display = "block";
                measureHudRef.current.innerHTML =
                  `<div class="font-semibold">${dp >= 0 ? "+" : ""}${formatPrice(dp)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)</div>` +
                  `<div class="opacity-90 mt-0.5">${bars} bars · ${timeStr}</div>`;
              }
            } catch {}
            return;
          }

          // Ray / alarm-ray: half-line preview (throttled)
          if (modeNow === "ray" || modeNow === "alarm-ray") {
            try {
              if (previewLineRef.current) {
                try { series.removePriceLine(previewLineRef.current); } catch {}
                previewLineRef.current = null;
              }
              const candles = candlesRef.current;
              if (!candles.length) return;
              const lastT = candles[candles.length - 1].time;
              const barSec = intervalToSeconds(String(intervalRef.current));
              // End must reach price-scale side (future whitespace)
              const t1 = Math.max(lastT + FUTURE_BARS * barSec, tCursor + barSec * 4);
              if (t1 <= tCursor) return;
              if (!previewDiagSeriesRef.current) {
                previewDiagSeriesRef.current = chart.addLineSeries({
                  color: drawColorRef.current,
                  lineWidth: Math.max(2, drawWidthRef.current) as 1 | 2 | 3 | 4,
                  lineStyle: LineStyle.Dashed,
                  priceLineVisible: false,
                  lastValueVisible: false,
                  crosshairMarkerVisible: false,
                });
              }
              previewDiagSeriesRef.current.setData([
                { time: tCursor as any, value: price },
                { time: t1 as any, value: price },
              ]);
            } catch {}
            return;
          }

          if ((modeNow === "diag" || modeNow === "alarm-diag") && diagStartRef.current) {
            updateDiagPreview(tCursor, price);
            return;
          }
          const md = moveDiagRef.current;
          if (!md) return;
          const a = md.phase === "drag-a" ? { time: tCursor, price } : md.pointA;
          const b = md.phase === "drag-b" ? { time: tCursor, price } : md.pointB;
          try {
            if (!previewDiagSeriesRef.current) {
              previewDiagSeriesRef.current = chart.addLineSeries({
                color: md.color,
                lineWidth: Math.max(2, md.width) as 1 | 2 | 3 | 4,
                lineStyle: LineStyle.Dashed,
                priceLineVisible: false,
                lastValueVisible: false,
                crosshairMarkerVisible: false,
              });
            }
            if (Math.abs(a.time - b.time) < 1) return;
            const pts = [
              { time: a.time as any, value: a.price },
              { time: b.time as any, value: b.price },
            ].sort((p, q) => Number(p.time) - Number(q.time));
            previewDiagSeriesRef.current.setData(pts);
            // Hollow CSS handles (no setMarkers — avoids freeze)
            positionHandles(a, b, md.phase === "drag-a" ? "a" : md.phase === "drag-b" ? "b" : null);
          } catch {}
        });
      };
      container.addEventListener("pointermove", onPointerMove, { signal: pointerAbortRef.current.signal });

      chart.subscribeCrosshairMove((param) => {
        // Heavy previews (diag / ray / move) handled by throttled pointermove — skip here
        if (
          modeRef.current === "none" ||
          modeRef.current === "move" ||
          modeRef.current === "diag" ||
          modeRef.current === "alarm-diag" ||
          modeRef.current === "ray" ||
          modeRef.current === "alarm-ray" ||
          modeRef.current === "measure"
        )
          return;
        if (!param.point || param.point.x < 0 || param.point.y < 0) return;
        const price = series.coordinateToPrice(param.point.y);
        if (price == null || Number.isNaN(price)) return;

        // Full horizontal (draw / alarm): cheap price line update only
        if (previewDiagSeriesRef.current) {
          try { chart.removeSeries(previewDiagSeriesRef.current); } catch {}
          previewDiagSeriesRef.current = null;
        }
        try {
          if (previewLineRef.current) {
            previewLineRef.current.applyOptions({
              price,
              color: drawColorRef.current,
              lineWidth: drawWidthRef.current,
              lineStyle: toLineStyle(drawDashRef.current),
              title: "",
            });
          } else {
            previewLineRef.current = series.createPriceLine({
              price,
              color: drawColorRef.current,
              lineWidth: drawWidthRef.current,
              lineStyle: toLineStyle(drawDashRef.current),
              axisLabelVisible: true,
              title: "",
            });
          }
        } catch {}
      });

      chart.subscribeClick(async (param) => {
        // Allow confirm-tap during pick phase even if clickLock is briefly set after save
        if (clickLockRef.current) {
          const md0 = moveDiagRef.current;
          if (!(modeRef.current === "move" && md0 && md0.phase === "pick")) return;
        }
        if (!param.point || param.point.x < 0 || param.point.y < 0) return;
        const price = series.coordinateToPrice(param.point.y);
        if (price == null || Number.isNaN(price)) return;
        const fp = formatPrice(price);
        const m = modeRef.current;

        if (m === "move" && movingIdRef.current) {
          const id = movingIdRef.current;
          const typ = movingTypeRef.current;
          const md = moveDiagRef.current;

          // ── Diagonal handle-based move ──
          // phase "pick": tap near a circle → select that endpoint
          // phase "drag-a"/"drag-b": tap new position → save that endpoint
          if (md && md.id === id) {
            const refreshHandles = () => {
              try {
                if (!previewDiagSeriesRef.current) {
                  previewDiagSeriesRef.current = chart.addLineSeries({
                    color: md.color,
                    lineWidth: Math.max(2, md.width) as 1 | 2 | 3 | 4,
                    lineStyle: LineStyle.Dashed,
                    priceLineVisible: false,
                    lastValueVisible: false,
                    crosshairMarkerVisible: false,
                  });
                }
                const pts = [
                  { time: md.pointA.time as any, value: md.pointA.price },
                  { time: md.pointB.time as any, value: md.pointB.price },
                ].sort((x, y) => Number(x.time) - Number(y.time));
                previewDiagSeriesRef.current.setData(pts);
                try { previewDiagSeriesRef.current.setMarkers([]); } catch {}
                positionHandles(md.pointA, md.pointB, null);
              } catch {}
            };

            if (md.phase === "pick") {
              // Hit-test which endpoint is closer in pixel space (supports future times)
              try {
                const candles = candlesRef.current;
                const barSec = intervalToSeconds(String(intervalRef.current));
                const timeToX = (t: number): number | null => {
                  let x = chart.timeScale().timeToCoordinate(t as any);
                  if (x != null) return x;
                  if (candles.length >= 2 && barSec > 0) {
                    const last = candles[candles.length - 1];
                    const prev = candles[candles.length - 2];
                    const lastX = chart.timeScale().timeToCoordinate(last.time as any);
                    const prevX = chart.timeScale().timeToCoordinate(prev.time as any);
                    if (lastX != null && prevX != null) {
                      return lastX + ((t - last.time) / barSec) * (lastX - prevX);
                    }
                  }
                  return null;
                };
                const xA = timeToX(md.pointA.time);
                const yA = series.priceToCoordinate(md.pointA.price);
                const xB = timeToX(md.pointB.time);
                const yB = series.priceToCoordinate(md.pointB.price);
                const px = param.point.x;
                const py = param.point.y;
                const distA = (xA != null && yA != null) ? Math.hypot(px - xA, py - yA) : 1e9;
                const distB = (xB != null && yB != null) ? Math.hypot(px - xB, py - yB) : 1e9;
                // Smaller hit radius so empty-chart confirm is easy on desktop; still ok for finger
                const HIT = 36;
                // Tap away from both handles → final confirm / exit edit
                if (distA > HIT && distB > HIT) {
                  moveDiagRef.current = null;
                  setMovingId(null);
                  setMovingType(null);
                  setMode("none");
                  clearPreview();
                  lockChartInteraction(false);
                  setStatusMsg("✓ Confirmed");
                  return;
                }
                if (distA <= distB) {
                  md.phase = "drag-a";
                  setStatusMsg("Move start point — tap new position");
                } else {
                  md.phase = "drag-b";
                  setStatusMsg("Move end point — tap new position");
                }
                // Soft-lock chart pan only while placing the endpoint
                lockChartInteraction(true);
              } catch {
                // On error, treat as confirm/exit
                moveDiagRef.current = null;
                setMovingId(null);
                setMovingType(null);
                setMode("none");
                clearPreview();
                lockChartInteraction(false);
                setStatusMsg("✓ Confirmed");
              }
              return;
            }

            // Place the selected endpoint
            const t = resolveTime(param);
            if (t == null || Number.isNaN(t)) {
              setStatusMsg("Could not read time — try on chart");
              return;
            }
            if (md.phase === "drag-a") {
              md.pointA = { time: t, price: fp };
            } else {
              md.pointB = { time: t, price: fp };
            }
            // Ensure endpoints differ in time
            if (Math.abs(md.pointA.time - md.pointB.time) < 1) {
              const barSec = intervalToSeconds(String(intervalRef.current));
              if (md.phase === "drag-a") md.pointA.time = md.pointB.time - barSec;
              else md.pointB.time = md.pointA.time + barSec;
            }

            clickLockRef.current = true;
            setSaving(true);
            try {
              const patch: any = {
                price: md.pointA.price,
                start_time: md.pointA.time,
                end_time: md.pointB.time,
                end_price: md.pointB.price,
                color: md.color,
                width: md.width,
                dash: md.dash,
              };
              if (typ === "line") {
                const { error } = await supabase.from("chart_lines").update(patch).eq("id", id);
                if (error) {
                  await supabase.from("chart_lines").update({
                    price: md.pointA.price,
                    start_time: md.pointA.time,
                    note: `__diag:${md.pointB.time}:${md.pointB.price}`,
                    color: md.color,
                    width: md.width,
                    dash: md.dash,
                  }).eq("id", id);
                }
                setLines((prev) =>
                  prev.map((l) =>
                    l.id === id
                      ? {
                          ...l,
                          price: md.pointA.price,
                          start_time: md.pointA.time,
                          end_time: md.pointB.time,
                          end_price: md.pointB.price,
                          color: md.color,
                          width: md.width,
                          dash: md.dash,
                          style: md.dash,
                        }
                      : l
                  )
                );
              } else if (typ === "alarm") {
                const { error } = await supabase.from("alarms").update(patch).eq("id", id);
                if (error) {
                  await supabase.from("alarms").update({
                    price: md.pointA.price,
                    start_time: md.pointA.time,
                    note: `__diag:${md.pointB.time}:${md.pointB.price}`,
                    color: md.color,
                    width: md.width,
                    dash: md.dash,
                  }).eq("id", id);
                }
                setAlarms((prev) =>
                  prev.map((a) =>
                    a.id === id
                      ? {
                          ...a,
                          price: md.pointA.price,
                          start_time: md.pointA.time,
                          end_time: md.pointB.time,
                          end_price: md.pointB.price,
                          color: md.color,
                          width: md.width,
                          dash: md.dash,
                        }
                      : a
                  )
                );
              }
              // Stay in pick mode so user can adjust the other handle — unlock chart pan
              md.phase = "pick";
              lockChartInteraction(false);
              refreshHandles();
              setStatusMsg("Saved — tap handle to edit more, or tap empty chart / ✓ Done");
            } catch {
              setStatusMsg("Move failed");
            }
            setSaving(false);
            setTimeout(() => { clickLockRef.current = false; }, 300);
            return;
          }

          // ── Horizontal single-click move ──
          clickLockRef.current = true;
          try {
            if (typ === "line") {
              // Ray: also move origin (start_time) so user can place it further left/right
              const isRay = movingRayRef.current;
              const tMove = resolveTime(param);
              const patch: any = { price: fp };
              if (isRay && tMove != null && !Number.isNaN(tMove)) {
                patch.start_time = tMove;
              }
              const { error } = await supabase.from("chart_lines").update(patch).eq("id", id);
              if (error && patch.start_time != null) {
                await supabase
                  .from("chart_lines")
                  .update({ price: fp, note: `__ray:${patch.start_time}` })
                  .eq("id", id);
              }
              setLines((prev) =>
                prev.map((l) =>
                  l.id === id
                    ? {
                        ...l,
                        price: fp,
                        start_time:
                          isRay && tMove != null ? tMove : l.start_time,
                      }
                    : l
                )
              );
              setStatusMsg(isRay ? "Ray moved" : "Line moved");
            } else if (typ === "alarm") {
              const isRayAl = movingRayRef.current;
              const tMove = resolveTime(param);
              const patch: any = { price: fp };
              if (isRayAl && tMove != null && !Number.isNaN(tMove)) {
                patch.start_time = tMove;
              }
              await supabase.from("alarms").update(patch).eq("id", id);
              setAlarms((prev) =>
                prev.map((a) =>
                  a.id === id
                    ? {
                        ...a,
                        price: fp,
                        start_time:
                          isRayAl && tMove != null ? tMove : a.start_time,
                      }
                    : a
                )
              );
              setStatusMsg(isRayAl ? "Ray alarm moved" : "Alarm moved");
            }
            movingRayRef.current = false;
          } catch {
            setStatusMsg("Move failed");
          }
          moveDiagRef.current = null;
          setMovingId(null);
          setMovingType(null);
          setMode("none");
          clearPreview();
          setTimeout(() => { clickLockRef.current = false; }, 300);
          return;
        }

        // Diagonal / trend line (or alarm-diag): two clicks → segment A→B
        if (m === "diag" || m === "alarm-diag") {
          const t = resolveTime(param);
          if (t == null || Number.isNaN(t)) {
            setStatusMsg("Could not read time — try on chart area");
            return;
          }
          const start = diagStartRef.current;
          if (!start) {
            // ① First point fixed — set ref immediately so pointermove works without waiting for React
            diagStartRef.current = { time: t, price: fp };
            setDiagStart({ time: t, price: fp });
            setStatusMsg("① set — drag to ② then tap");
            lockChartInteraction(true);
            // Do NOT change visible range here — whitespace already provides future space;
            // expanding range on every draw was causing the chart to jump right.
            try {
              // Remove any horizontal preview line (we only want diagonal)
              if (previewLineRef.current) {
                try { series.removePriceLine(previewLineRef.current); } catch {}
                previewLineRef.current = null;
              }
              if (!previewDiagSeriesRef.current) {
                previewDiagSeriesRef.current = chart.addLineSeries({
                  color: drawColorRef.current,
                  lineWidth: Math.max(2, drawWidthRef.current) as 1 | 2 | 3 | 4,
                  lineStyle: LineStyle.Dashed,
                  priceLineVisible: false,
                  lastValueVisible: false,
                  crosshairMarkerVisible: true,
                });
              }
              const barSec = intervalToSeconds(String(intervalRef.current));
              previewDiagSeriesRef.current.setData([
                { time: t as any, value: fp },
                { time: (t + barSec) as any, value: fp },
              ]);
            } catch {}
            return;
          }
          // Need two distinct times (at least 1 bar apart)
          let endT = t;
          if (Math.abs(endT - start.time) < 1) {
            endT = start.time + intervalToSeconds(String(intervalRef.current));
          }
          // ② Second point — save segment (no extension)
          clickLockRef.current = true;
          setSaving(true);
          lockChartInteraction(false);
          const base: any = {
            symbol: symbolRef.current.toUpperCase(),
            price: start.price,
            color: drawColorRef.current,
            width: drawWidthRef.current,
            dash: drawDashRef.current,
            start_time: start.time,
            end_time: endT,
            end_price: fp,
          };

          // Alarm-diag: save into alarms table
          if (m === "alarm-diag") {
            const chosenColor = drawColorRef.current || DEFAULT_ALARM_COLOR;
            let payload: any = {
              symbol: base.symbol,
              price: base.price,
              condition: conditionRef.current,
              is_active: true,
              triggered: false,
              color: chosenColor,
              width: base.width,
              dash: base.dash,
              start_time: base.start_time,
              end_time: base.end_time,
              end_price: base.end_price,
              note: "Diag",
            };
            let { data, error } = await supabase.from("alarms").insert([payload]).select().single();
            if (error) {
              payload = {
                symbol: base.symbol,
                price: base.price,
                condition: conditionRef.current,
                is_active: true,
                triggered: false,
                color: chosenColor,
                note: `__diag:${base.start_time}:${base.end_time}:${base.end_price}`,
              };
              ({ data, error } = await supabase.from("alarms").insert([payload]).select().single());
            }
            if (!error && data) {
              const saved: Alarm = {
                ...(data as Alarm),
                color: (data as any).color || chosenColor,
                start_time: (data as any).start_time ?? base.start_time,
                end_time: (data as any).end_time ?? base.end_time,
                end_price: (data as any).end_price ?? base.end_price,
              };
              if (!isDiagonalLine(saved) && saved.note?.startsWith("__diag:")) {
                const parts = saved.note.replace(/^__diag:/, "").split("|")[0].split(":");
                if (parts.length >= 3) {
                  saved.start_time = Number(parts[0]);
                  saved.end_time = Number(parts[1]);
                  saved.end_price = Number(parts[2]);
                }
              }
              setAlarms((prev) => [saved, ...prev]);
              setStatusMsg("Diag alarm saved");
            } else setStatusMsg("Alarm save failed");
            diagStartRef.current = null;
            setDiagStart(null);
            setSaving(false);
            clearPreview();
            setMode("none");
            setAlarmMenuOpen(false);
            setTimeout(() => { clickLockRef.current = false; }, 300);
            return;
          }

          let payload = { ...base };
          let { data, error } = await supabase.from("chart_lines").insert([payload]).select().single();
          if (error) {
            // Schema may lack end_time / end_price — store meta in note as fallback
            payload = {
              symbol: base.symbol,
              price: base.price,
              color: base.color,
              width: base.width,
              dash: base.dash,
              start_time: base.start_time,
              note: `__diag:${base.end_time}:${base.end_price}`,
            };
            ({ data, error } = await supabase.from("chart_lines").insert([payload]).select().single());
          }
          if (error) {
            payload = {
              symbol: base.symbol,
              price: base.price,
              color: base.color,
              start_time: base.start_time,
              note: `__diag:${base.end_time}:${base.end_price}`,
            };
            ({ data, error } = await supabase.from("chart_lines").insert([payload]).select().single());
          }
          if (!error && data) {
            const saved: ChartLine = {
              ...(data as ChartLine),
              color: (data as any).color || base.color,
              end_time: (data as any).end_time ?? base.end_time,
              end_price: (data as any).end_price ?? base.end_price,
              start_time: (data as any).start_time ?? base.start_time,
            };
            // Parse note fallback if columns missing
            if (!isDiagonalLine(saved) && saved.note?.startsWith("__diag:")) {
              const parts = saved.note.split(":");
              if (parts.length >= 3) {
                saved.end_time = Number(parts[1]);
                saved.end_price = Number(parts[2]);
              }
            }
            setLines((prev) => [saved, ...prev]);
            setStatusMsg("Diag saved (A→B) — Alarm to convert");
          } else setStatusMsg("Save failed");
          diagStartRef.current = null;
          setDiagStart(null);
          setSaving(false);
          clearPreview();
          setMode("none");
          setTimeout(() => { clickLockRef.current = false; }, 300);
          return;
        }

        // If a finished measure is showing, any chart tap clears it
        if (measureDoneRef.current && measureSeriesRef.current) {
          measureStartRef.current = null;
          measureDoneRef.current = false;
          setMeasureStart(null);
          setMeasureEnd(null);
          try { chart.removeSeries(measureSeriesRef.current); } catch {}
          measureSeriesRef.current = null;
          if (handleAElRef.current) handleAElRef.current.style.display = "none";
          if (handleBElRef.current) handleBElRef.current.style.display = "none";
          if (measureHudRef.current) measureHudRef.current.style.display = "none";
          return;
        }

        // Measure: ① hollow dot + dashed · ② second → keep until next tap
        if (m === "measure") {
          const t = resolveTime(param);
          if (t == null || Number.isNaN(t)) return;
          const placeDot = (el: HTMLDivElement | null, time: number, price: number) => {
            if (!el) return;
            try {
              const x = chart.timeScale().timeToCoordinate(time as any);
              const y = series.priceToCoordinate(price);
              if (x == null || y == null) return;
              el.style.display = "block";
              el.style.left = `${x}px`;
              el.style.top = `${y}px`;
              el.style.borderColor = "#60a5fa";
            } catch {}
          };
          if (!measureStartRef.current) {
            measureStartRef.current = { time: t, price: fp };
            measureDoneRef.current = false;
            setMeasureStart({ time: t, price: fp });
            setMeasureEnd(null);
            placeDot(handleAElRef.current, t, fp);
            if (handleBElRef.current) handleBElRef.current.style.display = "none";
            lockChartInteraction(true);
            setStatusMsg("Measure: tap second point");
            return;
          }
          const a = measureStartRef.current;
          const b = { time: t, price: fp };
          setMeasureEnd(b);
          // Hide pixel dots after finish (they don't track pan/zoom)
          if (handleAElRef.current) handleAElRef.current.style.display = "none";
          if (handleBElRef.current) handleBElRef.current.style.display = "none";
          try {
            if (!measureSeriesRef.current) {
              measureSeriesRef.current = chart.addLineSeries({
                color: "#60a5fa",
                lineWidth: 2,
                lineStyle: LineStyle.Dashed,
                priceLineVisible: false,
                lastValueVisible: false,
                crosshairMarkerVisible: false,
              });
            }
            const pts = [
              { time: a.time as any, value: a.price },
              { time: b.time as any, value: b.price },
            ].sort((p, q) => Number(p.time) - Number(q.time));
            measureSeriesRef.current.setData(pts);
          } catch {}
          if (measureHudRef.current) {
            const dp = b.price - a.price;
            const pct = (dp / a.price) * 100;
            const sec = Math.abs(b.time - a.time);
            const barSec = intervalToSeconds(String(intervalRef.current));
            const bars = barSec > 0 ? Math.max(1, Math.round(sec / barSec)) : 0;
            const h = Math.floor(sec / 3600);
            const mi = Math.floor((sec % 3600) / 60);
            const timeStr = h > 0 ? `${h}h ${mi}m` : `${mi}m`;
            measureHudRef.current.style.display = "block";
            measureHudRef.current.innerHTML =
              `<div class="font-semibold">${dp >= 0 ? "+" : ""}${formatPrice(dp)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)</div>` +
              `<div class="opacity-90 mt-0.5">${bars} bars · ${timeStr}</div>`;
          }
          measureStartRef.current = null;
          measureDoneRef.current = true; // next chart tap clears
          lockChartInteraction(false);
          requestAnimationFrame(() => {
            setMode("none");
            setStatusMsg("");
          });
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
            // Always resolve time from click (works on empty/future area too)
            const t = resolveTime(param);
            if (t != null && !Number.isNaN(t)) base.start_time = t;
          }
          let payload = { ...base };
          let { data, error } = await supabase.from("chart_lines").insert([payload]).select().single();
          if (error && m === "ray" && base.start_time != null) {
            // Schema may lack start_time — keep it in note fallback
            payload = {
              symbol: base.symbol,
              price: base.price,
              color: base.color,
              width: base.width,
              dash: base.dash,
              note: `__ray:${base.start_time}`,
            };
            ({ data, error } = await supabase.from("chart_lines").insert([payload]).select().single());
          }
          if (error) {
            payload = { symbol: base.symbol, price: base.price, color: base.color, width: base.width };
            ({ data, error } = await supabase.from("chart_lines").insert([payload]).select().single());
          }
          if (error) {
            payload = { symbol: base.symbol, price: base.price, color: base.color };
            ({ data, error } = await supabase.from("chart_lines").insert([payload]).select().single());
          }
          if (!error && data) {
            const saved: ChartLine = {
              ...(data as ChartLine),
              color: (data as any).color || base.color,
              // Preserve ray origin even if DB dropped the column
              start_time: (data as any).start_time ?? base.start_time ?? null,
            };
            if (saved.start_time == null && saved.note?.startsWith("__ray:")) {
              const n = Number(saved.note.replace("__ray:", ""));
              if (!Number.isNaN(n)) saved.start_time = n;
            }
            modeRef.current = "none";
            setMode("none");
            clearPreview();
            setLines((prev) => [saved, ...prev]);
            setStatusMsg(m === "ray" ? "Ray saved" : "Line saved");
          } else {
            setStatusMsg("Save failed");
            modeRef.current = "none";
            setMode("none");
            clearPreview();
          }
          setSaving(false);
          setTimeout(() => { clickLockRef.current = false; }, 300);
          return;
        }

        // Alarm-ray: horizontal half-line alarm from click time → right
        if (m === "alarm-ray") {
          clickLockRef.current = true;
          setSaving(true);
          const chosenColor = drawColorRef.current || DEFAULT_ALARM_COLOR;
          const t = resolveTime(param);
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
          if (t != null && !Number.isNaN(t)) {
            payload.start_time = t;
            // Always dual-write ray origin into note (survives schema / history reloads)
            payload.note = `__ray:${t}`;
          }
          let { data, error } = await supabase.from("alarms").insert([payload]).select().single();
          if (error && payload.start_time != null) {
            // Column may not exist — note-only fallback
            delete payload.start_time;
            ({ data, error } = await supabase.from("alarms").insert([payload]).select().single());
          }
          if (error) {
            const minimal: any = {
              symbol: payload.symbol, price: payload.price, condition: payload.condition,
              is_active: true, triggered: false,
            };
            if (t != null && !Number.isNaN(t)) minimal.note = `__ray:${t}`;
            ({ data, error } = await supabase.from("alarms").insert([minimal]).select().single());
          }
          if (!error && data) {
            const saved: Alarm = {
              ...(data as Alarm),
              color: (data as any).color || chosenColor,
              start_time: (data as any).start_time ?? (t != null ? t : null),
              note: (data as any).note || (t != null ? `__ray:${t}` : null),
            };
            if (saved.start_time == null && saved.note?.startsWith("__ray:")) {
              const n = Number(saved.note.replace("__ray:", ""));
              if (!Number.isNaN(n)) saved.start_time = n;
            }
            // Drop mode first so pointermove rAF cannot recreate preview
            modeRef.current = "none";
            setMode("none");
            setAlarmMenuOpen(false);
            clearPreview();
            setAlarms((prev) => [saved, ...prev]);
            setStatusMsg("Ray alarm saved");
          } else {
            setStatusMsg("Alarm save failed");
            modeRef.current = "none";
            setMode("none");
            clearPreview();
          }
          setSaving(false);
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

  // Apply timezone change live — preserve visible range (don't jump to empty future)
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    let saved: any = null;
    try {
      saved = chart.timeScale().getVisibleLogicalRange();
    } catch {}
    try {
      chart.applyOptions({
        localization: makeLocalization(timeZone),
        timeScale: {
          tickMarkFormatter: makeTickMarkFormatter(timeZone) as any,
        },
      });
      // Restore range so chart doesn't jump into empty whitespace
      if (saved) {
        requestAnimationFrame(() => {
          try {
            chart.timeScale().setVisibleLogicalRange(saved);
          } catch {}
        });
      }
    } catch {}
  }, [timeZone]);

  // Resize chart when side list is shown/hidden — keep future time strip
  useEffect(() => {
    const t = setTimeout(() => {
      if (chartRef.current && chartContainerRef.current) {
        chartRef.current.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight || 640,
        });
        try {
          const bars = candlesRef.current.length;
          if (bars > 2) {
            chartRef.current.timeScale().applyOptions({ rightOffset: 4 });
            const past = Math.min(70, bars);
            chartRef.current.timeScale().setVisibleLogicalRange({
              from: bars - past,
              to: bars - 1 + FUTURE_VISIBLE,
            });
          }
        } catch {}
      }
    }, 50);
    return () => clearTimeout(t);
  }, [showSideWl, showToolsPanel]);

  // Close TF / timezone / list / indicator menus when clicking outside
  useEffect(() => {
    const anyIndPanel =
      showIndicatorMenu ||
      smaSettings ||
      pivotSettings ||
      trendSettings ||
      rsiSettings ||
      dmiSettings ||
      hideMenuOpen ||
      trashMenuOpen;
    if (!tfMenuOpen && !tzMenuOpen && !openMenu && !anyIndPanel) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      const el = t as HTMLElement;
      if (tfMenuOpen && tfMenuRef.current && !tfMenuRef.current.contains(t)) setTfMenuOpen(false);
      if (tzMenuOpen && tzMenuRef.current && !tzMenuRef.current.contains(t)) setTzMenuOpen(false);
      if (openMenu) {
        if (!el.closest?.("[data-menu]")) setOpenMenu(null);
      }
      // Indicator list + gear settings + hide/trash menus: close when clicking outside
      if (anyIndPanel && !el.closest?.("[data-ind-panel]")) {
        setShowIndicatorMenu(false);
        setSmaSettings(false);
        setPivotSettings(false);
        setTrendSettings(false);
        setRsiSettings(false);
        setDmiSettings(false);
        setHideMenuOpen(false);
        setTrashMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [
    tfMenuOpen,
    tzMenuOpen,
    openMenu,
    showIndicatorMenu,
    smaSettings,
    pivotSettings,
    trendSettings,
    rsiSettings,
    dmiSettings,
    hideMenuOpen,
    trashMenuOpen,
  ]);

  // Refresh last-price axis label when timezone / TF changes
  useEffect(() => {
    applyLastPriceLabel();
  }, [timeZone, interval, applyLastPriceLabel]);

  // Tick countdown every second (counts DOWN like TradingView)
  useEffect(() => {
    const id = window.setInterval(() => {
      applyLastPriceLabel();
    }, 1000);
    return () => clearInterval(id);
  }, [applyLastPriceLabel, symbol, interval]);

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
    hideIndicators,
    rebuildIndicators,
  ]);

  useEffect(() => {
    (async () => {
      const { data: a } = await supabase.from("alarms").select("*").order("created_at", { ascending: false });
      if (a) {
        setAlarms(
          (a as Alarm[]).map((row) => {
            if (isDiagonalLine(row)) return row;
            if (row.note?.startsWith("__diag:")) {
              const body = row.note.replace(/^__diag:/, "").split("|")[0];
              const parts = body.split(":");
              if (parts.length >= 3) {
                return {
                  ...row,
                  start_time: Number(parts[0]),
                  end_time: Number(parts[1]),
                  end_price: Number(parts[2]),
                };
              }
            }
            if (row.note?.startsWith("__ray:") && row.start_time == null) {
              const n = Number(row.note.replace("__ray:", ""));
              if (!Number.isNaN(n)) return { ...row, start_time: n };
            }
            return row;
          })
        );
      }
      const { data: l } = await supabase.from("chart_lines").select("*").order("created_at", { ascending: false });
      if (l) {
        setLines(
          (l as ChartLine[]).map((row) => {
            if (isDiagonalLine(row)) return row;
            if (row.note?.startsWith("__diag:")) {
              const parts = row.note.split(":");
              if (parts.length >= 3) {
                return {
                  ...row,
                  end_time: Number(parts[1]),
                  end_price: Number(parts[2]),
                };
              }
            }
            if (row.note?.startsWith("__ray:") && row.start_time == null) {
              const n = Number(row.note.replace("__ray:", ""));
              if (!Number.isNaN(n)) return { ...row, start_time: n };
            }
            return row;
          })
        );
      }
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
      let addedNew = false;
      for (const c of fresh) {
        const idx = candles.findIndex((x: any) => x.time === c.time);
        if (idx >= 0) {
          candles[idx] = c;
          try { series.update(c as any); } catch {}
        } else if (!candles.length || c.time > candles[candles.length - 1].time) {
          candles.push(c);
          addedNew = true;
          try { series.update(c as any); } catch {}
        }
      }
      candlesRef.current = candles;
      // New bar consumed one whitespace slot — rebuild trailing future strip
      // without shifting the user's current view
      if (addedNew) {
        try {
          const chart = chartRef.current;
          let lr: { from: number; to: number } | null = null;
          try {
            const r = chart?.timeScale().getVisibleLogicalRange();
            if (r) lr = { from: r.from, to: r.to };
          } catch {}
          series.setData(appendFutureWhitespace(candles, String(intervalRef.current)) as any);
          if (lr && chart) {
            try { chart.timeScale().setVisibleLogicalRange(lr); } catch {}
          }
        } catch {}
      }

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

  /**
   * Local hit: notify immediately + mark triggered + ask server to send Telegram & Web Push.
   * (Previously client marked triggered without notifying Telegram → missed messages.)
   */
  const triggerAlarmLocal = useCallback(async (a: Alarm, price: number) => {
    const nowIso = new Date().toISOString();
    setAlarms((p) =>
      p.map((x) =>
        x.id === a.id
          ? { ...x, triggered: true, is_active: false, last_price: price, triggered_at: nowIso }
          : x
      )
    );
    try {
      await supabase
        .from("alarms")
        .update({
          triggered: true,
          is_active: false,
          last_price: price,
          triggered_at: nowIso,
        })
        .eq("id", a.id);
    } catch {}

    if (!notifiedAlarmsRef.current.has(a.id)) {
      notifiedAlarmsRef.current.add(a.id);
      showLocalNotification(`${a.symbol}`, `Alarm hit @ ${a.price}  now ${price}`);
    }

    // Ask Edge Function to send Telegram + Web Push for this alarm (even though already marked)
    try {
      await supabase.functions.invoke("check-alarms", {
        body: { notify_alarm_id: a.id, price },
      });
    } catch (e) {
      console.warn("notify invoke failed", e);
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
          const normalizeAlarm = (row: Alarm): Alarm => {
            if (isDiagonalLine(row)) return row;
            if (row.note?.startsWith("__diag:")) {
              const body = row.note.replace(/^__diag:/, "").split("|")[0];
              const parts = body.split(":");
              if (parts.length >= 3) {
                return {
                  ...row,
                  start_time: Number(parts[0]),
                  end_time: Number(parts[1]),
                  end_price: Number(parts[2]),
                };
              }
            }
            // Ray half-line encoded in note
            if (row.start_time == null && row.note?.startsWith("__ray:")) {
              const n = Number(row.note.replace("__ray:", ""));
              if (!Number.isNaN(n)) return { ...row, start_time: n };
            }
            return row;
          };
          setAlarms((prev) => {
            const byId = new Map(allAlarms.map((a: any) => [a.id, normalizeAlarm(a as Alarm)]));
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
                // keep local diagonal geometry if DB row stripped columns
                start_time: db.start_time ?? local.start_time,
                end_time: db.end_time ?? local.end_time,
                end_price: db.end_price ?? local.end_price,
                triggered: !!db.triggered,
                is_active: !!db.is_active && !db.triggered,
              };
            });
            // add any new alarms from DB not in local
            for (const db of allAlarms as Alarm[]) {
              const n = normalizeAlarm(db);
              if (!merged.some((m) => m.id === n.id)) merged.push(n);
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
              // Diagonal alarm: project price at "now" from the two endpoints
              let target = a.price;
              if (isDiagonalLine(a)) {
                const nowT = Math.floor(Date.now() / 1000);
                // Only active while "now" is within the segment time span
                const st = Number(a.start_time);
                const et = Number(a.end_time);
                const tMin = Math.min(st, et);
                const tMax = Math.max(st, et);
                if (nowT < tMin || nowT > tMax + 60) continue;
                target = projectedPriceOnDiag(st, Number(a.price), et, Number(a.end_price), nowT);
              }
              // Precision: only last-price cross (prev → price).
              // Never use chart-TF candle high/low — on 1h/4h a wick inside the bar
              // would false-trigger even when price never actually crossed the level.
              if (prev == null || Number.isNaN(prev)) continue;
              if (didCross(a.condition, target, prev, price)) {
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
  const deleteAllLines = async () => {
    const list = lines.filter((l) => l.symbol.toUpperCase() === symbolUpper);
    if (!list.length) return;
    if (!confirm(`Delete all ${list.length} lines on ${symbolUpper}?`)) return;
    const ids = list.map((l) => l.id);
    setLines((prev) => prev.filter((l) => !ids.includes(l.id)));
    try {
      await supabase.from("chart_lines").delete().in("id", ids);
    } catch {}
  };
  const deleteAllAlarmsOnSymbol = async () => {
    const list = alarms.filter(
      (a) => a.symbol.toUpperCase() === symbolUpper && a.is_active && !a.triggered
    );
    if (!list.length) return;
    if (!confirm(`Delete all ${list.length} active alarms on ${symbolUpper}?`)) return;
    const ids = list.map((a) => a.id);
    setAlarms((prev) => prev.filter((a) => !ids.includes(a.id)));
    try {
      await supabase.from("alarms").delete().in("id", ids);
    } catch {}
  };
  const clearAllIndicators = () => {
    if (!confirm("Remove all indicators from chart?")) return;
    setShowSMA(false);
    setShowPivot(false);
    setShowTrend(false);
    setShowRSI(false);
    setShowDMI(false);
    setShowVol(false);
  };
  const clearMeasure = () => {
    measureStartRef.current = null;
    measureDoneRef.current = false;
    setMeasureStart(null);
    setMeasureEnd(null);
    if (measureSeriesRef.current && chartRef.current) {
      try { chartRef.current.removeSeries(measureSeriesRef.current); } catch {}
      measureSeriesRef.current = null;
    }
    if (handleAElRef.current) handleAElRef.current.style.display = "none";
    if (handleBElRef.current) handleBElRef.current.style.display = "none";
    if (measureHudRef.current) measureHudRef.current.style.display = "none";
    // Unlock chart scroll/scale (lockChartInteraction lives inside loadCandles)
    try {
      chartRef.current?.applyOptions({
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
        handleScale: { axisPressedMouseMove: true, axisDoubleClickReset: true, mouseWheel: true, pinch: true },
      });
      if (chartContainerRef.current) chartContainerRef.current.style.touchAction = "";
      document.body.style.overflow = "";
      document.documentElement.style.overflow = "";
    } catch {}
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
      // Resolve diagonal / ray geometry (columns or note fallback)
      let startTime = line.start_time ?? null;
      let endTime = line.end_time ?? null;
      let endPrice = line.end_price ?? null;
      if ((!endTime || endPrice == null) && line.note?.startsWith("__diag:")) {
        const parts = line.note.replace(/^__diag:/, "").split("|")[0].split(":");
        if (parts.length >= 3) {
          startTime = startTime ?? Number(parts[0]);
          endTime = Number(parts[1]);
          endPrice = Number(parts[2]);
        }
      }
      // Ray stored as start_time only, or note `__ray:unix`
      if (startTime == null && line.note?.startsWith("__ray:")) {
        const n = Number(line.note.replace("__ray:", ""));
        if (!Number.isNaN(n)) startTime = n;
      }
      const isDiag =
        startTime != null &&
        endTime != null &&
        endPrice != null &&
        Number(endTime) !== Number(startTime);
      // Half-line (ray): has origin time but is NOT a diagonal
      const isRay = !isDiag && startTime != null;
      const noteClean =
        line.note &&
        !line.note.startsWith("__diag:") &&
        !line.note.startsWith("__ray:")
          ? line.note
          : isDiag
          ? "Diag"
          : isRay
          ? null
          : line.note || null;

      const payload: any = {
        symbol: line.symbol,
        price: line.price,
        condition: "cross",
        is_active: true,
        triggered: false,
        color: chosenColor,
        width: line.width || 2,
        dash: line.dash || "solid",
        note: noteClean,
      };
      if (isDiag) {
        payload.start_time = startTime;
        payload.end_time = endTime;
        payload.end_price = endPrice;
      } else if (isRay) {
        // Keep half-line geometry on the alarm (column + note backup)
        payload.start_time = startTime;
        payload.note = `__ray:${startTime}`;
      }
      let { data, error } = await supabase.from("alarms").insert([payload]).select().single();
      if (error && isDiag) {
        const fallbackNote = `__diag:${startTime}:${endTime}:${endPrice}${noteClean && noteClean !== "Diag" ? "|" + noteClean : ""}`;
        payload.note = fallbackNote;
        delete payload.start_time;
        delete payload.end_time;
        delete payload.end_price;
        ({ data, error } = await supabase.from("alarms").insert([payload]).select().single());
      }
      if (error && isRay) {
        // Schema may lack start_time — note-only
        delete payload.start_time;
        payload.note = `__ray:${startTime}`;
        ({ data, error } = await supabase.from("alarms").insert([payload]).select().single());
      }
      if (error) {
        const minimal: any = {
          symbol: line.symbol,
          price: line.price,
          condition: "cross",
          is_active: true,
          triggered: false,
          note: isDiag
            ? `__diag:${startTime}:${endTime}:${endPrice}`
            : isRay
            ? `__ray:${startTime}`
            : noteClean,
        };
        ({ data, error } = await supabase.from("alarms").insert([minimal]).select().single());
      }
      if (error || !data) {
        setStatusMsg("Convert failed");
        return;
      }
      const saved: Alarm = {
        ...(data as Alarm),
        color: (data as any).color || chosenColor,
        width: (data as any).width || payload.width,
        dash: (data as any).dash || payload.dash,
        note: (data as any).note || payload.note,
        start_time:
          (data as any).start_time ?? (isDiag || isRay ? startTime : null),
        end_time: (data as any).end_time ?? (isDiag ? endTime : null),
        end_price: (data as any).end_price ?? (isDiag ? endPrice : null),
      };
      // Parse note-encoded geometry if columns missing
      if (!isDiagonalLine(saved) && saved.note?.startsWith("__diag:")) {
        const parts = saved.note.replace(/^__diag:/, "").split("|")[0].split(":");
        if (parts.length >= 3) {
          saved.start_time = Number(parts[0]);
          saved.end_time = Number(parts[1]);
          saved.end_price = Number(parts[2]);
        }
      }
      if (saved.start_time == null && saved.note?.startsWith("__ray:")) {
        const n = Number(saved.note.replace("__ray:", ""));
        if (!Number.isNaN(n)) saved.start_time = n;
      }
      setAlarms((prev) => [saved, ...prev]);
      await supabase.from("chart_lines").delete().eq("id", line.id);
      setLines((prev) => prev.filter((l) => l.id !== line.id));
      setStatusMsg(
        isDiag ? "Diagonal alarm active" : isRay ? "Ray alarm active" : "Converted to alarm"
      );
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

  // Auto-register push if permission already granted (e.g. returning user on iPad PWA)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("Notification" in window)) {
      setPushStatus("unsupported");
      return;
    }
    if (Notification.permission === "granted") {
      ensurePushSubscription().then(setPushStatus);
    } else if (Notification.permission === "denied") {
      setPushStatus("denied");
    }
  }, []);

  const enablePushNotifications = async () => {
    setPushStatus("idle");
    const result = await ensurePushSubscription();
    setPushStatus(result);
    if (result === "ok") setStatusMsg("Push notifications enabled");
    else if (result === "denied") setStatusMsg("Notification permission denied");
    else if (result === "no-key") setStatusMsg("Missing VAPID key — see setup");
    else if (result === "unsupported") setStatusMsg("Push not supported on this browser");
    else setStatusMsg("Push setup failed");
  };

  const disablePushNotifications = async () => {
    try {
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          const endpoint = sub.endpoint;
          await sub.unsubscribe();
          try {
            await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
          } catch {}
        }
      }
    } catch {}
    setPushStatus("idle");
    setStatusMsg("Push notifications disabled");
  };

  const historyAlarms = useMemo(() => {
    return alarms
      .filter((a) => a.symbol.toUpperCase() === symbolUpper && a.triggered)
      .sort((a, b) => {
        const ta = new Date(a.triggered_at || a.created_at || 0).getTime();
        const tb = new Date(b.triggered_at || b.created_at || 0).getTime();
        return tb - ta;
      })
      .slice(0, 30);
  }, [alarms, symbolUpper]);

  return (
    <div className="min-h-screen bg-[#0b0e11] text-gray-100 p-3">
      <style>{`
        @keyframes tfPop{
          0%{opacity:0;transform:translateY(10px) scale(0.85)}
          60%{opacity:1;transform:translateY(-2px) scale(1.02)}
          100%{opacity:1;transform:translateY(0) scale(1)}
        }
        input[type="color"]{-webkit-appearance:none;appearance:none;border:none;padding:0;background:transparent;cursor:pointer}
        input[type="color"]::-webkit-color-swatch-wrapper{padding:0;border-radius:9999px}
        input[type="color"]::-webkit-color-swatch{border:none;border-radius:9999px}
        input[type="color"]::-moz-color-swatch{border:none;border-radius:9999px}
      `}</style>
      {/* Header — Live Chart + symbol search together on the left */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <h1 className="text-lg font-semibold text-gray-200">Live Chart</h1>
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
          onKeyDown={(e) => e.key === "Enter" && loadCandles()}
          className="bg-gray-900/90 border border-gray-600 rounded-full px-4 py-1.5 text-sm w-32 font-mono text-center tracking-wide shadow-inner focus:outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500/40 transition-colors"
          title="Symbol"
        />
        <div className="flex-1" />
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
              onClick={() => { setTfMenuOpen((v) => !v); setTzMenuOpen(false); setOpenMenu(null); }}
              className={`h-8 px-2.5 text-xs rounded-lg inline-flex items-center gap-1.5 border transition-all duration-200 ${
                tfMenuOpen
                  ? "bg-orange-500/20 border-orange-500 text-orange-300 shadow-lg"
                  : "bg-gray-900 border-gray-700 text-gray-300 hover:bg-white/10"
              }`}
              title="Timeframes"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="9" />
                <polyline points="12 7 12 12 15 14" />
              </svg>
              <span className="font-medium">Time</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`transition-transform duration-200 ${tfMenuOpen ? "rotate-180" : ""}`} aria-hidden>
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {tfMenuOpen && (
              <div
                className="absolute z-50 top-full right-0 mt-1.5 border border-white/20 rounded-2xl py-1.5 shadow-[0_8px_40px_rgba(0,0,0,0.5)] overflow-hidden isolate min-w-[160px]"
                style={{
                  animation: "tfPop 0.28s cubic-bezier(0.34,1.3,0.64,1)",
                  background: "rgba(20,20,22,0.42)",
                  backdropFilter: "blur(40px) saturate(200%)",
                  WebkitBackdropFilter: "blur(40px) saturate(200%)",
                }}
              >
                {ALL_TIMEFRAMES.map((t) => (
                  <div key={t.value} className="flex items-center">
                    <button
                      type="button"
                      onClick={() => { setIntervalTf(t.value); setTfMenuOpen(false); }}
                      className={`flex-1 text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-white/10 ${
                        interval === t.value ? "text-orange-300" : "text-gray-200"
                      }`}
                    >
                      <span className="w-3 text-orange-400">{interval === t.value ? "✓" : ""}</span>
                      <span>{t.label}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleFavTf(t.value)}
                      className="w-8 h-8 flex items-center justify-center text-yellow-400 text-sm rounded hover:bg-white/10"
                    >
                      {favTfs.includes(t.value) ? "★" : "☆"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        {/* Left tools — fully hidden when collapsed (chart expands like side list) */}
        {showToolsPanel && (
          <div className="flex flex-col gap-1 shrink-0">
            {/* Hide tools — same idea as « Hide on coin list */}
            <button
              type="button"
              title="Hide tools"
              onClick={() => {
                setShowToolsPanel(false);
                setAlarmMenuOpen(false);
                setShowIndicatorMenu(false);
                setMode("none");
                setDiagStart(null);
              }}
              className="w-9 h-9 rounded-lg flex items-center justify-center border bg-gray-900 border-gray-700 text-gray-400 hover:bg-white/10 hover:text-white transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>

            {/* Alarm — top of tool list */}
            <div className="relative">
              <button
                type="button"
                title="Alarm"
                onClick={() => {
                  setAlarmMenuOpen((v) => !v);
                  if (alarmMenuOpen) {
                    setMode("none");
                    setDiagStart(null);
                  }
                  setMovingId(null);
                  setMovingType(null);
                }}
                className={`w-9 h-9 rounded-lg flex items-center justify-center border transition-colors ${
                  alarmMenuOpen || mode === "alarm" || mode === "alarm-ray" || mode === "alarm-diag"
                    ? "bg-orange-500/20 border-orange-500 text-orange-300"
                    : "bg-gray-900 border-gray-700 text-gray-300 hover:bg-white/10"
                }`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
              </button>
              {alarmMenuOpen && (
                <div
                  className="absolute left-full top-0 ml-1.5 flex flex-col gap-1 z-30"
                  style={{ animation: "tfPop 0.22s cubic-bezier(0.34,1.3,0.64,1)" }}
                >
                  <button
                    type="button"
                    title="Full line alarm"
                    onClick={() => {
                      clearPreview();
                      setMode("alarm");
                      setAlarmMenuOpen(false);
                      setDiagStart(null);
                      setStatusMsg("Tap chart for full-line alarm");
                    }}
                    className={`w-9 h-9 rounded-lg flex items-center justify-center border transition-colors ${
                      mode === "alarm"
                        ? "bg-orange-500/20 border-orange-500 text-orange-300"
                        : "bg-gray-900 border-gray-700 text-gray-300 hover:bg-white/10"
                    }`}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <line x1="3" y1="12" x2="21" y2="12" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    title="Half-line (ray) alarm"
                    onClick={() => {
                      clearPreview();
                      setMode("alarm-ray");
                      setAlarmMenuOpen(false);
                      setDiagStart(null);
                      setStatusMsg("Tap chart for ray alarm");
                    }}
                    className={`w-9 h-9 rounded-lg flex items-center justify-center border transition-colors ${
                      mode === "alarm-ray"
                        ? "bg-orange-500/20 border-orange-500 text-orange-300"
                        : "bg-gray-900 border-gray-700 text-gray-300 hover:bg-white/10"
                    }`}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <line x1="4" y1="12" x2="20" y2="12" />
                      <circle cx="4" cy="12" r="2" fill="currentColor" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    title="Diagonal alarm"
                    onClick={() => {
                      clearPreview();
                      setMode("alarm-diag");
                      setAlarmMenuOpen(false);
                      setDiagStart(null);
                      setStatusMsg("Tap two points for diagonal alarm");
                    }}
                    className={`w-9 h-9 rounded-lg flex items-center justify-center border transition-colors ${
                      mode === "alarm-diag"
                        ? "bg-orange-500/20 border-orange-500 text-orange-300"
                        : "bg-gray-900 border-gray-700 text-gray-300 hover:bg-white/10"
                    }`}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <line x1="4" y1="18" x2="20" y2="6" />
                      <circle cx="4" cy="18" r="1.5" fill="currentColor" />
                      <circle cx="20" cy="6" r="1.5" fill="currentColor" />
                    </svg>
                  </button>
                </div>
              )}
            </div>

            {/* Horizontal line (draw) */}
            <button
              type="button"
              title="Horizontal line"
              onClick={() => {
                setMode(mode === "draw" ? "none" : "draw");
                setMovingId(null);
                setMovingType(null);
                setDiagStart(null);
              }}
              className={`w-9 h-9 rounded-lg flex items-center justify-center border transition-colors ${
                mode === "draw"
                  ? "bg-orange-500/20 border-orange-500 text-orange-300"
                  : "bg-gray-900 border-gray-700 text-gray-300 hover:bg-white/10"
              }`}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="3" y1="12" x2="21" y2="12" />
              </svg>
            </button>

            {/* Horizontal ray */}
            <button
              type="button"
              title="Horizontal ray"
              onClick={() => {
                clearPreview();
                setMode(mode === "ray" ? "none" : "ray");
                setMovingId(null);
                setMovingType(null);
                setDiagStart(null);
              }}
              className={`w-9 h-9 rounded-lg flex items-center justify-center border transition-colors ${
                mode === "ray"
                  ? "bg-orange-500/20 border-orange-500 text-orange-300"
                  : "bg-gray-900 border-gray-700 text-gray-300 hover:bg-white/10"
              }`}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="4" y1="12" x2="18" y2="12" />
                <polyline points="14,8 18,12 14,16" />
              </svg>
            </button>

            {/* Trendline / diagonal */}
            <button
              type="button"
              title="Trendline (2 clicks)"
              onClick={() => {
                setMode(mode === "diag" ? "none" : "diag");
                setMovingId(null);
                setMovingType(null);
                if (mode === "diag") setDiagStart(null);
              }}
              className={`w-9 h-9 rounded-lg flex items-center justify-center border transition-colors ${
                mode === "diag"
                  ? "bg-orange-500/20 border-orange-500 text-orange-300"
                  : "bg-gray-900 border-gray-700 text-gray-300 hover:bg-white/10"
              }`}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="4" y1="18" x2="20" y2="6" />
                <circle cx="4" cy="18" r="1.5" fill="currentColor" />
                <circle cx="20" cy="6" r="1.5" fill="currentColor" />
              </svg>
            </button>

            {/* Indicators */}
            <button
              type="button"
              data-ind-panel
              title="Indicators"
              onClick={() => setShowIndicatorMenu((v) => !v)}
              className={`w-9 h-9 rounded-lg flex items-center justify-center border transition-colors ${
                showIndicatorMenu
                  ? "bg-blue-500/20 border-blue-500 text-blue-300"
                  : "bg-gray-900 border-gray-700 text-gray-300 hover:bg-white/10"
              }`}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <line x1="6" y1="20" x2="6" y2="10" />
                <line x1="12" y1="20" x2="12" y2="4" />
                <line x1="18" y1="20" x2="18" y2="14" />
              </svg>
            </button>

            {/* Measure — classic ruler icon */}
            <button
              type="button"
              title="Measure"
              onClick={() => {
                if (mode === "measure") {
                  setMode("none");
                  clearMeasure();
                } else {
                  setMode("measure");
                  clearMeasure();
                  setDiagStart(null);
                  setAlarmMenuOpen(false);
                  setStatusMsg("Measure: tap first point");
                }
              }}
              className={`w-9 h-9 rounded-lg flex items-center justify-center border transition-colors ${
                mode === "measure"
                  ? "bg-orange-500/20 border-orange-500 text-orange-300"
                  : "bg-gray-900 border-gray-700 text-gray-300 hover:bg-white/10"
              }`}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="8" width="20" height="8" rx="1.2" />
                <line x1="6" y1="8" x2="6" y2="12" />
                <line x1="10" y1="8" x2="10" y2="11" />
                <line x1="14" y1="8" x2="14" y2="12" />
                <line x1="18" y1="8" x2="18" y2="11" />
              </svg>
            </button>

            {/* Eye — hide lines / alarms / indicators */}
            <div className="relative" data-ind-panel>
              <button
                type="button"
                title="Hide"
                onClick={() => { setHideMenuOpen((v) => !v); setTrashMenuOpen(false); }}
                className={`w-9 h-9 rounded-lg flex items-center justify-center border transition-colors ${
                  hideLines || hideIndicators || hideAlarms || hideMenuOpen
                    ? "bg-orange-500/20 border-orange-500 text-orange-300"
                    : "bg-gray-900 border-gray-700 text-gray-300 hover:bg-white/10"
                }`}
              >
                {hideLines && hideIndicators && hideAlarms ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
              {hideMenuOpen && (
                <div
                  data-ind-panel
                  className="absolute left-full top-0 ml-1.5 z-30 bg-gray-900/95 border border-gray-600 rounded-xl p-1.5 shadow-xl w-44"
                  style={{ animation: "tfPop 0.18s cubic-bezier(0.34,1.3,0.64,1)" }}
                >
                  <button
                    type="button"
                    onClick={() => setHideLines((v) => !v)}
                    className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center gap-2 hover:bg-white/10 ${
                      hideLines ? "text-orange-300" : "text-gray-200"
                    }`}
                  >
                    <span className="w-3 text-orange-400">{hideLines ? "✓" : ""}</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="12" x2="21" y2="12" /></svg>
                    Hide lines
                  </button>
                  <button
                    type="button"
                    onClick={() => setHideAlarms((v) => !v)}
                    className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center gap-2 hover:bg-white/10 ${
                      hideAlarms ? "text-orange-300" : "text-gray-200"
                    }`}
                  >
                    <span className="w-3 text-orange-400">{hideAlarms ? "✓" : ""}</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>
                    Hide alarms
                  </button>
                  <button
                    type="button"
                    onClick={() => setHideIndicators((v) => !v)}
                    className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center gap-2 hover:bg-white/10 ${
                      hideIndicators ? "text-orange-300" : "text-gray-200"
                    }`}
                  >
                    <span className="w-3 text-orange-400">{hideIndicators ? "✓" : ""}</span>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><line x1="6" y1="20" x2="6" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="18" y1="20" x2="18" y2="14" /></svg>
                    Hide indicators
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setHideLines(true);
                      setHideAlarms(true);
                      setHideIndicators(true);
                    }}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-gray-200 hover:bg-white/10 flex items-center gap-2"
                  >
                    <span className="w-3" />
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
                    Hide all
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setHideLines(false);
                      setHideAlarms(false);
                      setHideIndicators(false);
                      setHideMenuOpen(false);
                    }}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-green-400 hover:bg-white/10 flex items-center gap-2"
                  >
                    <span className="w-3" />
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                    Show all
                  </button>
                </div>
              )}
            </div>

            {/* Trash — choose lines / alarms / indicators */}
            <div className="relative" data-ind-panel>
              <button
                type="button"
                title="Delete"
                onClick={() => { setTrashMenuOpen((v) => !v); setHideMenuOpen(false); }}
                className={`w-9 h-9 rounded-lg flex items-center justify-center border transition-colors ${
                  trashMenuOpen
                    ? "bg-red-500/20 border-red-500 text-red-300"
                    : "bg-gray-900 border-gray-700 text-gray-400 hover:bg-red-950/50 hover:border-red-700 hover:text-red-400"
                }`}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
              {trashMenuOpen && (
                <div
                  data-ind-panel
                  className="absolute left-full top-0 ml-1.5 z-30 bg-gray-900/95 border border-gray-600 rounded-xl p-1.5 shadow-xl w-44"
                  style={{ animation: "tfPop 0.18s cubic-bezier(0.34,1.3,0.64,1)" }}
                >
                  <button
                    type="button"
                    onClick={() => { deleteAllLines(); setTrashMenuOpen(false); }}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-gray-200 hover:bg-red-950/40 hover:text-red-300 flex items-center gap-2"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="3" y1="12" x2="21" y2="12" /></svg>
                    Delete lines
                  </button>
                  <button
                    type="button"
                    onClick={() => { deleteAllAlarmsOnSymbol(); setTrashMenuOpen(false); }}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-gray-200 hover:bg-red-950/40 hover:text-red-300 flex items-center gap-2"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>
                    Delete alarms
                  </button>
                  <button
                    type="button"
                    onClick={() => { clearAllIndicators(); setTrashMenuOpen(false); }}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-gray-200 hover:bg-red-950/40 hover:text-red-300 flex items-center gap-2"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><line x1="6" y1="20" x2="6" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="18" y1="20" x2="18" y2="14" /></svg>
                    Delete indicators
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!confirm(`Delete ALL lines, alarms and indicators on ${symbolUpper}?`)) return;
                      const lineIds = lines.filter((l) => l.symbol.toUpperCase() === symbolUpper).map((l) => l.id);
                      const alarmIds = alarms
                        .filter((a) => a.symbol.toUpperCase() === symbolUpper && a.is_active && !a.triggered)
                        .map((a) => a.id);
                      if (lineIds.length) {
                        setLines((prev) => prev.filter((l) => !lineIds.includes(l.id)));
                        try { await supabase.from("chart_lines").delete().in("id", lineIds); } catch {}
                      }
                      if (alarmIds.length) {
                        setAlarms((prev) => prev.filter((a) => !alarmIds.includes(a.id)));
                        try { await supabase.from("alarms").delete().in("id", alarmIds); } catch {}
                      }
                      setShowSMA(false);
                      setShowPivot(false);
                      setShowTrend(false);
                      setShowRSI(false);
                      setShowDMI(false);
                      setShowVol(false);
                      setTrashMenuOpen(false);
                    }}
                    className="w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-red-400 hover:bg-red-950/50 flex items-center gap-2 border-t border-gray-700 mt-0.5 pt-2"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
                    Delete all
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Chart */}
        <div className="flex-1 min-w-0 relative">
          <div
            ref={chartContainerRef}
            className="w-full rounded-xl border border-gray-800 bg-black overflow-hidden"
            style={{ height: 640 }}
          />
          {/* Hollow circle handles for diagonal Move — overlay on chart */}
          <div
            ref={handleAElRef}
            className="absolute w-4 h-4 rounded-full border-2 border-white pointer-events-none z-20"
            style={{ display: "none", transform: "translate(-50%, -50%)", background: "transparent", boxShadow: "0 0 0 1px rgba(0,0,0,0.5)" }}
          />
          <div
            ref={handleBElRef}
            className="absolute w-4 h-4 rounded-full border-2 border-white pointer-events-none z-20"
            style={{ display: "none", transform: "translate(-50%, -50%)", background: "transparent", boxShadow: "0 0 0 1px rgba(0,0,0,0.5)" }}
          />

          <div className="absolute top-2 left-2 z-10 flex flex-col gap-1 pointer-events-auto">
            {!hideIndicators && showSMA && (
              <IndChip label="3SMA" visible={smaVisible} onToggleVisible={() => setSmaVisible((v) => !v)}
                onSettings={() => setSmaSettings((v) => !v)} onRemove={() => { setShowSMA(false); removeSMA(); }} />
            )}
            {!hideIndicators && showPivot && (
              <IndChip label="Pivot" visible={pivotVisible} onToggleVisible={() => setPivotVisible((v) => !v)}
                onSettings={() => setPivotSettings((v) => !v)} onRemove={() => { setShowPivot(false); removePivot(); }} />
            )}
            {!hideIndicators && showTrend && (
              <IndChip label="Trend" visible={trendVisible} onToggleVisible={() => setTrendVisible((v) => !v)}
                onSettings={() => setTrendSettings((v) => !v)} onRemove={() => { setShowTrend(false); removeTrend(); }} />
            )}
            {!hideIndicators && showRSI && (
              <IndChip label="RSI" visible={rsiVisible} onToggleVisible={() => setRsiVisible((v) => !v)}
                onSettings={() => setRsiSettings((v) => !v)} onRemove={() => { setShowRSI(false); removeRSI(); }} />
            )}
            {!hideIndicators && showDMI && (
              <IndChip label="DMI" visible={dmiVisible} onToggleVisible={() => setDmiVisible((v) => !v)}
                onSettings={() => setDmiSettings((v) => !v)} onRemove={() => { setShowDMI(false); removeDMI(); }} />
            )}
            {!hideIndicators && showVol && (
              <IndChip label="Vol" visible={volVisible} onToggleVisible={() => setVolVisible((v) => !v)}
                onRemove={() => { setShowVol(false); applyVolume(); }} />
            )}
          </div>

          {/* Measure HUD — updated via DOM during drag (no React lag) */}
          <div
            ref={measureHudRef}
            className="absolute top-14 left-1/2 -translate-x-1/2 z-30 bg-blue-600/95 text-white text-xs rounded-lg px-3 py-2 shadow-xl pointer-events-none tabular-nums"
            style={{ display: "none" }}
          />

          {showIndicatorMenu && (
            <div data-ind-panel className="absolute top-2 left-14 z-20 bg-gray-900/95 border border-gray-700 rounded-xl p-2 shadow-xl w-40">
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
                    it.on ? "bg-orange-500/20 text-orange-300" : "hover:bg-white/10"
                  }`}
                >
                  {it.on ? "✓ " : ""}{it.label}
                </button>
              ))}
            </div>
          )}

          {/* Style panel: color / width / dash — bottom-left of chart */}
          {(mode === "draw" ||
            mode === "ray" ||
            mode === "diag" ||
            mode === "alarm" ||
            mode === "alarm-ray" ||
            mode === "alarm-diag" ||
            mode === "move") && (
            <div className="absolute bottom-10 left-3 z-20 bg-gray-900/95 border border-gray-700 rounded-xl px-3 py-2 shadow-xl flex items-center gap-2">
              <div className="relative w-8 h-8 rounded-full overflow-hidden border-2 border-gray-500 shadow shrink-0" title="Color">
                <input
                  type="color"
                  value={drawColor}
                  onChange={(e) => {
                    const c = e.target.value;
                    setDrawColor(c);
                    // Live-apply style while editing a diagonal
                    const md = moveDiagRef.current;
                    if (mode === "move" && md) {
                      md.color = c;
                      try {
                        previewDiagSeriesRef.current?.applyOptions({ color: c });
                      } catch {}
                    }
                  }}
                  className="absolute -top-2 -left-2 w-12 h-12 cursor-pointer border-0 p-0"
                />
              </div>
              <div className="flex gap-1">
                {LINE_WIDTHS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => {
                      setDrawWidth(w);
                      const md = moveDiagRef.current;
                      if (mode === "move" && md) {
                        md.width = w;
                        try {
                          previewDiagSeriesRef.current?.applyOptions({ lineWidth: Math.max(2, w) as 1 | 2 | 3 | 4 });
                        } catch {}
                      }
                    }}
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
                onClick={() => {
                  setDrawDash((d) => {
                    const next = d === "solid" ? "dashed" : "solid";
                    const md = moveDiagRef.current;
                    if (mode === "move" && md) {
                      md.dash = next;
                      try {
                        previewDiagSeriesRef.current?.applyOptions({
                          lineStyle: next === "dashed" ? LineStyle.Dashed : LineStyle.Solid,
                        });
                      } catch {}
                    }
                    return next;
                  });
                }}
                className="px-2 py-1 rounded text-xs bg-gray-800 text-gray-300"
              >
                {drawDash === "solid" ? "——" : "- -"}
              </button>
              {(mode === "alarm" || mode === "alarm-ray" || mode === "alarm-diag") && (
                <select
                  value={condition}
                  onChange={(e) => setCondition(e.target.value as any)}
                  className="bg-gray-800 rounded px-1.5 py-1 text-xs"
                  title="Trigger condition"
                >
                  <option value="cross">Cross</option>
                  <option value="above">Above</option>
                  <option value="below">Below</option>
                </select>
              )}
              {previewPrice != null && (
                <span className="text-xs text-orange-300 font-mono">{formatPrice(previewPrice)}</span>
              )}
              {mode === "diag" && (
                <span className="text-xs text-amber-400">
                  {diagStart ? "② second point" : "① first point"}
                </span>
              )}
              {mode === "move" && (
                <>
                  <span className="text-xs text-amber-400">
                    {moveDiagRef.current ? "Edit handles" : "Click chart"}
                  </span>
                  <button
                    type="button"
                    onClick={async () => {
                      // Persist style (color/width/dash) if user only changed appearance
                      const md = moveDiagRef.current;
                      const id = movingIdRef.current;
                      const typ = movingTypeRef.current;
                      if (md && id) {
                        try {
                          const stylePatch: any = {
                            color: md.color,
                            width: md.width,
                            dash: md.dash,
                            price: md.pointA.price,
                            start_time: md.pointA.time,
                            end_time: md.pointB.time,
                            end_price: md.pointB.price,
                          };
                          if (typ === "line") {
                            await supabase.from("chart_lines").update(stylePatch).eq("id", id);
                            setLines((prev) =>
                              prev.map((l) =>
                                l.id === id
                                  ? { ...l, ...stylePatch, style: md.dash }
                                  : l
                              )
                            );
                          } else if (typ === "alarm") {
                            await supabase.from("alarms").update(stylePatch).eq("id", id);
                            setAlarms((prev) =>
                              prev.map((a) => (a.id === id ? { ...a, ...stylePatch } : a))
                            );
                          }
                        } catch {}
                      }
                      moveDiagRef.current = null;
                      setMovingId(null);
                      setMovingType(null);
                      setMode("none");
                      clearPreview();
                      try {
                        chartRef.current?.applyOptions({
                          handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
                          handleScale: { axisPressedMouseMove: true, axisDoubleClickReset: true, mouseWheel: true, pinch: true },
                        });
                        if (chartContainerRef.current) chartContainerRef.current.style.touchAction = "";
                        document.body.style.overflow = "";
                        document.documentElement.style.overflow = "";
                      } catch {}
                      setStatusMsg("✓ Confirmed");
                    }}
                    className="px-2.5 py-1 rounded-lg text-xs font-bold bg-green-500 text-black hover:bg-green-400"
                  >
                    ✓ Done
                  </button>
                </>
              )}
            </div>
          )}

          {smaSettings && showSMA && (
            <div data-ind-panel className="absolute top-2 left-28 z-20 bg-gray-900 border border-gray-700 rounded-xl p-3 shadow-xl w-52 text-sm">
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
            <div data-ind-panel className="absolute top-2 left-28 z-20 bg-gray-900 border border-gray-700 rounded-xl p-3 shadow-xl w-44 text-sm">
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
            <div data-ind-panel className="absolute top-2 left-28 z-20 bg-gray-900 border border-gray-700 rounded-xl p-3 shadow-xl w-48 text-sm">
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
            <div data-ind-panel className="absolute top-2 left-28 z-20 bg-gray-900 border border-gray-700 rounded-xl p-3 shadow-xl w-44 text-sm">
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
            <div data-ind-panel className="absolute top-2 left-28 z-20 bg-gray-900 border border-gray-700 rounded-xl p-3 shadow-xl w-48 text-sm">
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

          {/* Timezone selector under price scale (bottom-right) — same popover effect as Time menu */}
          <div className="absolute bottom-1 right-1 z-20" ref={tzMenuRef}>
            <button
              type="button"
              onClick={() => { setTzMenuOpen((v) => !v); setTfMenuOpen(false); setOpenMenu(null); }}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[10px] shadow transition-all duration-200 ${
                tzMenuOpen
                  ? "bg-orange-500 text-black border-orange-400 scale-105"
                  : "bg-gray-900/95 text-gray-200 border-gray-600 hover:bg-white/10"
              }`}
              title="Chart timezone"
            >
              <span>{TIMEZONES.find((z) => z.value === timeZone)?.label || "UTC"}</span>
              <span className={`transition-transform duration-200 ${tzMenuOpen ? "rotate-180" : ""}`}>▾</span>
            </button>
            {tzMenuOpen && (
              <div
                className="absolute right-0 bottom-full mb-1.5 z-50 border border-white/20 rounded-2xl py-1.5 shadow-[0_8px_40px_rgba(0,0,0,0.5)] overflow-hidden isolate min-w-[130px]"
                style={{
                  animation: "tfPop 0.28s cubic-bezier(0.34,1.3,0.64,1)",
                  background: "rgba(20,20,22,0.42)",
                  backdropFilter: "blur(40px) saturate(200%)",
                  WebkitBackdropFilter: "blur(40px) saturate(200%)",
                }}
              >
                {TIMEZONES.map((z) => (
                  <button
                    key={z.value}
                    type="button"
                    onClick={() => {
                      setTimeZone(z.value);
                      setTzMenuOpen(false);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-white/10 ${
                      timeZone === z.value ? "text-orange-300" : "text-gray-200"
                    }`}
                  >
                    <span className="w-3 text-orange-400">{timeZone === z.value ? "✓" : ""}</span>
                    <span>{z.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Floating Show tools when tools panel is hidden (chart wider) */}
          {!showToolsPanel && (
            <button
              type="button"
              onClick={() => setShowToolsPanel(true)}
              className="absolute top-2 left-2 z-30 px-2.5 py-1.5 text-xs rounded-lg bg-orange-500 text-black font-medium shadow-lg hover:bg-orange-400 border border-orange-300 inline-flex items-center gap-1.5"
              title="Show drawing tools"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 19l7-7 3 3-7 7-3-3z" />
                <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
              </svg>
              Tools
            </button>
          )}

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
                          : "hover:bg-white/10 border border-transparent"
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

      {/* Bottom lists: active alarms | lines | history */}
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div>
          <h3 className="text-sm font-medium text-green-400 mb-2">
            Alarms — {symbolUpper} ({currentAlarms.length})
          </h3>
          <div className="space-y-1.5">
            {currentAlarms.map((a) => (
              <div key={a.id} className="bg-gray-900 border border-gray-800 rounded-lg px-3 py-2">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-mono font-medium min-w-[110px] shrink-0" style={{ color: a.color || DEFAULT_ALARM_COLOR }}>
                    {isDiagonalLine(a)
                      ? `${getConditionSymbol(a.condition)} ↗ ${formatPrice(a.price)}→${formatPrice(Number(a.end_price))}`
                      : `${getConditionSymbol(a.condition)} ${formatPrice(a.price)}`}
                  </span>
                  {isDiagonalLine(a) && (
                    <span className="text-[10px] text-blue-400/80 shrink-0">Diag</span>
                  )}
                  {a.note && !a.note.startsWith("__diag:") && (
                    <span className="text-gray-500 text-xs truncate max-w-[70px]">{a.note}</span>
                  )}
                  <div className="ml-auto flex flex-wrap items-center gap-1.5 justify-end">
                    {/* Condition — same dark popover as timezone */}
                    <div className="relative" data-menu>
                      <button
                        type="button"
                        onClick={() => setOpenMenu(openMenu === `a-cond-${a.id}` ? null : `a-cond-${a.id}`)}
                        className={`px-1.5 py-0.5 rounded border text-[11px] transition-all ${
                          openMenu === `a-cond-${a.id}`
                            ? "bg-orange-500 text-black border-orange-400"
                            : "bg-gray-900/95 border-gray-600 text-gray-200"
                        }`}
                      >
                        {a.condition === "above" ? "Above" : a.condition === "below" ? "Below" : "Cross"} ▾
                      </button>
                      {openMenu === `a-cond-${a.id}` && (
                        <div className="absolute z-50 bottom-full mb-1 right-0 border border-white/20 rounded-2xl py-1.5 shadow-[0_8px_40px_rgba(0,0,0,0.5)] overflow-hidden isolate min-w-[100px]" style={{
                          animation: "tfPop 0.28s cubic-bezier(0.34,1.3,0.64,1)",
                          background: "rgba(20,20,22,0.42)",
                          backdropFilter: "blur(40px) saturate(200%)",
                          WebkitBackdropFilter: "blur(40px) saturate(200%)",
                        }}>
                          {(["cross", "above", "below"] as const).map((c) => (
                            <button key={c} type="button"
                              onClick={() => { updateAlarmCondition(a.id, c); setOpenMenu(null); }}
                              className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-white/10 ${a.condition === c ? "text-orange-300" : "text-gray-200"}`}
                            >
                              <span className="w-3 text-orange-400">{a.condition === c ? "✓" : ""}</span>
                              {c === "cross" ? "Cross" : c === "above" ? "Above" : "Below"}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {/* Round color */}
                    <div className="relative w-7 h-7 rounded-full overflow-hidden border-2 border-gray-500 shadow shrink-0" title="Color">
                      <input
                        type="color"
                        value={a.color || DEFAULT_ALARM_COLOR}
                        onChange={(e) => updateAlarmColor(a.id, e.target.value)}
                        className="absolute -top-2 -left-2 w-12 h-12 cursor-pointer border-0 p-0"
                      />
                    </div>
                    {/* Width popover */}
                    <div className="relative" data-menu>
                      <button
                        type="button"
                        onClick={() => setOpenMenu(openMenu === `a-w-${a.id}` ? null : `a-w-${a.id}`)}
                        className={`px-1.5 py-0.5 rounded border text-[11px] transition-all ${
                          openMenu === `a-w-${a.id}`
                            ? "bg-orange-500 text-black border-orange-400"
                            : "bg-gray-900/95 border-gray-600 text-gray-200"
                        }`}
                      >
                        W{a.width || 2} ▾
                      </button>
                      {openMenu === `a-w-${a.id}` && (
                        <div className="absolute z-50 bottom-full mb-1 left-1/2 -translate-x-1/2 border border-white/20 rounded-2xl py-1.5 shadow-[0_8px_40px_rgba(0,0,0,0.5)] overflow-hidden isolate min-w-[80px]" style={{
                          animation: "tfPop 0.28s cubic-bezier(0.34,1.3,0.64,1)",
                          background: "rgba(20,20,22,0.42)",
                          backdropFilter: "blur(40px) saturate(200%)",
                          WebkitBackdropFilter: "blur(40px) saturate(200%)",
                        }}>
                          {LINE_WIDTHS.map((w) => (
                            <button key={w} type="button"
                              onClick={() => { updateAlarmWidth(a.id, w); setOpenMenu(null); }}
                              className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-white/10 ${(a.width || 2) === w ? "text-orange-300" : "text-gray-200"}`}
                            >
                              <span className="w-3 text-orange-400">{(a.width || 2) === w ? "✓" : ""}</span>
                              W{w}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {/* Dash popover */}
                    <div className="relative" data-menu>
                      <button
                        type="button"
                        onClick={() => setOpenMenu(openMenu === `a-d-${a.id}` ? null : `a-d-${a.id}`)}
                        className={`px-1.5 py-0.5 rounded border text-[11px] transition-all ${
                          openMenu === `a-d-${a.id}`
                            ? "bg-orange-500 text-black border-orange-400"
                            : "bg-gray-900/95 border-gray-600 text-gray-200"
                        }`}
                      >
                        {a.dash === "dashed" ? "- -" : "——"} ▾
                      </button>
                      {openMenu === `a-d-${a.id}` && (
                        <div className="absolute z-50 bottom-full mb-1 left-1/2 -translate-x-1/2 border border-white/20 rounded-2xl py-1.5 shadow-[0_8px_40px_rgba(0,0,0,0.5)] overflow-hidden isolate min-w-[110px]" style={{
                          animation: "tfPop 0.28s cubic-bezier(0.34,1.3,0.64,1)",
                          background: "rgba(20,20,22,0.42)",
                          backdropFilter: "blur(40px) saturate(200%)",
                          WebkitBackdropFilter: "blur(40px) saturate(200%)",
                        }}>
                          {(["solid", "dashed"] as const).map((d) => (
                            <button key={d} type="button"
                              onClick={() => { updateAlarmDash(a.id, d); setOpenMenu(null); }}
                              className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-white/10 ${(a.dash === "dashed" ? "dashed" : "solid") === d ? "text-orange-300" : "text-gray-200"}`}
                            >
                              <span className="w-3 text-orange-400">{(a.dash === "dashed" ? "dashed" : "solid") === d ? "✓" : ""}</span>
                              {d === "solid" ? "—— Solid" : "- - Dash"}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button type="button" onClick={() => { setEditingNoteId(a.id); setEditingNoteType("alarm"); setNoteDraft(a.note || ""); }}
                      className="text-xs text-gray-400 hover:text-white px-1">Note</button>
                    <button
                      type="button"
                      onClick={() => {
                        setMode("move");
                        setMovingId(a.id);
                        setMovingType("alarm");
                        movingRayRef.current =
                          a.start_time != null && !isDiagonalLine(a as any);
                        if (isDiagonalLine(a as any)) {
                          movingRayRef.current = false;
                          moveDiagRef.current = {
                            id: a.id,
                            phase: "pick",
                            pointA: { time: Number(a.start_time), price: Number(a.price) },
                            pointB: { time: Number(a.end_time), price: Number(a.end_price) },
                            color: a.color || DEFAULT_ALARM_COLOR,
                            width: a.width || 2,
                            dash: (a.dash || "solid") as string,
                          };
                          setDrawColor(a.color || DEFAULT_ALARM_COLOR);
                          setDrawWidth(((a.width as 1 | 2 | 3) || 2) as 1 | 2 | 3);
                          setDrawDash((a.dash === "dashed" ? "dashed" : "solid") as "solid" | "dashed");
                          setStatusMsg("Tap a circle to move — empty chart or ✓ Done");
                          try {
                            // Pick phase: keep chart + page fully interactive (no lock)
                            document.body.style.overflow = "";
                            document.documentElement.style.overflow = "";
                            if (chartContainerRef.current) chartContainerRef.current.style.touchAction = "";
                            chartRef.current?.applyOptions({
                              handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
                              handleScale: { axisPressedMouseMove: true, axisDoubleClickReset: true, mouseWheel: true, pinch: true },
                            });
                            const chart = chartRef.current;
                            const md = moveDiagRef.current!;
                            if (chart) {
                              // Keep visible range fixed — no auto-scroll to the right while editing
                              if (previewDiagSeriesRef.current) {
                                try { chart.removeSeries(previewDiagSeriesRef.current); } catch {}
                                previewDiagSeriesRef.current = null;
                              }
                              previewDiagSeriesRef.current = chart.addLineSeries({
                                color: md.color,
                                lineWidth: Math.max(2, md.width) as 1 | 2 | 3 | 4,
                                lineStyle: LineStyle.Dashed,
                                priceLineVisible: false,
                                lastValueVisible: false,
                                crosshairMarkerVisible: false,
                              });
                              const pts = [
                                { time: md.pointA.time as any, value: md.pointA.price },
                                { time: md.pointB.time as any, value: md.pointB.price },
                              ].sort((x, y) => Number(x.time) - Number(y.time));
                              previewDiagSeriesRef.current.setData(pts);
                              try { previewDiagSeriesRef.current.setMarkers([]); } catch {}
                              positionHandles(md.pointA, md.pointB, null);
                            }
                          } catch {}
                        } else {
                          moveDiagRef.current = null;
                          setStatusMsg("Click on chart to move alarm");
                        }
                      }}
                      className="text-sm font-semibold text-blue-400 hover:text-blue-300 px-1"
                    >
                      Move
                    </button>
                    <button type="button" onClick={() => deleteAlarm(a.id)} className="text-xs text-red-400 px-1">Delete</button>
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
                    {isDiagonalLine(l)
                      ? `↗ ${formatPrice(l.price)}→${formatPrice(Number(l.end_price))}`
                      : formatPrice(l.price)}
                  </span>
                  {isDiagonalLine(l) && (
                    <span className="text-[10px] text-orange-400/80 shrink-0">Diag</span>
                  )}
                  {l.note && !l.note.startsWith("__diag:") && (
                    <span className="text-gray-500 text-xs truncate max-w-[70px]">{l.note}</span>
                  )}
                  <div className="ml-auto flex flex-wrap items-center gap-1.5 justify-end">
                    {/* Round color */}
                    <div className="relative w-7 h-7 rounded-full overflow-hidden border-2 border-gray-500 shadow shrink-0" title="Color">
                      <input
                        type="color"
                        value={l.color || DEFAULT_LINE_COLOR}
                        onChange={(e) => updateLineColor(l.id, e.target.value)}
                        className="absolute -top-2 -left-2 w-12 h-12 cursor-pointer border-0 p-0"
                      />
                    </div>
                    {/* Width */}
                    <div className="relative" data-menu>
                      <button
                        type="button"
                        onClick={() => setOpenMenu(openMenu === `l-w-${l.id}` ? null : `l-w-${l.id}`)}
                        className={`px-1.5 py-0.5 rounded border text-[11px] transition-all ${
                          openMenu === `l-w-${l.id}`
                            ? "bg-orange-500 text-black border-orange-400"
                            : "bg-gray-900/95 border-gray-600 text-gray-200"
                        }`}
                      >
                        W{l.width || 2} ▾
                      </button>
                      {openMenu === `l-w-${l.id}` && (
                        <div className="absolute z-50 bottom-full mb-1 left-1/2 -translate-x-1/2 border border-white/20 rounded-2xl py-1.5 shadow-[0_8px_40px_rgba(0,0,0,0.5)] overflow-hidden isolate min-w-[80px]" style={{
                          animation: "tfPop 0.28s cubic-bezier(0.34,1.3,0.64,1)",
                          background: "rgba(20,20,22,0.42)",
                          backdropFilter: "blur(40px) saturate(200%)",
                          WebkitBackdropFilter: "blur(40px) saturate(200%)",
                        }}>
                          {LINE_WIDTHS.map((w) => (
                            <button key={w} type="button"
                              onClick={() => { updateLineWidth(l.id, w); setOpenMenu(null); }}
                              className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-white/10 ${(l.width || 2) === w ? "text-orange-300" : "text-gray-200"}`}
                            >
                              <span className="w-3 text-orange-400">{(l.width || 2) === w ? "✓" : ""}</span>
                              W{w}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {/* Dash */}
                    <div className="relative" data-menu>
                      <button
                        type="button"
                        onClick={() => setOpenMenu(openMenu === `l-d-${l.id}` ? null : `l-d-${l.id}`)}
                        className={`px-1.5 py-0.5 rounded border text-[11px] transition-all ${
                          openMenu === `l-d-${l.id}`
                            ? "bg-orange-500 text-black border-orange-400"
                            : "bg-gray-900/95 border-gray-600 text-gray-200"
                        }`}
                      >
                        {(l.dash || l.style) === "dashed" ? "- -" : "——"} ▾
                      </button>
                      {openMenu === `l-d-${l.id}` && (
                        <div className="absolute z-50 bottom-full mb-1 left-1/2 -translate-x-1/2 border border-white/20 rounded-2xl py-1.5 shadow-[0_8px_40px_rgba(0,0,0,0.5)] overflow-hidden isolate min-w-[110px]" style={{
                          animation: "tfPop 0.28s cubic-bezier(0.34,1.3,0.64,1)",
                          background: "rgba(20,20,22,0.42)",
                          backdropFilter: "blur(40px) saturate(200%)",
                          WebkitBackdropFilter: "blur(40px) saturate(200%)",
                        }}>
                          {(["solid", "dashed"] as const).map((d) => (
                            <button key={d} type="button"
                              onClick={() => { updateLineDash(l.id, d); setOpenMenu(null); }}
                              className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-white/10 ${((l.dash || l.style) === "dashed" ? "dashed" : "solid") === d ? "text-orange-300" : "text-gray-200"}`}
                            >
                              <span className="w-3 text-orange-400">{((l.dash || l.style) === "dashed" ? "dashed" : "solid") === d ? "✓" : ""}</span>
                              {d === "solid" ? "—— Solid" : "- - Dash"}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    <button type="button" onClick={() => convertLineToAlarm(l)} className="text-xs text-green-400 px-1">Alarm</button>
                    <button type="button" onClick={() => { setEditingNoteId(l.id); setEditingNoteType("line"); setNoteDraft(l.note || ""); }}
                      className="text-xs text-gray-400 hover:text-white px-1">Note</button>
                    <button
                      type="button"
                      onClick={() => {
                        setMode("move");
                        setMovingId(l.id);
                        setMovingType("line");
                        // Ray = has start_time but is not a full diagonal segment
                        movingRayRef.current =
                          l.start_time != null && !isDiagonalLine(l);
                        if (isDiagonalLine(l)) {
                          movingRayRef.current = false;
                          moveDiagRef.current = {
                            id: l.id,
                            phase: "pick",
                            pointA: { time: Number(l.start_time), price: Number(l.price) },
                            pointB: { time: Number(l.end_time), price: Number(l.end_price) },
                            color: l.color || DEFAULT_LINE_COLOR,
                            width: l.width || 2,
                            dash: (l.dash || l.style || "solid") as string,
                          };
                          setDrawColor(l.color || DEFAULT_LINE_COLOR);
                          setDrawWidth(((l.width as 1 | 2 | 3) || 2) as 1 | 2 | 3);
                          setDrawDash(((l.dash || l.style) === "dashed" ? "dashed" : "solid") as "solid" | "dashed");
                          setStatusMsg("Tap a circle to move — empty chart or ✓ Done");
                          try {
                            // Pick phase: keep chart + page fully interactive (no lock)
                            document.body.style.overflow = "";
                            document.documentElement.style.overflow = "";
                            if (chartContainerRef.current) chartContainerRef.current.style.touchAction = "";
                            chartRef.current?.applyOptions({
                              handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
                              handleScale: { axisPressedMouseMove: true, axisDoubleClickReset: true, mouseWheel: true, pinch: true },
                            });
                            const chart = chartRef.current;
                            const md = moveDiagRef.current!;
                            if (chart) {
                              // Keep visible range fixed — no auto-scroll to the right while editing
                              if (previewDiagSeriesRef.current) {
                                try { chart.removeSeries(previewDiagSeriesRef.current); } catch {}
                                previewDiagSeriesRef.current = null;
                              }
                              previewDiagSeriesRef.current = chart.addLineSeries({
                                color: md.color,
                                lineWidth: Math.max(2, md.width) as 1 | 2 | 3 | 4,
                                lineStyle: LineStyle.Dashed,
                                priceLineVisible: false,
                                lastValueVisible: false,
                                crosshairMarkerVisible: false,
                              });
                              const pts = [
                                { time: md.pointA.time as any, value: md.pointA.price },
                                { time: md.pointB.time as any, value: md.pointB.price },
                              ].sort((x, y) => Number(x.time) - Number(y.time));
                              previewDiagSeriesRef.current.setData(pts);
                              try { previewDiagSeriesRef.current.setMarkers([]); } catch {}
                              positionHandles(md.pointA, md.pointB, null);
                            }
                          } catch {}
                        } else {
                          moveDiagRef.current = null;
                          setStatusMsg("Click on chart to move line");
                        }
                      }}
                      className="text-sm font-semibold text-blue-400 hover:text-blue-300 px-1"
                    >
                      Move
                    </button>
                    <button type="button" onClick={() => deleteLine(l.id)} className="text-xs text-red-400 px-1">Delete</button>
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

        {/* Alarm history for current symbol */}
        <div>
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-sm font-medium text-gray-400">
              History — {symbolUpper} ({historyAlarms.length})
            </h3>
            {historyAlarms.length > 0 && (
              <button
                type="button"
                onClick={async () => {
                  const ids = historyAlarms.map((a) => a.id);
                  setAlarms((prev) => prev.filter((a) => !ids.includes(a.id)));
                  try {
                    await supabase.from("alarms").delete().in("id", ids);
                  } catch {}
                }}
                className="ml-auto text-[11px] text-red-400 hover:text-red-300 px-2 py-0.5 rounded border border-red-900/50"
              >
                Delete all
              </button>
            )}
          </div>
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {historyAlarms.map((a) => {
              const when = a.triggered_at || a.created_at;
              return (
                <div
                  key={a.id}
                  className="bg-gray-950 border border-gray-800/80 rounded-lg px-3 py-2 text-sm cursor-pointer hover:border-amber-600/50"
                  onClick={() => {
                    // Resolve diagonal geometry (columns or note fallback)
                    let st = a.start_time ?? null;
                    let et = a.end_time ?? null;
                    let ep = a.end_price ?? null;
                    if ((!et || ep == null) && a.note?.startsWith("__diag:")) {
                      const parts = a.note.replace(/^__diag:/, "").split("|")[0].split(":");
                      if (parts.length >= 3) {
                        st = Number(parts[0]);
                        et = Number(parts[1]);
                        ep = Number(parts[2]);
                      }
                    }
                    const isDiag =
                      st != null &&
                      et != null &&
                      ep != null &&
                      Number(st) !== Number(et);
                    setHighlightAlarmId(null);

                    // Jump chart to the hit / line region (not just flash off-screen)
                    const chart = chartRef.current;
                    const series = seriesRef.current;
                    const candles = candlesRef.current;
                    const barSec = intervalToSeconds(String(intervalRef.current));
                    const idxNear = (unix: number) => {
                      if (!candles.length) return 0;
                      // binary search nearest bar
                      let lo = 0;
                      let hi = candles.length - 1;
                      while (lo < hi) {
                        const mid = (lo + hi) >> 1;
                        if (candles[mid].time < unix) lo = mid + 1;
                        else hi = mid;
                      }
                      return Math.max(0, Math.min(candles.length - 1, lo));
                    };

                    if (isDiag) {
                      setHighlightPrice(null);
                      setHighlightRay(null);
                      setHighlightDiag({
                        start_time: Number(st),
                        end_time: Number(et),
                        price: Number(a.price),
                        end_price: Number(ep),
                      });
                      setStatusMsg(`History Diag ${formatPrice(a.price)}→${formatPrice(Number(ep))}`);
                      if (chart && candles.length) {
                        const t0 = Math.min(Number(st), Number(et));
                        const t1 = Math.max(Number(st), Number(et));
                        // Prefer trigger moment if known, else middle of segment
                        let focusT = (t0 + t1) / 2;
                        try {
                          const trig = (a as any).triggered_at || (a as any).updated_at;
                          if (trig) {
                            const n = Math.floor(new Date(trig).getTime() / 1000);
                            if (!Number.isNaN(n) && n > 0) focusT = n;
                          }
                        } catch {}
                        // Time-based window around the hit (works on any TF)
                        const span = Math.max(t1 - t0, barSec * 12);
                        const pad = Math.max(span * 0.8, barSec * 20);
                        const fromT = Math.min(t0, focusT) - pad;
                        const toT = Math.max(t1, focusT) + pad;
                        historyFocusRef.current = { from: fromT, to: toT };
                        try {
                          (chart.timeScale() as any).setVisibleRange({
                            from: fromT as any,
                            to: toT as any,
                          });
                        } catch {
                          // Fallback: logical indices
                          const i0 = idxNear(fromT);
                          const i1 = idxNear(toT);
                          try {
                            chart.timeScale().setVisibleLogicalRange({
                              from: Math.max(0, i0 - 2),
                              to: Math.min(candles.length - 1 + FUTURE_VISIBLE, i1 + 5),
                            });
                          } catch {}
                        }
                        // Keep focus locked for a few seconds so live updates / re-renders don't yank away
                        window.setTimeout(() => {
                          historyFocusRef.current = null;
                        }, 5000);
                        try {
                          const pLo = Math.min(Number(a.price), Number(ep));
                          const pHi = Math.max(Number(a.price), Number(ep));
                          const ppad = Math.max((pHi - pLo) * 0.5, pHi * 0.004);
                          const ps = series?.priceScale() as any;
                          if (ps && typeof ps.setVisibleRange === "function") {
                            ps.setVisibleRange({ from: pLo - ppad, to: pHi + ppad });
                          }
                        } catch {}
                      }
                    } else {
                      // Resolve ray (half-line) geometry — column, note, or non-diag start_time
                      let rayStart: number | null = null;
                      if (a.start_time != null && (a.end_time == null || a.end_price == null)) {
                        rayStart = Number(a.start_time);
                      }
                      if (rayStart == null && a.note?.startsWith("__ray:")) {
                        const n = Number(String(a.note).replace("__ray:", "").split("|")[0]);
                        if (!Number.isNaN(n) && n > 0) rayStart = n;
                      }
                      // Note may contain "__ray:unix" even alongside other text
                      if (rayStart == null && a.note && String(a.note).includes("__ray:")) {
                        const m = String(a.note).match(/__ray:(\d+)/);
                        if (m) rayStart = Number(m[1]);
                      }
                      const isRayHist = rayStart != null && !Number.isNaN(rayStart) && rayStart > 0;

                      setHighlightDiag(null);
                      if (isRayHist) {
                        setHighlightPrice(null);
                        setHighlightRay({
                          start_time: Number(rayStart),
                          price: Number(a.price),
                        });
                        setStatusMsg(`History Ray @ ${formatPrice(a.price)}`);
                      } else {
                        setHighlightRay(null);
                        setHighlightPrice(a.price);
                        setStatusMsg(`History @ ${formatPrice(a.price)}`);
                      }

                      if (chart && candles.length) {
                        let focusT: number | null = isRayHist ? Number(rayStart) : null;
                        try {
                          const trig = (a as any).triggered_at || (a as any).updated_at;
                          if (trig) {
                            const n = Math.floor(new Date(trig).getTime() / 1000);
                            if (!Number.isNaN(n) && n > 0) focusT = n;
                          }
                        } catch {}
                        if (focusT != null) {
                          const pad = barSec * 40;
                          const fromT = focusT - pad;
                          const toT = focusT + pad;
                          historyFocusRef.current = { from: fromT, to: toT };
                          try {
                            (chart.timeScale() as any).setVisibleRange({
                              from: fromT as any,
                              to: toT as any,
                            });
                          } catch {
                            const iF = idxNear(focusT);
                            try {
                              chart.timeScale().setVisibleLogicalRange({
                                from: Math.max(0, iF - 40),
                                to: Math.min(candles.length - 1 + FUTURE_VISIBLE, iF + 20),
                              });
                            } catch {}
                          }
                          window.setTimeout(() => {
                            historyFocusRef.current = null;
                          }, 5000);
                        } else {
                          historyFocusRef.current = null;
                          try {
                            const bars = candles.length;
                            const past = Math.min(70, bars);
                            chart.timeScale().setVisibleLogicalRange({
                              from: bars - past,
                              to: bars - 1 + FUTURE_VISIBLE,
                            });
                          } catch {}
                        }
                        try {
                          const p = Number(a.price);
                          const ppad = Math.abs(p) * 0.012;
                          const ps = series?.priceScale() as any;
                          if (ps && typeof ps.setVisibleRange === "function") {
                            ps.setVisibleRange({ from: p - ppad, to: p + ppad });
                          }
                        } catch {}
                      }
                    }
                  }}
                  title="Tap to jump to hit area on chart"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono font-medium text-gray-400">
                      {(() => {
                        let et = a.end_time ?? null;
                        let ep = a.end_price ?? null;
                        if ((!et || ep == null) && a.note?.startsWith("__diag:")) {
                          const parts = a.note.replace(/^__diag:/, "").split("|")[0].split(":");
                          if (parts.length >= 3) {
                            et = Number(parts[1]);
                            ep = Number(parts[2]);
                          }
                        }
                        // Ray history label
                        let rayS = a.start_time ?? null;
                        if (rayS == null && a.note?.startsWith("__ray:")) {
                          const n = Number(String(a.note).replace("__ray:", "").split("|")[0]);
                          if (!Number.isNaN(n)) rayS = n;
                        }
                        if (
                          rayS != null &&
                          (a.end_time == null || a.end_price == null) &&
                          !(a.end_time != null && a.end_price != null)
                        ) {
                          return `→ ${formatPrice(a.price)}`;
                        }
                        if (et != null && ep != null && Number(a.start_time) !== Number(et)) {
                          return `↗ ${formatPrice(a.price)}→${formatPrice(Number(ep))}`;
                        }
                        return `${getConditionSymbol(a.condition)} ${formatPrice(a.price)}`;
                      })()}
                    </span>
                    <span className="ml-auto text-[11px] text-gray-500 tabular-nums">
                      {formatRelativeTime(when)}
                    </span>
                    <button
                      type="button"
                      title="Delete from history"
                      onClick={async () => {
                        setAlarms((prev) => prev.filter((x) => x.id !== a.id));
                        try {
                          await supabase.from("alarms").delete().eq("id", a.id);
                        } catch {}
                      }}
                      className="text-gray-600 hover:text-red-400 text-xs leading-none px-1"
                    >
                      ×
                    </button>
                  </div>
                  <div className="text-[11px] text-gray-600 mt-0.5">
                    {formatAlarmDate(when)}
                    {a.note ? ` · ${a.note}` : ""}
                  </div>
                </div>
              );
            })}
            {!historyAlarms.length && (
              <p className="text-gray-600 text-sm">No triggered alarms yet</p>
            )}
          </div>
        </div>
      </div>

      <p className="text-center text-gray-600 text-xs mt-6">© 2026 Alarm Chert</p>
    </div>
  );
}

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

/** BTCUSDT@BINANCE → BTCUSDT (برای API و نمایش) */
function chartSymbol(sym: string): string {
  if (!sym) return "";
  return String(sym).split("@")[0].toUpperCase().replace(/[^A-Z0-9]/g, "");
}


type ToolMode =
  | "none"
  | "draw"
  | "ray"
  | "diag"
  | "vline"
  | "arrow"
  | "arrow-up"
  | "arrow-down"
  | "arrow-marker"
  | "path"
  | "brush"
  | "curve"
  | "rect"
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

/** AudioContext مشترک — روی دسکتاپ بدون resume صدا نمی‌دهد */
let _alarmAudioCtx: AudioContext | null = null;
function getAlarmAudioCtx(): AudioContext | null {
  try {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    if (!_alarmAudioCtx) _alarmAudioCtx = new AC();
    return _alarmAudioCtx;
  } catch {
    return null;
  }
}
if (typeof window !== "undefined") {
  const unlock = () => {
    try {
      const ctx = getAlarmAudioCtx();
      if (ctx && ctx.state === "suspended") void ctx.resume();
    } catch {}
  };
  window.addEventListener("pointerdown", unlock, { capture: true });
  window.addEventListener("keydown", unlock, { capture: true });
}

/** Desktop: چند نت بلند | موبایل: کوتاه */
function playAlarmBeep() {
  try {
    const ctx = getAlarmAudioCtx();
    if (!ctx) return;
    const start = () => {
      try {
        const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
        const notes = isMobile ? [880, 988] : [660, 880, 1100, 880, 1320, 880];
        const gap = isMobile ? 0.32 : 0.22;
        const vol = isMobile ? 0.35 : 0.4;
        notes.forEach((freq, i) => {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.connect(g);
          g.connect(ctx.destination);
          o.type = isMobile ? "sine" : "square";
          o.frequency.value = freq;
          const t0 = ctx.currentTime + i * gap;
          g.gain.setValueAtTime(0.0001, t0);
          g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + gap * 0.9);
          o.start(t0);
          o.stop(t0 + gap);
        });
      } catch {}
    };
    if (ctx.state === "suspended") {
      ctx.resume().then(start).catch(() => start());
    } else {
      start();
    }
  } catch {}
}

let _lastBeepAt = 0;
function showLocalNotification(
  title: string,
  body: string,
  tag?: string
) {
  const notifTag = tag || "alarm-chert";
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, {
        body,
        icon: "/icon-192.png",
        tag: notifTag,
        silent: false,
      } as NotificationOptions);
    }
  } catch {}
  // همیشه بیپ وقتی صفحه باز است
  const now = Date.now();
  if (now - _lastBeepAt > 1000) {
    _lastBeepAt = now;
    playAlarmBeep();
  }
}


function userFacingNote(note?: string | null): string {
  if (!note) return "";
  const s = String(note).trim();
  if (!s) return "";
  if (s === "__vline__") return "";
  if (s === "__arrow__" || s.startsWith("__arrow")) return "Arrow";
  if (s.startsWith("__path:")) return "Path";
  if (s.startsWith("__curve:")) return "Curve";
  if (s.startsWith("__diag:") || s.startsWith("__ray:")) {
    const idx = s.indexOf("|");
    if (idx >= 0) return s.slice(idx + 1).trim();
    return "";
  }
  return s;
}

function alarmNotifyBody(
  a: { price: number; note?: string | null },
  price: number
) {
  let body = `Alarm hit @ ${a.price}  now ${price}`;
  const n = userFacingNote(a.note);
  if (n) body += `\n📝 ${n}`;
  return body;
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

async function ensurePushSubscription(): Promise<"ok" | "denied" | "unsupported" | "no-key" | "error" | "not-logged-in"> {
  if (typeof window === "undefined") return "unsupported";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return "unsupported";
  }

  let userId: string | null = null;
  try {
    const { data } = await supabase.auth.getUser();
    if (data?.user?.id) userId = data.user.id;
  } catch {}
  if (!userId) {
    try {
      const res = await fetch("/api/auth/session", { credentials: "same-origin" });
      const json = await res.json();
      if (json?.user?.id) userId = String(json.user.id);
    } catch {}
  }
  if (!userId) return "not-logged-in";

  const vapid =
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_VAPID_PUBLIC_KEY) ||
    (typeof window !== "undefined" && (window as any).__VAPID_PUBLIC_KEY) ||
    VAPID_PUBLIC_KEY_FALLBACK;

  if (!vapid) return "no-key";

  try {
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
          user_id: userId,
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
          user_id: userId,
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
  if (prev == null || Number.isNaN(prev) || Number.isNaN(price)) return false;
  if (!target || !Number.isFinite(target)) return false;
  // فقط عبور واقعی: prev یک طرف خط، price طرف دیگر یا روی خط
  const eps = Math.max(Math.abs(target) * 1e-10, 1e-10);
  // گلیچ تیکر (پرش غیرعادی بدون عبور از سطح) را رد کن
  const jump = Math.abs(price - prev);
  const thru =
    (prev < target && price >= target) || (prev > target && price <= target);
  if (jump > Math.max(Math.abs(target) * 0.12, 50) && !thru) return false;

  const cond = String(condition || "cross").toLowerCase();
  if (cond === "above") return prev < target - eps && price >= target - eps;
  if (cond === "below") return prev > target + eps && price <= target + eps;
  return (
    (prev < target - eps && price >= target - eps) ||
    (prev > target + eps && price <= target + eps)
  );
}
function toLineStyle(dash?: string | null) {
  return dash === "dashed" ? LineStyle.Dashed : LineStyle.Solid;
}

/**
 * Diagonal = exactly 2 points (A→B).
 * Mid-points caused drift/skew deeper in history (times forced +1s).
 * LWC draws a true straight segment between two points on a linear time scale.
 */
function denseDiagPoints(
  t0: number,
  t1: number,
  v0: number,
  v1: number,
  barSec: number
): { time: any; value: number }[] {
  const bs = Math.max(1, barSec || 60);
  let aT = Number(t0);
  let bT = Number(t1);
  let aV = Number(v0);
  let bV = Number(v1);
  if (!(aT > 0) || !(bT > 0) || Number.isNaN(aV) || Number.isNaN(bV)) {
    return [];
  }
  if (bT < aT) {
    const tmpT = aT; aT = bT; bT = tmpT;
    const tmpV = aV; aV = bV; bV = tmpV;
  }
  // Same bar: nudge end by a fraction of bar so LWC accepts strictly increasing times
  if (bT <= aT) {
    return [
      { time: aT as any, value: aV },
      { time: (aT + Math.max(1, Math.floor(bs / 8))) as any, value: bV },
    ];
  }
  return [
    { time: aT as any, value: aV },
    { time: bT as any, value: bV },
  ];
}

/** Format unix seconds in a given IANA timezone */

/** Snap unix time to the candle that contains it (floor) — critical for rays on higher TFs */
function snapTimeToBars(t: number, candles: { time: number }[]): number {
  const n = Number(t);
  if (!candles.length || Number.isNaN(n)) return n;
  const first = Number(candles[0].time);
  const last = Number(candles[candles.length - 1].time);
  if (n <= first) return first;
  if (n >= last) return last;
  // binary search: largest candle.time <= n
  let lo = 0, hi = candles.length - 1, best = first;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const ct = Number(candles[mid].time);
    if (ct <= n) {
      best = ct;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}


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
const FUTURE_BARS = 800;
/** How many future bars are visible on first load (rest remains scrollable) */
const FUTURE_VISIBLE = 55;

/** Convert OHLC candles to Heikin-Ashi */
function toHeikinAshi(candles: any[]): any[] {
  if (!candles.length) return [];
  const out: any[] = [];
  let prevHa: any = null;
  for (const c of candles) {
    const haClose = (Number(c.open) + Number(c.high) + Number(c.low) + Number(c.close)) / 4;
    const haOpen = prevHa
      ? (Number(prevHa.open) + Number(prevHa.close)) / 2
      : (Number(c.open) + Number(c.close)) / 2;
    const haHigh = Math.max(Number(c.high), haOpen, haClose);
    const haLow = Math.min(Number(c.low), haOpen, haClose);
    const bar = { time: c.time, open: haOpen, high: haHigh, low: haLow, close: haClose };
    out.push(bar);
    prevHa = bar;
  }
  return out;
}
function appendFutureWhitespace(candles: any[], interval: string, count = FUTURE_BARS): any[] {
  if (!candles.length) return candles;
  const barSec = intervalToSeconds(String(interval));
  if (barSec <= 0) return candles;
  const lastT = Number(candles[candles.length - 1].time);
  // align to interval grid
  const base = Math.floor(lastT / barSec) * barSec;
  const out = candles.slice();
  for (let i = 1; i <= count; i++) {
    // WhitespaceData: time only — LWC draws empty slot + tick mark
    out.push({ time: (base + i * barSec) as any });
  }
  return out;
}

/** Future helper points for a transparent line series (forces time-axis labels) */
function futureHelperPoints(candles: any[], interval: string, count = FUTURE_BARS, lastPrice = 0): { time: any; value: number }[] {
  if (!candles.length) return [];
  const barSec = intervalToSeconds(String(interval));
  if (barSec <= 0) return [];
  const lastT = Number(candles[candles.length - 1].time);
  const base = Math.floor(lastT / barSec) * barSec;
  const px = Number(lastPrice) || Number(candles[candles.length - 1].close) || 0;
  const pts: { time: any; value: number }[] = [];
  // include last real point so series connects
  pts.push({ time: lastT as any, value: px });
  for (let i = 1; i <= count; i++) {
    pts.push({ time: (base + i * barSec) as any, value: px });
  }
  return pts;
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

function CoinIcon({ symbol, size = 20 }: { symbol: string; size?: number }) {
  const base = symbol.replace(/USDT$|USD$|PERP$/i, "").toLowerCase();
  const cls = size <= 16 ? "w-4 h-4" : size <= 18 ? "w-[18px] h-[18px]" : "w-5 h-5";
  return (
    <img
      src={`https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/32/color/${base}.png`}
      alt="" width={size} height={size} className={`${cls} rounded-full shrink-0`}
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
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | ISeriesApi<"Line"> | ISeriesApi<"Area"> | null>(null);
  const futureSeriesRef = useRef<any>(null);
  const volumeSeriesRef = useRef<any>(null);
  const previewLineRef = useRef<IPriceLine | null>(null);
  /** Temporary line series while drawing diagonal (start → cursor) */
  const previewDiagSeriesRef = useRef<any>(null);
  /** AbortController to remove pointer listeners on chart rebuild */
  const pointerAbortRef = useRef<AbortController | null>(null);
  /** Monotonic id so a slow TF fetch never overwrites a newer one / leaves a black gap */
  const loadGenRef = useRef(0);
  const lastLoadedSymbolRef = useRef<string>("");
  const lastLoadedIntervalRef = useRef<string>("");

  const loadCandlesRef = useRef<() => Promise<void>>(async () => {});

  /** User is following the live edge — only then may we auto-scroll on new bars (stops iPad jump) */
  const pinnedToRightRef = useRef(true);
  /** True while finger/mouse is dragging the chart — freeze all auto range changes */
  const userInteractingRef = useRef(false);
  const interactTimerRef = useRef<number | null>(null);
  /** True while WE are changing the visible range — ignore those events for pin detection */
  const programmaticRangeRef = useRef(false);
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
  const movingVLineRef = useRef(false);
  const lastPriceLineRef = useRef<IPriceLine | null>(null);
  const alarmLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const chartLinesRef = useRef<Map<string, any>>(new Map());
  /** DOM vertical lines (true vertical — LWC series cannot draw true vertical) */
  const vlineOverlayRef = useRef<HTMLDivElement | null>(null);
  const pathPointsRef = useRef<{ time: number; price: number }[]>([]);
  const vlineItemsRef = useRef<{ id: string; time: number; color: string; width: number; dash: string }[]>([])
  const rayItemsRef = useRef<{ id: string; time: number; price: number; color: string; width: number; dash: string }[]>([]);
  const arrowMoveItemsRef = useRef<{ id: string; time: number; price: number }[]>([]);
  const smaSeriesRef = useRef<{ s1: any; s2: any; s3: any } | null>(null);
  const rsiSeriesRef = useRef<any>(null);
  const dmiSeriesRef = useRef<{ plus: any; minus: any; adx: any } | null>(null);
  const pivotSeriesRef = useRef<any[]>([]);
  const trendSeriesRef = useRef<any[]>([]);
  const candlesRef = useRef<any[]>([]);
  const notifiedAlarmsRef = useRef<Set<string>>(new Set());
  /** in-flight triggers — prevents concurrent double-fire */
  const triggeringAlarmsRef = useRef<Set<string>>(new Set());
  const tickInFlightRef = useRef(false);
  const prevPricesRef = useRef<Record<string, number>>({});
  /** بعد از لود/عوض TF چند تیک صبر کن تا seed پایدار شود */
  const priceSeedCountRef = useRef<Record<string, number>>({});
  /** After symbol/TF change, block triggers briefly to avoid false hits */
  const alarmCooldownUntilRef = useRef<number>(0);
  /** زوم عمودی دستی روی محور قیمت (null = autoScale) */
  const priceRangeOverrideRef = useRef<{ from: number; to: number } | null>(null);
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
  const linesRef = useRef<ChartLine[]>([]);
  const alarmsRef = useRef<Alarm[]>([]);
  useEffect(() => { linesRef.current = lines; }, [lines]);
  useEffect(() => { alarmsRef.current = alarms; }, [alarms]);
  const hideLinesRef = useRef(false);
  const hideIndicatorsRef = useRef(false);
  const renderAllLinesAndAlarmsRef = useRef<(() => void) | null>(null);
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
  /** Chart series style: candles | hollow | line | area | heikin */
  const [chartType, setChartType] = useState<"candles" | "hollow" | "line" | "area" | "heikin">(() =>
    loadLS("chart_type", "candles")
  );
  const [showChartTypeMenu, setShowChartTypeMenu] = useState(false);
  /** Multi-pane layout like TradingView */
  type ChartLayoutId =
    | "1"
    | "2h" | "2v"
    | "3a" | "3b" | "3c"
    | "4a" | "4b" | "4c"
    | "5a" | "5b"
    | "6a" | "6b";
  const [chartLayout, setChartLayout] = useState<ChartLayoutId>(() => {
    const saved = loadLS<string>("chart_layout", "1");
    // migrate old ids
    const map: Record<string, string> = { "3": "3a", "4": "4a", "5": "5a", "6": "6a" };
    return (map[saved] || saved || "1") as ChartLayoutId;
  });
  const [showLayoutMenu, setShowLayoutMenu] = useState(false);
  /** Full symbol universe for pane search (from /api/symbols) */
  const [allSymbols, setAllSymbols] = useState<string[]>([]);
  /** Symbols for extra panes (index 0..4) — main chart uses `symbol` */
  const [paneSymbols, setPaneSymbols] = useState<string[]>(() => {
    const def = ["ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"];
    const saved = loadLS<string[]>("pane_symbols", def);
    if (!Array.isArray(saved)) return def;
    const out = [...saved];
    while (out.length < 5) out.push(def[out.length] || "ETHUSDT");
    return out;
  });
  const [paneSearchOpen, setPaneSearchOpen] = useState<number | null>(null);
  const [paneSearchQ, setPaneSearchQ] = useState("");
  /** 0 = main chart, 1..5 = secondary panes (index+1 in UI = paneSymbols index) */
  const [activePane, setActivePane] = useState(0);
  /** Independent TF for each secondary pane (same values as main interval) */
  const [paneIntervals, setPaneIntervals] = useState<string[]>(() => {
    const def = ["15", "15", "15", "15", "15"];
    const saved = loadLS<string[]>("pane_intervals", def);
    if (!Array.isArray(saved)) return def;
    const out = [...saved];
    while (out.length < 5) out.push("15");
    return out;
  });
  const paneIntervalsRef = useRef(paneIntervals);
  useEffect(() => { paneIntervalsRef.current = paneIntervals; }, [paneIntervals]);
  useEffect(() => { saveLS("pane_intervals", paneIntervals); }, [paneIntervals]);
  const paneRefs = useRef<(HTMLDivElement | null)[]>([null, null, null, null, null]);
  const secondaryChartsRef = useRef<
    Map<number, { chart: IChartApi; series: any; symbol: string; interval: string }>
  >(new Map());
  const layoutWrapRef = useRef<HTMLDivElement>(null);

  const applyTfToActivePane = useCallback((tf: string) => {
    if (activePane === 0) {
      setIntervalTf(tf);
      return;
    }
    const idx = activePane - 1;
    setPaneIntervals((prev) => {
      const n = [...prev];
      n[idx] = tf;
      return n;
    });
  }, [activePane]);
  /** Undo / Redo stacks (lines + active alarms snapshots) */
  const undoStackRef = useRef<{ lines: ChartLine[]; alarms: Alarm[] }[]>([]);
  const redoStackRef = useRef<{ lines: ChartLine[]; alarms: Alarm[] }[]>([]);
  const [histTick, setHistTick] = useState(0); // force re-render for undo/redo button state
  const pushUndo = useCallback(() => {
    try {
      const snap: any = {
        lines: JSON.parse(JSON.stringify(linesRef.current || [])),
        alarms: JSON.parse(JSON.stringify(alarmsRef.current || [])),
        symbol: symbolRef.current || "",
        interval: intervalRef.current || "",
        chartType: chartTypeRef.current || "candles",
        hideLines: !!hideLinesRef.current,
        hideIndicators: !!hideIndicatorsRef.current,
      };
      const prev = undoStackRef.current[undoStackRef.current.length - 1] as any;
      if (prev && JSON.stringify({
        lines: prev.lines, alarms: prev.alarms, symbol: prev.symbol,
        interval: prev.interval, chartType: prev.chartType,
        hideLines: prev.hideLines, hideIndicators: prev.hideIndicators,
      }) === JSON.stringify({
        lines: snap.lines, alarms: snap.alarms, symbol: snap.symbol,
        interval: snap.interval, chartType: snap.chartType,
        hideLines: snap.hideLines, hideIndicators: snap.hideIndicators,
      })) return;
      undoStackRef.current.push(snap);
      if (undoStackRef.current.length > 50) undoStackRef.current.shift();
      redoStackRef.current = [];
      setHistTick((n) => n + 1);
    } catch {}
  }, []);
  const applySnapshot = useCallback((snap: any) => {
    const lines = snap.lines || [];
    const alarms = snap.alarms || [];
    linesRef.current = lines;
    alarmsRef.current = alarms;
    setLines(lines);
    setAlarms(alarms);
    if (typeof snap.hideLines === "boolean") setHideLines(snap.hideLines);
    if (typeof snap.hideIndicators === "boolean") setHideIndicators(snap.hideIndicators);
    if (snap.chartType && snap.chartType !== chartTypeRef.current) {
      setChartType(snap.chartType);
    }
    if (snap.symbol && snap.symbol !== symbolRef.current) {
      setSymbol(String(snap.symbol).toUpperCase());
    }
    if (snap.interval && snap.interval !== intervalRef.current) {
      setIntervalTf(String(snap.interval));
    }
    requestAnimationFrame(() => {
      try { renderAllLinesAndAlarmsRef.current?.(); } catch {}
    });
    setTimeout(() => {
      try { renderAllLinesAndAlarmsRef.current?.(); } catch {}
      try { loadCandlesRef.current?.(); } catch {}
    }, 60);
  }, []);
  const undoChart = useCallback(() => {
    if (!undoStackRef.current.length) return;
    try {
      redoStackRef.current.push({
        lines: JSON.parse(JSON.stringify(linesRef.current || [])),
        alarms: JSON.parse(JSON.stringify(alarmsRef.current || [])),
      });
      const snap = undoStackRef.current.pop()!;
      applySnapshot(snap);
      setHistTick((n) => n + 1);
    } catch {}
  }, [applySnapshot]);
  const redoChart = useCallback(() => {
    if (!redoStackRef.current.length) return;
    try {
      undoStackRef.current.push({
        lines: JSON.parse(JSON.stringify(linesRef.current || [])),
        alarms: JSON.parse(JSON.stringify(alarmsRef.current || [])),
      });
      const snap = redoStackRef.current.pop()!;
      applySnapshot(snap);
      setHistTick((n) => n + 1);
    } catch {}
  }, [applySnapshot]);
  /** Collapsible left drawing tools panel (TradingView-style) */
  const [showToolsPanel, setShowToolsPanel] = useState(() => loadLS("show_tools_panel", true));
  /** Alarm sub-menu: full / ray / diag placement */
  const [alarmMenuOpen, setAlarmMenuOpen] = useState(false);
  /** Eye menu: hide lines / indicators */
  const [hideMenuOpen, setHideMenuOpen] = useState(false);
  const [hideLines, setHideLines] = useState(false);
  const [hideIndicators, setHideIndicators] = useState(false);
  useEffect(() => { hideLinesRef.current = hideLines; }, [hideLines]);
  useEffect(() => { hideIndicatorsRef.current = hideIndicators; }, [hideIndicators]);
  const [hideAlarms, setHideAlarms] = useState(false);
  const [trashMenuOpen, setTrashMenuOpen] = useState(false);
  const [drawToolsOpen, setDrawToolsOpen] = useState(false);
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
  /** Show TradingView-style "go to live" chevron when user scrolled into history */
  const [showGoLive, setShowGoLive] = useState(false);
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
  /** Watchlist panel: ⋮ menu + rename / delete-list mode */
  const [wlMenuOpen, setWlMenuOpen] = useState(false);
  const [wlRenameOpen, setWlRenameOpen] = useState(false);
  const [wlRenameDraft, setWlRenameDraft] = useState("");
  /** "delete" = show × on list letters | null = normal */
  const [wlManageMode, setWlManageMode] = useState<null | "delete">(null);
  /** Sections inside Alarms panel (localStorage — no DB table) */
  const [alarmSections, setAlarmSections] = useState<
    { id: string; name: string; sort_order: number }[]
  >(() => loadLS("alarm_sections_v1", []));
  const [secRenameId, setSecRenameId] = useState<string | null>(null);
  const [secRenameDraft, setSecRenameDraft] = useState("");
  /** History panel: current coin vs all symbols */
  const [historyMode, setHistoryMode] = useState<"coin" | "all">(() =>
    loadLS("history_mode", "coin")
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
  // Vertical tool: emphasize vertical crosshair, hide horizontal guide
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    try {
      if (mode === "vline") {
        // Only vertical guide — never horizontal
        chart.applyOptions({
          crosshair: {
            mode: CrosshairMode.Normal,
            vertLine: {
              visible: true,
              labelVisible: true,
              width: 1,
              style: LineStyle.Dashed,
              color: "rgba(249, 115, 22, 0.85)",
            },
            horzLine: {
              visible: false,
              labelVisible: false,
              color: "transparent",
            },
          },
        } as any);
      } else if (
        mode === "arrow-up" ||
        mode === "arrow-down" ||
        mode === "arrow-marker"
      ) {
        // No crosshair lines while placing arrow marks
        chart.applyOptions({
          crosshair: {
            mode: CrosshairMode.Normal,
            vertLine: { visible: false, labelVisible: false, color: "transparent" },
            horzLine: { visible: false, labelVisible: false, color: "transparent" },
          },
        } as any);
      } else if (mode === "draw" || mode === "ray" || mode === "alarm" || mode === "alarm-ray") {
        chart.applyOptions({
          crosshair: {
            mode: CrosshairMode.Normal,
            vertLine: { visible: false, labelVisible: false },
            horzLine: {
              visible: true,
              labelVisible: true,
              width: 1,
              style: LineStyle.Dashed,
              color: "rgba(249, 115, 22, 0.85)",
            },
          },
        } as any);
      } else {
        chart.applyOptions({
          crosshair: {
            mode: CrosshairMode.Normal,
            vertLine: { visible: true, labelVisible: true, color: "rgba(156,163,175,0.6)" },
            horzLine: { visible: true, labelVisible: true, color: "rgba(156,163,175,0.6)" },
          },
        } as any);
      }
    } catch {}
  }, [mode]);
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
  useEffect(() => {
    symbolRef.current = symbol;
    localStorage.setItem("chart_symbol", symbol);
    // فقط کوین فعلی seed از نو — بقیه نمادها prev خود را نگه دارند
    const s = chartSymbol(symbol).toUpperCase();
    delete prevPricesRef.current[s];
    priceSeedCountRef.current[s] = 0;
    alarmCooldownUntilRef.current = Date.now() + 1500;
  }, [symbol]);
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

  useEffect(() => {
    intervalRef.current = interval;
    localStorage.setItem("chart_interval", interval);
    // عوض TF نباید آلارم را قطع کند — prev قیمت‌ها را نگه دار
  }, [interval]);
  useEffect(() => { timeZoneRef.current = timeZone; saveLS("chart_tz", timeZone); }, [timeZone]);
  useEffect(() => { saveLS("fav_tfs", favTfs); }, [favTfs]);
  useEffect(() => { saveLS("side_order", sideOrder); }, [sideOrder]);
  useEffect(() => { saveLS("show_side_wl", showSideWl); }, [showSideWl]);
  useEffect(() => { saveLS("chart_type", chartType); }, [chartType]);
  useEffect(() => { saveLS("chart_layout", chartLayout); }, [chartLayout]);
  useEffect(() => { saveLS("pane_symbols", paneSymbols); }, [paneSymbols]);

  // Load full coin list once (same source as watchlist search)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/symbols", { cache: "force-cache" });
        const data = await res.json();
        const list: string[] = [];
        const rows = Array.isArray(data) ? data : data?.symbols || data?.data || [];
        for (const r of rows) {
          const s = typeof r === "string" ? r : r?.symbol;
          if (s && typeof s === "string") list.push(String(s).toUpperCase());
        }
        if (!cancelled && list.length) {
          setAllSymbols(Array.from(new Set(list)).sort());
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  /** Force main chart to fill container after layout change (esp. back to 1) */
  useEffect(() => {
    const forceResize = () => {
      try {
        const el = chartContainerRef.current;
        const chart = chartRef.current;
        if (!el || !chart) return;
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (w > 20 && h > 20) {
          chart.applyOptions({ width: w, height: h });
          try { chart.timeScale().applyOptions({}); } catch {}
        }
      } catch {}
    };
    forceResize();
    const t1 = window.setTimeout(forceResize, 50);
    const t2 = window.setTimeout(forceResize, 150);
    const t3 = window.setTimeout(forceResize, 350);
    let ro: ResizeObserver | null = null;
    try {
      const el = chartContainerRef.current;
      if (el && typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(() => forceResize());
        ro.observe(el);
      }
    } catch {}
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      try { ro?.disconnect(); } catch {}
    };
  }, [chartLayout]);
  const chartTypeRef = useRef(chartType);
  useEffect(() => { chartTypeRef.current = chartType; }, [chartType]);
  // Keyboard Undo / Redo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undoChart();
      } else if (e.key === "y" || (e.key === "z" && e.shiftKey)) {
        e.preventDefault();
        redoChart();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undoChart, redoChart]);

  useEffect(() => { saveLS("show_tools_panel", showToolsPanel); }, [showToolsPanel]);
  useEffect(() => { saveLS("side_view_id", sideViewId); }, [sideViewId]);
  useEffect(() => { saveLS("alarm_sections_v1", alarmSections); }, [alarmSections]);
  useEffect(() => { saveLS("history_mode", historyMode); }, [historyMode]);

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
      if (a.is_active && !a.triggered) set.add(chartSymbol(a.symbol));
    });
    return Array.from(set);
  }, [alarms]);
  const alarmSymbols = useMemo(() => {
    const set = new Set(alarmSymbolsRaw.map((s) => chartSymbol(s)));
    const ordered = sideOrder
      .map((s) => chartSymbol(s))
      .filter((s) => set.has(s));
    const rest = alarmSymbolsRaw
      .map((s) => chartSymbol(s))
      .filter((s) => !ordered.includes(s))
      .sort();
    // فقط نمادهایی که واقعاً آلارم فعال همین یوزر دارند
    return [...ordered, ...rest];
  }, [alarmSymbolsRaw, sideOrder]);

  /** Symbols shown in the right side panel (alarms view or selected watchlist) */
  const sidePanelSymbols = useMemo(() => {
    if (sideViewId === SIDE_VIEW_ALARMS) return alarmSymbols;
    const listItems = watchItems
      .filter((i) => i.list_id === sideViewId)
      .filter((i) => {
        const s = String(i.symbol || "");
        return s !== "__SECTION__" && !s.startsWith("__SECTION__:");
      })
      .sort((a, b) => (a.sort_order ?? 9999) - (b.sort_order ?? 9999));
    return listItems.map((i) => chartSymbol(i.symbol));
  }, [sideViewId, alarmSymbols, watchItems]);

  /** Full rows for watchlist panel (symbols + named section dividers) */
  const sidePanelRows = useMemo(() => {
    if (sideViewId === SIDE_VIEW_ALARMS) {
      type Out =
        | { kind: "sym"; symbol: string; itemId: string }
        | { kind: "section"; id: string; name: string };
      const rows: Out[] = alarmSymbols.map((s) => ({
        kind: "sym",
        symbol: s,
        itemId: "",
      }));
      const secs = [...(alarmSections || [])].sort(
        (a, b) => (a.sort_order || 0) - (b.sort_order || 0)
      );
      // insert from highest index so earlier inserts stay stable
      for (const sec of [...secs].reverse()) {
        const idx = Math.min(Math.max(0, (Number(sec.sort_order) || 1) - 1), rows.length);
        rows.splice(idx, 0, { kind: "section", id: sec.id, name: sec.name });
      }
      return rows;
    }
    const listItems = watchItems
      .filter((i) => i.list_id === sideViewId)
      .sort((a, b) => (a.sort_order ?? 9999) - (b.sort_order ?? 9999));
    return listItems.map((i) => {
      const s = String(i.symbol || "");
      if (s === "__SECTION__" || s.startsWith("__SECTION__:")) {
        const name =
          (i.note && String(i.note).trim()) ||
          (s.startsWith("__SECTION__:") ? s.slice("__SECTION__:".length) : "Section");
        return { kind: "section" as const, id: i.id, name };
      }
      return { kind: "sym" as const, symbol: chartSymbol(i.symbol), itemId: i.id };
    });
  }, [sideViewId, alarmSymbols, watchItems, alarmSections]);

  const sideViewLabel = useMemo(() => {
    if (sideViewId === SIDE_VIEW_ALARMS) return "Alarms";
    return watchLists.find((l) => l.id === sideViewId)?.name || "Watchlist";
  }, [sideViewId, watchLists]);

  const updateMargins = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const hasVol = showVol && volVisible;
    const hasRsi = showRSI && rsiVisible && !hideIndicators;
    const hasDmi = showDMI && dmiVisible && !hideIndicators;
    // Stack panes from bottom: DMI (lowest) → RSI → Volume → main chart
    // Each pane ~12–14% height, TradingView-style
    let used = 0;
    if (hasDmi) {
      const h = 0.13;
      try {
        chart.priceScale("dmi").applyOptions({
          scaleMargins: { top: 1 - used - h, bottom: used },
          borderVisible: false,
        });
      } catch {}
      used += h;
    }
    if (hasRsi) {
      const h = 0.14;
      try {
        chart.priceScale("rsi").applyOptions({
          scaleMargins: { top: 1 - used - h, bottom: used },
          borderVisible: false,
        });
      } catch {}
      used += h;
    }
    if (hasVol) {
      const h = 0.12;
      try {
        chart.priceScale("volume").applyOptions({
          scaleMargins: { top: 1 - used - h, bottom: used },
          borderVisible: false,
        });
      } catch {}
      used += h;
    }
    // Main price pane leaves room for lower panes
    chart.priceScale("right").applyOptions({
      scaleMargins: {
        top: 0.05,
        bottom: Math.max(0.05, used + 0.02),
      },
    });
  }, [showVol, volVisible, showRSI, rsiVisible, showDMI, dmiVisible, hideIndicators]);

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
    try {
      vlineOverlayRef.current?.querySelectorAll("[data-vline-guide]").forEach((el) => el.remove());
    } catch {}
    try {
      vlineOverlayRef.current?.querySelectorAll("[data-arrow-ring]").forEach((el) => el.remove());
    } catch {}
    try {
      vlineOverlayRef.current?.querySelectorAll("[data-arrow-preview]").forEach((el) => el.remove());
    } catch {}
    hideHandles();
    // Restore chart pan/zoom (never touch page overflow)
    try {
      chartRef.current?.applyOptions({
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
        handleScale: { axisPressedMouseMove: true, axisDoubleClickReset: true, mouseWheel: true, pinch: true },
      });
    } catch {}
    try {
      if (chartContainerRef.current) chartContainerRef.current.style.touchAction = "none";
      document.body.style.overflow = "";
      document.documentElement.style.overflow = "";
    } catch {}
    moveDiagRef.current = null;
    setPreviewPrice(null);
  }, [hideHandles]);

  const destroyChart = useCallback(() => {
    try {
      const ch = chartRef.current as any;
      if (ch?.__interactCleanup) { ch.__interactCleanup(); ch.__interactCleanup = null; }
    } catch {}
    if (interactTimerRef.current) { window.clearTimeout(interactTimerRef.current); interactTimerRef.current = null; }
    userInteractingRef.current = false;

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
    futureSeriesRef.current = null;
    if (chartRef.current) {
      try { chartRef.current.remove(); } catch {}
      chartRef.current = null;
    lastLoadedSymbolRef.current = "";
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
    const color = up ? "#089981" : "#f23645";
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

    // هر بار قبل از رسم، preview موقت را پاک کن تا خط دوتایی نماند
    try {
      if (previewLineRef.current) {
        series.removePriceLine(previewLineRef.current);
        previewLineRef.current = null;
      }
    } catch {}
    try {
      if (previewDiagSeriesRef.current) {
        chart.removeSeries(previewDiagSeriesRef.current);
        previewDiagSeriesRef.current = null;
      }
    } catch {}

    // Freeze visible window — adding line series with future times must not scroll the chart
    let savedRange: { from: number; to: number } | null = null;
    try {
      const lr = chart.timeScale().getVisibleLogicalRange();
      if (lr) savedRange = { from: lr.from, to: lr.to };
    } catch {}

    // Lock vertical scale so adding/removing diagonals cannot stretch candles
    let lockedPriceRange: { from: number; to: number } | null = null;
    try {
      const pr = (series.priceScale() as any).getVisibleRange?.();
      if (pr && pr.from != null && pr.to != null && Number(pr.to) > Number(pr.from)) {
        lockedPriceRange = { from: Number(pr.from), to: Number(pr.to) };
      }
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

    vlineItemsRef.current = [];
    rayItemsRef.current = [];
    arrowMoveItemsRef.current = [];
    try {
      vlineOverlayRef.current?.querySelectorAll("[data-arrow-ring]").forEach((el) => el.remove());
    } catch {}
    try {
      vlineOverlayRef.current?.querySelectorAll("[data-arrow-preview]").forEach((el) => el.remove());
    } catch {}
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
          !String(l.note).startsWith("__ray:") &&
          l.note !== "__vline__"
            ? String(l.note)
            : "";
        const title = isMoving ? "MOVING" : noteClean;
        const isArrowMark =
          typeof l.note === "string" &&
          (l.note === "__arrow_up__" ||
            l.note === "__arrow_down__" ||
            l.note === "__arrow_marker__" ||
            l.note.startsWith("__arrow"));
        const isVLine =
          !isArrowMark &&
          (l.note === "__vline__" ||
            (typeof l.note === "string" && l.note.startsWith("__vline__:")) ||
            (l.start_time != null &&
              l.end_time != null &&
              Number(l.start_time) === Number(l.end_time) &&
              l.end_price != null));
        if (hideLines) {
          // skip drawing lines when eye-hide is on
        } else if (isVLine) {
          // True vertical via DOM overlay (LWC line series always has time slope)
          const t = Number(l.start_time);
          if (!Number.isNaN(t) && t > 0) {
            vlineItemsRef.current.push({
              id: String(l.id),
              time: t,
              color: color,
              width: Math.max(1, Number(width) || 2),
              dash: isMoving ? "dashed" : String(l.dash || l.style || "solid"),
            });
          }
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
          const isArrow = l.note === "__arrow__" || (typeof l.note === "string" && l.note.startsWith("__arrow"));
          // Diagonals always solid continuous segment (dash looks like "gaps" on higher TF)
          const ls: any = chart.addLineSeries({
            color,
            lineWidth: width,
            lineStyle: LineStyle.Solid,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
            title: title || "",
            // prevent diagonal from pulling price scale / stretching candles
            autoscaleInfoProvider: () => null as any,
          });
          ls.setData(
            denseDiagPoints(t0, t1, v0, v1, intervalToSeconds(String(intervalRef.current)))
          );
          if (isArrow) {
            try {
              ls.setMarkers([
                {
                  time: et as any,
                  position: "inBar",
                  color,
                  shape: "arrowUp",
                  size: 2,
                },
              ]);
            } catch {}
          }
          chartLinesRef.current.set(l.id, ls);
        } else if (typeof l.note === "string" && l.note.startsWith("__rect:")) {
          const raw = l.note.replace(/^__rect:/, "");
          const parts = raw.split("|");
          if (parts.length >= 2) {
            const [a, b] = parts;
            const [t0s, p0s] = a.split(",");
            const [t1s, p1s] = b.split(",");
            const t0 = Number(t0s), t1 = Number(t1s), p0 = Number(p0s), p1 = Number(p1s);
            if (t1 > t0 && p1 !== p0) {
              const ls: any = chart.addLineSeries({
                color, lineWidth: width, lineStyle: style,
                priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
                autoscaleInfoProvider: () => null as any,
              });
              // rectangle as 4 edges via two horizontal + connecting (simplified box outline)
              ls.setData([
                { time: t0 as any, value: p0 },
                { time: t1 as any, value: p0 },
                { time: t1 as any, value: p1 },
                { time: t0 as any, value: p1 },
                { time: (t0 + 1) as any, value: p0 },
              ]);
              chartLinesRef.current.set(l.id, ls);
            }
          }
        } else if (typeof l.note === "string" && (l.note === "__arrow_up__" || l.note === "__arrow_down__" || l.note === "__arrow_marker__")) {
          const t = Number(l.start_time || 0);
          if (t > 0) {
            const baseCol =
              l.note === "__arrow_up__"
                ? (color && color !== DEFAULT_LINE_COLOR ? color : "#22c55e")
                : l.note === "__arrow_down__"
                ? (color && color !== DEFAULT_LINE_COLOR ? color : "#ef4444")
                : color || "#f97316";
            // Size: width 1/2/3 → visibly different marker sizes
            const w = Math.max(1, Math.min(3, Number(l.width) || width || 2));
            const mkSize = (w === 1 ? 1 : w === 2 ? 2 : 3) as 1 | 2 | 3;
            const mkColor = baseCol;
            const ls: any = chart.addLineSeries({
              color: "rgba(0,0,0,0)",
              lineWidth: 1,
              priceLineVisible: false,
              lastValueVisible: false,
              crosshairMarkerVisible: false,
              autoscaleInfoProvider: () => null as any,
            });
            ls.setData([{ time: t as any, value: l.price }]);
            try {
              const shape =
                l.note === "__arrow_up__" ? "arrowUp" : l.note === "__arrow_down__" ? "arrowDown" : "circle";
              if (isMoving) {
                // Hide solid marker — dashed hollow arrow drawn as SVG overlay
                ls.setMarkers([]);
              } else {
                ls.setMarkers([
                  {
                    time: t as any,
                    position: "inBar",
                    color: mkColor,
                    shape,
                    size: mkSize,
                  },
                ]);
              }
            } catch {}
            chartLinesRef.current.set(l.id, ls);

            // Moving: gray dashed hollow arrow (outline only), size follows width 1/2/3
            if (isMoving) {
              try {
                const host = vlineOverlayRef.current;
                const ser = seriesRef.current;
                if (host && ser) {
                  const px = w === 1 ? 24 : w === 2 ? 32 : 42;
                  let el = host.querySelector(`[data-arrow-ring="${l.id}"]`) as HTMLDivElement | null;
                  if (!el) {
                    el = document.createElement("div");
                    el.dataset.arrowRing = String(l.id);
                    host.appendChild(el);
                  }
                  el.style.cssText =
                    `position:absolute;width:${px}px;height:${px}px;margin-left:-${px / 2}px;margin-top:-${px / 2}px;pointer-events:none;z-index:30;`;
                  const up = l.note === "__arrow_up__";
                  const down = l.note === "__arrow_down__";
                  const stroke = "#9ca3af"; // gray dashed outline
                  const sw = w === 1 ? 1.5 : w === 2 ? 2 : 2.5;
                  const svg = up
                    ? `<svg width="${px}" height="${px}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 6 L26 18 L20 18 L20 26 L12 26 L12 18 L6 18 Z" stroke="${stroke}" stroke-width="${sw}" stroke-dasharray="3 2" fill="none"/></svg>`
                    : down
                    ? `<svg width="${px}" height="${px}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 26 L6 14 L12 14 L12 6 L20 6 L20 14 L26 14 Z" stroke="${stroke}" stroke-width="${sw}" stroke-dasharray="3 2" fill="none"/></svg>`
                    : `<svg width="${px}" height="${px}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="16" cy="16" r="9" stroke="${stroke}" stroke-width="${sw}" stroke-dasharray="3 2" fill="none"/></svg>`;
                  el.innerHTML = svg;
                  arrowMoveItemsRef.current.push({ id: String(l.id), time: t, price: Number(l.price) });
                  const x = chart.timeScale().timeToCoordinate(t as any);
                  const y = ser.priceToCoordinate(Number(l.price));
                  if (x != null && y != null && !Number.isNaN(x) && !Number.isNaN(y)) {
                    el.style.left = `${x}px`;
                    el.style.top = `${y}px`;
                    el.style.display = "block";
                  } else {
                    el.style.display = "none";
                  }
                }
              } catch {}
            }
          }
        } else if (typeof l.note === "string" && (l.note.startsWith("__path:") || l.note.startsWith("__curve:"))) {
          const raw = l.note.replace(/^__(?:path|curve):/, "");
          const pairs = raw.split("|").map((s) => {
            const [tt, pp] = s.split(",");
            return { time: Number(tt), value: Number(pp) };
          }).filter((p) => p.time > 0 && !Number.isNaN(p.value));
          pairs.sort((a, b) => a.time - b.time);
          for (let i = 1; i < pairs.length; i++) {
            if (pairs[i].time <= pairs[i - 1].time) pairs[i].time = pairs[i - 1].time + 1;
          }
          if (pairs.length >= 2) {
            const ls: any = chart.addLineSeries({
              color,
              lineWidth: width,
              lineStyle: style,
              priceLineVisible: false,
              lastValueVisible: false,
              crosshairMarkerVisible: false,
              title: title || "",
              autoscaleInfoProvider: () => null as any,
            });
            ls.setData(pairs.map((p) => ({ time: p.time as any, value: p.value })));
            chartLinesRef.current.set(l.id, ls);
          }
        } else if (l.start_time != null) {
          // Horizontal half-line via DOM overlay (no LWC gap on any TF)
          const bars = candlesRef.current || [];
          const t0 = snapTimeToBars(Number(l.start_time), bars);
          if (!Number.isNaN(t0) && t0 > 0) {
            rayItemsRef.current.push({
              id: String(l.id),
              time: t0,
              price: Number(l.price),
              color: color,
              width: Math.max(1, Number(width) || 2),
              dash: isMoving ? "dashed" : String(l.dash || l.style || "solid"),
            });
          }
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
            autoscaleInfoProvider: () => null as any,
          });
          // Dense points — continuous on any TF (hit detection still uses projectedPriceOnDiag)
          ls.setData(
            denseDiagPoints(t0, t1, v0, v1, intervalToSeconds(String(intervalRef.current)))
          );
          chartLinesRef.current.set(`alarm-diag-${a.id}`, ls);
        } else if (a.start_time != null) {
          // Horizontal half-line alarm via DOM overlay
          const bars = candlesRef.current || [];
          const t0 = snapTimeToBars(Number(a.start_time), bars);
          if (!Number.isNaN(t0) && t0 > 0) {
            rayItemsRef.current.push({
              id: `alarm-ray-${a.id}`,
              time: t0,
              price: Number(a.price),
              color: color,
              width: Math.max(1, Number(width) || 2),
              dash: isMoving ? "dashed" : String(a.dash || "solid"),
            });
          }
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
    // Paint true-vertical DOM lines
    const paintVLines = () => {
      const host = vlineOverlayRef.current;
      const chart2 = chartRef.current;
      if (!host || !chart2) return;
      // Only remove vertical line nodes — keep rays intact
      host.querySelectorAll("[data-vline-id]").forEach((el) => el.remove());
      if (hideLines) return;
      for (const v of vlineItemsRef.current) {
        let x: number | null = null;
        try {
          x = chart2.timeScale().timeToCoordinate(v.time as any);
        } catch { x = null; }
        if (x == null || Number.isNaN(x)) continue;
        const el = document.createElement("div");
        el.dataset.vlineId = v.id;
        el.style.position = "absolute";
        el.style.top = "0";
        el.style.bottom = "0";
        el.style.left = `${x}px`;
        el.style.width = `${Math.max(1, v.width)}px`;
        el.style.transform = "translateX(-50%)";
        el.style.pointerEvents = "none";
        el.style.zIndex = "5";
        if (v.dash === "dashed" || v.dash === "dotted") {
          el.style.background = "transparent";
          el.style.borderLeft = `${Math.max(1, v.width)}px ${v.dash === "dotted" ? "dotted" : "dashed"} ${v.color}`;
          el.style.width = "0";
        } else {
          el.style.background = v.color;
        }
        host.appendChild(el);
      }
    };

    const paintRays = () => {
      const host = vlineOverlayRef.current;
      const chart2 = chartRef.current;
      const ser = seriesRef.current;
      if (!host || !chart2 || !ser) return;
      host.querySelectorAll("[data-ray-id]").forEach((el) => el.remove());
      if (hideLines) return;
      const hostW = host.clientWidth || host.getBoundingClientRect().width || 800;
      for (const r of rayItemsRef.current) {
        let x: number | null = null;
        let y: number | null = null;
        try {
          x = chart2.timeScale().timeToCoordinate(r.time as any);
        } catch { x = null; }
        try {
          y = ser.priceToCoordinate(r.price);
        } catch { y = null; }
        if (y == null || Number.isNaN(y)) continue;
        // If origin is left of viewport, start at 0 so ray still spans to the right edge
        const x0 = x == null || Number.isNaN(x) ? 0 : Math.max(0, x);
        if (x0 > hostW) continue;
        const el = document.createElement("div");
        el.dataset.rayId = r.id;
        el.style.position = "absolute";
        el.style.left = `${x0}px`;
        el.style.top = `${y}px`;
        el.style.width = `${Math.max(4, hostW - x0)}px`;
        el.style.height = `${Math.max(1, r.width)}px`;
        el.style.transform = "translateY(-50%)";
        el.style.background = r.color;
        el.style.opacity = "0.95";
        el.style.pointerEvents = "none";
        el.style.zIndex = "5";
        el.style.willChange = "left, top, width";
        if (r.dash === "dashed") {
          el.style.background = "transparent";
          el.style.borderTop = `${Math.max(1, r.width)}px dashed ${r.color}`;
          el.style.height = "0px";
        }
        host.appendChild(el);
      }
    };

    /** Live-sync DOM overlays while user pans/zooms (no React, no flicker) */
    const syncOverlayPositions = () => {
      const host = vlineOverlayRef.current;
      const chart2 = chartRef.current;
      const ser = seriesRef.current;
      if (!host || !chart2) return;
      const hostW = host.clientWidth || host.getBoundingClientRect().width || 800;
      for (const child of Array.from(host.children) as HTMLElement[]) {
        if (child.dataset.vlineId) {
          const item = vlineItemsRef.current.find((v) => v.id === child.dataset.vlineId);
          if (!item) continue;
          let x: number | null = null;
          try { x = chart2.timeScale().timeToCoordinate(item.time as any); } catch { x = null; }
          if (x == null || Number.isNaN(x)) {
            child.style.visibility = "hidden";
          } else {
            child.style.visibility = "visible";
            child.style.left = `${x}px`;
          }
        } else if (child.dataset.rayId && ser) {
          const item = rayItemsRef.current.find((v) => v.id === child.dataset.rayId);
          if (!item) continue;
          let x: number | null = null;
          let y: number | null = null;
          try { x = chart2.timeScale().timeToCoordinate(item.time as any); } catch { x = null; }
          try { y = ser.priceToCoordinate(item.price); } catch { y = null; }
          if (y == null || Number.isNaN(y)) {
            child.style.visibility = "hidden";
            continue;
          }
          const x0 = x == null || Number.isNaN(x) ? 0 : Math.max(0, x);
          if (x0 > hostW) {
            child.style.visibility = "hidden";
            continue;
          }
          child.style.visibility = "visible";
          child.style.left = `${x0}px`;
          child.style.top = `${y}px`;
          child.style.width = `${Math.max(4, hostW - x0)}px`;
        } else if (child.dataset.arrowRing && ser) {
          const item = arrowMoveItemsRef.current.find((a) => a.id === child.dataset.arrowRing);
          if (!item) continue;
          let x: number | null = null;
          let y: number | null = null;
          try { x = chart2.timeScale().timeToCoordinate(item.time as any); } catch { x = null; }
          try { y = ser.priceToCoordinate(item.price); } catch { y = null; }
          if (x == null || y == null || Number.isNaN(x) || Number.isNaN(y)) {
            child.style.visibility = "hidden";
          } else {
            child.style.visibility = "visible";
            child.style.left = `${x}px`;
            child.style.top = `${y}px`;
          }
        }
      }
    };

    paintVLines();
    paintRays();
    // Sync overlay on horizontal scroll AND vertical price pan
    const scheduleOverlaySync = () => {
      requestAnimationFrame(() => {
        try {
          syncOverlayPositions();
        } catch {
          try {
            paintVLines();
            paintRays();
          } catch {}
        }
      });
    };
    try {
      chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleOverlaySync);
    } catch {}
    // Vertical pan/zoom does not fire timeScale events — listen on container
    try {
      const hostEl = chartContainerRef.current;
      if (hostEl) {
        hostEl.addEventListener("wheel", scheduleOverlaySync, { passive: true });
        hostEl.addEventListener("pointermove", scheduleOverlaySync, { passive: true });
        hostEl.addEventListener("touchmove", scheduleOverlaySync, { passive: true });
      }
    } catch {}

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
    // Restore price scale so diagonals never stretch candles
    if (lockedPriceRange) {
      try {
        (series.priceScale() as any).setVisibleRange(lockedPriceRange);
        priceRangeOverrideRef.current = lockedPriceRange;
      } catch {}
    }
  }, [currentLines, currentAlarms, movingId, movingType, highlightAlarmId, highlightPrice, highlightDiag, highlightRay, hideLines, hideAlarms]);
  useEffect(() => { renderAllLinesAndAlarmsRef.current = renderAllLinesAndAlarms; }, [renderAllLinesAndAlarms]);


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
      color: rsiColor,
      lineWidth: 2,
      priceScaleId: "rsi",
      priceLineVisible: false,
      lastValueVisible: true,
      // Fixed 0–100 range like TradingView RSI pane
      autoscaleInfoProvider: () => ({
        priceRange: { minValue: 0, maxValue: 100 },
      }),
    });
    s.setData(calcRSI(candlesRef.current, rsiPeriod) as any);
    // Overbought / mid / oversold dashed guides
    try {
      s.createPriceLine({
        price: 70,
        color: "rgba(148,163,184,0.55)",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "",
      });
      s.createPriceLine({
        price: 30,
        color: "rgba(148,163,184,0.55)",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "",
      });
      s.createPriceLine({
        price: 50,
        color: "rgba(148,163,184,0.28)",
        lineWidth: 1,
        lineStyle: LineStyle.Dotted,
        axisLabelVisible: false,
        title: "",
      });
    } catch {}
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
    const paneOpts = {
      priceScaleId: "dmi",
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: () => ({
        priceRange: { minValue: 0, maxValue: 100 },
      }),
    } as const;
    const plus = chartRef.current.addLineSeries({ color: dmiPlusColor, lineWidth: 1, ...paneOpts });
    const minus = chartRef.current.addLineSeries({ color: dmiMinusColor, lineWidth: 1, ...paneOpts });
    const adxS = chartRef.current.addLineSeries({ color: dmiAdxColor, lineWidth: 2, ...paneOpts });
    plus.setData(plusDI as any);
    minus.setData(minusDI as any);
    adxS.setData(adx as any);
    // ADX strength guides (20 / 40) — dashed like TV
    try {
      adxS.createPriceLine({
        price: 20,
        color: "rgba(148,163,184,0.45)",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "",
      });
      adxS.createPriceLine({
        price: 40,
        color: "rgba(148,163,184,0.35)",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
        title: "",
      });
    } catch {}
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


  const syncFutureAxis = useCallback((candles: any[], iv: string) => {
    try {
      const chart = chartRef.current;
      const last = candles[candles.length - 1];
      if (!chart || !last) return;
      const pts = futureHelperPoints(candles, iv, FUTURE_BARS, last.close);
      if (!futureSeriesRef.current) {
        futureSeriesRef.current = chart.addLineSeries({
          color: "rgba(0,0,0,0)",
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          visible: true,
        } as any);
      }
      futureSeriesRef.current.setData(pts as any);
    } catch {}
  }, []);

  const loadCandles = useCallback(async () => {
    const container = chartContainerRef.current;
    if (!container) return;
    if (container.clientWidth < 20) {
      await new Promise((r) => setTimeout(r, 150));
    }
    // Keep previous chart visible until new data is ready (no black flash on TF switch).
    // Capture symbol/interval + generation so a slow response never clobbers a newer request.
    // فقط رنج قیمت دستی را ریست کن — prev آلارم‌ها را پاک نکن (دیر تریگر نشود)
    priceRangeOverrideRef.current = null;
    const gen = ++loadGenRef.current;
    const fetchSym = chartSymbol(symbolRef.current);
    const fetchIv = String(intervalRef.current);
    // فقط اگر چارت هنوز ساخته نشده Loading بزرگ نشان بده (جلوگیری از چشمک هنگام عوض TF)
    if (!chartRef.current || !seriesRef.current) {
      setStatusMsg("Loading...");
    } else {
      setStatusMsg("");
    }
    try {
      const fetchRows = async (limit: number, endTime?: number) => {
        let url = `/api/kline?symbol=${encodeURIComponent(fetchSym)}&interval=${encodeURIComponent(fetchIv)}&limit=${limit}`;
        if (endTime != null && endTime > 0) url += `&endTime=${endTime}`;
        const res = await fetch(url, { cache: "no-store" });
        const raw = await res.json();
        return Array.isArray(raw) ? raw : raw?.data || raw?.result?.list || raw?.candles || [];
      };
      // FAST first paint: one request only (max 1000). More history loads in background after paint.
      let rows: any[] = await fetchRows(1000);
      if (gen !== loadGenRef.current) return;
      if (!rows.length) {
        await new Promise((r) => setTimeout(r, 250));
        if (gen !== loadGenRef.current) return;
        rows = await fetchRows(1000);
      }
      if (gen !== loadGenRef.current) return;
      if (!rows.length) { setStatusMsg("No data — change TF or retry"); return; }

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

      if (gen !== loadGenRef.current) return;

      candlesRef.current = candles;
      const lastClose = candles[candles.length - 1]?.close || 1;
      const lastTime = candles[candles.length - 1]?.time ?? null;
      setLastBarClose(lastClose);
      setLastBarTime(lastTime);
      const { precision, minMove } = getPrecision(lastClose);
      const tz = timeZoneRef.current;
      const isIntraday = ["1", "5", "15"].includes(fetchIv);

      // ── Soft path: keep same chart instance (no black flash / no freeze) ──
      if (chartRef.current && seriesRef.current) {
        try {
          const chart = chartRef.current;
          const series = seriesRef.current;

          // 1) Paint candles FIRST so TF/symbol switch feels instant
          const symbolChanged =
            lastLoadedSymbolRef.current !== "" &&
            lastLoadedSymbolRef.current !== fetchSym;
          lastLoadedSymbolRef.current = fetchSym;

          series.applyOptions({
            priceFormat: { type: "price", precision, minMove },
          });

          // On symbol change: strip old price lines first so scale is not stuck at BTC levels
          if (symbolChanged) {
            try {
              const pls = (series as any).priceLines?.() || [];
              for (const pl of pls) {
                try { series.removePriceLine(pl); } catch {}
              }
            } catch {}
            // Clear stale indicators that still hold old price range
            try {
              for (const s of [smaSeriesRef.current?.s1, smaSeriesRef.current?.s2, smaSeriesRef.current?.s3]) {
                if (s) { try { s.setData([]); } catch {} }
              }
            } catch {}
          }

          // Clear old price-lines before data so autoscale is not stuck (TF + symbol)
          try {
            const pls = (series as any).priceLines?.() || [];
            for (const pl of pls) {
              try { series.removePriceLine(pl); } catch {}
            }
          } catch {}

          series.setData(appendFutureWhitespace(candles, fetchIv) as any);
          try { syncFutureAxis(candles, fetchIv); } catch {}

          chart.applyOptions({
            localization: makeLocalization(tz),
            timeScale: {
              secondsVisible: isIntraday,
              tickMarkFormatter: makeTickMarkFormatter(tz) as any,
            },
          });

          const intervalChanged =
            lastLoadedIntervalRef.current !== "" &&
            lastLoadedIntervalRef.current !== fetchIv;
          const shouldResetView =
            symbolChanged ||
            intervalChanged ||
            lastLoadedIntervalRef.current === "";
          lastLoadedIntervalRef.current = fetchIv;

          // مثل عوض کوین: برو روی آخرین کندل‌های واقعی — نه ته فضای خالی آینده
          // نکته: appendFutureWhitespace صدها بار خالی اضافه می‌کند؛
          // scrollToRealTime می‌رود ته همان فضا → چارت خالی (باگ قبلی)
          if (shouldResetView) {
            try {
              priceRangeOverrideRef.current = null;
              pinnedToRightRef.current = true;
              setShowGoLive(false);
              programmaticRangeRef.current = true;

              series.priceScale().applyOptions({
                autoScale: true,
                scaleMargins: { top: 0.08, bottom: 0.12 },
              });
              chart.priceScale("right").applyOptions({ autoScale: true });

              const snapToLastCandles = () => {
                try {
                  const n = (candlesRef.current && candlesRef.current.length
                    ? candlesRef.current.length
                    : candles.length);
                  if (n < 2) return;
                  series.priceScale().applyOptions({
                    autoScale: true,
                    scaleMargins: { top: 0.08, bottom: 0.12 },
                  });
                  chart.priceScale("right").applyOptions({ autoScale: true });
                  // logical index: 0..n-1 = کندل واقعی؛ بعدش whitespace
                  const past = Math.min(500, n);
                  chart.timeScale().applyOptions({ rightOffset: 12, barSpacing: 2.5 });
                  chart.timeScale().setVisibleLogicalRange({
                    from: Math.max(0, n - past),
                    to: n - 1 + FUTURE_VISIBLE,
                  });
                } catch {}
              };

              snapToLastCandles();
              requestAnimationFrame(() => {
                snapToLastCandles();
                requestAnimationFrame(() => {
                  snapToLastCandles();
                  programmaticRangeRef.current = false;
                });
              });
            } catch {
              programmaticRangeRef.current = false;
            }
          } else {
            try {
              series.priceScale().applyOptions({
                autoScale: true,
                scaleMargins: { top: 0.08, bottom: 0.12 },
              });
              chart.priceScale("right").applyOptions({ autoScale: true });
            } catch {}
          }

          // 2) Then clear overlays (chart already shows new TF candles)
          clearPreview();
          try {
            if (lastPriceLineRef.current) {
              series.removePriceLine(lastPriceLineRef.current);
              lastPriceLineRef.current = null;
            }
          } catch {}
          alarmLinesRef.current.forEach((pl) => {
            try { series.removePriceLine(pl); } catch {}
          });
          alarmLinesRef.current.clear();
          chartLinesRef.current.forEach((s) => {
            try {
              if (s && typeof s === "object" && "applyOptions" in s) {
                try { chart.removeSeries(s); } catch {
                  try { series.removePriceLine(s); } catch {}
                }
              } else {
                try { series.removePriceLine(s); } catch {}
              }
            } catch {}
          });
          chartLinesRef.current.clear();
          try {
            if (smaSeriesRef.current) {
              const { s1, s2, s3 } = smaSeriesRef.current;
              try { chart.removeSeries(s1); } catch {}
              try { chart.removeSeries(s2); } catch {}
              try { chart.removeSeries(s3); } catch {}
              smaSeriesRef.current = null;
            }
          } catch {}
          try {
            if (rsiSeriesRef.current) {
              chart.removeSeries(rsiSeriesRef.current);
              rsiSeriesRef.current = null;
            }
          } catch {}
          try {
            if (dmiSeriesRef.current) {
              const { plus, minus, adx } = dmiSeriesRef.current;
              try { chart.removeSeries(plus); } catch {}
              try { chart.removeSeries(minus); } catch {}
              try { chart.removeSeries(adx); } catch {}
              dmiSeriesRef.current = null;
            }
          } catch {}
          pivotSeriesRef.current.forEach((s) => {
            try { chart.removeSeries(s); } catch {}
          });
          pivotSeriesRef.current = [];
          trendSeriesRef.current.forEach((s) => {
            try { chart.removeSeries(s); } catch {}
          });
          trendSeriesRef.current = [];
          try {
            if (volumeSeriesRef.current) {
              chart.removeSeries(volumeSeriesRef.current);
              volumeSeriesRef.current = null;
            }
          } catch {}

          if (gen !== loadGenRef.current) return;
          renderAllLinesAndAlarms();
          rebuildIndicators();
          applyLastPriceLabel();
          setStatusMsg("");

          // Background: add older history (does not block UI; skip if user already switched away)
          void (async () => {
            try {
              const myGen = gen;
              let all = candles.slice();
              for (let p = 0; p < 12; p++) {
                if (myGen !== loadGenRef.current) return;
                const oldest = all[0]?.time;
                if (!oldest) break;
                const olderRaw = await fetchRows(1000, oldest - 1);
                if (myGen !== loadGenRef.current) return;
                if (!Array.isArray(olderRaw) || !olderRaw.length) break;
                const mapped = olderRaw
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
                  .filter((c: any) => c.time && !Number.isNaN(c.close));
                const seen = new Set(all.map((c) => c.time));
                const extra = mapped.filter((c: any) => !seen.has(c.time));
                if (extra.length < 10) break;
                all = [...extra, ...all].sort((a, b) => a.time - b.time);
              }
              if (myGen !== loadGenRef.current) return;
              if (all.length <= candles.length) return;
              // تاریخچه بیشتر به چپ اضافه می‌شود — رنج را بر اساس زمان نگه دار نه logical
              candlesRef.current = all;
              if (seriesRef.current && chartRef.current) {
                let savedTime: any = null;
                try {
                  savedTime = (chartRef.current.timeScale() as any).getVisibleRange?.();
                } catch {}
                seriesRef.current.setData(appendFutureWhitespace(all, fetchIv) as any);
                try { syncFutureAxis(all, fetchIv); } catch {}
                // اگر تازه TF/کوین عوض شده، رنج ذخیره‌شده را برنگردان — بمان روی آخرین کندل
                const keepLatest =
                  pinnedToRightRef.current ||
                  Date.now() < (alarmCooldownUntilRef.current || 0) + 2000;
                if (
                  !keepLatest &&
                  savedTime &&
                  savedTime.from != null &&
                  savedTime.to != null
                ) {
                  try {
                    programmaticRangeRef.current = true;
                    (chartRef.current.timeScale() as any).setVisibleRange(savedTime);
                    requestAnimationFrame(() => {
                      programmaticRangeRef.current = false;
                    });
                  } catch {
                    programmaticRangeRef.current = false;
                  }
                } else if (keepLatest && chartRef.current && seriesRef.current) {
                  try {
                    const n = all.length;
                    if (n >= 2) {
                      programmaticRangeRef.current = true;
                      const past = Math.min(500, n);
                      chartRef.current.timeScale().setVisibleLogicalRange({
                        from: Math.max(0, n - past),
                        to: n - 1 + FUTURE_VISIBLE,
                      });
                      seriesRef.current.priceScale().applyOptions({ autoScale: true });
                      requestAnimationFrame(() => {
                        programmaticRangeRef.current = false;
                      });
                    }
                  } catch {
                    programmaticRangeRef.current = false;
                  }
                }
                try { rebuildIndicators(); } catch {}
                try { renderAllLinesAndAlarms(); } catch {}
              }
            } catch {}
          })();

          return; // done — no destroy, no recreate
        } catch (softErr) {
          console.warn("soft TF switch failed, full rebuild", softErr);
          destroyChart();
        }
      }

      // ── Full path: first load or soft update failed ──
      destroyChart();
      if (gen !== loadGenRef.current) return;

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
          scaleMargins: { top: 0.06, bottom: 0.08 },
          entireTextOnly: false,
          autoScale: true,
          mode: 0, // Normal — drag/scroll price axis freely (TV-style)
          invertScale: false,
          alignLabels: true,
        },
        // اسکرول روی محور قیمت = زوم عمودی؛ روی بدنه چارت = افقی
        handleScroll: {
          mouseWheel: true,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: true,
        },
        // موبایل: اینرسی اسکرول افقی/عمودی (بدون این، درSafari/Chrome موبایل چارت «گیر» می‌کند)
        kineticScroll: {
          touch: true,
          mouse: true,
        },
        handleScale: {
          // چرخ ماوس روی محور راست قیمت → زوم عمودی مثل TradingView
          axisPressedMouseMove: { time: true, price: true },
          axisDoubleClickReset: { time: true, price: true },
          mouseWheel: true,
          pinch: true,
        },
        timeScale: {
          borderColor: "#2a2e39",
          timeVisible: true,
          secondsVisible: isIntraday,
          // فضای خالی آینده خیلی بیشتر (مثل TradingView)
          rightOffset: 12,
          barSpacing: 2.5,
          minBarSpacing: 1.5,
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
      try {
        chart.applyOptions({
          handleScroll: {
            mouseWheel: true,
            pressedMouseMove: true,
            horzTouchDrag: true,
            vertTouchDrag: true,
          },
          kineticScroll: {
            touch: true,
            mouse: true,
          },
          handleScale: {
            axisPressedMouseMove: { time: true, price: true },
            axisDoubleClickReset: { time: true, price: true },
            mouseWheel: true,
            pinch: true,
          },
        });
        // موبایل: touch-action none تا ژست‌ها به LWC برسد (نه اسکرول صفحه)
        container.style.touchAction = "none";
        container.style.webkitUserSelect = "none";
        (container.style as any).userSelect = "none";
        (container.style as any).webkitUserSelect = "none";
        (container.style as any).userSelect = "none";
        // اطمینان از باز بودن اسکرول لمسی
        chart.applyOptions({
          handleScroll: {
            mouseWheel: true,
            pressedMouseMove: true,
            horzTouchDrag: true,
            vertTouchDrag: true,
          },
        });
      } catch {}
      const ctype = chartTypeRef.current || chartType;
      const dataSrc = ctype === "heikin" ? toHeikinAshi(candles) : candles;
      const withFuture = appendFutureWhitespace(dataSrc, String(intervalRef.current));
      let series: any;
      if (ctype === "line") {
        series = chart.addLineSeries({
          color: "#3b82f6",
          lineWidth: 2,
          priceFormat: { type: "price", precision, minMove },
          lastValueVisible: false,
          priceLineVisible: false,
        });
        series.setData(
          withFuture
            .filter((c: any) => c.open != null || c.close != null || c.value != null)
            .map((c: any) => ({ time: c.time, value: c.close ?? c.value })) as any
        );
      } else if (ctype === "area") {
        series = chart.addAreaSeries({
          lineColor: "#3b82f6",
          topColor: "rgba(59,130,246,0.35)",
          bottomColor: "rgba(59,130,246,0.02)",
          lineWidth: 2,
          priceFormat: { type: "price", precision, minMove },
          lastValueVisible: false,
          priceLineVisible: false,
        });
        series.setData(
          withFuture
            .filter((c: any) => c.open != null || c.close != null || c.value != null)
            .map((c: any) => ({ time: c.time, value: c.close ?? c.value })) as any
        );
      } else {
        // candles | hollow | heikin
        const hollow = ctype === "hollow";
        series = chart.addCandlestickSeries({
          upColor: hollow ? "transparent" : "#089981",
          downColor: hollow ? "transparent" : "#f23645",
          borderUpColor: "#089981",
          borderDownColor: "#f23645",
          wickUpColor: "#089981",
          wickDownColor: "#f23645",
          priceFormat: { type: "price", precision, minMove },
          lastValueVisible: false,
          priceLineVisible: false,
        });
        series.setData(withFuture as any);
      }
              try { syncFutureAxis(candles, String(intervalRef.current)); } catch {}
      try { syncFutureAxis(candles, String(intervalRef.current)); } catch {}
      lastLoadedSymbolRef.current = fetchSym;
      seriesRef.current = series;
      pinnedToRightRef.current = true;
      setShowGoLive(false);

      // اسکرول روی محور قیمت → زوم عمودی | بقیه چارت → افقی (پیش‌فرض LWC)
      try {
        chart.applyOptions({
          handleScale: {
            axisPressedMouseMove: { time: true, price: true },
            axisDoubleClickReset: { time: true, price: true },
            mouseWheel: true,
            pinch: true,
          },
          handleScroll: {
            mouseWheel: true,
            pressedMouseMove: true,
            horzTouchDrag: true,
            vertTouchDrag: true,
          },
        });
      } catch {}
      // autoscaleInfoProvider برای زوم عمودی دستی
      try {
        series.applyOptions({
          autoscaleInfoProvider: (original: any) => {
            const ov = priceRangeOverrideRef.current;
            if (ov && ov.to > ov.from) {
              return {
                priceRange: { minValue: ov.from, maxValue: ov.to },
              };
            }
            try {
              return typeof original === "function" ? original() : original;
            } catch {
              return null;
            }
          },
        } as any);
      } catch {}
      try {
        const onWheelPrice = (e: WheelEvent) => {
          const rect = container.getBoundingClientRect();
          const fromRight = rect.right - e.clientX;
          const yRatio = (e.clientY - rect.top) / Math.max(1, rect.height);
          // پنل اسیلاتور: هرجای ارتفاع پنل + اسکرول = زوم عمودی همان پنل
          const hasRsi = !!(rsiSeriesRef.current);
          const hasDmi = !!(dmiSeriesRef.current);
          const hasVol = !!(volumeSeriesRef.current);
          // margins approx (must match updateMargins stacking from bottom)
          let bot = 0;
          const zones: { id: string; top: number; bot: number }[] = [];
          if (hasDmi) { const h = 0.13; zones.push({ id: "dmi", top: 1 - bot - h, bot }); bot += h; }
          if (hasRsi) { const h = 0.14; zones.push({ id: "rsi", top: 1 - bot - h, bot }); bot += h; }
          if (hasVol) { const h = 0.12; zones.push({ id: "volume", top: 1 - bot - h, bot }); bot += h; }
          const inPane = zones.find((z) => yRatio >= z.top - 0.01 && yRatio <= 1 - z.bot + 0.01);
          // فقط لبه راست پنل اسیلاتور — تا اسکرول افقی چارت خراب نشود
          if (inPane && (inPane.id === "rsi" || inPane.id === "dmi") && fromRight <= 100) {
            e.preventDefault();
            e.stopPropagation();
            let delta = e.deltaY;
            if (Math.abs(delta) < 0.5 && Math.abs(e.deltaX) > Math.abs(delta)) delta = e.deltaX;
            if (e.deltaMode === 1) delta *= 16;
            if (delta === 0) return;
            const zoomIn = delta < 0;
            // تغییر ارتفاع پنل با scaleMargins
            try {
              const chart = chartRef.current;
              if (!chart) return;
              const ps = chart.priceScale(inPane.id) as any;
              const cur = inPane;
              const h = (1 - cur.bot) - cur.top;
              const nh = Math.min(0.28, Math.max(0.08, h * (zoomIn ? 1.08 : 0.92)));
              const top = 1 - cur.bot - nh;
              ps.applyOptions({ scaleMargins: { top: Math.max(0.5, top), bottom: cur.bot } });
              try {
                const ser = inPane.id === "rsi" ? rsiSeriesRef.current : dmiSeriesRef.current?.adx;
                if (ser && typeof ser.priceScale === "function") {
                  const factor = zoomIn ? 0.9 : 1.12;
                  const mid = 50;
                  const half = zoomIn ? 40 : 55;
                  ser.applyOptions({
                    autoscaleInfoProvider: () => ({
                      priceRange: {
                        minValue: Math.max(0, mid - half * factor),
                        maxValue: Math.min(100, mid + half * factor),
                      },
                    }),
                  });
                }
              } catch {}
            } catch {}
            return;
          }
          // فقط نوار قیمت سمت راست (~90px) برای چارت اصلی
          if (fromRight > 90 || fromRight < 0) return;
          e.preventDefault();
          e.stopPropagation();
          const s = seriesRef.current as any;
          if (!s) return;

          // جهت: اسکرول بالا = بزرگ‌تر (zoom in) | پایین = کوچک‌تر (zoom out)
          // نرمال‌سازی delta تا هر تیک موس یک پله ملایم باشد (نه پرش شدید)
          let delta = e.deltaY;
          if (Math.abs(delta) < 0.5 && Math.abs(e.deltaX) > Math.abs(delta)) delta = e.deltaX;
          if (e.deltaMode === 1) delta *= 16; // line mode
          if (e.deltaMode === 2) delta *= 40; // page mode — قبلاً 400 خیلی تند بود
          if (delta === 0) return;
          // هر چقدر delta بزرگ باشد فقط یک پله (±1) حساب کن تا پرش نکند
          const steps = Math.max(1, Math.min(3, Math.round(Math.abs(delta) / 100)));
          const zoomIn = delta < 0;

          let pTop: number | null = null;
          let pBot: number | null = null;
          const ov0 = priceRangeOverrideRef.current;
          if (ov0 && ov0.to > ov0.from) {
            pBot = ov0.from;
            pTop = ov0.to;
          } else {
            try {
              const t = s.coordinateToPrice?.(1);
              const b = s.coordinateToPrice?.(Math.max(2, container.clientHeight - 1));
              if (t != null && b != null && Number.isFinite(t) && Number.isFinite(b)) {
                pTop = Math.max(Number(t), Number(b));
                pBot = Math.min(Number(t), Number(b));
              }
            } catch {}
          }
          if (pTop == null || pBot == null || !(pTop > pBot)) return;

          const relY = Math.min(1, Math.max(0, (e.clientY - rect.top) / Math.max(1, rect.height)));
          const priceAtCursor = pTop - relY * (pTop - pBot);
          // پله ملایم ~6٪ در هر تیک (pinch همچنان با touch جداست)
          let factor = 1;
          for (let i = 0; i < steps; i++) {
            factor *= zoomIn ? 0.94 : 1.06;
          }
          const newRange = Math.max((pTop - pBot) * factor, Math.abs(priceAtCursor) * 0.00005 + 0.5);
          const aboveRatio = (pTop - priceAtCursor) / Math.max(1e-12, pTop - pBot);
          const newTop = priceAtCursor + newRange * aboveRatio;
          const newBot = priceAtCursor - newRange * (1 - aboveRatio);
          if (!(newTop > newBot)) return;
          priceRangeOverrideRef.current = { from: newBot, to: newTop };
          try {
            const ps = s.priceScale?.() || chart.priceScale("right");
            // autoScale را روشن نگه دار تا autoscaleInfoProvider بازهٔ دستی را اعمال کند
            ps?.setAutoScale?.(true);
            ps?.applyOptions?.({ autoScale: true });
            // اگر API setVisibleRange داشت، مستقیم هم ست کن
            try { ps?.setVisibleRange?.({ from: newBot, to: newTop }); } catch {}
          } catch {}
        };
        const onDblPrice = (e: MouseEvent) => {
          const rect = container.getBoundingClientRect();
          const fromRight = rect.right - e.clientX;
          if (fromRight > 100 || fromRight < 0) return;
          priceRangeOverrideRef.current = null;
          try {
            const s = seriesRef.current as any;
            const ps = s?.priceScale?.() || chart.priceScale("right");
            ps?.setAutoScale?.(true);
            ps?.applyOptions?.({ autoScale: true, scaleMargins: { top: 0.08, bottom: 0.12 } });
          } catch {}
        };
        // capture:true تا قبل از handler خود LWC اجرا شود
        container.addEventListener("wheel", onWheelPrice, { passive: false, capture: true });
        container.addEventListener("dblclick", onDblPrice, { capture: true });
        const onCtxChart = (e: MouseEvent) => {
          const m = modeRef.current;
          if (m && m !== "none") {
            e.preventDefault();
            e.stopPropagation();
            try {
              moveDiagRef.current = null;
              movingVLineRef.current = false;
              movingRayRef.current = false;
              diagStartRef.current = null;
              pathPointsRef.current = [];
              setMovingId(null);
              setMovingType(null);
              setDiagStart(null);
              setMode("none");
              modeRef.current = "none";
              clearPreview();
              setStatusMsg("");
            } catch {}
          }
        };
        container.addEventListener("contextmenu", onCtxChart);

        // iPad / touch: درگ عمودی روی محور قیمت = زوم عمودی
        let priceTouchY0 = 0;
        let priceTouchRange: { from: number; to: number } | null = null;
        let priceTouchActive = false;
        const onTouchStartPrice = (e: TouchEvent) => {
          if (!e.touches.length) return;
          const rect = container.getBoundingClientRect();
          const fromRight = rect.right - e.touches[0].clientX;
          // فقط نوار باریک محور قیمت (نه کل چارت) — وگرنه در موبایل pan کندل‌ها قفل می‌شود
          if (fromRight > 56 || fromRight < 0) {
            priceTouchActive = false;
            return;
          }
          priceTouchActive = true;
          priceTouchY0 = e.touches[0].clientY;
          const s = seriesRef.current as any;
          let pTop: number | null = null;
          let pBot: number | null = null;
          try {
            const t = s?.coordinateToPrice?.(1);
            const b = s?.coordinateToPrice?.(Math.max(2, container.clientHeight - 1));
            if (t != null && b != null) {
              pTop = Math.max(Number(t), Number(b));
              pBot = Math.min(Number(t), Number(b));
            }
          } catch {}
          if (pTop == null || pBot == null) {
            const ov = priceRangeOverrideRef.current;
            if (ov) { pBot = ov.from; pTop = ov.to; }
          }
          if (pTop != null && pBot != null && pTop > pBot) {
            priceTouchRange = { from: pBot, to: pTop };
          } else {
            priceTouchRange = null;
          }
        };
        const onTouchMovePrice = (e: TouchEvent) => {
          if (!priceTouchActive || !priceTouchRange || !e.touches.length) return;
          // فقط preventDefault — stopPropagation نکن تا LWC روی بقیه ژست‌ها بماند
          try { e.preventDefault(); } catch {}
          const dy = e.touches[0].clientY - priceTouchY0;
          // drag down = zoom out, drag up = zoom in
          const factor = Math.exp(dy / 280);
          const mid = (priceTouchRange.from + priceTouchRange.to) / 2;
          const half = ((priceTouchRange.to - priceTouchRange.from) / 2) * factor;
          const minHalf = Math.max(Math.abs(mid) * 0.00004, 0.25);
          const h = Math.max(half, minHalf);
          priceRangeOverrideRef.current = { from: mid - h, to: mid + h };
          try {
            const s = seriesRef.current as any;
            const ps = s?.priceScale?.() || chart.priceScale("right");
            ps?.setAutoScale?.(true);
            ps?.applyOptions?.({ autoScale: true });
          } catch {}
        };
        const onTouchEndPrice = () => {
          priceTouchActive = false;
          priceTouchRange = null;
        };
        // بدون capture تا LWC اول pan افقی را بگیرد؛ زوم قیمت فقط روی محور راست
        container.addEventListener("touchstart", onTouchStartPrice, { passive: true });
        container.addEventListener("touchmove", onTouchMovePrice, { passive: false });
        container.addEventListener("touchend", onTouchEndPrice);
        container.addEventListener("touchcancel", onTouchEndPrice);

        const prevCleanup = (chart as any).__interactCleanup;
        (chart as any).__interactCleanup = () => {
          try { container.removeEventListener("wheel", onWheelPrice); } catch {}
          try { container.removeEventListener("dblclick", onDblPrice); } catch {}
          try { container.removeEventListener("touchstart", onTouchStartPrice); } catch {}
          try { container.removeEventListener("touchmove", onTouchMovePrice); } catch {}
          try { container.removeEventListener("touchend", onTouchEndPrice); } catch {}
          try { container.removeEventListener("touchcancel", onTouchEndPrice); } catch {}
          try { if (typeof prevCleanup === "function") prevCleanup(); } catch {}
        };
      } catch {}

      // User-driven range changes only (ignore our own programmatic sets)
      try {
        chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
          // Reposition overlays always (including programmatic) — no flicker
          try {
            const host = vlineOverlayRef.current;
            const chart2 = chartRef.current;
            const ser = seriesRef.current;
            if (host && chart2) {
              const hostW = host.clientWidth || host.getBoundingClientRect().width || 800;
              for (const child of Array.from(host.children) as HTMLElement[]) {
                if (child.dataset.vlineId) {
                  const item = vlineItemsRef.current.find((v) => v.id === child.dataset.vlineId);
                  if (!item) continue;
                  let x: number | null = null;
                  try { x = chart2.timeScale().timeToCoordinate(item.time as any); } catch { x = null; }
                  if (x == null || Number.isNaN(x)) child.style.visibility = "hidden";
                  else {
                    child.style.visibility = "visible";
                    child.style.left = `${x}px`;
                  }
                } else if (child.dataset.rayId && ser) {
                  const item = rayItemsRef.current.find((v) => v.id === child.dataset.rayId);
                  if (!item) continue;
                  let x: number | null = null;
                  let y: number | null = null;
                  try { x = chart2.timeScale().timeToCoordinate(item.time as any); } catch { x = null; }
                  try { y = ser.priceToCoordinate(item.price); } catch { y = null; }
                  if (y == null || Number.isNaN(y)) {
                    child.style.visibility = "hidden";
                    continue;
                  }
                  const x0 = x == null || Number.isNaN(x) ? 0 : Math.max(0, x);
                  if (x0 > hostW) {
                    child.style.visibility = "hidden";
                    continue;
                  }
                  child.style.visibility = "visible";
                  child.style.left = `${x0}px`;
                  child.style.top = `${y}px`;
                  child.style.width = `${Math.max(4, hostW - x0)}px`;
                }
              }
            }
          } catch {}
          // user-interaction bookkeeping only for real user pans
          if (!range || programmaticRangeRef.current) return;
          userInteractingRef.current = true;
          const bars = candlesRef.current.length;
          let pinned = false;
          if (bars >= 2) {
            const liveEdge = bars - 1 + FUTURE_VISIBLE;
            pinned = range.to >= liveEdge - 5;
          }
          pinnedToRightRef.current = pinned;
          setShowGoLive(!pinned);
          if (interactTimerRef.current) window.clearTimeout(interactTimerRef.current);
          interactTimerRef.current = window.setTimeout(() => {
            userInteractingRef.current = false;
            interactTimerRef.current = null;
          }, 1500);
        });
      } catch {}

      /** Frame last ~70 real bars + a wide visible future strip (more is scrollable) */
      const ensureFutureTimeSpace = () => {
        try {
          const bars = candlesRef.current.length || candles.length;
          if (bars < 2) return;
          programmaticRangeRef.current = true;
          // rightOffset بزرگ = فضای خالی سمت راست (زمان آینده)
          chart.timeScale().applyOptions({ rightOffset: 12, barSpacing: 2.5 });
          const past = Math.min(500, bars);
          // bars = تعداد کندل واقعی؛ whitespace بعد از آن اضافه شده
          chart.timeScale().setVisibleLogicalRange({
            from: Math.max(0, bars - past),
            to: bars - 1 + FUTURE_VISIBLE,
          });
          requestAnimationFrame(() => { programmaticRangeRef.current = false; });
        } catch {
          programmaticRangeRef.current = false;
        }
      };
      ensureFutureTimeSpace();

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
            // Snap to nearest bar, but keep exact candle time (critical for long diags in the past)
            const idx = Math.max(0, Math.min(lastIdx, Math.round(logical)));
            return Number(candles[idx].time);
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
          container.style.touchAction = lock ? "none" : "pan-x pan-y";
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
            pinnedToRightRef.current = true;
            setShowGoLive(false);
            return;
          }
          programmaticRangeRef.current = true;
          // آخرین کندل واقعی — نه scrollToRealTime (آن ته whitespace آینده می‌رود)
          chart.timeScale().applyOptions({ rightOffset: 12, barSpacing: 2.5 });
          const past = Math.min(500, bars);
          chart.timeScale().setVisibleLogicalRange({
            from: Math.max(0, bars - past),
            to: bars - 1 + FUTURE_VISIBLE,
          });
          pinnedToRightRef.current = true;
          setShowGoLive(false);
          try {
            seriesRef.current?.priceScale()?.applyOptions({ autoScale: true });
            chart.priceScale("right").applyOptions({ autoScale: true });
          } catch {}
          requestAnimationFrame(() => {
            try {
              chart.timeScale().setVisibleLogicalRange({
                from: Math.max(0, bars - past),
                to: bars - 1 + FUTURE_VISIBLE,
              });
            } catch {}
            programmaticRangeRef.current = false;
          });
        } catch {
          programmaticRangeRef.current = false;
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
          ((modeRef.current === "diag" || modeRef.current === "alarm-diag" || modeRef.current === "arrow") &&
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
          (m0 === "diag" || m0 === "alarm-diag" || m0 === "arrow") && !!diagStartRef.current;
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
                                autoscaleInfoProvider: () => null as any,
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
                                autoscaleInfoProvider: () => null as any,
                });
              }
              previewDiagSeriesRef.current.setData([
                { time: tCursor as any, value: price },
                { time: t1 as any, value: price },
              ]);
            } catch {}
            return;
          }

          if (((modeNow as ToolMode) === "diag" || (modeNow as ToolMode) === "alarm-diag" || (modeNow as ToolMode) === "arrow") && diagStartRef.current) {
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
                                autoscaleInfoProvider: () => null as any,
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
        const mm = modeRef.current;
        // No horizontal price-line preview for these tools
        if (
          mm === "none" ||
          mm === "move" ||
          mm === "diag" ||
          mm === "alarm-diag" ||
          mm === "ray" ||
          mm === "alarm-ray" ||
          mm === "measure" ||
          mm === "vline" ||
          mm === "arrow-up" ||
          mm === "arrow-down" ||
          mm === "arrow-marker"
        ) {
          // Clear horizontal ghost
          if (
            mm === "vline" ||
            mm === "arrow-up" ||
            mm === "arrow-down" ||
            mm === "arrow-marker" ||
            mm === "none"
          ) {
            try {
              if (previewLineRef.current) {
                series.removePriceLine(previewLineRef.current);
                previewLineRef.current = null;
              }
            } catch {}
            try {
              vlineOverlayRef.current
                ?.querySelectorAll("[data-vline-guide]")
                .forEach((el) => el.remove());
            } catch {}
          }
          // Arrow tools: show floating dashed arrow under cursor before place
          if (
            (mm === "arrow-up" || mm === "arrow-down" || mm === "arrow-marker") &&
            param.point &&
            param.point.x >= 0 &&
            param.point.y >= 0
          ) {
            try {
              const host = vlineOverlayRef.current;
              if (host) {
                let el = host.querySelector("[data-arrow-preview]") as HTMLDivElement | null;
                if (!el) {
                  el = document.createElement("div");
                  el.dataset.arrowPreview = "1";
                  el.style.cssText =
                    "position:absolute;width:28px;height:28px;margin-left:-14px;margin-top:-14px;pointer-events:none;z-index:35;";
                  host.appendChild(el);
                }
                const stroke =
                  mm === "arrow-up"
                    ? "#22c55e"
                    : mm === "arrow-down"
                    ? "#ef4444"
                    : (drawColorRef.current || "#f97316");
                const svg =
                  mm === "arrow-up"
                    ? `<svg width="28" height="28" viewBox="0 0 32 32" fill="none"><path d="M16 6 L26 18 L20 18 L20 26 L12 26 L12 18 L6 18 Z" stroke="${stroke}" stroke-width="2" fill="${stroke}" fill-opacity="0.25"/></svg>`
                    : mm === "arrow-down"
                    ? `<svg width="28" height="28" viewBox="0 0 32 32" fill="none"><path d="M16 26 L6 14 L12 14 L12 6 L20 6 L20 14 L26 14 Z" stroke="${stroke}" stroke-width="2" fill="${stroke}" fill-opacity="0.25"/></svg>`
                    : `<svg width="28" height="28" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="8" stroke="${stroke}" stroke-width="2" fill="${stroke}" fill-opacity="0.25"/></svg>`;
                el.innerHTML = svg;
                el.style.left = `${param.point.x}px`;
                el.style.top = `${param.point.y}px`;
                el.style.display = "block";
              }
            } catch {}
            return;
          }
          // Leaving arrow mode → remove preview
          try {
            vlineOverlayRef.current
              ?.querySelectorAll("[data-arrow-preview]")
              .forEach((el) => el.remove());
          } catch {}
          // Vertical tool: rely on LWC crosshair vertLine only
          return;
        }
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
        const m = modeRef.current;
        // Vertical line only needs time (x) — do not require a valid price
        let price: number | null = series.coordinateToPrice(param.point.y);
        if ((price == null || Number.isNaN(price)) && m !== "vline") return;
        if (price == null || Number.isNaN(price)) {
          // fallback for vline: mid of last candle range
          const bars0 = candlesRef.current;
          if (bars0.length) {
            const last = bars0[bars0.length - 1];
            price = (Number(last.high) + Number(last.low)) / 2;
          } else {
            price = 0;
          }
        }
        const fp = formatPrice(price);

        // ── Click on existing drawing to move it (TradingView-like) ──
        if (m === "none" && param.point) {
          const px = param.point.x;
          const py = param.point.y;
          const HIT = 28;
          const symU = symbolRef.current.toUpperCase();
          const list = (linesRef.current || []).filter(
            (l) => String(l.symbol || "").toUpperCase() === symU
          );
          type Hit = { id: string; kind: "line"; score: number; isV: boolean; isRay: boolean; isDiag: boolean };
          // Holder object so TS tracks mutation inside nested function (avoids type 'never')
          const hitBox: { current: Hit | null } = { current: null };
          const consider = (id: string, score: number, isV: boolean, isRay: boolean, isDiag: boolean) => {
            if (score > HIT) return;
            if (!hitBox.current || score < hitBox.current.score) {
              hitBox.current = { id, kind: "line", score, isV, isRay, isDiag };
            }
          };
          for (const l of list) {
            const isArrow =
              typeof l.note === "string" &&
              (l.note === "__arrow_up__" ||
                l.note === "__arrow_down__" ||
                l.note === "__arrow_marker__" ||
                l.note.startsWith("__arrow"));
            const isRayNote =
              typeof l.note === "string" && l.note.startsWith("__ray:");
            const isV =
              !isArrow &&
              !isRayNote &&
              (l.note === "__vline__" ||
                (typeof l.note === "string" && l.note.startsWith("__vline__:")) ||
                (l.start_time != null &&
                  l.end_time != null &&
                  Number(l.start_time) === Number(l.end_time) &&
                  l.end_price != null &&
                  !isDiagonalLine(l)));
            const isDiag = isDiagonalLine(l);
            const isRay =
              !isV &&
              !isDiag &&
              !isArrow &&
              l.start_time != null &&
              (isRayNote || l.end_time == null || l.end_price == null);
            try {
              if (isV && l.start_time != null) {
                const x = chart.timeScale().timeToCoordinate(Number(l.start_time) as any);
                if (x != null) consider(l.id, Math.abs(px - x), true, false, false);
              } else if (isDiag) {
                const x0 = chart.timeScale().timeToCoordinate(Number(l.start_time) as any);
                const x1 = chart.timeScale().timeToCoordinate(Number(l.end_time) as any);
                const y0 = series.priceToCoordinate(Number(l.price));
                const y1 = series.priceToCoordinate(Number(l.end_price));
                if (x0 != null && x1 != null && y0 != null && y1 != null) {
                  // distance to segment
                  const dx = x1 - x0, dy = y1 - y0;
                  const len2 = dx * dx + dy * dy || 1;
                  let t = ((px - x0) * dx + (py - y0) * dy) / len2;
                  t = Math.max(0, Math.min(1, t));
                  const cx = x0 + t * dx, cy = y0 + t * dy;
                  consider(l.id, Math.hypot(px - cx, py - cy), false, false, true);
                }
              } else if (isArrow && l.start_time != null) {
                const x = chart.timeScale().timeToCoordinate(Number(l.start_time) as any);
                const y = series.priceToCoordinate(Number(l.price));
                if (x != null && y != null) consider(l.id, Math.hypot(px - x, py - y), false, false, false);
              } else if (isRay && l.start_time != null) {
                const x0 = chart.timeScale().timeToCoordinate(Number(l.start_time) as any);
                const y = series.priceToCoordinate(Number(l.price));
                if (y != null) {
                  const dy = Math.abs(py - y);
                  if (x0 == null || Number.isNaN(x0)) {
                    consider(l.id, dy, false, true, false);
                  } else if (px >= x0 - 8) {
                    consider(l.id, dy, false, true, false);
                  }
                }
              } else {
                // horizontal
                const y = series.priceToCoordinate(Number(l.price));
                if (y != null) consider(l.id, Math.abs(py - y), false, false, false);
              }
            } catch {}
          }
          // Also hit-test alarm lines (horizontal / ray / diagonal)
          const alarmList = (alarmsRef.current || []).filter(
            (a) =>
              String(a.symbol || "").toUpperCase() === symU &&
              a.is_active !== false &&
              !a.triggered
          );
          type AlarmHit = {
            id: string;
            kind: "alarm";
            score: number;
            isV: boolean;
            isRay: boolean;
            isDiag: boolean;
          };
          const alarmBox: { current: AlarmHit | null } = { current: null };
          const considerAlarm = (
            id: string,
            score: number,
            isV: boolean,
            isRay: boolean,
            isDiag: boolean
          ) => {
            if (score > HIT) return;
            if (!alarmBox.current || score < alarmBox.current.score) {
              alarmBox.current = { id, kind: "alarm", score, isV, isRay, isDiag };
            }
          };
          for (const a of alarmList) {
            try {
              if (isDiagonalLine(a)) {
                const x0 = chart.timeScale().timeToCoordinate(Number(a.start_time) as any);
                const x1 = chart.timeScale().timeToCoordinate(Number(a.end_time) as any);
                const y0 = series.priceToCoordinate(Number(a.price));
                const y1 = series.priceToCoordinate(Number(a.end_price));
                if (x0 != null && x1 != null && y0 != null && y1 != null) {
                  const dx = x1 - x0, dy = y1 - y0;
                  const len2 = dx * dx + dy * dy || 1;
                  let t = ((px - x0) * dx + (py - y0) * dy) / len2;
                  t = Math.max(0, Math.min(1, t));
                  const cx = x0 + t * dx, cy = y0 + t * dy;
                  considerAlarm(a.id, Math.hypot(px - cx, py - cy), false, false, true);
                }
              } else if (a.start_time != null && (a.end_time == null || a.end_price == null)) {
                // ray alarm
                const x0 = chart.timeScale().timeToCoordinate(Number(a.start_time) as any);
                const y = series.priceToCoordinate(Number(a.price));
                if (y != null) {
                  const dy = Math.abs(py - y);
                  if (x0 == null || Number.isNaN(x0) || px >= x0 - 8) {
                    considerAlarm(a.id, dy, false, true, false);
                  }
                }
              } else {
                // horizontal alarm
                const y = series.priceToCoordinate(Number(a.price));
                if (y != null) considerAlarm(a.id, Math.abs(py - y), false, false, false);
              }
            } catch {}
          }

          const bestLine = hitBox.current;
          const bestAlarm = alarmBox.current;
          let best:
            | { id: string; kind: "line" | "alarm"; score: number; isV: boolean; isRay: boolean; isDiag: boolean }
            | null = null;
          if (bestLine && bestAlarm) {
            best = bestLine.score <= bestAlarm.score
              ? { ...bestLine, kind: "line" }
              : { ...bestAlarm, kind: "alarm" };
          } else if (bestLine) {
            best = { ...bestLine, kind: "line" };
          } else if (bestAlarm) {
            best = { ...bestAlarm, kind: "alarm" };
          }

          if (best) {
            setMode("move");
            setMovingId(best.id);
            setMovingType(best.kind);
            movingVLineRef.current = best.isV;
            movingRayRef.current = best.isRay;
            if (best.kind === "line") {
              const l = list.find((x) => x.id === best!.id);
              const isArrowSel =
                l &&
                typeof l.note === "string" &&
                (l.note === "__arrow_up__" ||
                  l.note === "__arrow_down__" ||
                  l.note === "__arrow_marker__" ||
                  l.note.startsWith("__arrow"));
              // Arrows move freely in X+Y (treat like ray origin)
              if (isArrowSel) {
                movingRayRef.current = true;
                movingVLineRef.current = false;
              }
              if (l && best.isDiag) {
                moveDiagRef.current = {
                  id: l.id,
                  phase: "pick",
                  pointA: { time: Number(l.start_time), price: Number(l.price) },
                  pointB: { time: Number(l.end_time), price: Number(l.end_price) },
                  color: l.color || DEFAULT_LINE_COLOR,
                  width: l.width || 2,
                  dash: (l.dash || l.style || "solid") as string,
                };
                setStatusMsg("Tap a circle to move — empty chart or ✓ Done");
              } else if (best.isV) {
                moveDiagRef.current = null;
                setStatusMsg("Click chart to move vertical line");
              } else if (isArrowSel) {
                moveDiagRef.current = null;
                setStatusMsg("Click chart to move arrow (any direction)");
              } else if (best.isRay) {
                moveDiagRef.current = null;
                setStatusMsg("Click chart to move ray");
              } else {
                moveDiagRef.current = null;
                setStatusMsg("Click chart to move line");
              }
            } else {
              // alarm
              const a = alarmList.find((x) => x.id === best!.id);
              if (a && best.isDiag) {
                moveDiagRef.current = {
                  id: a.id,
                  phase: "pick",
                  pointA: { time: Number(a.start_time), price: Number(a.price) },
                  pointB: { time: Number(a.end_time), price: Number(a.end_price) },
                  color: a.color || DEFAULT_ALARM_COLOR,
                  width: a.width || 2,
                  dash: (a.dash || "solid") as string,
                };
                setStatusMsg("Tap a circle to move alarm — empty chart or ✓ Done");
              } else if (best.isRay) {
                moveDiagRef.current = null;
                setStatusMsg("Click chart to move alarm ray");
              } else {
                moveDiagRef.current = null;
                setStatusMsg("Click chart to move alarm");
              }
            }
            return;
          }
        }

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
                                autoscaleInfoProvider: () => null as any,
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

          // ── Horizontal / vertical / ray single-click move ──
          clickLockRef.current = true;
          try {
            if (typ === "line") {
              const isV = movingVLineRef.current;
              const isRay = movingRayRef.current && !isV;
              const tMove = resolveTime(param);
              if (isV) {
                // Vertical line: move only in time; keep both ends on same timestamp
                if (tMove == null || Number.isNaN(tMove)) {
                  setStatusMsg("Could not read time");
                } else {
                  const bars = candlesRef.current;
                  let lo = Infinity, hi = -Infinity;
                  try {
                    const pr = (series.priceScale() as any).getVisibleRange?.();
                    if (pr && pr.from != null && pr.to != null && Number(pr.to) > Number(pr.from)) {
                      lo = Number(pr.from);
                      hi = Number(pr.to);
                    }
                  } catch {}
                  if (!(hi > lo)) {
                    for (const c of bars) {
                      if (c.low < lo) lo = c.low;
                      if (c.high > hi) hi = c.high;
                    }
                  }
                  if (!(hi > lo)) {
                    lo = fp * 0.98;
                    hi = fp * 1.02;
                  }
                  const pad = (hi - lo) * 0.08;
                  const patch: any = {
                    start_time: tMove,
                    end_time: tMove,
                    price: lo - pad,
                    end_price: hi + pad,
                    note: "__vline__",
                  };
                  try {
                    await supabase.from("chart_lines").update(patch).eq("id", id);
                  } catch {}
                  setLines((prev) =>
                    prev.map((l) =>
                      l.id === id
                        ? {
                            ...l,
                            start_time: tMove,
                            end_time: tMove,
                            price: lo - pad,
                            end_price: hi + pad,
                            note: "__vline__",
                          }
                        : l
                    )
                  );
                  setStatusMsg("Vertical line moved");
                }
              } else {
              // Ray vs arrow: different geometry
              const cur = (linesRef.current || []).find((x) => x.id === id);
              const isArrowMove =
                !!cur &&
                typeof cur.note === "string" &&
                (cur.note === "__arrow_up__" ||
                  cur.note === "__arrow_down__" ||
                  cur.note === "__arrow_marker__" ||
                  cur.note.startsWith("__arrow"));
              const patch: any = { price: fp };
              if (isRay && tMove != null && !Number.isNaN(tMove)) {
                patch.start_time = tMove;
                if (isArrowMove) {
                  // Arrow is a point — keep both times equal
                  patch.end_time = tMove;
                  patch.end_price = fp;
                } else {
                  // Half-line (ray): origin + price only — never set end_time=start_time
                  // (that would turn it into a vertical line)
                  patch.end_time = null;
                  patch.end_price = null;
                  if (cur?.note?.startsWith("__ray:")) {
                    patch.note = `__ray:${tMove}`;
                  }
                }
              }
              const { error } = await supabase.from("chart_lines").update(patch).eq("id", id);
              if (error && patch.start_time != null && !isArrowMove) {
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
                        end_time: isArrowMove
                          ? tMove != null
                            ? tMove
                            : l.end_time
                          : isRay
                          ? null
                          : l.end_time,
                        end_price: isArrowMove
                          ? fp
                          : isRay
                          ? null
                          : l.end_price,
                        note:
                          isRay && !isArrowMove && tMove != null && l.note?.startsWith("__ray:")
                            ? `__ray:${tMove}`
                            : l.note,
                      }
                    : l
                )
              );
              setStatusMsg(isArrowMove ? "Arrow moved" : isRay ? "Ray moved" : "Line moved");
              }
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
            movingVLineRef.current = false;
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

        // Vertical line: one click → line at that time
        if (m === "vline") {
          const t = resolveTime(param);
          if (t == null || Number.isNaN(t)) {
            setStatusMsg("Could not read time — try on chart area");
            return;
          }
          const bars = candlesRef.current;
          let lo = Infinity, hi = -Infinity;
          // Prefer visible price range so the vertical line spans the whole chart pane
          try {
            const pr = (series.priceScale() as any).getVisibleRange?.();
            if (pr && pr.from != null && pr.to != null && Number(pr.to) > Number(pr.from)) {
              lo = Number(pr.from);
              hi = Number(pr.to);
            }
          } catch {}
          if (!(hi > lo)) {
            for (const c of bars) {
              if (c.low < lo) lo = c.low;
              if (c.high > hi) hi = c.high;
            }
          }
          if (!(hi > lo)) {
            lo = fp * 0.98;
            hi = fp * 1.02;
          }
          const pad = (hi - lo) * 0.08;
          const color = drawColorRef.current || DEFAULT_LINE_COLOR;
          const width = drawWidthRef.current || 2;
          const dash = drawDashRef.current || "solid";
          try {
            const uid =
              (await supabase.auth.getSession()).data.session?.user?.id || null;
            let payload: any = {
              symbol: symbolUpper,
              price: lo - pad,
              end_price: hi + pad,
              start_time: t,
              end_time: t,
              color,
              width,
              style: dash,
              dash,
              note: "__vline__",
            };
            if (uid) payload.user_id = uid;
            let { data, error } = await supabase
              .from("chart_lines")
              .insert([payload])
              .select()
              .single();
            if (error) {
              payload = {
                symbol: symbolUpper,
                price: Number(fp) || lo,
                start_time: t,
                color,
                width,
                dash,
                note: `__vline__:${t}`,
              };
              if (uid) payload.user_id = uid;
              ({ data, error } = await supabase
                .from("chart_lines")
                .insert([payload])
                .select()
                .single());
            }
            if (!error && data) {
              pushUndo();
              const saved: ChartLine = {
                ...(data as ChartLine),
                start_time: (data as any).start_time ?? t,
                end_time: (data as any).end_time ?? t,
                end_price: (data as any).end_price ?? hi + pad,
                note: "__vline__",
              };
              setLines((prev) => [saved, ...prev]);
              setStatusMsg("Vertical line added");
            } else {
              const local: ChartLine = {
                id: `local-vl-${Date.now()}`,
                symbol: symbolUpper,
                price: lo - pad,
                end_price: hi + pad,
                start_time: t,
                end_time: t,
                color,
                width,
                style: dash,
                dash,
                note: "__vline__",
              };
              setLines((prev) => [local, ...prev]);
              setStatusMsg("Vertical line local only — check login / DB");
            }
          } catch {
            const local: ChartLine = {
              id: `local-vl-${Date.now()}`,
              symbol: symbolUpper,
              price: lo - pad,
              end_price: hi + pad,
              start_time: t,
              end_time: t,
              color,
              width,
              style: dash,
              dash,
              note: "__vline__",
            };
            setLines((prev) => [local, ...prev]);
            setStatusMsg("Vertical line local only — check login / DB");
          }
          setMode("none");
          return;
        }

        // Diagonal / trend line (or alarm-diag): two clicks → segment A→B
        if (m === "diag" || m === "alarm-diag" || m === "arrow") {
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
            note: m === "arrow" ? "__arrow__" : null,
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
            (payload as any).user_id = (await supabase.auth.getSession()).data.session?.user?.id;
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
              (payload as any).user_id = (await supabase.auth.getSession()).data.session?.user?.id;
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
              pushUndo();
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
          (payload as any).user_id = (await supabase.auth.getSession()).data.session?.user?.id;
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
            (payload as any).user_id = (await supabase.auth.getSession()).data.session?.user?.id;
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
            (payload as any).user_id = (await supabase.auth.getSession()).data.session?.user?.id;
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
            pushUndo();
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
                                autoscaleInfoProvider: () => null as any,
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



        // Arrow mark up / down / marker — single click (TradingView-style, stay in tool)
        if (m === "arrow-up" || m === "arrow-down" || m === "arrow-marker") {
          clickLockRef.current = true;
          setSaving(true);
          const t = resolveTime(param);
          const note =
            m === "arrow-up" ? "__arrow_up__" : m === "arrow-down" ? "__arrow_down__" : "__arrow_marker__";
          // Default TV colors if user still on generic orange
          let col = drawColorRef.current || DEFAULT_LINE_COLOR;
          if (m === "arrow-up" && (col === DEFAULT_LINE_COLOR || col === DEFAULT_ALARM_COLOR)) {
            col = "#22c55e";
          }
          if (m === "arrow-down" && (col === DEFAULT_LINE_COLOR || col === DEFAULT_ALARM_COLOR)) {
            col = "#ef4444";
          }
          const base: any = {
            symbol: symbolRef.current.toUpperCase(),
            price: fp,
            color: col,
            width: drawWidthRef.current || 2,
            start_time: t,
            end_time: t,
            end_price: fp,
            note,
          };
          (base as any).user_id = (await supabase.auth.getSession()).data.session?.user?.id;
          let { data, error } = await supabase.from("chart_lines").insert([base]).select().single();
          if (error) {
            const fb = { symbol: base.symbol, price: base.price, color: base.color, start_time: t, note };
            (fb as any).user_id = base.user_id;
            ({ data, error } = await supabase.from("chart_lines").insert([fb]).select().single());
          }
          if (!error && data) {
            pushUndo();
            setLines((prev) => [{ ...(data as ChartLine), ...base, id: (data as any).id }, ...prev]);
            setStatusMsg("Mark placed");
          } else setStatusMsg("Save failed");
          // One placement only — must re-select tool for another mark
          setMode("none");
          modeRef.current = "none";
          clearPreview();
          setSaving(false);
          setTimeout(() => { clickLockRef.current = false; }, 200);
          return;
        }

        // Rectangle: 2 corners
        if (m === "rect") {
          const t = resolveTime(param);
          if (t == null) return;
          const start = diagStartRef.current;
          if (!start) {
            diagStartRef.current = { time: t, price: fp };
            setDiagStart({ time: t, price: fp });
            setStatusMsg("Rectangle: tap opposite corner");
            return;
          }
          clickLockRef.current = true;
          setSaving(true);
          const t0 = Math.min(start.time, t);
          const t1 = Math.max(start.time, t);
          const p0 = Math.min(start.price, fp);
          const p1 = Math.max(start.price, fp);
          const note = `__rect:${t0},${p0}|${t1},${p1}`;
          const base: any = {
            symbol: symbolRef.current.toUpperCase(),
            price: p0,
            end_price: p1,
            start_time: t0,
            end_time: t1,
            color: drawColorRef.current,
            width: drawWidthRef.current,
            dash: drawDashRef.current,
            note,
          };
          (base as any).user_id = (await supabase.auth.getSession()).data.session?.user?.id;
          let { data, error } = await supabase.from("chart_lines").insert([base]).select().single();
          if (error) {
            const fb = { symbol: base.symbol, price: base.price, color: base.color, start_time: t0, note };
            (fb as any).user_id = base.user_id;
            ({ data, error } = await supabase.from("chart_lines").insert([fb]).select().single());
          }
          if (!error && data) {
            pushUndo();
            setLines((prev) => [{ ...(data as ChartLine), ...base, id: (data as any).id }, ...prev]);
            setStatusMsg("Rectangle saved");
          } else setStatusMsg("Save failed");
          diagStartRef.current = null;
          setDiagStart(null);
          clearPreview();
          setMode("none");
          modeRef.current = "none";
          setSaving(false);
          setTimeout(() => { clickLockRef.current = false; }, 300);
          return;
        }

        // Path: multi-point polyline (double-click finishes)
        if (m === "path") {
          const t = resolveTime(param);
          if (t == null) return;
          const pts = pathPointsRef.current;
          // Double-click detection via detail or second quick click near last
          const isDbl = (param as any)?._dbl || false;
          pts.push({ time: t, price: fp });
          pathPointsRef.current = pts;
          try {
            if (!previewDiagSeriesRef.current) {
              previewDiagSeriesRef.current = chart.addLineSeries({
                color: drawColorRef.current,
                lineWidth: Math.max(2, drawWidthRef.current) as 1 | 2 | 3 | 4,
                lineStyle: LineStyle.Solid,
                priceLineVisible: false,
                lastValueVisible: false,
                crosshairMarkerVisible: false,
                autoscaleInfoProvider: () => null as any,
              });
            }
            // Sort by time for LWC
            const sorted = [...pts].sort((a, b) => a.time - b.time);
            if (sorted.length >= 2) {
              previewDiagSeriesRef.current.setData(
                sorted.map((p) => ({ time: p.time as any, value: p.price }))
              );
            }
          } catch {}
          if (pts.length >= 2 && isDbl) {
            // finish — save as diagonal-like multi via note
            clickLockRef.current = true;
            setSaving(true);
            const first = pts[0];
            const last = pts[pts.length - 1];
            const note = `__path:` + pts.map((p) => `${p.time},${p.price}`).join("|");
            const base: any = {
              symbol: symbolRef.current.toUpperCase(),
              price: first.price,
              color: drawColorRef.current,
              width: drawWidthRef.current,
              dash: drawDashRef.current,
              start_time: first.time,
              end_time: last.time,
              end_price: last.price,
              note,
            };
            (base as any).user_id = (await supabase.auth.getSession()).data.session?.user?.id;
            let { data, error } = await supabase.from("chart_lines").insert([base]).select().single();
            if (error) {
              const fallback = {
                symbol: base.symbol,
                price: base.price,
                color: base.color,
                start_time: base.start_time,
                note,
              };
              (fallback as any).user_id = base.user_id;
              ({ data, error } = await supabase.from("chart_lines").insert([fallback]).select().single());
            }
            if (!error && data) {
              const saved = { ...(data as ChartLine), ...base, id: (data as any).id };
              pushUndo();
              setLines((prev) => [saved, ...prev]);
              setStatusMsg("Path saved");
            } else setStatusMsg("Path save failed");
            pathPointsRef.current = [];
            clearPreview();
            setMode("none");
            modeRef.current = "none";
            setSaving(false);
            setTimeout(() => { clickLockRef.current = false; }, 300);
          } else {
            setStatusMsg(`Path: ${pts.length} point(s) — double-click to finish`);
          }
          return;
        }

        // Curve: 3 points → quadratic-ish polyline
        if (m === "curve") {
          const t = resolveTime(param);
          if (t == null) return;
          const pts = pathPointsRef.current;
          pts.push({ time: t, price: fp });
          pathPointsRef.current = pts;
          if (pts.length < 3) {
            setStatusMsg(`Curve: point ${pts.length}/3`);
            return;
          }
          // Build dense curve points (quadratic Bezier in time-price space)
          const [p0, p1, p2] = pts;
          const curvePts: { time: number; price: number }[] = [];
          for (let i = 0; i <= 24; i++) {
            const u = i / 24;
            const mt = (1 - u) * (1 - u) * p0.time + 2 * (1 - u) * u * p1.time + u * u * p2.time;
            const mp = (1 - u) * (1 - u) * p0.price + 2 * (1 - u) * u * p1.price + u * u * p2.price;
            curvePts.push({ time: Math.round(mt), price: mp });
          }
          // ensure increasing times
          for (let i = 1; i < curvePts.length; i++) {
            if (curvePts[i].time <= curvePts[i - 1].time) curvePts[i].time = curvePts[i - 1].time + 1;
          }
          clickLockRef.current = true;
          setSaving(true);
          const note = `__curve:` + curvePts.map((p) => `${p.time},${p.price}`).join("|");
          const base: any = {
            symbol: symbolRef.current.toUpperCase(),
            price: p0.price,
            color: drawColorRef.current,
            width: drawWidthRef.current,
            dash: drawDashRef.current,
            start_time: curvePts[0].time,
            end_time: curvePts[curvePts.length - 1].time,
            end_price: curvePts[curvePts.length - 1].price,
            note,
          };
          (base as any).user_id = (await supabase.auth.getSession()).data.session?.user?.id;
          let { data, error } = await supabase.from("chart_lines").insert([base]).select().single();
          if (error) {
            const fallback = { symbol: base.symbol, price: base.price, color: base.color, start_time: base.start_time, note };
            (fallback as any).user_id = base.user_id;
            ({ data, error } = await supabase.from("chart_lines").insert([fallback]).select().single());
          }
          if (!error && data) {
            const saved = { ...(data as ChartLine), ...base, id: (data as any).id };
            pushUndo();
            setLines((prev) => [saved, ...prev]);
            setStatusMsg("Curve saved");
          } else setStatusMsg("Curve save failed");
          pathPointsRef.current = [];
          clearPreview();
          setMode("none");
          modeRef.current = "none";
          setSaving(false);
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
            // Always resolve time from click (works on empty/future area too)
            const t = resolveTime(param);
            if (t != null && !Number.isNaN(t)) base.start_time = t;
          }
          let payload = { ...base };
          (payload as any).user_id = (await supabase.auth.getSession()).data.session?.user?.id;
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
            (payload as any).user_id = (await supabase.auth.getSession()).data.session?.user?.id;
              ({ data, error } = await supabase.from("chart_lines").insert([payload]).select().single());
          }
          if (error) {
            payload = { symbol: base.symbol, price: base.price, color: base.color, width: base.width };
            (payload as any).user_id = (await supabase.auth.getSession()).data.session?.user?.id;
              ({ data, error } = await supabase.from("chart_lines").insert([payload]).select().single());
          }
          if (error) {
            payload = { symbol: base.symbol, price: base.price, color: base.color };
            (payload as any).user_id = (await supabase.auth.getSession()).data.session?.user?.id;
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
            pushUndo();
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
          (payload as any).user_id = (await supabase.auth.getSession()).data.session?.user?.id;
          let { data, error } = await supabase.from("alarms").insert([payload]).select().single();
          if (error && payload.start_time != null) {
            // Column may not exist — note-only fallback
            delete payload.start_time;
            (payload as any).user_id = (await supabase.auth.getSession()).data.session?.user?.id;
              ({ data, error } = await supabase.from("alarms").insert([payload]).select().single());
          }
          if (error) {
            const minimal: any = {
              symbol: payload.symbol, price: payload.price, condition: payload.condition,
              is_active: true, triggered: false,
            };
            if (t != null && !Number.isNaN(t)) minimal.note = `__ray:${t}`;
            (minimal as any).user_id = (await supabase.auth.getSession()).data.session?.user?.id;
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
            pushUndo();
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
          (payload as any).user_id = (await supabase.auth.getSession()).data.session?.user?.id;
          let { data, error } = await supabase.from("alarms").insert([payload]).select().single();
          if (error) {
            const minimal: any = {
              symbol: payload.symbol,
              price: payload.price,
              condition: payload.condition,
              is_active: true,
              triggered: false,
              user_id: (await supabase.auth.getSession()).data.session?.user?.id,
            };
              ({ data, error } = await supabase.from("alarms").insert([minimal]).select().single());
          }
          // اول preview و mode را ببند تا خط دوتایی نماند
          modeRef.current = "none";
          setMode("none");
          setAlarmMenuOpen(false);
          clearPreview();
          if (!error && data) {
            const saved = {
              ...(data as Alarm),
              color: (data as any).color || chosenColor,
              width: (data as any).width || payload.width,
              dash: (data as any).dash || payload.dash,
            };
            pushUndo();
            setAlarms((prev) => [saved, ...prev]);
            setStatusMsg("Alarm saved");
          } else setStatusMsg("Alarm save failed");
          setSaving(false);
          setTimeout(() => { clickLockRef.current = false; }, 300);
        }
      });

      if (gen !== loadGenRef.current) return;
      renderAllLinesAndAlarms();
      rebuildIndicators();
      // Native axis label for last price + bar time (does not float on scroll)
      applyLastPriceLabel();
      setStatusMsg("");
    } catch (e: any) {
      if (gen === loadGenRef.current) setStatusMsg(e?.message || "Load error");
    }
  }, [destroyChart, rebuildIndicators, renderAllLinesAndAlarms, clearPreview, applyLastPriceLabel]);

  // ── Secondary multi-pane charts (view-only + symbol switch) ──
  useEffect(() => {
    const need =
      chartLayout === "2h" || chartLayout === "2v"
        ? 1
        : chartLayout === "3a" || chartLayout === "3b" || chartLayout === "3c"
        ? 2
        : chartLayout === "4a" || chartLayout === "4b" || chartLayout === "4c"
        ? 3
        : chartLayout === "5a" || chartLayout === "5b"
        ? 4
        : chartLayout === "6a" || chartLayout === "6b"
        ? 5
        : 0;

    const parseRows = (rows: any[]) => {
      const out: { time: number; open: number; high: number; low: number; close: number }[] = [];
      for (const r of rows) {
        let t = Number(r.time ?? r[0] ?? r.openTime ?? r.open_time);
        if (t > 1e12) t = Math.floor(t / 1000);
        if (!(t > 0)) continue;
        const o = Number(r.open ?? r[1]);
        const h = Number(r.high ?? r[2]);
        const l = Number(r.low ?? r[3]);
        const c = Number(r.close ?? r[4]);
        if ([o, h, l, c].some((x) => Number.isNaN(x))) continue;
        out.push({ time: t, open: o, high: h, low: l, close: c });
      }
      out.sort((a, b) => a.time - b.time);
      // dedupe
      const dedup: typeof out = [];
      for (const c of out) {
        if (dedup.length && dedup[dedup.length - 1].time === c.time) dedup[dedup.length - 1] = c;
        else dedup.push(c);
      }
      return dedup;
    };

    const mountPane = async (idx: number, el: HTMLDivElement | null, sym: string, paneIv: string) => {
      if (!el || need <= idx) {
        const prev = secondaryChartsRef.current.get(idx);
        if (prev) {
          try { prev.chart.remove(); } catch {}
          secondaryChartsRef.current.delete(idx);
        }
        return;
      }
      const cleanSym = chartSymbol(sym) || sym;
      const iv = String(paneIv || "15");
      let entry = secondaryChartsRef.current.get(idx);
      if (!entry || entry.symbol !== cleanSym) {
        if (entry) {
          try { entry.chart.remove(); } catch {}
          secondaryChartsRef.current.delete(idx);
        }
        // wait for layout size
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        if (el.clientWidth < 40 || el.clientHeight < 40) {
          await new Promise((r) => setTimeout(r, 120));
        }
        try {
          const chart = createChart(el, {
            width: el.clientWidth,
            height: el.clientHeight,
            layout: {
              background: { color: "#000000" } as any,
              textColor: "#9ca3af",
              fontSize: 10,
              attributionLogo: false as any,
            },
            grid: {
              vertLines: { color: "rgba(42,46,57,0.5)" },
              horzLines: { color: "rgba(42,46,57,0.5)" },
            },
            rightPriceScale: { borderVisible: false },
            timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
            crosshair: { mode: CrosshairMode.Normal },
          } as any);
          const series = chart.addCandlestickSeries({
            upColor: "#089981",
            downColor: "#f23645",
            borderUpColor: "#089981",
            borderDownColor: "#f23645",
            wickUpColor: "#089981",
            wickDownColor: "#f23645",
          });
          try {
            chart.applyOptions({ layout: { attributionLogo: false } as any });
          } catch {}
          entry = { chart, series, symbol: cleanSym, interval: iv };
          secondaryChartsRef.current.set(idx, entry);
        } catch {
          return;
        }
      }
      // Reload data if symbol or interval changed
      if (entry && entry.interval !== iv) {
        entry.interval = iv;
      }
      try {
        const res = await fetch(
          `/api/kline?symbol=${encodeURIComponent(cleanSym)}&interval=${encodeURIComponent(iv)}&limit=300`,
          { cache: "no-store" }
        );
        const raw = await res.json();
        const rows = Array.isArray(raw) ? raw : raw?.data || raw?.result?.list || [];
        const candles = parseRows(rows);
        if (candles.length && entry) {
          entry.series.setData(candles as any);
          try {
            entry.chart.timeScale().fitContent();
          } catch {}
        }
      } catch {}
    };

    const defaults = ["ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"];
    for (let i = 0; i < 5; i++) {
      void mountPane(
        i,
        paneRefs.current[i],
        paneSymbols[i] || defaults[i],
        paneIntervals[i] || paneIntervalsRef.current[i] || "15"
      );
    }

    const onResize = () => {
      secondaryChartsRef.current.forEach((entry, idx) => {
        const el = paneRefs.current[idx];
        if (!el) return;
        try {
          entry.chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
        } catch {}
      });
      if (chartRef.current && chartContainerRef.current) {
        try {
          chartRef.current.applyOptions({
            width: chartContainerRef.current.clientWidth,
            height: chartContainerRef.current.clientHeight,
          });
        } catch {}
      }
    };
    window.addEventListener("resize", onResize);
    const t = window.setTimeout(onResize, 100);

    // light poll for secondary panes
    const poll = window.setInterval(() => {
      if (need < 1) return;
      secondaryChartsRef.current.forEach((entry, idx) => {
        const sym = paneSymbols[idx];
        if (!sym) return;
        const cleanSym = chartSymbol(sym) || sym;
        const iv = String(entry.interval || paneIntervalsRef.current[idx] || "15");
        fetch(
          `/api/kline?symbol=${encodeURIComponent(cleanSym)}&interval=${encodeURIComponent(iv)}&limit=3`,
          { cache: "no-store" }
        )
          .then((r) => r.json())
          .then((raw) => {
            const rows = Array.isArray(raw) ? raw : raw?.data || raw?.result?.list || [];
            const candles = parseRows(rows);
            if (!candles.length) return;
            const last = candles[candles.length - 1];
            try {
              entry.series.update(last as any);
            } catch {
              try {
                entry.series.setData(candles as any);
              } catch {}
            }
          })
          .catch(() => {});
      });
    }, 8000);

    return () => {
      window.removeEventListener("resize", onResize);
      window.clearTimeout(t);
      window.clearInterval(poll);
      if (need === 0) {
        secondaryChartsRef.current.forEach((entry) => {
          try { entry.chart.remove(); } catch {}
        });
        secondaryChartsRef.current.clear();
      }
    };
  }, [chartLayout, paneSymbols, paneIntervals]);

  // همیشه آخرین loadCandles را در ref نگه دار تا useEffect با عوض شدن identity دوباره لود نکند
  loadCandlesRef.current = loadCandles;

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      requestAnimationFrame(() => {
        if (!cancelled) loadCandlesRef.current();
      });
    };
    run();
    const onResize = () => {
      if (chartRef.current && chartContainerRef.current) {
        chartRef.current.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight,
        });
        // عمداً رنج را دست نمی‌زنیم
      }
    };
    const onVis = () => {
      if (document.visibilityState === "visible") {
        if (!seriesRef.current || !candlesRef.current.length) run();
      }
    };
    const onFocus = () => {
      if (!seriesRef.current || !candlesRef.current.length) run();
    };
    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
      // Do NOT destroyChart here — that caused the black flash on 1m↔5m.
    };
  }, [symbol, interval]); // فقط نماد و تایم‌فریم — نه loadCandles

  // Destroy chart only when this component actually unmounts (leave page)
  useEffect(() => {
    return () => {
      loadGenRef.current += 1; // invalidate any in-flight load
      destroyChart();
    };
  }, [destroyChart]);

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

  // Resize chart when side list is shown/hidden — فقط عرض/ارتفاع، رنج را دست نزن
  useEffect(() => {
    const t = setTimeout(() => {
      if (chartRef.current && chartContainerRef.current) {
        chartRef.current.applyOptions({
          width: chartContainerRef.current.clientWidth,
          height: chartContainerRef.current.clientHeight || 640,
        });
        // عمداً setVisibleLogicalRange نمی‌زنیم — باعث پرش/آهنربا می‌شد
      }
    }, 50);
    return () => clearTimeout(t);
  }, [showSideWl, showToolsPanel]);

  // Close TF / timezone / list / indicator menus / note editor when clicking outside
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
    if (!tfMenuOpen && !tzMenuOpen && !openMenu && !anyIndPanel && !editingNoteId && !wlMenuOpen) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      const el = t as HTMLElement;
      if (tfMenuOpen && tfMenuRef.current && !tfMenuRef.current.contains(t)) setTfMenuOpen(false);
      if (tzMenuOpen && tzMenuRef.current && !tzMenuRef.current.contains(t)) setTzMenuOpen(false);
      if (openMenu) {
        if (!el.closest?.("[data-menu]")) setOpenMenu(null);
      }
      if (wlMenuOpen && !el.closest?.("[data-menu]")) {
        setWlMenuOpen(false);
      }
      if (drawToolsOpen && !el.closest?.("[data-menu]")) {
        setDrawToolsOpen(false);
      }
      // Note editor: click anywhere outside saves
      if (editingNoteId && !el.closest?.("[data-note-edit]")) {
        void saveNote();
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
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("touchstart", onDown, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("touchstart", onDown, true);
      document.removeEventListener("pointerdown", onDown, true);
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
    editingNoteId,
    noteDraft,
    editingNoteType,
    wlMenuOpen,
    drawToolsOpen,
  ]);

  // Cancel tool / move: outside click (move only) OR right-click (any tool)
  useEffect(() => {
    const isTool =
      mode !== "none" &&
      (mode === "move" ||
        mode === "draw" ||
        mode === "ray" ||
        mode === "diag" ||
        mode === "vline" ||
        mode === "arrow" ||
        mode === "arrow-up" ||
        mode === "arrow-down" ||
        mode === "arrow-marker" ||
        mode === "path" ||
        mode === "brush" ||
        mode === "curve" ||
        mode === "rect" ||
        mode === "alarm" ||
        mode === "alarm-ray" ||
        mode === "alarm-diag" ||
        mode === "measure");
    if (!isTool) return;

    const cancelAll = () => {
      try {
        moveDiagRef.current = null;
        movingVLineRef.current = false;
        movingRayRef.current = false;
        diagStartRef.current = null;
        pathPointsRef.current = [];
        setMovingId(null);
        setMovingType(null);
        setDiagStart(null);
        setMode("none");
        modeRef.current = "none";
        clearPreview();
        setStatusMsg("");
      } catch {}
    };

    const onDown = (e: MouseEvent | TouchEvent | PointerEvent) => {
      // Outside-click only cancels move selection
      if (mode !== "move" || !movingId) return;
      const el = e.target as HTMLElement | null;
      if (!el) return;
      if (
        el.closest?.("[data-menu]") ||
        el.closest?.("[data-note-edit]") ||
        el.closest?.("[data-ind-panel]") ||
        el.closest?.("[data-move-bar]")
      ) {
        return;
      }
      if (chartContainerRef.current && chartContainerRef.current.contains(el)) {
        return;
      }
      cancelAll();
    };

    const onContext = (e: MouseEvent) => {
      // Right-click cancels any active tool or move selection
      const el = e.target as HTMLElement | null;
      if (el?.closest?.("[data-menu]") || el?.closest?.("[data-move-bar]")) return;
      e.preventDefault();
      cancelAll();
    };

    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("touchstart", onDown, true);
    document.addEventListener("contextmenu", onContext, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("touchstart", onDown, true);
      document.removeEventListener("contextmenu", onContext, true);
    };
  }, [mode, movingId, clearPreview]);

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

  const loadUserScopedData = useCallback(async () => {
    try {
      const { data: sessA } = await supabase.auth.getSession();
      const uidA = sessA?.session?.user?.id;
      if (!uidA) {
        setAlarms([]);
        setLines([]);
        setWatchLists([]);
        setWatchItems([]);
        return;
      }
      // Parallel fetch: alarms + lines together (faster when returning to chart)
      const [alarmsRes, linesRes] = await Promise.all([
        supabase
          .from("alarms")
          .select("*")
          .eq("user_id", uidA)
          .order("created_at", { ascending: false }),
        supabase
          .from("chart_lines")
          .select("*")
          .eq("user_id", uidA)
          .order("created_at", { ascending: false }),
      ]);
      const a = alarmsRes.data;
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
      } else {
        setAlarms([]);
      }
      const l = linesRes.data;
      if (l) {
        setLines(
          (l as ChartLine[]).map((row) => {
            if (isDiagonalLine(row)) return row;
            if (row.note === "__vline__" || (typeof row.note === "string" && row.note.startsWith("__vline__:"))) {
              let st = row.start_time != null ? Number(row.start_time) : null;
              if ((st == null || Number.isNaN(st)) && typeof row.note === "string" && row.note.startsWith("__vline__:")) {
                const n = Number(row.note.replace("__vline__:", ""));
                if (!Number.isNaN(n) && n > 0) st = n;
              }
              return { ...row, start_time: st, end_time: st, note: "__vline__" };
            }
            if (row.note?.startsWith("__diag:")) {
              const parts = row.note.replace(/^__diag:/, "").split("|")[0].split(":");
              if (parts.length >= 3) {
                return {
                  ...row,
                  start_time: row.start_time ?? Number(parts[0]),
                  end_time: Number(parts[1]),
                  end_price: Number(parts[2]),
                };
              }
            }
            if (row.note?.startsWith("__ray:") && row.start_time == null) {
              const n = Number(String(row.note).replace("__ray:", "").split("|")[0]);
              if (!Number.isNaN(n)) return { ...row, start_time: n };
            }
            return row;
          })
        );
      } else {
        setLines([]);
      }
      // خطوط را بلافاصله روی چارت بکش (بدون منتظر ماندن واچ‌لیست)
      try {
        requestAnimationFrame(() => {
          try { renderAllLinesAndAlarmsRef.current?.(); } catch {}
        });
      } catch {}
      const { data: wl } = await supabase
        .from("watchlist_lists")
        .select("*")
        .eq("user_id", uidA)
        .order("created_at", { ascending: true });
      setWatchLists((wl as WatchList[]) || []);
      const { data: wi } = await supabase
        .from("watchlist_items")
        .select("*")
        .eq("user_id", uidA)
        .order("sort_order", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: true });
      setWatchItems((wi as WatchItem[]) || []);
    } catch (e) {
      console.error("loadUserScopedData", e);
    }
  }, []);

  useEffect(() => {
    loadUserScopedData();
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (
        event === "SIGNED_IN" ||
        event === "TOKEN_REFRESHED" ||
        event === "INITIAL_SESSION" ||
        event === "USER_UPDATED"
      ) {
        loadUserScopedData();
      }
      if (event === "SIGNED_OUT") {
        setAlarms([]);
        setLines([]);
        setWatchLists([]);
        setWatchItems([]);
        setSideOrder([]);
      }
    });
    return () => {
      try {
        sub.subscription.unsubscribe();
      } catch {}
    };
  }, [loadUserScopedData]);

  // Refresh watchlist items periodically (in case user edits on Watchlist page)
  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const { data: sessR } = await supabase.auth.getSession();
        const uidR = sessR?.session?.user?.id;
        if (!uidR) {
          if (alive) { setWatchLists([]); setWatchItems([]); }
          return;
        }
        const { data: wl } = await supabase
          .from("watchlist_lists")
          .select("*")
          .eq("user_id", uidR)
          .order("created_at", { ascending: true });
        if (alive) setWatchLists((wl as WatchList[]) || []);
        const { data: wi } = await supabase
          .from("watchlist_items")
          .select("*")
          .eq("user_id", uidR)
          .order("sort_order", { ascending: true, nullsFirst: false })
          .order("created_at", { ascending: true });
        if (alive) setWatchItems((wi as WatchItem[]) || []);
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
        `/api/kline?symbol=${encodeURIComponent(symbolRef.current)}&interval=${encodeURIComponent(String(intervalRef.current))}&limit=5`,
        { cache: "no-store" }
      );
      if (!res.ok) return;
      const raw = await res.json();
      const rows: any[] = Array.isArray(raw) ? raw : raw?.data || raw?.result?.list || raw?.candles || [];
      if (!rows.length) return;
      const fresh = parseKlineRows(rows);
      if (!fresh.length) return;

      const candles = candlesRef.current.slice(); // copy
      let addedNew = false;
      let changed = false;
      for (const c of fresh) {
        const idx = candles.findIndex((x: any) => Number(x.time) === Number(c.time));
        if (idx >= 0) {
          const prev = candles[idx];
          if (
            prev.close !== c.close ||
            prev.high !== c.high ||
            prev.low !== c.low ||
            prev.open !== c.open ||
            prev.volume !== c.volume
          ) {
            candles[idx] = c;
            changed = true;
          }
        } else if (!candles.length || Number(c.time) > Number(candles[candles.length - 1].time)) {
          candles.push(c);
          addedNew = true;
          changed = true;
        }
      }
      if (!changed) {
        // still refresh axis label countdown
        const last = candles[candles.length - 1];
        if (last) applyLastPriceLabel();
        return last ? { last, high: last.high, low: last.low } : null;
      }
      candlesRef.current = candles;

      // CRITICAL: never call setVisibleRange / setVisibleLogicalRange on live ticks.
      // That was the iPad jump. Append keeps zoom; only scrollToRealTime if pinned.
      const chart = chartRef.current;

      const mapBarForSeries = (bar: any) => {
        const ct = chartTypeRef.current;
        if (ct === "line" || ct === "area") {
          return { time: bar.time, value: bar.close };
        }
        return bar;
      };
      const setSeriesFull = (bars: any[]) => {
        const ct = chartTypeRef.current;
        const src = ct === "heikin" ? toHeikinAshi(bars) : bars;
        const withF = appendFutureWhitespace(src, String(intervalRef.current));
        if (ct === "line" || ct === "area") {
          series.setData(
            withF
              .filter((c: any) => c.close != null || c.value != null)
              .map((c: any) => ({ time: c.time, value: c.close ?? c.value })) as any
          );
        } else {
          series.setData(withF as any);
        }
        try { syncFutureAxis(bars, String(intervalRef.current)); } catch {}
      };

      if (addedNew) {
        try {
          // فقط داده را عوض کن — هیچ scroll / setVisibleRange نزن (جلوگیری از آهنربا و پرش)
          const lastBar = candles[candles.length - 1];
          if (lastBar) {
            try {
              series.update(mapBarForSeries(lastBar) as any);
            } catch {
              setSeriesFull(candles);
            }
          }
        } catch {}
      } else {
        // Same bars — update in place only (zero range mutation)
        const tail = fresh.slice(-3);
        let needFull = false;
        for (const c of tail) {
          try { series.update(mapBarForSeries(c) as any); } catch {
            needFull = true;
            break;
          }
        }
        if (needFull) {
          try {
            setSeriesFull(candles);
            // still do not touch visible range
          } catch {}
        }
        if (volumeSeriesRef.current && candles.length) {
          const last = candles[candles.length - 1];
          try {
            volumeSeriesRef.current.update({
              time: last.time as any,
              value: last.volume || 0,
              color: last.close >= last.open ? "rgba(34,197,94,0.5)" : "rgba(239,68,68,0.5)",
            });
          } catch {}
        }
      }

      const last = candles[candles.length - 1];
      if (last) {
        setLastBarClose((prev) => (prev === last.close ? prev : last.close));
        setLastBarTime((prev) => (prev === last.time ? prev : last.time));
        applyLastPriceLabel();
        return { last, high: last.high, low: last.low };
      }
    } catch {}
    return null;
  }, [parseKlineRows, applyLastPriceLabel]);

  /**
   * Local hit: notify immediately + mark triggered + ask server to send Telegram & Web Push.
   * (Previously client marked triggered without notifying Telegram → missed messages.)
   */
  const triggerAlarmLocal = useCallback(async (a: Alarm, price: number) => {
    // فقط یک‌بار برای هر آلارم
    if (
      notifiedAlarmsRef.current.has(a.id) ||
      triggeringAlarmsRef.current.has(a.id)
    ) {
      return;
    }
    triggeringAlarmsRef.current.add(a.id);

    const nowIso = new Date().toISOString();

    // Claim اتمیک در DB — اگر کرون زودتر زده باشد، نوتیف دوم نده (مشکل iPad)
    let claimed = false;
    try {
      const { data: row } = await supabase
        .from("alarms")
        .update({
          triggered: true,
          is_active: false,
          last_price: price,
          triggered_at: nowIso,
        })
        .eq("id", a.id)
        .eq("triggered", false)
        .select("id")
        .maybeSingle();
      claimed = !!(row && (row as any).id);
    } catch {
      claimed = false;
    }

    // UI را در هر حالت آپدیت کن
    setAlarms((p) =>
      p.map((x) =>
        x.id === a.id
          ? {
              ...x,
              triggered: true,
              is_active: false,
              last_price: price,
              triggered_at: nowIso,
            }
          : x
      )
    );
    notifiedAlarmsRef.current.add(a.id);

    if (!claimed) {
      // سرور/کرون قبلاً نوتیف فرستاده — دوباره نده
      triggeringAlarmsRef.current.delete(a.id);
      return;
    }

    // سایت باز است → همیشه نوتیف + صدای بیپ روی کامپیوتر
    showLocalNotification(
      `${a.symbol}`,
      alarmNotifyBody(a, price),
      `alarm-${a.id}`
    );
    try {
      playAlarmBeep();
    } catch {}

    try {
      await supabase.functions.invoke("check-alarms", {
        body: {
          notify_alarm_id: a.id,
          price,
          skip_push: false,
        },
      });
    } catch (e) {
      console.warn("notify invoke failed", e);
    } finally {
      triggeringAlarmsRef.current.delete(a.id);
    }
  }, []);

  // پوش از SW وقتی تب فوکوس است (بدون دابل نوتیف سیستم)
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMsg = (event: MessageEvent) => {
      const data = event.data;
      if (!data || data.type !== "ALARM_PUSH") return;
      const id = String(data.alarmId || "");
      if (id && notifiedAlarmsRef.current.has(id)) return;
      if (id) notifiedAlarmsRef.current.add(id);
      if (document.visibilityState === "visible") {
        showLocalNotification(
          data.title || "Alarm",
          data.body || "Alarm triggered",
          id ? `alarm-${id}` : "alarm-chert"
        );
      }
    };
    navigator.serviceWorker.addEventListener("message", onMsg);
    return () => navigator.serviceWorker.removeEventListener("message", onMsg);
  }, []);

  // Sync alarms from DB (Telegram / server triggers) + price cross + live candles
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      // جلوگیری از اجرای همزمان دو tick (باعث چندباره شدن آلارم می‌شد)
      if (tickInFlightRef.current) return;
      tickInFlightRef.current = true;
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
                // فقط اگر هنوز نوتیف نداده باشیم و تریگر تازه باشد (کرون وقتی تب بسته بود)
                if (!notifiedAlarmsRef.current.has(local.id)) {
                  const trigAt = (db as any).triggered_at
                    ? new Date((db as any).triggered_at).getTime()
                    : 0;
                  const fresh = trigAt > 0 && Date.now() - trigAt < 20000;
                  const lp = Number((db as any).last_price ?? 0);
                  const ap = Number(db.price);
                  const near = lp > 0 && ap > 0 && Math.abs(lp - ap) / ap < 0.008;
                  if (fresh && near) {
                    notifiedAlarmsRef.current.add(local.id);
                    showLocalNotification(
                      `${db.symbol}`,
                      alarmNotifyBody(db, Number(db.last_price ?? db.price))
                    );
                  } else {
                    // already handled by client or too old — mark so we never double
                    notifiedAlarmsRef.current.add(local.id);
                  }
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
        // Normalize keys so NEAR and NEARUSDT map the same
        const symbols = [
          ...new Set(
            stillActive.map((a) => chartSymbol(String(a.symbol)).toUpperCase())
          ),
        ];

        // فقط بعد از تعویض کوین کوتاه صبر کن (نه بعد از عوض TF)
        const inCooldown = Date.now() < (alarmCooldownUntilRef.current || 0);
        const currentSym = chartSymbol(symbolRef.current).toUpperCase();

        for (const sym of symbols) {
          try {
            let price = 0;
            // 1) تیکر لحظه‌ای
            const candidates = [sym];
            if (!/USDT$|USDC$|BUSD$|USD$/i.test(sym)) {
              candidates.push(sym + "USDT");
            }
            for (const c of candidates) {
              try {
                const res = await fetch(
                  `/api/ticker?symbol=${encodeURIComponent(c)}`,
                  { cache: "no-store" }
                );
                const j = await res.json();
                const p = parseFloat(
                  j?.price || j?.lastPrice || j?.data?.price || 0
                );
                if (p && Number.isFinite(p)) {
                  price = p;
                  break;
                }
              } catch {}
            }
            // 2) اگر تیکر نداد و همین کوین روی چارت است → close کندل زنده
            if (!price && sym === currentSym && live?.last?.close) {
              const c = Number(live.last.close);
              if (c && Number.isFinite(c)) price = c;
            }
            if (!price) continue;

            const prev = prevPricesRef.current[sym];
            const seeds = priceSeedCountRef.current[sym] || 0;

            for (const a of stillActive.filter(
              (x) => chartSymbol(String(x.symbol)).toUpperCase() === sym
            )) {
              let target = Number(a.price);
              if (isDiagonalLine(a)) {
                const nowT = Math.floor(Date.now() / 1000);
                const st = Number(a.start_time);
                const et = Number(a.end_time);
                const tMin = Math.min(st, et);
                const tMax = Math.max(st, et);
                if (nowT < tMin || nowT > tMax + 60) continue;
                target = projectedPriceOnDiag(
                  st,
                  Number(a.price),
                  et,
                  Number(a.end_price),
                  nowT
                );
              }
              // قبلاً زده شده → رد شو
              if (
                notifiedAlarmsRef.current.has(a.id) ||
                triggeringAlarmsRef.current.has(a.id)
              ) {
                continue;
              }
              // بعد از ۱ نمونه پایدار می‌تواند تریگر شود
              let hit = false;
              if (
                !inCooldown &&
                prev != null &&
                !Number.isNaN(prev) &&
                seeds >= 1
              ) {
                hit = didCross(a.condition, target, prev, price);
              }
              if (hit) await triggerAlarmLocal(a, price);
            }
            prevPricesRef.current[sym] = price;
            priceSeedCountRef.current[sym] = Math.min(
              20,
              (priceSeedCountRef.current[sym] || 0) + 1
            );
          } catch {}
        }
      } catch {
      } finally {
        tickInFlightRef.current = false;
      }
    };
    tick();
    // کندل سریع‌تر؛ همگام‌سازی آلارم از DB کمی آهسته‌تر تا چارت گیر نکند
    // 1s live tip — setData only on new bar; update() for same bar
    const idCandle = window.setInterval(async () => {
      if (!alive) return;
      try { await refreshLiveCandles(); } catch {}
    }, 1000);
    const id = window.setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(id);
      clearInterval(idCandle);
    };
  }, [refreshLiveCandles, triggerAlarmLocal]);

  const deleteAlarm = async (id: string) => {
    pushUndo();
    setAlarms((prev) => prev.filter((a) => a.id !== id));
    await supabase.from("alarms").delete().eq("id", id);
  };
  const deleteLine = async (id: string) => {
    pushUndo();
    setLines((prev) => prev.filter((l) => l.id !== id));
    await supabase.from("chart_lines").delete().eq("id", id);
  };
  const deleteAllLines = async () => {
    const list = lines.filter((l) => l.symbol.toUpperCase() === symbolUpper);
    if (!list.length) return;
    if (!confirm(`Delete all ${list.length} lines on ${symbolUpper}?`)) return;
    pushUndo();
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
    pushUndo();
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
      if (chartContainerRef.current) chartContainerRef.current.style.touchAction = "none";
      document.body.style.overflow = "";
      document.documentElement.style.overflow = "";
    } catch {}
  };
  const updateAlarmCondition = async (id: string, condition: Alarm["condition"]) => {
    pushUndo();
    setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, condition } : a)));
    await supabase.from("alarms").update({ condition }).eq("id", id);
  };
  const updateAlarmColor = async (id: string, color: string) => {
    pushUndo();
    setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, color } : a)));
    await supabase.from("alarms").update({ color }).eq("id", id);
  };
  const updateAlarmWidth = async (id: string, width: number) => {
    pushUndo();
    setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, width } : a)));
    await supabase.from("alarms").update({ width }).eq("id", id);
  };
  const updateAlarmDash = async (id: string, dash: string) => {
    pushUndo();
    setAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, dash } : a)));
    await supabase.from("alarms").update({ dash }).eq("id", id);
  };
  const updateLineColor = async (id: string, color: string) => {
    pushUndo();
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, color } : l)));
    await supabase.from("chart_lines").update({ color }).eq("id", id);
  };
  const updateLineWidth = async (id: string, width: number) => {
    pushUndo();
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, width } : l)));
    await supabase.from("chart_lines").update({ width }).eq("id", id);
  };
  const updateLineDash = async (id: string, dash: string) => {
    pushUndo();
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
      (payload as any).user_id = (await supabase.auth.getSession()).data.session?.user?.id;
          let { data, error } = await supabase.from("alarms").insert([payload]).select().single();
      if (error && isDiag) {
        const fallbackNote = `__diag:${startTime}:${endTime}:${endPrice}${noteClean && noteClean !== "Diag" ? "|" + noteClean : ""}`;
        payload.note = fallbackNote;
        delete payload.start_time;
        delete payload.end_time;
        delete payload.end_price;
        (payload as any).user_id = (await supabase.auth.getSession()).data.session?.user?.id;
              ({ data, error } = await supabase.from("alarms").insert([payload]).select().single());
      }
      if (error && isRay) {
        // Schema may lack start_time — note-only
        delete payload.start_time;
        payload.note = `__ray:${startTime}`;
        (payload as any).user_id = (await supabase.auth.getSession()).data.session?.user?.id;
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
        (minimal as any).user_id = (await supabase.auth.getSession()).data.session?.user?.id;
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
      pushUndo();
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

  const goToSymbol = (sym: string) => {
    const s = chartSymbol(sym);
    if (!s) return;
    // Immediate ref so loadCandles sees new symbol even before React re-render
    symbolRef.current = s;
    setSymbol(s);
    // iPad: force a fresh load (otherwise chart can stick on previous coin)
    try {
      loadGenRef.current += 1;
    } catch {}
    requestAnimationFrame(() => {
      try {
        loadCandlesRef.current?.();
      } catch {}
    });
  };

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
    setStatusMsg("Enabling notifications…");
    const result = await ensurePushSubscription();
    setPushStatus(result);
    if (result === "ok") {
      setStatusMsg("Push notifications ON");
      // Confirm to user (and wake iOS notification permission UX)
      try {
        showLocalNotification("Alarm Chart", "Notifications enabled — you will get alerts when lines/alarms hit");
      } catch {}
    } else if (result === "denied") {
      setStatusMsg("Permission denied — iPad: Settings → [App] → Notifications → Allow");
    } else if (result === "no-key") setStatusMsg("Missing VAPID key — see setup");
    else if (result === "unsupported") {
      setStatusMsg("Add to Home Screen first (iPad Safari Share → Add to Home Screen)");
    } else setStatusMsg("Push setup failed — check /public/sw.js and VAPID keys");
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
      .filter((a) => {
        if (!a.triggered) return false;
        if (historyMode === "all") return true;
        return a.symbol.toUpperCase() === symbolUpper;
      })
      .sort((a, b) => {
        const ta = new Date(a.triggered_at || a.created_at || 0).getTime();
        const tb = new Date(b.triggered_at || b.created_at || 0).getTime();
        return tb - ta;
      })
      .slice(0, historyMode === "all" ? 80 : 30);
  }, [alarms, symbolUpper, historyMode]);

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
        /* Hide Lightweight Charts / TradingView attribution logo on all panes */
        #tv-attr-logo,
        a#tv-attr-logo,
        a[href*="tradingview.com"][title*="Charting"],
        a[href*="tradingview.com"][aria-label*="TradingView"] {
          display: none !important;
          visibility: hidden !important;
          opacity: 0 !important;
          pointer-events: none !important;
          width: 0 !important;
          height: 0 !important;
        }
      `}</style>
      {/* Header — symbol search + timeframes + indicators on the left */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input
          value={symbol}
          onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setSymbol(chartSymbol((e.target as HTMLInputElement).value));
              setTimeout(() => loadCandles(), 0);
            }
          }}
          className="bg-gray-900/90 border border-gray-600 rounded-full px-4 py-1.5 text-sm w-32 font-mono text-center tracking-wide shadow-inner focus:outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500/40 transition-colors"
          title="Symbol"
        />
        <div className="flex items-center gap-1">
          {chartLayout !== "1" && (
            <span className="text-[10px] text-orange-300/90 px-1.5 py-0.5 rounded border border-orange-500/30 bg-orange-500/10 mr-0.5">
              {activePane === 0 ? "Main" : `P${activePane}`}
            </span>
          )}
          {favTfButtons.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => applyTfToActivePane(t.value)}
              className={`px-2 py-1 text-xs rounded ${
                (activePane === 0 ? interval : (paneIntervals[activePane - 1] || interval)) === t.value
                  ? "bg-orange-500 text-black"
                  : "bg-gray-800 hover:bg-gray-700"
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
                      onClick={() => { applyTfToActivePane(t.value); setTfMenuOpen(false); }}
                      className={`flex-1 text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-white/10 ${
                        (activePane === 0 ? interval : (paneIntervals[activePane - 1] || interval)) === t.value ? "text-orange-300" : "text-gray-200"
                      }`}
                    >
                      <span className="w-3 text-orange-400">{(activePane === 0 ? interval : (paneIntervals[activePane - 1] || interval)) === t.value ? "✓" : ""}</span>
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

          {/* Indicators — next to timeframe tools */}
          <div className="relative" data-ind-panel>
            <button
              type="button"
              data-ind-panel
              title="Indicators"
              onClick={() => { setShowIndicatorMenu((v) => !v); setTfMenuOpen(false); setTzMenuOpen(false); setOpenMenu(null); }}
              className={`h-8 px-2.5 text-xs rounded-lg inline-flex items-center gap-1.5 border transition-all duration-200 ${
                showIndicatorMenu
                  ? "bg-blue-500/20 border-blue-500 text-blue-300 shadow-lg"
                  : "bg-gray-900 border-gray-700 text-gray-300 hover:bg-white/10"
              }`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <line x1="6" y1="20" x2="6" y2="10" />
                <line x1="12" y1="20" x2="12" y2="4" />
                <line x1="18" y1="20" x2="18" y2="14" />
              </svg>
              <span className="font-medium">Indicators</span>
            </button>
            {showIndicatorMenu && (
              <div
                data-ind-panel
                className="absolute z-50 top-full left-0 mt-1.5 border border-white/20 rounded-2xl py-1.5 shadow-[0_8px_40px_rgba(0,0,0,0.5)] overflow-hidden isolate min-w-[150px]"
                style={{
                  animation: "tfPop 0.28s cubic-bezier(0.34,1.3,0.64,1)",
                  background: "rgba(20,20,22,0.42)",
                  backdropFilter: "blur(40px) saturate(200%)",
                  WebkitBackdropFilter: "blur(40px) saturate(200%)",
                }}
              >
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
                    data-ind-panel
                    onClick={() => it.set((v: boolean) => !v)}
                    className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-white/10 ${
                      it.on ? "text-orange-300" : "text-gray-200"
                    }`}
                  >
                    <span className="w-3 text-orange-400">{it.on ? "✓" : ""}</span>
                    <span>{it.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Chart type (Candles / Line / Area / Heikin) */}
          <div className="relative">
            <button
              type="button"
              title="Chart type"
              onClick={() => {
                setShowChartTypeMenu((v) => !v);
                setShowIndicatorMenu(false);
                setTfMenuOpen(false);
                setTzMenuOpen(false);
                setOpenMenu(null);
              }}
              className={`h-8 px-2.5 text-xs rounded-lg inline-flex items-center gap-1.5 border transition-all duration-200 ${
                showChartTypeMenu
                  ? "bg-orange-500/20 border-orange-500 text-orange-300 shadow-lg"
                  : "bg-gray-900 border-gray-700 text-gray-300 hover:bg-white/10"
              }`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="18" rx="1" />
                <rect x="14" y="8" width="7" height="13" rx="1" />
              </svg>
              <span className="font-medium capitalize">{chartType === "heikin" ? "Heikin" : chartType}</span>
            </button>
            {showChartTypeMenu && (
              <div
                className="absolute z-50 top-full left-0 mt-1.5 border border-white/20 rounded-2xl py-1.5 shadow-[0_8px_40px_rgba(0,0,0,0.5)] overflow-hidden isolate min-w-[170px]"
                style={{
                  animation: "tfPop 0.28s cubic-bezier(0.34,1.3,0.64,1)",
                  background: "rgba(20,20,22,0.42)",
                  backdropFilter: "blur(40px) saturate(200%)",
                  WebkitBackdropFilter: "blur(40px) saturate(200%)",
                }}
              >
                {([
                  ["candles", "Candles"],
                  ["hollow", "Hollow candles"],
                  ["line", "Line"],
                  ["area", "Area"],
                  ["heikin", "Heikin Ashi"],
                ] as const).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => {
                      setChartType(k);
                      setShowChartTypeMenu(false);
                      setTimeout(() => loadCandlesRef.current?.(), 0);
                    }}
                    className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-white/10 ${
                      chartType === k ? "text-orange-300" : "text-gray-200"
                    }`}
                  >
                    <span className="w-3 text-orange-400">{chartType === k ? "✓" : ""}</span>
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Undo / Redo */}
          <div className="flex items-center gap-0.5 ml-1" data-hist={histTick}>
            <button
              type="button"
              title="Undo"
              disabled={histTick >= 0 && !undoStackRef.current.length}
              onClick={() => undoChart()}
              className={`h-8 w-8 rounded-lg inline-flex items-center justify-center border transition-colors ${
                undoStackRef.current.length
                  ? "bg-gray-900 border-gray-700 text-gray-200 hover:bg-white/10"
                  : "bg-gray-950 border-gray-800 text-gray-600 cursor-not-allowed"
              }`}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 14 4 9 9 4" />
                <path d="M20 20a8 8 0 0 0-8-8H4" />
              </svg>
            </button>
            <button
              type="button"
              title="Redo"
              disabled={histTick >= 0 && !redoStackRef.current.length}
              onClick={() => redoChart()}
              className={`h-8 w-8 rounded-lg inline-flex items-center justify-center border transition-colors ${
                redoStackRef.current.length
                  ? "bg-gray-900 border-gray-700 text-gray-200 hover:bg-white/10"
                  : "bg-gray-950 border-gray-800 text-gray-600 cursor-not-allowed"
              }`}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 14 20 9 15 4" />
                <path d="M4 20a8 8 0 0 1 8-8h8" />
              </svg>
            </button>
          </div>

        </div>

          {/* Layout + Camera — far right of header (near coin list) */}
          <div className="flex items-center gap-0.5 ml-auto">
            <div className="relative" data-menu>
              <button
                type="button"
                title="Chart layout"
                onClick={() => { setShowLayoutMenu((v) => !v); setShowChartTypeMenu(false); setShowIndicatorMenu(false); }}
                className={`h-8 w-8 rounded-lg inline-flex items-center justify-center border transition-colors ${
                  showLayoutMenu
                    ? "bg-orange-500/20 border-orange-500 text-orange-300"
                    : "bg-gray-900 border-gray-700 text-gray-300 hover:bg-white/10"
                }`}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <rect x="3" y="3" width="8" height="8" rx="1" />
                  <rect x="13" y="3" width="8" height="8" rx="1" />
                  <rect x="3" y="13" width="8" height="8" rx="1" />
                  <rect x="13" y="13" width="8" height="8" rx="1" />
                </svg>
              </button>
              {showLayoutMenu && (
                <div
                  className="absolute z-50 top-full right-0 mt-1.5 border border-white/20 rounded-xl p-3 shadow-[0_8px_40px_rgba(0,0,0,0.5)] isolate min-w-[200px]"
                  style={{ background: "rgba(20,20,22,0.92)", backdropFilter: "blur(24px)" }}
                >
                  <div className="text-[10px] text-gray-500 px-1 mb-2 font-medium tracking-wide">LAYOUT</div>
                  <div className="flex flex-col gap-2 max-h-[70vh] overflow-y-auto pr-0.5">
                    {(
                      [
                        {
                          row: "1",
                          items: [{ id: "1", title: "1 chart", icon: "1" }],
                        },
                        {
                          row: "2",
                          items: [
                            { id: "2h", title: "2 side by side", icon: "2h" },
                            { id: "2v", title: "2 stacked", icon: "2v" },
                          ],
                        },
                        {
                          row: "3",
                          items: [
                            { id: "3a", title: "1 top + 2 bottom", icon: "3a" },
                            { id: "3b", title: "3 columns", icon: "3b" },
                            { id: "3c", title: "Big left + 2 right", icon: "3c" },
                          ],
                        },
                        {
                          row: "4",
                          items: [
                            { id: "4a", title: "2×2 grid", icon: "4a" },
                            { id: "4b", title: "1 top + 3 bottom", icon: "4b" },
                            { id: "4c", title: "4 columns", icon: "4c" },
                          ],
                        },
                        {
                          row: "5",
                          items: [
                            { id: "5a", title: "2 top + 3 bottom", icon: "5a" },
                            { id: "5b", title: "1 left + 4 right", icon: "5b" },
                          ],
                        },
                        {
                          row: "6",
                          items: [
                            { id: "6a", title: "2×3 grid", icon: "6a" },
                            { id: "6b", title: "3×2 grid", icon: "6b" },
                          ],
                        },
                      ] as const
                    ).map((group) => (
                      <div key={group.row} className="flex items-center gap-1.5">
                        <span className="text-[10px] text-gray-500 w-3 shrink-0">{group.row}</span>
                        <div className="flex flex-wrap gap-1">
                          {group.items.map((opt) => (
                            <button
                              key={opt.id}
                              type="button"
                              title={opt.title}
                              onClick={() => {
                                setChartLayout(opt.id as any);
                                setShowLayoutMenu(false);
                                setStatusMsg(`Layout: ${opt.title}`);
                                const force = () => {
                                  try {
                                    if (chartRef.current && chartContainerRef.current) {
                                      chartRef.current.applyOptions({
                                        width: chartContainerRef.current.clientWidth,
                                        height: chartContainerRef.current.clientHeight,
                                      });
                                    }
                                  } catch {}
                                };
                                requestAnimationFrame(force);
                                setTimeout(force, 80);
                                setTimeout(force, 200);
                                setTimeout(force, 400);
                              }}
                              className={`w-9 h-8 flex items-center justify-center rounded-md border transition-colors ${
                                chartLayout === opt.id
                                  ? "border-orange-500 bg-orange-500/15 text-orange-300"
                                  : "border-white/10 text-gray-300 hover:bg-white/10"
                              }`}
                            >
                              <span className="w-6 h-5 flex items-center justify-center">
                                {opt.icon === "1" && <span className="w-5 h-4 border border-current rounded-[2px]" />}
                                {opt.icon === "2h" && (
                                  <span className="flex gap-px w-5 h-4">
                                    <span className="flex-1 border border-current rounded-[1px]" />
                                    <span className="flex-1 border border-current rounded-[1px]" />
                                  </span>
                                )}
                                {opt.icon === "2v" && (
                                  <span className="flex flex-col gap-px w-5 h-4">
                                    <span className="flex-1 border border-current rounded-[1px]" />
                                    <span className="flex-1 border border-current rounded-[1px]" />
                                  </span>
                                )}
                                {opt.icon === "3a" && (
                                  <span className="flex flex-col gap-px w-5 h-4">
                                    <span className="flex-1 border border-current rounded-[1px]" />
                                    <span className="flex flex-1 gap-px">
                                      <span className="flex-1 border border-current rounded-[1px]" />
                                      <span className="flex-1 border border-current rounded-[1px]" />
                                    </span>
                                  </span>
                                )}
                                {opt.icon === "3b" && (
                                  <span className="flex gap-px w-5 h-4">
                                    <span className="flex-1 border border-current rounded-[1px]" />
                                    <span className="flex-1 border border-current rounded-[1px]" />
                                    <span className="flex-1 border border-current rounded-[1px]" />
                                  </span>
                                )}
                                {opt.icon === "3c" && (
                                  <span className="flex gap-px w-5 h-4">
                                    <span className="w-[55%] border border-current rounded-[1px]" />
                                    <span className="flex-1 flex flex-col gap-px">
                                      <span className="flex-1 border border-current rounded-[1px]" />
                                      <span className="flex-1 border border-current rounded-[1px]" />
                                    </span>
                                  </span>
                                )}
                                {opt.icon === "4a" && (
                                  <span className="grid grid-cols-2 gap-px w-5 h-4">
                                    <span className="border border-current rounded-[1px]" />
                                    <span className="border border-current rounded-[1px]" />
                                    <span className="border border-current rounded-[1px]" />
                                    <span className="border border-current rounded-[1px]" />
                                  </span>
                                )}
                                {opt.icon === "4b" && (
                                  <span className="flex flex-col gap-px w-5 h-4">
                                    <span className="flex-1 border border-current rounded-[1px]" />
                                    <span className="flex flex-1 gap-px">
                                      <span className="flex-1 border border-current rounded-[1px]" />
                                      <span className="flex-1 border border-current rounded-[1px]" />
                                      <span className="flex-1 border border-current rounded-[1px]" />
                                    </span>
                                  </span>
                                )}
                                {opt.icon === "4c" && (
                                  <span className="flex gap-px w-5 h-4">
                                    <span className="flex-1 border border-current rounded-[1px]" />
                                    <span className="flex-1 border border-current rounded-[1px]" />
                                    <span className="flex-1 border border-current rounded-[1px]" />
                                    <span className="flex-1 border border-current rounded-[1px]" />
                                  </span>
                                )}
                                {opt.icon === "5a" && (
                                  <span className="flex flex-col gap-px w-5 h-4">
                                    <span className="flex flex-1 gap-px">
                                      <span className="flex-1 border border-current rounded-[1px]" />
                                      <span className="flex-1 border border-current rounded-[1px]" />
                                    </span>
                                    <span className="flex flex-1 gap-px">
                                      <span className="flex-1 border border-current rounded-[1px]" />
                                      <span className="flex-1 border border-current rounded-[1px]" />
                                      <span className="flex-1 border border-current rounded-[1px]" />
                                    </span>
                                  </span>
                                )}
                                {opt.icon === "5b" && (
                                  <span className="flex gap-px w-5 h-4">
                                    <span className="w-[40%] border border-current rounded-[1px]" />
                                    <span className="flex-1 grid grid-cols-2 gap-px">
                                      <span className="border border-current rounded-[1px]" />
                                      <span className="border border-current rounded-[1px]" />
                                      <span className="border border-current rounded-[1px]" />
                                      <span className="border border-current rounded-[1px]" />
                                    </span>
                                  </span>
                                )}
                                {opt.icon === "6a" && (
                                  <span className="grid grid-cols-3 gap-px w-5 h-4">
                                    <span className="border border-current rounded-[1px]" />
                                    <span className="border border-current rounded-[1px]" />
                                    <span className="border border-current rounded-[1px]" />
                                    <span className="border border-current rounded-[1px]" />
                                    <span className="border border-current rounded-[1px]" />
                                    <span className="border border-current rounded-[1px]" />
                                  </span>
                                )}
                                {opt.icon === "6b" && (
                                  <span className="grid grid-cols-2 gap-px w-5 h-4" style={{ gridTemplateRows: "1fr 1fr 1fr" }}>
                                    <span className="border border-current rounded-[1px]" />
                                    <span className="border border-current rounded-[1px]" />
                                    <span className="border border-current rounded-[1px]" />
                                    <span className="border border-current rounded-[1px]" />
                                    <span className="border border-current rounded-[1px]" />
                                    <span className="border border-current rounded-[1px]" />
                                  </span>
                                )}
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <button
              type="button"
              title="Screenshot chart"
              onClick={() => {
                try {
                  const chart = chartRef.current as any;
                  if (!chart || typeof chart.takeScreenshot !== "function") {
                    setStatusMsg("Screenshot not available");
                    return;
                  }
                  const canvas = chart.takeScreenshot();
                  const a = document.createElement("a");
                  a.download = `${symbolUpper}_${interval}_${Date.now()}.png`;
                  a.href = canvas.toDataURL("image/png");
                  a.click();
                  setStatusMsg("Screenshot saved");
                } catch {
                  setStatusMsg("Screenshot failed");
                }
              }}
              className="h-8 w-8 rounded-lg inline-flex items-center justify-center border bg-gray-900 border-gray-700 text-gray-300 hover:bg-white/10"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
            </button>
          </div>
      </div>

      <div className="flex gap-2">
        {/* Left tools — fully hidden when collapsed (chart expands like side list) */}
        {showToolsPanel && (
          <div className="flex flex-col gap-1 shrink-0 self-stretch" style={{ minHeight: 420 }}>
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

            {/* Vertical line */}
            <button
              type="button"
              title="Vertical line"
              onClick={() => {
                setMode(mode === "vline" ? "none" : "vline");
                setDiagStart(null);
                setAlarmMenuOpen(false);
                clearPreview();
                if (mode !== "vline") setStatusMsg("Vertical line: tap on chart");
                else setStatusMsg("");
              }}
              className={`w-9 h-9 rounded-lg flex items-center justify-center border transition-colors ${
                mode === "vline"
                  ? "bg-orange-500/20 border-orange-500 text-orange-300"
                  : "bg-gray-900 border-gray-700 text-gray-300 hover:bg-white/10"
              }`}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="12" y1="3" x2="12" y2="21" />
                <line x1="9" y1="3" x2="15" y2="3" />
                <line x1="9" y1="21" x2="15" y2="21" />
              </svg>
            </button>

            {/* Separator + shapes menu (TradingView-style) */}
            <div className="h-px w-7 mx-auto my-1 bg-gray-700/80 rounded-full" />
            <div className="relative" data-menu>
              <button
                type="button"
                title="Shapes & tools"
                onClick={() => setDrawToolsOpen((v) => !v)}
                className={`w-9 h-9 rounded-lg flex items-center justify-center border transition-colors ${
                  drawToolsOpen || mode === "arrow" || mode === "path" || mode === "brush" || mode === "curve" || mode === "rect"
                    ? "bg-orange-500/20 border-orange-500 text-orange-300"
                    : "bg-gray-900 border-gray-700 text-gray-300 hover:bg-white/10"
                }`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1" />
                  <rect x="14" y="3" width="7" height="7" rx="1" />
                  <rect x="3" y="14" width="7" height="7" rx="1" />
                  <rect x="14" y="14" width="7" height="7" rx="1" />
                </svg>
              </button>
              {drawToolsOpen && (
                <div className="absolute left-full top-0 ml-2 z-50 w-48 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl py-1 text-xs text-gray-200">
                  <div className="px-3 py-1 text-[10px] text-gray-500 uppercase tracking-wide">Arrows</div>
                  {[
                    { id: "arrow", label: "Arrow", icon: "↗" },
                    { id: "arrow-up", label: "Arrow mark up", icon: "↑" },
                    { id: "arrow-down", label: "Arrow mark down", icon: "↓" },
                    { id: "arrow-marker", label: "Arrow marker", icon: "➤" },
                  ].map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={`w-full text-left px-3 py-2 hover:bg-white/10 flex items-center gap-2 ${mode === t.id ? "text-orange-300" : ""}`}
                      onClick={() => {
                        clearPreview();
                        setDrawToolsOpen(false);
                        setDiagStart(null);
                        setMovingId(null);
                        pathPointsRef.current = [];
                        setMode(t.id as any);
                        if (t.id === "arrow-up") setDrawColor("#22c55e");
                        if (t.id === "arrow-down") setDrawColor("#ef4444");
                        setStatusMsg(
                          t.id === "arrow"
                            ? "Arrow: first point, then tip"
                            : t.id === "arrow-up" || t.id === "arrow-down"
                            ? "Tap chart to place mark — color/size from style panel"
                            : "Arrow marker: tap on chart"
                        );
                      }}
                    >
                      <span className="w-4 text-center">{t.icon}</span>
                      {t.label}
                    </button>
                  ))}
                  <div className="border-t border-gray-700 my-1" />
                  <div className="px-3 py-1 text-[10px] text-gray-500 uppercase tracking-wide">Shapes</div>
                  {[
                    { id: "rect", label: "Rectangle", icon: "▭" },
                    { id: "path", label: "Path", icon: "∿" },
                    { id: "curve", label: "Curve", icon: "◠" },
                    { id: "brush", label: "Brush", icon: "✎" },
                  ].map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={`w-full text-left px-3 py-2 hover:bg-white/10 flex items-center gap-2 ${mode === t.id ? "text-orange-300" : ""}`}
                      onClick={() => {
                        clearPreview();
                        setDrawToolsOpen(false);
                        setDiagStart(null);
                        setMovingId(null);
                        pathPointsRef.current = [];
                        setMode(t.id as any);
                        setStatusMsg(
                          t.id === "rect"
                            ? "Rectangle: corner 1, then corner 2"
                            : t.id === "path"
                            ? "Path: click points, click menu again to finish"
                            : t.id === "curve"
                            ? "Curve: 3 points"
                            : "Brush: drag on chart"
                        );
                      }}
                    >
                      <span className="w-4 text-center">{t.icon}</span>
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Spacer — push measure / hide / trash lower but not at the very bottom */}
            <div className="flex-1 min-h-2" style={{ maxHeight: 48 }} />
            <div className="h-px w-7 mx-auto my-0.5 bg-gray-700/80 rounded-full" />

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

        {/* Chart — multi-pane layout */}
        <div ref={layoutWrapRef} className="flex-1 min-w-0 relative" style={{ height: 640 }}>
          <div
            className={
              chartLayout === "1"
                ? "h-full w-full"
                : chartLayout === "2h"
                ? "h-full w-full grid grid-cols-2 gap-1"
                : chartLayout === "2v"
                ? "h-full w-full grid grid-rows-2 gap-1"
                : chartLayout === "3a"
                ? "h-full w-full grid grid-cols-2 grid-rows-2 gap-1"
                : chartLayout === "3b"
                ? "h-full w-full grid grid-cols-3 gap-1"
                : chartLayout === "3c"
                ? "h-full w-full grid grid-cols-2 grid-rows-2 gap-1"
                : chartLayout === "4a"
                ? "h-full w-full grid grid-cols-2 grid-rows-2 gap-1"
                : chartLayout === "4b"
                ? "h-full w-full grid grid-cols-3 grid-rows-2 gap-1"
                : chartLayout === "4c"
                ? "h-full w-full grid grid-cols-4 gap-1"
                : chartLayout === "5a"
                ? "h-full w-full grid grid-cols-6 grid-rows-2 gap-1"
                : chartLayout === "5b"
                ? "h-full w-full grid grid-cols-3 grid-rows-2 gap-1"
                : chartLayout === "6a"
                ? "h-full w-full grid grid-cols-3 grid-rows-2 gap-1"
                : chartLayout === "6b"
                ? "h-full w-full grid grid-cols-2 grid-rows-3 gap-1"
                : "h-full w-full"
            }
          >
            {/* Main chart */}
            <div
              onMouseDown={() => setActivePane(0)}
              className={
                (chartLayout === "1"
                  ? "relative min-h-0 min-w-0 h-full w-full"
                  : chartLayout === "3a"
                  ? "relative min-h-0 min-w-0 col-span-2"
                  : chartLayout === "3c"
                  ? "relative min-h-0 min-w-0 row-span-2"
                  : chartLayout === "4b"
                  ? "relative min-h-0 min-w-0 col-span-3"
                  : chartLayout === "5a"
                  ? "relative min-h-0 min-w-0 col-span-3"
                  : chartLayout === "5b"
                  ? "relative min-h-0 min-w-0 row-span-2"
                  : "relative min-h-0 min-w-0") +
                (activePane === 0 && chartLayout !== "1"
                  ? " ring-1 ring-dashed ring-orange-400/80 rounded-xl"
                  : "")
              }
            >
              <div
                ref={chartContainerRef}
                className="w-full h-full rounded-xl border border-gray-800 bg-black overflow-hidden touch-none"
                style={{
                  touchAction: "none",
                  WebkitUserSelect: "none",
                  userSelect: "none",
                  cursor:
                    mode === "vline"
                      ? "col-resize"
                      : mode === "draw" || mode === "ray" || mode === "alarm" || mode === "alarm-ray"
                        ? "row-resize"
                        : mode === "diag" || mode === "alarm-diag" || mode === "measure"
                          ? "crosshair"
                          : "default",
                }}
              />
              <div
                ref={vlineOverlayRef}
                className="absolute inset-0 pointer-events-none overflow-hidden rounded-xl"
                style={{ zIndex: 4 }}
              />
              {statusMsg === "Loading..." && (
                <div className="absolute inset-0 z-30 flex items-center justify-center pointer-events-none rounded-xl bg-black/35">
                  <div className="px-3 py-1.5 rounded-full bg-gray-900/90 border border-gray-600 text-xs text-gray-200">
                    Loading…
                  </div>
                </div>
              )}
              <div className="absolute top-1.5 left-2 z-10 text-[10px] font-semibold text-orange-300/90 pointer-events-none">
                {symbolUpper}
              </div>
            </div>

            {/* Extra panes 0..4 */}
            {([0, 1, 2, 3, 4] as const).map((i) => {
              const needExtra =
                chartLayout === "2h" || chartLayout === "2v"
                  ? 1
                  : chartLayout === "3a" || chartLayout === "3b" || chartLayout === "3c"
                  ? 2
                  : chartLayout === "4a" || chartLayout === "4b" || chartLayout === "4c"
                  ? 3
                  : chartLayout === "5a" || chartLayout === "5b"
                  ? 4
                  : chartLayout === "6a" || chartLayout === "6b"
                  ? 5
                  : 0;
              const visible = i < needExtra;
              if (!visible) return null;
              const spanClass =
                chartLayout === "5a" && i === 0
                  ? "col-span-3"
                  : chartLayout === "5a" && i >= 1
                  ? "col-span-2"
                  : "";
              const sym = paneSymbols[i] || "ETHUSDT";
              const pool = Array.from(
                new Set(
                  [
                    symbolUpper,
                    ...paneSymbols,
                    ...(watchItems || []).map((w) => chartSymbol(w.symbol)),
                    ...allSymbols,
                  ].filter(Boolean)
                )
              );
              const q = paneSearchOpen === i ? paneSearchQ.trim().toUpperCase() : "";
              const filtered = (q
                ? pool.filter((s) => s.includes(q))
                : pool
              ).slice(0, 40);
              return (
                <div
                  key={`pane-${i}`}
                  onMouseDown={() => setActivePane(i + 1)}
                  className={`relative min-h-0 min-w-0 rounded-xl border bg-black overflow-hidden ${spanClass} ${
                    activePane === i + 1
                      ? "border-orange-400 ring-1 ring-dashed ring-orange-400/90"
                      : "border-gray-800"
                  }`}
                >
                  <div className="absolute top-1 left-1 z-10" data-menu>
                    <input
                      value={paneSearchOpen === i ? paneSearchQ : sym}
                      onFocus={() => {
                        setPaneSearchOpen(i);
                        setPaneSearchQ(sym);
                      }}
                      onChange={(e) => {
                        setPaneSearchOpen(i);
                        setPaneSearchQ(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          const v = (paneSearchQ || sym).toUpperCase().replace(/[^A-Z0-9]/g, "");
                          if (!v) return;
                          setPaneSymbols((prev) => {
                            const n = [...prev];
                            n[i] = v;
                            return n;
                          });
                          setPaneSearchOpen(null);
                          setPaneSearchQ("");
                        } else if (e.key === "Escape") {
                          setPaneSearchOpen(null);
                          setPaneSearchQ("");
                        }
                      }}
                      onBlur={() => {
                        // delay so option click can fire
                        setTimeout(() => {
                          if (paneSearchOpen === i) {
                            const v = (paneSearchQ || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
                            if (v && v !== sym) {
                              setPaneSymbols((prev) => {
                                const n = [...prev];
                                n[i] = v;
                                return n;
                              });
                            }
                            setPaneSearchOpen(null);
                            setPaneSearchQ("");
                          }
                        }, 150);
                      }}
                      placeholder="Search…"
                      className="bg-gray-900/95 border border-gray-700 rounded px-1.5 py-0.5 text-[10px] text-gray-200 w-[100px]"
                    />
                    {paneSearchOpen === i && filtered.length > 0 && (
                      <div
                        className="absolute top-full left-0 mt-0.5 z-40 max-h-36 overflow-y-auto rounded-lg border border-white/15 shadow-xl min-w-[120px]"
                        style={{ background: "rgba(20,20,22,0.95)", backdropFilter: "blur(16px)" }}
                      >
                        {filtered.map((s) => (
                          <button
                            key={s}
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => {
                              setPaneSymbols((prev) => {
                                const n = [...prev];
                                n[i] = s;
                                return n;
                              });
                              setPaneSearchOpen(null);
                              setPaneSearchQ("");
                            }}
                            className={`w-full text-left px-2 py-1 text-[10px] hover:bg-white/10 ${
                              s === sym ? "text-orange-300" : "text-gray-200"
                            }`}
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div
                    ref={(el) => {
                      paneRefs.current[i] = el;
                    }}
                    className="w-full h-full"
                  />
                </div>
              );
            })}
          </div>

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

          {/* Go to live — only when scrolled into history (TradingView-style) */}
          {showGoLive && (
            <button
              type="button"
              title="Jump to latest candles"
              onClick={() => {
                const chart = chartRef.current;
                if (!chart) return;
                try {
                  const bars = candlesRef.current.length;
                  if (bars < 2) {
                    /* scrollToRealTime removed */
                  } else {
                    programmaticRangeRef.current = true;
                    chart.timeScale().applyOptions({ rightOffset: 12, barSpacing: 2.5 });
                    const past = Math.min(500, bars);
                    chart.timeScale().setVisibleLogicalRange({
                      from: Math.max(0, bars - past),
                      to: bars - 1 + FUTURE_VISIBLE,
                    });
                    try {
                      seriesRef.current?.priceScale()?.applyOptions({ autoScale: true });
                    } catch {}
                    requestAnimationFrame(() => {
                      programmaticRangeRef.current = false;
                    });
                  }
                } catch {
                  programmaticRangeRef.current = false;
                }
                pinnedToRightRef.current = true;
                setShowGoLive(false);
              }}
              className="absolute bottom-2 right-14 z-20 flex items-center justify-center w-9 h-9 rounded-full bg-gray-900/95 border border-gray-500 text-white shadow-lg hover:bg-orange-600 hover:border-orange-500 active:scale-95 transition"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="13 17 18 12 13 7" />
                <polyline points="6 17 11 12 6 7" />
              </svg>
            </button>
          )}

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


          {/* Style panel: color / width / dash — bottom-left of chart */}
          {(mode === "draw" ||
            mode === "ray" ||
            mode === "diag" ||
            mode === "arrow" ||
            mode === "arrow-up" ||
            mode === "arrow-down" ||
            mode === "arrow-marker" ||
            mode === "path" ||
            mode === "brush" ||
            mode === "curve" ||
            mode === "alarm" ||
            mode === "alarm-ray" ||
            mode === "alarm-diag" ||
            mode === "move") && (
            <div data-move-bar className="absolute bottom-10 left-3 z-20 bg-gray-900/95 border border-gray-700 rounded-xl px-3 py-2 shadow-xl flex items-center gap-2">
              <div className="relative" data-menu>
                <button
                  type="button"
                  title="Color"
                  onClick={() => setOpenMenu((m) => (m === "__style_color__" ? null : "__style_color__"))}
                  className="w-8 h-8 rounded-full border-2 border-gray-500 shadow shrink-0"
                  style={{ background: drawColor }}
                />
                {openMenu === "__style_color__" && (
                  <div
                    className="absolute bottom-full left-0 mb-2 z-50 p-3 rounded-2xl border border-white/10 shadow-2xl min-w-[180px]"
                    style={{
                      background: "rgba(22,22,26,0.92)",
                      backdropFilter: "blur(28px) saturate(180%)",
                      WebkitBackdropFilter: "blur(28px) saturate(180%)",
                    }}
                  >
                    <div className="text-[10px] text-gray-400 mb-2 font-medium tracking-wide">Colors</div>
                    <div className="grid grid-cols-5 gap-1.5 mb-3">
                      {PRESET_COLORS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => {
                            setDrawColor(c);
                            const md = moveDiagRef.current;
                            if (mode === "move" && md) {
                              md.color = c;
                              try {
                                previewDiagSeriesRef.current?.applyOptions({ color: c });
                              } catch {}
                            }
                            if (mode === "move" && movingId) {
                              if (movingType === "line") void updateLineColor(movingId, c);
                              else if (movingType === "alarm") void updateAlarmColor(movingId, c);
                            }
                            setOpenMenu(null);
                          }}
                          className={`w-7 h-7 rounded-lg border transition-transform hover:scale-110 ${
                            drawColor.toLowerCase() === c.toLowerCase()
                              ? "border-orange-400 ring-2 ring-orange-400/40"
                              : "border-white/10"
                          }`}
                          style={{ background: c }}
                        />
                      ))}
                    </div>
                    <label className="flex items-center gap-2 text-[11px] text-gray-300 cursor-pointer">
                      <span className="relative w-7 h-7 rounded-lg overflow-hidden border border-white/20 shrink-0">
                        <input
                          type="color"
                          value={drawColor}
                          onChange={(e) => {
                            const c = e.target.value;
                            setDrawColor(c);
                            const md = moveDiagRef.current;
                            if (mode === "move" && md) {
                              md.color = c;
                              try {
                                previewDiagSeriesRef.current?.applyOptions({ color: c });
                              } catch {}
                            }
                            if (mode === "move" && movingId) {
                              if (movingType === "line") void updateLineColor(movingId, c);
                              else if (movingType === "alarm") void updateAlarmColor(movingId, c);
                            }
                          }}
                          className="absolute -top-1 -left-1 w-10 h-10 cursor-pointer border-0 p-0"
                        />
                      </span>
                      Custom color
                    </label>
                  </div>
                )}
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
                      // Live size for selected arrow / line / alarm (immediate UI)
                      if (mode === "move" && movingId) {
                        if (movingType === "line") {
                          setLines((prev) =>
                            prev.map((l) => (l.id === movingId ? { ...l, width: w } : l))
                          );
                          void updateLineWidth(movingId, w);
                        } else if (movingType === "alarm") {
                          setAlarms((prev) =>
                            prev.map((a) => (a.id === movingId ? { ...a, width: w } : a))
                          );
                          void updateAlarmWidth(movingId, w);
                        }
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
                        if (chartContainerRef.current) chartContainerRef.current.style.touchAction = "none";
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
            <div className="px-2 py-1.5 border-b border-gray-800 flex flex-col gap-1.5">
              <div className="flex items-center gap-1">
                <span className="text-[11px] font-medium text-gray-300 truncate flex-1 min-w-0" title={sideViewLabel}>
                  {sideViewId === SIDE_VIEW_ALARMS ? "Alarms" : (watchLists.find((l) => l.id === sideViewId)?.name || "Watchlist")}
                </span>
                <button
                  type="button"
                  onClick={() => setShowSideWl(false)}
                  className="text-[11px] text-gray-500 hover:text-white px-1 shrink-0"
                >
                  « Hide
                </button>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <button
                  type="button"
                  title="All alarms"
                  onClick={() => {
                    setSideViewId(SIDE_VIEW_ALARMS);
                    setWlMenuOpen(false);
                    setWlRenameOpen(false);
                    setWlManageMode(null);
                  }}
                  className={`w-9 h-9 flex items-center justify-center rounded-full shrink-0 transition-colors ${
                    sideViewId === SIDE_VIEW_ALARMS
                      ? "text-orange-400 ring-1 ring-orange-500/60 bg-orange-500/10"
                      : "text-gray-500 hover:text-orange-400 hover:bg-gray-800/80"
                  }`}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <circle cx="12" cy="13" r="8" />
                    <path d="M12 9v4l2.5 1.5" />
                    <path d="M9 3h6" />
                    <path d="M5.5 5.5l1.5 1.5M18.5 5.5l-1.5 1.5" />
                  </svg>
                </button>
                {watchLists.map((l) => {
                  const letter = (l.name || "?").trim().charAt(0).toUpperCase() || "?";
                  const active = sideViewId === l.id;
                  return (
                    <div key={l.id} className="relative shrink-0">
                      <button
                        type="button"
                        title={l.name}
                        onClick={() => {
                          if (wlManageMode === "delete") return;
                          setSideViewId(l.id);
                          setWlMenuOpen(false);
                          setWlRenameOpen(false);
                        }}
                        className={`w-5 h-5 rounded-full text-[9px] font-semibold flex items-center justify-center transition-all border ${
                          active
                            ? "bg-orange-500/20 text-orange-400 border-orange-500 shadow-[0_0_0_1px_rgba(249,115,22,0.25)]"
                            : "bg-transparent text-gray-500 border-gray-600 hover:text-gray-300 hover:border-gray-500"
                        }`}
                      >
                        {letter}
                      </button>
                      {wlManageMode === "delete" && (
                        <button
                          type="button"
                          title={`Delete list ${l.name}`}
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (!window.confirm(`Delete list "${l.name}"?`)) return;
                            try {
                              const itemIds = watchItems.filter((w) => w.list_id === l.id).map((w) => w.id);
                              if (itemIds.length) {
                                await supabase.from("watchlist_items").delete().in("id", itemIds);
                              }
                              await supabase.from("watchlist_lists").delete().eq("id", l.id);
                              setWatchItems((prev) => prev.filter((w) => w.list_id !== l.id));
                              setWatchLists((prev) => prev.filter((x) => x.id !== l.id));
                              if (sideViewId === l.id) setSideViewId(SIDE_VIEW_ALARMS);
                              setStatusMsg("List deleted");
                            } catch {
                              setStatusMsg("Delete failed");
                            }
                          }}
                          className="absolute -top-1 -right-1 w-3.5 h-3.5 rounded-full bg-red-600 text-white text-[9px] leading-none flex items-center justify-center shadow"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  );
                })}
                <div className="relative ml-auto" data-menu>
                  <button
                    type="button"
                    title="List options"
                    onClick={() => {
                      setWlMenuOpen((v) => !v);
                      setWlRenameOpen(false);
                    }}
                    className={`w-6 h-6 flex items-center justify-center rounded-full text-sm leading-none ${
                      wlMenuOpen ? "bg-gray-700 text-white" : "text-gray-400 hover:text-white hover:bg-gray-800"
                    }`}
                  >
                    ⋮
                  </button>
                  {wlMenuOpen && (
                    <div className="absolute z-50 top-full right-0 mt-1 min-w-[150px] border border-white/15 rounded-xl py-1 shadow-[0_8px_32px_rgba(0,0,0,0.55)] bg-gray-950 overflow-hidden">
                      <button
                        type="button"
                        className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-800 disabled:opacity-40 flex items-center gap-2"
                        disabled={sideViewId === SIDE_VIEW_ALARMS}
                        onClick={() => {
                          const name = watchLists.find((x) => x.id === sideViewId)?.name || "";
                          setWlRenameDraft(name);
                          setWlRenameOpen(true);
                          setWlMenuOpen(false);
                          setWlManageMode(null);
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="opacity-80"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                        Rename
                      </button>
                      <button
                        type="button"
                        className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-800 disabled:opacity-40 flex items-center gap-2"
                        onClick={async () => {
                          setWlMenuOpen(false);
                          const name = window.prompt("Section name", "Section");
                          if (!name || !name.trim()) return;
                          const label = name.trim().slice(0, 40);
                          // Alarms panel: local sections
                          if (sideViewId === SIDE_VIEW_ALARMS) {
                            const maxOrder = Math.max(
                              alarmSymbols.length,
                              ...(alarmSections || []).map((s) => Number(s.sort_order) || 0),
                              0
                            );
                            const id = `asec-${Date.now()}`;
                            setAlarmSections((prev) => [
                              ...prev,
                              { id, name: label, sort_order: maxOrder + 1 },
                            ]);
                            setStatusMsg("Section added");
                            return;
                          }
                          try {
                            const { data: sess } = await supabase.auth.getSession();
                            const uid = sess?.session?.user?.id;
                            if (!uid) { setStatusMsg("Login required"); return; }
                            const maxOrder = watchItems
                              .filter((w) => w.list_id === sideViewId)
                              .reduce((m, w) => Math.max(m, Number(w.sort_order) || 0), 0);
                            const payload: Record<string, unknown> = {
                              list_id: sideViewId,
                              user_id: uid,
                              symbol: `__SECTION__:${label}`,
                              note: label,
                              sort_order: maxOrder + 1,
                            };
                            let { data, error } = await supabase
                              .from("watchlist_items")
                              .insert([payload])
                              .select("*")
                              .maybeSingle();
                            if (error) {
                              const { user_id: _u, ...rest } = payload;
                              const r2 = await supabase
                                .from("watchlist_items")
                                .insert([rest])
                                .select("*")
                                .maybeSingle();
                              data = r2.data;
                              error = r2.error;
                            }
                            if (error) {
                              const localId = `local-sec-${Date.now()}`;
                              setWatchItems((prev) => [
                                ...prev,
                                {
                                  id: localId,
                                  list_id: sideViewId,
                                  symbol: `__SECTION__:${label}`,
                                  note: label,
                                  sort_order: maxOrder + 1,
                                } as WatchItem,
                              ]);
                              setStatusMsg("Section added (local)");
                              console.warn("Add section DB error", error);
                              return;
                            }
                            if (data) {
                              setWatchItems((prev) => [...prev, data as WatchItem]);
                              setStatusMsg("Section added");
                            }
                          } catch (e) {
                            console.warn(e);
                            setStatusMsg("Add section failed");
                          }
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="opacity-80">
                          <path d="M4 7h16M4 12h10M4 17h16" />
                        </svg>
                        Add section
                      </button>
                      <button
                        type="button"
                        className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-gray-800 flex items-center gap-2"
                        onClick={() => {
                          setWlMenuOpen(false);
                          setWlManageMode((m) => (m === "delete" ? null : "delete"));
                          setStatusMsg(wlManageMode === "delete" ? "" : "Tap × on a list letter to delete");
                        }}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" className="opacity-80"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
                        Clear list
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {wlManageMode === "delete" && (
                <button
                  type="button"
                  className="text-[10px] text-gray-400 hover:text-white self-start"
                  onClick={() => setWlManageMode(null)}
                >
                  Done deleting
                </button>
              )}
              {wlRenameOpen && sideViewId !== SIDE_VIEW_ALARMS && (
                <div className="flex items-center gap-1" data-note-edit>
                  <input
                    value={wlRenameDraft}
                    onChange={(e) => setWlRenameDraft(e.target.value)}
                    className="flex-1 min-w-0 bg-gray-800 rounded px-1.5 py-0.5 text-[11px] text-gray-100 outline-none border border-gray-700"
                    placeholder="List name"
                    autoFocus
                    onKeyDown={async (e) => {
                      if (e.key === "Escape") { setWlRenameOpen(false); return; }
                      if (e.key !== "Enter") return;
                      const name = wlRenameDraft.trim();
                      if (!name) return;
                      try {
                        await supabase.from("watchlist_lists").update({ name }).eq("id", sideViewId);
                        setWatchLists((prev) =>
                          prev.map((l) => (l.id === sideViewId ? { ...l, name } : l))
                        );
                        setWlRenameOpen(false);
                        setStatusMsg("Renamed");
                      } catch {
                        setStatusMsg("Rename failed");
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="text-[10px] text-emerald-400 px-1"
                    onClick={async () => {
                      const name = wlRenameDraft.trim();
                      if (!name) return;
                      try {
                        await supabase.from("watchlist_lists").update({ name }).eq("id", sideViewId);
                        setWatchLists((prev) =>
                          prev.map((l) => (l.id === sideViewId ? { ...l, name } : l))
                        );
                        setWlRenameOpen(false);
                        setStatusMsg("Renamed");
                      } catch {
                        setStatusMsg("Rename failed");
                      }
                    }}
                  >
                    ✓
                  </button>
                  <button
                    type="button"
                    className="text-[10px] text-gray-500 px-1"
                    onClick={() => setWlRenameOpen(false)}
                  >
                    ✕
                  </button>
                </div>
              )}
            </div>
            <div className="overflow-y-auto flex-1 p-1.5">
              {sidePanelRows.map((row, rowIdx) => {
                if (row.kind === "section") {
                  const secKey = `__SEC__:${row.id}`;
                  const isDrag = draggingSym === secKey;
                  const isOver = dragOverSym === secKey && draggingSym != null && draggingSym !== secKey;
                  return (
                    <div key={`sec-${row.id}`}>
                      {isOver ? (
                        draggingSym && String(draggingSym).startsWith("__SEC__") ? (
                          <div className="h-0.5 mb-1 mx-1 rounded-full bg-orange-400/80" />
                        ) : (
                          <div className="h-8 mb-1 rounded-lg border-2 border-dashed border-orange-500/60 bg-orange-500/10" />
                        )
                      ) : null}
                      <div
                        data-sym={secKey}
                        data-item-id={row.id}
                        onPointerDown={(e) => {
                          if ((e.target as HTMLElement).closest("button,input")) return;
                          e.preventDefault();
                          try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
                          setDraggingSym(secKey);
                          setDragOverSym(null);
                        }}
                        onPointerMove={(e) => {
                          if (!draggingSym) return;
                          const el = document.elementFromPoint(e.clientX, e.clientY);
                          const rowEl = el?.closest?.("[data-sym]") as HTMLElement | null;
                          const target = rowEl?.dataset?.sym || null;
                          if (target && target !== draggingSym) setDragOverSym((prev) => (prev === target ? prev : target));
                        }}
                        onPointerUp={async () => {
                          // reuse same handler path via synthetic - fall through by calling shared logic below after state clear
                          // handled in symbol onPointerUp if we duplicate — instead trigger reorder here
                          if (!draggingSym) {
                            setDraggingSym(null);
                            setDragOverSym(null);
                            return;
                          }
                          const fromSym = draggingSym;
                          const toSym = dragOverSym;
                          setDraggingSym(null);
                          setDragOverSym(null);
                          if (!toSym || fromSym === toSym) return;

                          if (sideViewId === SIDE_VIEW_ALARMS) {
                            // rebuild ordered list of keys: symbols + sec ids
                            const keys: string[] = [];
                            sidePanelRows.forEach((r) => {
                              if (r.kind === "section") keys.push(`__SEC__:${r.id}`);
                              else keys.push(r.symbol);
                            });
                            const fromIdx = keys.indexOf(fromSym);
                            const toIdxOrig = toSym === "__END__" ? keys.length : keys.indexOf(toSym);
                            const without = keys.filter((k) => k !== fromSym);
                            let insertAt = without.length;
                            if (toSym !== "__END__") {
                              const ti = without.indexOf(toSym);
                              if (ti >= 0) {
                                // moving down → insert after target so drop position matches finger
                                insertAt = fromIdx >= 0 && fromIdx < toIdxOrig ? ti + 1 : ti;
                              }
                            }
                            without.splice(insertAt, 0, fromSym);
                            // apply: symbols order + section sort_orders
                            const newSymOrder: string[] = [];
                            const newSecs: { id: string; name: string; sort_order: number }[] = [];
                            without.forEach((k, i) => {
                              if (k.startsWith("__SEC__:")) {
                                const id = k.slice("__SEC__:".length);
                                const prev = alarmSections.find((s) => s.id === id);
                                newSecs.push({ id, name: prev?.name || "Section", sort_order: i + 1 });
                              } else {
                                newSymOrder.push(k);
                              }
                            });
                            // interleave: section sort_order is absolute index; symbols keep relative sideOrder
                            setSideOrder(newSymOrder);
                            setAlarmSections(newSecs);
                            return;
                          }

                          // watchlist: reorder items including section rows
                          const listRows = watchItems
                            .filter((w) => w.list_id === sideViewId)
                            .sort((a, b) => (a.sort_order ?? 9999) - (b.sort_order ?? 9999));
                          const fromItem = listRows.find((w) => w.id === row.id);
                          if (!fromItem) return;
                          const fromIdx = listRows.findIndex((w) => w.id === fromItem.id);
                          const without = listRows.filter((w) => w.id !== fromItem.id);
                          let insertAt = without.length;
                          if (toSym && toSym !== "__END__") {
                            let ti = -1;
                            let toIdxOrig = -1;
                            if (toSym.startsWith("__SEC__:")) {
                              const tid = toSym.slice("__SEC__:".length);
                              toIdxOrig = listRows.findIndex((w) => w.id === tid);
                              ti = without.findIndex((w) => w.id === tid);
                            } else {
                              toIdxOrig = listRows.findIndex(
                                (w) =>
                                  chartSymbol(w.symbol) === toSym &&
                                  !String(w.symbol).startsWith("__SECTION__")
                              );
                              ti = without.findIndex(
                                (w) =>
                                  chartSymbol(w.symbol) === toSym &&
                                  !String(w.symbol).startsWith("__SECTION__")
                              );
                            }
                            if (ti >= 0) {
                              insertAt = fromIdx >= 0 && fromIdx < toIdxOrig ? ti + 1 : ti;
                            }
                          }
                          const next = [...without];
                          next.splice(insertAt, 0, fromItem);
                          const withOrder = next.map((w, i) => ({ ...w, sort_order: i + 1 }));
                          setWatchItems((prev) => {
                            const others = prev.filter((w) => w.list_id !== sideViewId);
                            return [...others, ...withOrder];
                          });
                          try {
                            await Promise.all(
                              withOrder
                                .filter((w) => !String(w.id).startsWith("local-"))
                                .map((w) =>
                                  supabase
                                    .from("watchlist_items")
                                    .update({ sort_order: w.sort_order })
                                    .eq("id", w.id)
                                )
                            );
                          } catch {}
                        }}
                        onPointerCancel={() => { setDraggingSym(null); setDragOverSym(null); }}
                        className={`mb-1.5 mt-0.5 px-1 py-1 rounded-md group/sec cursor-default select-none border ${isDrag ? "opacity-40 border-orange-500/50 bg-orange-500/5 pointer-events-none" : "border-transparent hover:border-gray-700/80 hover:bg-gray-800/40"}`}
                      >
                        <div className="flex items-center gap-1 mb-0.5">
                          {secRenameId === row.id ? (
                            <input
                              value={secRenameDraft}
                              onChange={(e) => setSecRenameDraft(e.target.value)}
                              className="flex-1 min-w-0 bg-gray-800 rounded px-1 py-0.5 text-[10px] text-gray-100 outline-none border border-gray-600"
                              autoFocus
                              onClick={(e) => e.stopPropagation()}
                              onPointerDown={(e) => e.stopPropagation()}
                              onKeyDown={async (e) => {
                                if (e.key === "Escape") { setSecRenameId(null); return; }
                                if (e.key !== "Enter") return;
                                const nm = secRenameDraft.trim() || "Section";
                                if (sideViewId === SIDE_VIEW_ALARMS) {
                                  setAlarmSections((prev) =>
                                    prev.map((s) => (s.id === row.id ? { ...s, name: nm } : s))
                                  );
                                } else {
                                  setWatchItems((prev) =>
                                    prev.map((w) =>
                                      w.id === row.id
                                        ? { ...w, note: nm, symbol: `__SECTION__:${nm}` }
                                        : w
                                    )
                                  );
                                  try {
                                    if (!String(row.id).startsWith("local-")) {
                                      await supabase
                                        .from("watchlist_items")
                                        .update({ note: nm, symbol: `__SECTION__:${nm}` })
                                        .eq("id", row.id);
                                    }
                                  } catch {}
                                }
                                setSecRenameId(null);
                              }}
                              onBlur={async () => {
                                const nm = secRenameDraft.trim() || "Section";
                                if (sideViewId === SIDE_VIEW_ALARMS) {
                                  setAlarmSections((prev) =>
                                    prev.map((s) => (s.id === row.id ? { ...s, name: nm } : s))
                                  );
                                } else {
                                  setWatchItems((prev) =>
                                    prev.map((w) =>
                                      w.id === row.id
                                        ? { ...w, note: nm, symbol: `__SECTION__:${nm}` }
                                        : w
                                    )
                                  );
                                  try {
                                    if (!String(row.id).startsWith("local-")) {
                                      await supabase
                                        .from("watchlist_items")
                                        .update({ note: nm, symbol: `__SECTION__:${nm}` })
                                        .eq("id", row.id);
                                    }
                                  } catch {}
                                }
                                setSecRenameId(null);
                              }}
                            />
                          ) : (
                            <button
                              type="button"
                              title="Click to rename"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSecRenameId(row.id);
                                setSecRenameDraft(row.name);
                              }}
                              onPointerDown={(e) => e.stopPropagation()}
                              className="text-[10px] font-medium text-gray-300 hover:text-orange-300 truncate flex-1 text-left py-0.5 rounded px-0.5 hover:bg-gray-800/80"
                            >
                              {row.name}
                            </button>
                          )}
                          <button
                            type="button"
                            title="Remove section"
                            onClick={async (e) => {
                              e.stopPropagation();
                              if (sideViewId === SIDE_VIEW_ALARMS) {
                                setAlarmSections((prev) => prev.filter((s) => s.id !== row.id));
                                return;
                              }
                              setWatchItems((prev) => prev.filter((w) => w.id !== row.id));
                              try {
                                if (!String(row.id).startsWith("local-")) {
                                  await supabase.from("watchlist_items").delete().eq("id", row.id);
                                }
                              } catch {}
                            }}
                            onPointerDown={(e) => e.stopPropagation()}
                            className="text-gray-600 hover:text-red-400 text-[10px] opacity-0 group-hover/sec:opacity-100 px-0.5"
                          >
                            ×
                          </button>
                        </div>
                        <div className="border-t border-dashed border-gray-600/80" />
                      </div>
                    </div>
                  );
                }
                const sym = row.symbol;
                const isDrag = draggingSym === sym;
                const isOver = dragOverSym === sym && draggingSym != null && draggingSym !== sym;
                return (
                  <div key={`${sym}-${row.itemId || rowIdx}`}>
                    {isOver ? (
                      draggingSym && String(draggingSym).startsWith("__SEC__") ? (
                        <div className="h-0.5 mb-1 mx-1 rounded-full bg-orange-400/80" />
                      ) : (
                        <div className="h-8 mb-1 rounded-lg border-2 border-dashed border-orange-500/60 bg-orange-500/10" />
                      )
                    ) : null}
                    <div
                      data-sym={sym}
                      data-item-id={row.itemId || ""}
                      onPointerDown={(e) => {
                        if ((e.target as HTMLElement).closest("button")) return;
                        e.preventDefault();
                        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch {}
                        setDraggingSym(sym);
                        setDragOverSym(null);
                      }}
                      onPointerMove={(e) => {
                        if (!draggingSym) return;
                        const el = document.elementFromPoint(e.clientX, e.clientY);
                        const rowEl = el?.closest?.("[data-sym]") as HTMLElement | null;
                        const target = rowEl?.dataset?.sym || null;
                        if (target && target !== draggingSym) setDragOverSym((prev) => (prev === target ? prev : target));
                      }}
                      onPointerUp={async () => {
                        if (!draggingSym) {
                          setDraggingSym(null);
                          setDragOverSym(null);
                          return;
                        }
                        const fromSym = draggingSym;
                        const toSym = dragOverSym;
                        setDraggingSym(null);
                        setDragOverSym(null);
                        if (!toSym || fromSym === toSym) return;

                        if (sideViewId === SIDE_VIEW_ALARMS) {
                          const keys: string[] = [];
                          sidePanelRows.forEach((r) => {
                            if (r.kind === "section") keys.push(`__SEC__:${r.id}`);
                            else keys.push(r.symbol);
                          });
                          if (!keys.includes(fromSym)) keys.push(fromSym);
                          const fromIdx = keys.indexOf(fromSym);
                          const toIdxOrig = toSym === "__END__" ? keys.length : keys.indexOf(toSym);
                          const without = keys.filter((k) => k !== fromSym);
                          let insertAt = without.length;
                          if (toSym && toSym !== "__END__") {
                            const ti = without.indexOf(toSym);
                            if (ti >= 0) {
                              insertAt = fromIdx >= 0 && fromIdx < toIdxOrig ? ti + 1 : ti;
                            }
                          }
                          without.splice(insertAt, 0, fromSym);
                          const newSymOrder: string[] = [];
                          const newSecs: { id: string; name: string; sort_order: number }[] = [];
                          without.forEach((k, i) => {
                            if (k.startsWith("__SEC__:")) {
                              const id = k.slice("__SEC__:".length);
                              const prev = alarmSections.find((s) => s.id === id);
                              newSecs.push({ id, name: prev?.name || "Section", sort_order: i + 1 });
                            } else {
                              newSymOrder.push(k);
                            }
                          });
                          setSideOrder(newSymOrder);
                          setAlarmSections(newSecs);
                          return;
                        }

                        const listRows = watchItems
                          .filter((w) => w.list_id === sideViewId)
                          .sort((a, b) => (a.sort_order ?? 9999) - (b.sort_order ?? 9999));
                        const fromItem = listRows.find(
                          (w) =>
                            chartSymbol(w.symbol) === fromSym &&
                            !String(w.symbol).startsWith("__SECTION__")
                        );
                        if (!fromItem) return;
                        const fromIdx = listRows.findIndex((w) => w.id === fromItem.id);
                        const without = listRows.filter((w) => w.id !== fromItem.id);
                        let insertAt = without.length;
                        if (toSym && toSym !== "__END__") {
                          let ti = -1;
                          let toIdxOrig = -1;
                          if (toSym.startsWith("__SEC__:")) {
                            const tid = toSym.slice("__SEC__:".length);
                            toIdxOrig = listRows.findIndex((w) => w.id === tid);
                            ti = without.findIndex((w) => w.id === tid);
                          } else {
                            toIdxOrig = listRows.findIndex(
                              (w) =>
                                chartSymbol(w.symbol) === toSym &&
                                !String(w.symbol).startsWith("__SECTION__")
                            );
                            ti = without.findIndex(
                              (w) =>
                                chartSymbol(w.symbol) === toSym &&
                                !String(w.symbol).startsWith("__SECTION__")
                            );
                          }
                          if (ti >= 0) {
                            insertAt = fromIdx >= 0 && fromIdx < toIdxOrig ? ti + 1 : ti;
                          }
                        }
                        const next = [...without];
                        next.splice(insertAt, 0, fromItem);
                        const withOrder = next.map((w, i) => ({ ...w, sort_order: i + 1 }));
                        setWatchItems((prev) => {
                          const others = prev.filter((w) => w.list_id !== sideViewId);
                          return [...others, ...withOrder];
                        });
                        try {
                          await Promise.all(
                            withOrder
                              .filter((w) => !String(w.id).startsWith("local-"))
                              .map((w) =>
                                supabase
                                  .from("watchlist_items")
                                  .update({ sort_order: w.sort_order })
                                  .eq("id", w.id)
                              )
                          );
                        } catch {}
                      }}
                      onPointerCancel={() => { setDraggingSym(null); setDragOverSym(null); }}
                      onPointerUp={(e) => {
                        if (draggingSym) return;
                        // Ignore if this was a drag (moved more than a few px)
                        e.stopPropagation();
                        goToSymbol(sym);
                      }}
                      onClick={(e) => {
                        // Fallback for mouse; prevent double-fire after pointerup
                        if (draggingSym) return;
                        e.preventDefault();
                      }}
                      className={`group flex items-center gap-1.5 px-1.5 py-1.5 mb-0.5 rounded-lg text-[11px] select-none cursor-pointer touch-manipulation ${
                        isDrag
                          ? "opacity-40 pointer-events-none"
                          : symbolUpper === sym
                            ? "bg-orange-500/15 ring-1 ring-orange-500/40"
                            : "hover:bg-gray-800/80"
                      }`}
                    >
                      <span
                        className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-semibold shrink-0 border"
                        style={{
                          background:
                            symbolUpper === sym ? "rgba(249,115,22,0.18)" : "rgba(75,85,99,0.45)",
                          borderColor:
                            symbolUpper === sym ? "rgba(249,115,22,0.45)" : "rgba(107,114,128,0.55)",
                          color: symbolUpper === sym ? "#fdba74" : "#9ca3af",
                        }}
                      >
                        {(sym || "?").replace(/USDT$|USD$|PERP$/i, "").slice(0, 2)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium text-gray-200 truncate leading-tight">{sym.replace(/USDT$/i, "")}</div>
                        <div className="text-[9px] text-gray-500 truncate leading-tight">
                          {(alarmCountBySym[sym] || 0) > 0 ? `${alarmCountBySym[sym]} alarm` : "0 alarm"}
                          {(lineCountBySym[sym] || 0) > 0 ? ` · ${lineCountBySym[sym]} line` : ""}
                        </div>
                      </div>
                      <button
                        type="button"
                        title="Remove from list"
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          void (async () => {
                            const s = sym;
                            if (sideViewId === SIDE_VIEW_ALARMS) {
                              setSideOrder((prev) => {
                                const base = (prev.length ? prev : alarmSymbols).filter((x) => x !== s);
                                return base;
                              });
                              return;
                            }
                            const itemId = row.itemId;
                            if (itemId) {
                              setWatchItems((prev) => prev.filter((w) => w.id !== itemId));
                              try {
                                if (!String(itemId).startsWith("local-")) {
                                  await supabase.from("watchlist_items").delete().eq("id", itemId);
                                }
                              } catch {}
                              return;
                            }
                            const item = watchItems.find(
                              (w) => w.list_id === sideViewId && chartSymbol(w.symbol) === s
                            );
                            if (!item) return;
                            setWatchItems((prev) => prev.filter((w) => w.id !== item.id));
                            try {
                              await supabase.from("watchlist_items").delete().eq("id", item.id);
                            } catch {}
                          })();
                        }}
                        onPointerDown={(e) => e.stopPropagation()}
                        className="shrink-0 w-3.5 h-3.5 flex items-center justify-center rounded text-red-500/90 hover:bg-red-500/25 hover:text-red-400 text-[11px] leading-none opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                );
              })}
              {draggingSym ? (
                <div
                  data-sym="__END__"
                  onPointerEnter={() => setDragOverSym("__END__")}
                  className={
                    String(draggingSym).startsWith("__SEC__")
                      ? `h-1 mt-1 mx-1 rounded-full ${
                          dragOverSym === "__END__" ? "bg-orange-400" : "bg-gray-700"
                        }`
                      : `h-10 mt-1 rounded-lg border-2 border-dashed flex items-center justify-center text-[10px] ${
                          dragOverSym === "__END__"
                            ? "border-orange-500 bg-orange-500/15 text-orange-300"
                            : "border-gray-700 text-gray-600"
                        }`
                  }
                >
                  {String(draggingSym).startsWith("__SEC__") ? null : "Drop at end"}
                </div>
              ) : null}
              {!sidePanelRows.length && (
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
      <div className="mt-4 grid grid-cols-1 lg:grid-cols-[1.15fr_1.15fr_0.7fr] gap-4">
        <div>
          <h3 className="text-sm font-medium text-green-400 mb-2">
            Alarms — <span className="text-gray-400 font-normal">{symbolUpper}</span>{" "}
            <span className="text-gray-500">({currentAlarms.length})</span>
          </h3>
          <div className="space-y-1.5">
            {currentAlarms.map((a) => (
              <div
                key={a.id}
                className={`bg-gray-900 border rounded-lg px-3 py-2 ${
                  movingId === a.id && movingType === "alarm"
                    ? "border-dashed border-gray-400 ring-1 ring-gray-500/40"
                    : "border-gray-800"
                }`}
              >
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-mono font-medium shrink-0" style={{ color: a.color || DEFAULT_ALARM_COLOR }}>
                    {isDiagonalLine(a)
                      ? `↗ ${formatPrice(a.price)}→${formatPrice(Number(a.end_price))}`
                      : formatPrice(a.price)}
                  </span>
                  {/* Condition next to price */}
                  <div className="relative shrink-0" data-menu>
                    <button
                      type="button"
                      onClick={() => setOpenMenu(openMenu === `a-cond-${a.id}` ? null : `a-cond-${a.id}`)}
                      className={`px-1 py-0.5 rounded border text-[10px] transition-all ${
                        openMenu === `a-cond-${a.id}`
                          ? "bg-orange-500 text-black border-orange-400"
                          : "bg-gray-900/95 border-gray-600 text-gray-300"
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
                  {/* Note centered — click to edit */}
                  <div className="flex-1 flex justify-center min-w-0 px-1" data-note-edit>
                    {editingNoteId === a.id && editingNoteType === "alarm" ? (
                      <input
                        value={noteDraft}
                        onChange={(e) => setNoteDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void saveNote(); }
                          if (e.key === "Escape") { setEditingNoteId(null); setEditingNoteType(null); }
                        }}
                        className="w-full max-w-[140px] bg-gray-800 rounded px-2 py-0.5 text-xs text-center text-gray-100 outline-none border border-gray-600"
                        placeholder="Note..."
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingNoteId(a.id);
                          setEditingNoteType("alarm");
                          setNoteDraft(userFacingNote(a.note) || "");
                        }}
                        className="text-xs truncate max-w-full px-1 text-center text-gray-400 hover:text-white"
                        title="Note"
                      >
                        {a.note && !String(a.note).startsWith("__diag:") && !String(a.note).startsWith("__ray:") && userFacingNote(a.note)
                          ? userFacingNote(a.note)
                          : "Note"}
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 justify-end shrink-0">
                    {/* Color — palette popup (desktop) + native picker */}
                    <div className="relative" data-menu>
                      <button
                        type="button"
                        title="Color"
                        onClick={() => setOpenMenu(openMenu === `a-color-${a.id}` ? null : `a-color-${a.id}`)}
                        className="w-6 h-6 rounded-full border-2 border-gray-500 shadow shrink-0 hover:scale-110 transition-transform"
                        style={{ background: a.color || DEFAULT_ALARM_COLOR }}
                      />
                      {openMenu === `a-color-${a.id}` && (
                        <div
                          className="absolute z-50 bottom-full mb-2 right-0 p-3 rounded-2xl border border-white/20 shadow-[0_12px_48px_rgba(0,0,0,0.55)] isolate min-w-[200px]"
                          style={{
                            animation: "tfPop 0.22s cubic-bezier(0.34,1.3,0.64,1)",
                            background: "rgba(22,22,26,0.92)",
                            backdropFilter: "blur(28px) saturate(180%)",
                            WebkitBackdropFilter: "blur(28px) saturate(180%)",
                          }}
                        >
                          <div className="text-[10px] text-gray-400 mb-2 font-medium tracking-wide">Colors</div>
                          <div className="grid grid-cols-5 gap-1.5 mb-3">
                            {["#ef4444","#f97316","#eab308","#22c55e","#14b8a6","#3b82f6","#6366f1","#a855f7","#ec4899","#f43f5e","#ffffff","#94a3b8","#64748b","#0ea5e9","#84cc16"].map((c) => (
                              <button
                                key={c}
                                type="button"
                                onClick={() => { pushUndo(); updateAlarmColor(a.id, c); setOpenMenu(null); }}
                                className={`w-7 h-7 rounded-lg border transition-transform hover:scale-110 ${
                                  (a.color || DEFAULT_ALARM_COLOR).toLowerCase() === c.toLowerCase()
                                    ? "border-orange-400 ring-2 ring-orange-400/40"
                                    : "border-white/10"
                                }`}
                                style={{ background: c }}
                              />
                            ))}
                          </div>
                          <label className="flex items-center gap-2 text-[11px] text-gray-300 cursor-pointer">
                            <span className="relative w-7 h-7 rounded-lg overflow-hidden border border-white/20 shrink-0">
                              <input
                                type="color"
                                value={a.color || DEFAULT_ALARM_COLOR}
                                onChange={(e) => { pushUndo(); updateAlarmColor(a.id, e.target.value); }}
                                className="absolute -top-1 -left-1 w-10 h-10 cursor-pointer border-0 p-0"
                              />
                            </span>
                            Custom color
                          </label>
                        </div>
                      )}
                    </div>
                    {/* Style = width + dash in one icon */}
                    <div className="relative" data-menu>
                      <button
                        type="button"
                        title="Line style"
                        onClick={() => setOpenMenu(openMenu === `a-style-${a.id}` ? null : `a-style-${a.id}`)}
                        className={`w-7 h-7 rounded-md border flex items-center justify-center text-[10px] transition-all ${
                          openMenu === `a-style-${a.id}`
                            ? "bg-orange-500 text-black border-orange-400"
                            : "bg-gray-900/95 border-gray-600 text-gray-200 hover:bg-white/10"
                        }`}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <line x1="4" y1="12" x2="20" y2="12" strokeDasharray={a.dash === "dashed" ? "4 3" : "0"} strokeWidth={a.width || 2} />
                        </svg>
                      </button>
                      {openMenu === `a-style-${a.id}` && (
                        <div className="absolute z-50 bottom-full mb-1 right-0 border border-white/20 rounded-2xl py-1.5 shadow-[0_8px_40px_rgba(0,0,0,0.5)] overflow-hidden isolate min-w-[130px]" style={{
                          animation: "tfPop 0.28s cubic-bezier(0.34,1.3,0.64,1)",
                          background: "rgba(20,20,22,0.92)",
                          backdropFilter: "blur(24px)",
                        }}>
                          <div className="text-[10px] text-gray-500 px-3 py-0.5">Width</div>
                          {LINE_WIDTHS.map((w) => (
                            <button key={w} type="button"
                              onClick={() => { pushUndo(); updateAlarmWidth(a.id, w); setOpenMenu(null); }}
                              className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-white/10 ${(a.width || 2) === w ? "text-orange-300" : "text-gray-200"}`}
                            >
                              <span className="w-3 text-orange-400">{(a.width || 2) === w ? "✓" : ""}</span>
                              W{w}
                            </button>
                          ))}
                          <div className="border-t border-white/10 my-1" />
                          <div className="text-[10px] text-gray-500 px-3 py-0.5">Style</div>
                          {(["solid", "dashed"] as const).map((d) => (
                            <button key={d} type="button"
                              onClick={() => { pushUndo(); updateAlarmDash(a.id, d); setOpenMenu(null); }}
                              className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-white/10 ${(a.dash === "dashed" ? "dashed" : "solid") === d ? "text-orange-300" : "text-gray-200"}`}
                            >
                              <span className="w-3 text-orange-400">{(a.dash === "dashed" ? "dashed" : "solid") === d ? "✓" : ""}</span>
                              {d === "solid" ? "—— Solid" : "- - Dash"}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
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
                            if (chartContainerRef.current) chartContainerRef.current.style.touchAction = "none";
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
                                autoscaleInfoProvider: () => null as any,
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
                    <button type="button" title="Delete" onClick={() => deleteAlarm(a.id)} className="w-5 h-5 flex items-center justify-center rounded text-red-500 hover:bg-red-500/20 text-sm leading-none">×</button>
                  </div>
                </div>
              </div>
            ))}
            {!currentAlarms.length && <p className="text-gray-600 text-sm">No alarms</p>}
          </div>
        </div>

        <div>
          <h3 className="text-sm font-medium text-orange-400 mb-2">
            Lines — <span className="text-gray-400 font-normal">{symbolUpper}</span>{" "}
            <span className="text-gray-500">({currentLines.length})</span>
          </h3>
          <div className="space-y-1.5">
            {currentLines.map((l) => (
              <div
                key={l.id}
                className={`bg-gray-900 border rounded-lg px-3 py-2 ${
                  movingId === l.id && movingType === "line"
                    ? "border-dashed border-gray-400 ring-1 ring-gray-500/40"
                    : "border-gray-800"
                }`}
              >
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-mono font-medium shrink-0" style={{ color: l.color || DEFAULT_LINE_COLOR }}>
                    {l.note === "__vline__"
                      ? "Vertical"
                      : isDiagonalLine(l)
                      ? `↗ ${formatPrice(l.price)}→${formatPrice(Number(l.end_price))}`
                      : formatPrice(l.price)}
                    {isDiagonalLine(l) ? <span className="text-[10px] text-orange-400/80 ml-1">Diag</span> : null}
                    {l.note === "__vline__" ? <span className="text-[10px] text-orange-400/80 ml-1">V</span> : null}
                  </span>
                  <div className="flex-1 flex justify-center min-w-0 px-1" data-note-edit>
                    {editingNoteId === l.id && editingNoteType === "line" ? (
                      <input
                        value={noteDraft}
                        onChange={(e) => setNoteDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void saveNote(); }
                          if (e.key === "Escape") { setEditingNoteId(null); setEditingNoteType(null); }
                        }}
                        className="w-full max-w-[140px] bg-gray-800 rounded px-2 py-0.5 text-xs text-center text-gray-100 outline-none border border-gray-600"
                        placeholder="Note..."
                        autoFocus
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingNoteId(l.id);
                          setEditingNoteType("line");
                          setNoteDraft(userFacingNote(l.note) || "");
                        }}
                        className="text-xs truncate max-w-full px-1 text-center text-gray-400 hover:text-white"
                        title="Note"
                      >
                        {l.note && l.note !== "__vline__" && !String(l.note).startsWith("__diag:") && !String(l.note).startsWith("__ray:") && userFacingNote(l.note)
                          ? userFacingNote(l.note)
                          : "Note"}
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 justify-end shrink-0">
                    {/* Color — palette popup (desktop) + native picker */}
                    <div className="relative" data-menu>
                      <button
                        type="button"
                        title="Color"
                        onClick={() => setOpenMenu(openMenu === `l-color-${l.id}` ? null : `l-color-${l.id}`)}
                        className="w-6 h-6 rounded-full border-2 border-gray-500 shadow shrink-0 hover:scale-110 transition-transform"
                        style={{ background: l.color || DEFAULT_LINE_COLOR }}
                      />
                      {openMenu === `l-color-${l.id}` && (
                        <div
                          className="absolute z-50 bottom-full mb-2 right-0 p-3 rounded-2xl border border-white/20 shadow-[0_12px_48px_rgba(0,0,0,0.55)] isolate min-w-[200px]"
                          style={{
                            animation: "tfPop 0.22s cubic-bezier(0.34,1.3,0.64,1)",
                            background: "rgba(22,22,26,0.92)",
                            backdropFilter: "blur(28px) saturate(180%)",
                            WebkitBackdropFilter: "blur(28px) saturate(180%)",
                          }}
                        >
                          <div className="text-[10px] text-gray-400 mb-2 font-medium tracking-wide">Colors</div>
                          <div className="grid grid-cols-5 gap-1.5 mb-3">
                            {["#ef4444","#f97316","#eab308","#22c55e","#14b8a6","#3b82f6","#6366f1","#a855f7","#ec4899","#f43f5e","#ffffff","#94a3b8","#64748b","#0ea5e9","#84cc16"].map((c) => (
                              <button
                                key={c}
                                type="button"
                                onClick={() => { pushUndo(); updateLineColor(l.id, c); setOpenMenu(null); }}
                                className={`w-7 h-7 rounded-lg border transition-transform hover:scale-110 ${
                                  (l.color || DEFAULT_LINE_COLOR).toLowerCase() === c.toLowerCase()
                                    ? "border-orange-400 ring-2 ring-orange-400/40"
                                    : "border-white/10"
                                }`}
                                style={{ background: c }}
                              />
                            ))}
                          </div>
                          <label className="flex items-center gap-2 text-[11px] text-gray-300 cursor-pointer">
                            <span className="relative w-7 h-7 rounded-lg overflow-hidden border border-white/20 shrink-0">
                              <input
                                type="color"
                                value={l.color || DEFAULT_LINE_COLOR}
                                onChange={(e) => { pushUndo(); updateLineColor(l.id, e.target.value); }}
                                className="absolute -top-1 -left-1 w-10 h-10 cursor-pointer border-0 p-0"
                              />
                            </span>
                            Custom color
                          </label>
                        </div>
                      )}
                    </div>
                    {/* Style = width + dash */}
                    <div className="relative" data-menu>
                      <button
                        type="button"
                        title="Line style"
                        onClick={() => setOpenMenu(openMenu === `l-style-${l.id}` ? null : `l-style-${l.id}`)}
                        className={`w-7 h-7 rounded-md border flex items-center justify-center transition-all ${
                          openMenu === `l-style-${l.id}`
                            ? "bg-orange-500 text-black border-orange-400"
                            : "bg-gray-900/95 border-gray-600 text-gray-200 hover:bg-white/10"
                        }`}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <line x1="4" y1="12" x2="20" y2="12" strokeDasharray={(l.dash || l.style) === "dashed" ? "4 3" : "0"} strokeWidth={l.width || 2} />
                        </svg>
                      </button>
                      {openMenu === `l-style-${l.id}` && (
                        <div className="absolute z-50 bottom-full mb-1 right-0 border border-white/20 rounded-2xl py-1.5 shadow-[0_8px_40px_rgba(0,0,0,0.5)] overflow-hidden isolate min-w-[130px]" style={{
                          animation: "tfPop 0.28s cubic-bezier(0.34,1.3,0.64,1)",
                          background: "rgba(20,20,22,0.92)",
                          backdropFilter: "blur(24px)",
                        }}>
                          <div className="text-[10px] text-gray-500 px-3 py-0.5">Width</div>
                          {LINE_WIDTHS.map((w) => (
                            <button key={w} type="button"
                              onClick={() => { pushUndo(); updateLineWidth(l.id, w); setOpenMenu(null); }}
                              className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-white/10 ${(l.width || 2) === w ? "text-orange-300" : "text-gray-200"}`}
                            >
                              <span className="w-3 text-orange-400">{(l.width || 2) === w ? "✓" : ""}</span>
                              W{w}
                            </button>
                          ))}
                          <div className="border-t border-white/10 my-1" />
                          <div className="text-[10px] text-gray-500 px-3 py-0.5">Style</div>
                          {(["solid", "dashed"] as const).map((d) => (
                            <button key={d} type="button"
                              onClick={() => { pushUndo(); updateLineDash(l.id, d); setOpenMenu(null); }}
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
                    <button
                      type="button"
                      onClick={() => {
                        setMode("move");
                        setMovingId(l.id);
                        setMovingType("line");
                        const isArrowL =
                          typeof l.note === "string" &&
                          (l.note === "__arrow_up__" ||
                            l.note === "__arrow_down__" ||
                            l.note === "__arrow_marker__" ||
                            l.note.startsWith("__arrow"));
                        const isRayNote =
                          typeof l.note === "string" && l.note.startsWith("__ray:");
                        const isV =
                          !isArrowL &&
                          !isRayNote &&
                          (l.note === "__vline__" ||
                            (typeof l.note === "string" && l.note.startsWith("__vline__:")) ||
                            (l.start_time != null &&
                              l.end_time != null &&
                              Number(l.start_time) === Number(l.end_time) &&
                              l.end_price != null &&
                              !isDiagonalLine(l)));
                        movingVLineRef.current = !!isV;
                        // Ray / arrow: can move in time + price (left-right and up-down)
                        movingRayRef.current =
                          !isV &&
                          (isArrowL ||
                            isRayNote ||
                            (l.start_time != null && !isDiagonalLine(l)));
                        if (isDiagonalLine(l)) {
                          movingRayRef.current = false;
                          movingVLineRef.current = false;
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
                            if (chartContainerRef.current) chartContainerRef.current.style.touchAction = "none";
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
                                autoscaleInfoProvider: () => null as any,
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
                    <button type="button" title="Delete" onClick={() => deleteLine(l.id)} className="w-5 h-5 flex items-center justify-center rounded text-red-500 hover:bg-red-500/20 text-sm leading-none">×</button>
                  </div>
                </div>
              </div>
            ))}
            {!currentLines.length && <p className="text-gray-600 text-sm">No lines</p>}
          </div>
        </div>

        {/* Alarm history for current symbol */}
        <div>
          <div className="flex flex-wrap items-center gap-1.5 mb-2 min-h-[32px]">
            <button
              type="button"
              onClick={() => setHistoryMode("coin")}
              className={`text-sm font-medium px-2.5 py-1 rounded-full border transition-colors shrink-0 touch-manipulation ${
                historyMode === "coin"
                  ? "text-orange-300/90 border-orange-500/50 bg-orange-500/15"
                  : "text-gray-500 border-gray-600 hover:text-gray-300 hover:border-gray-500"
              }`}
            >
              History — {symbolUpper}
            </button>
            <button
              type="button"
              title="All history"
              onClick={() => setHistoryMode("all")}
              className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors touch-manipulation ${
                historyMode === "all"
                  ? "text-orange-300/90 border-orange-500/50 bg-orange-500/15"
                  : "text-gray-500 border-gray-600 bg-transparent hover:text-gray-300 hover:border-gray-500"
              }`}
            >
              All History
            </button>
            <span className="text-xs text-gray-600">({historyAlarms.length})</span>
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
                className="ml-auto text-[11px] text-red-400 hover:text-red-300 px-2.5 py-1 rounded border border-red-900/50 touch-manipulation"
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
                  className="bg-gray-950 border border-gray-800/80 rounded-md px-2 py-2 text-xs cursor-pointer hover:border-amber-600/50 touch-manipulation active:bg-gray-900"
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
                            const past = Math.min(500, bars);
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
                    <span className="text-[10px] font-semibold text-gray-400 shrink-0">
                      {chartSymbol(a.symbol)}
                    </span>
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
                      onClick={async (e) => {
                        e.stopPropagation();
                        setAlarms((prev) => prev.filter((x) => x.id !== a.id));
                        try {
                          await supabase.from("alarms").delete().eq("id", a.id);
                        } catch {}
                      }}
                      className="text-gray-600 hover:text-red-400 text-xs leading-none px-1 shrink-0"
                    >
                      ×
                    </button>
                  </div>
                  <div className="text-[11px] text-gray-500 mt-0.5 text-center truncate">
                    {a.note && !String(a.note).startsWith("__diag:") && !String(a.note).startsWith("__ray:")
                      ? userFacingNote(a.note)
                      : formatAlarmDate(when)}
                  </div>
                  <div className="mt-1 flex justify-center">
                    <button
                      type="button"
                      title="Restore to active alarms"
                      onClick={async (e) => {
                        e.stopPropagation();
                        try {
                          pushUndo();
                          await supabase
                            .from("alarms")
                            .update({ triggered: false, triggered_at: null, is_active: true })
                            .eq("id", a.id);
                          setAlarms((prev) =>
                            prev.map((x) =>
                              x.id === a.id
                                ? { ...x, triggered: false, triggered_at: null, is_active: true }
                                : x
                            )
                          );
                          setStatusMsg("Alarm restored");
                        } catch {
                          setStatusMsg("Restore failed");
                        }
                      }}
                      className="text-[10px] text-orange-400/70 hover:text-orange-300 px-2 py-0.5 rounded border border-orange-800/40 hover:border-orange-600/50 bg-orange-500/5"
                    >
                      ↩ Restore
                    </button>
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

"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createChart, ISeriesApi } from "lightweight-charts";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import type { User, Session } from "@supabase/supabase-js";

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

interface SearchHit {
  symbol: string;
  baseCoin?: string;
  quoteCoin?: string;
  market: "Spot" | "Futures";
  exchange?: string;
}

const TIMEFRAMES = [
  { label: "1m", value: "1" },
  { label: "5m", value: "5" },
  { label: "15m", value: "15" },
  { label: "1h", value: "60" },
  { label: "4h", value: "240" },
  { label: "1D", value: "D" },
  { label: "1W", value: "W" },
  { label: "1M", value: "M" },
];

type ViewMode = "grid" | "list";

/** DB unique is (list_id, symbol) — encode exchange in symbol: BTCUSDT@BINANCE */
function storageSymbol(sym: string, exchange?: string) {
  // نماد + صرافی (اگر هست) تا فقط همان ردیف اد شود نه همهٔ صرافی‌ها
  const s = String(sym || "").toUpperCase().trim();
  const bare = s.split("@")[0].replace(/[^A-Z0-9]/g, "");
  const ex = (exchange || (s.includes("@") ? s.split("@")[1] : "") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return ex ? `${bare}@${ex}` : bare;
}
function bareSymbol(stored: string) {
  return stored.split("@")[0].toUpperCase();
}
function storedExchange(stored: string): string | null {
  const p = stored.split("@");
  return p.length > 1 ? p[1] : null;
}

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

function formatPrice(p: number) {
  if (p >= 1000) return p.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.01) return p.toFixed(5);
  return p.toFixed(6);
}

function formatPct(pct: number) {
  const sign = pct > 0 ? "+" : "";
  return `${sign}${(pct * 100).toFixed(2)}%`;
}

function intervalToSeconds(iv: string): number {
  if (iv === "D") return 86400;
  if (iv === "W") return 604800;
  if (iv === "M") return 2592000;
  const n = parseInt(iv, 10);
  return Number.isNaN(n) ? 3600 : n * 60;
}

/** Countdown to candle close — same as main Charts page */
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

function baseFromSymbol(symbol: string) {
  const s = symbol.toUpperCase();
  const quotes = ["USDT", "USDC", "USD", "BTC", "ETH", "BUSD", "DAI"];
  for (const q of quotes) {
    if (s.endsWith(q) && s.length > q.length) return s.slice(0, -q.length).toLowerCase();
  }
  return s.toLowerCase();
}

function CoinIcon({ symbol, size = 28 }: { symbol: string; size?: number }) {
  const base = baseFromSymbol(symbol);
  const [err, setErr] = useState(false);
  const letter = (base[0] || "?").toUpperCase();
  const colors = [
    "bg-orange-600",
    "bg-blue-600",
    "bg-green-600",
    "bg-purple-600",
    "bg-pink-600",
    "bg-cyan-600",
    "bg-amber-600",
    "bg-indigo-600",
  ];
  const color = colors[letter.charCodeAt(0) % colors.length];

  if (err) {
    return (
      <div
        className={`${color} rounded-full flex items-center justify-center text-white font-bold shrink-0`}
        style={{ width: size, height: size, fontSize: size * 0.4 }}
      >
        {letter}
      </div>
    );
  }

  return (
    <img
      src={`https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/svg/color/${base}.svg`}
      alt={base}
      width={size}
      height={size}
      className="rounded-full shrink-0 bg-gray-800 object-contain"
      onError={() => setErr(true)}
      draggable={false}
    />
  );
}

function MiniChart({
  symbol,
  interval,
  pct,
  candleMode = false,
}: {
  symbol: string;
  interval: string;
  pct?: number | null;
  candleMode?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = "";

    const isUp = pct != null && !Number.isNaN(pct) && pct >= 0;
    const isDown = pct != null && !Number.isNaN(pct) && pct < 0;
    const lineColor = isUp ? "#22c55e" : isDown ? "#ef4444" : "#f97316";
    const topColor = isUp
      ? "rgba(34,197,94,0.35)"
      : isDown
      ? "rgba(239,68,68,0.35)"
      : "rgba(249,115,22,0.35)";
    const bottomColor = isUp
      ? "rgba(34,197,94,0.02)"
      : isDown
      ? "rgba(239,68,68,0.02)"
      : "rgba(249,115,22,0.02)";

    const chart = createChart(ref.current, {
      width: ref.current.clientWidth || 160,
      height: 96,
      layout: {
        background: { color: "transparent" },
        textColor: "#6b7280",
        attributionLogo: false as any,
      },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { visible: false },
      timeScale: { visible: false },
      crosshair: { mode: 0 },
      handleScroll: false,
      handleScale: false,
    });

    (async () => {
      try {
        const res = await fetch(
          `/api/kline?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=60`
        );
        const json = await res.json();
        const list = Array.isArray(json) ? json : json?.data || json?.result?.list || [];
        if (!list?.length) return;
        if (candleMode) {
          const series = chart.addCandlestickSeries({
            upColor: "#22c55e",
            downColor: "#ef4444",
            borderVisible: false,
            wickUpColor: "#22c55e",
            wickDownColor: "#ef4444",
            priceLineVisible: false,
            lastValueVisible: false,
          });
          const rows = list
            .map((item: any) => ({
              time: typeof item.time === "number" ? item.time : Math.floor(Number(item[0] || item.time) / (Number(item[0]) > 1e12 ? 1000 : 1)),
              open: Number(item.open ?? item[1]),
              high: Number(item.high ?? item[2]),
              low: Number(item.low ?? item[3]),
              close: Number(item.close ?? item.value ?? item[4]),
            }))
            .filter((r: any) => r.time && Number.isFinite(r.close));
          series.setData(rows as any);
        } else {
          const series = chart.addAreaSeries({
            lineColor,
            topColor,
            bottomColor,
            lineWidth: 2,
            priceLineVisible: false,
            lastValueVisible: false,
            crosshairMarkerVisible: false,
          });
          const rows = list
            .map((item: any) => ({
              time: typeof item.time === "number" ? item.time : Math.floor(Number(item[0] || item.time) / (Number(item[0]) > 1e12 ? 1000 : 1)),
              value: Number(item.value ?? item.close ?? item[4]),
            }))
            .filter((r: any) => r.time && Number.isFinite(r.value));
          series.setData(rows as any);
        }
        chart.timeScale().fitContent();
      } catch {}
    })();

    return () => {
      chart.remove();
    };
  }, [symbol, interval, pct, candleMode]);

  return <div ref={ref} className="w-full h-24 pointer-events-none" />;
}

function DetailChart({
  symbol,
  interval,
  lineMode,
}: {
  symbol: string;
  interval: string;
  lineMode: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof createChart> | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lineRef = useRef<ISeriesApi<"Area"> | null>(null);
  const lastBarTimeRef = useRef<number | null>(null);
  const priceLineRef = useRef<any>(null);
  const fittedRef = useRef(false);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = "";
    candleRef.current = null;
    lineRef.current = null;
    priceLineRef.current = null;
    lastBarTimeRef.current = null;
    fittedRef.current = false;

    const chart = createChart(ref.current, {
      width: ref.current.clientWidth,
      height: Math.max(520, Math.floor(window.innerHeight * 0.55)),
      layout: {
        background: { color: "#0f0f0f" },
        textColor: "#d1d5db",
        attributionLogo: false as any,
      },
      grid: {
        vertLines: { color: "#1f2937" },
        horzLines: { color: "#1f2937" },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.06, bottom: 0.18 },
        autoScale: true,
      },
      timeScale: {
        borderVisible: true,
        borderColor: "#2a2e39",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 40,
        barSpacing: 6,
        minBarSpacing: 0.5,
        fixLeftEdge: false,
        fixRightEdge: false,
        shiftVisibleRangeOnScroll: false as any,
      },
      localization: {
        timeFormatter: (t: number) => {
          try {
            const d = new Date((typeof t === "number" ? t : 0) * 1000);
            return d.toLocaleString(undefined, {
              month: "short",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            });
          } catch {
            return String(t);
          }
        },
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      kineticScroll: { touch: true, mouse: true } as any,
      handleScale: {
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: true,
        mouseWheel: true,
        pinch: true,
      },
    } as any);
    chartRef.current = chart;
    try {
      ref.current.style.touchAction = "none";
      (ref.current.style as any).webkitUserSelect = "none";
    } catch {}

    const priceOverride = { current: null as { from: number; to: number } | null };

    if (lineMode) {
      lineRef.current = chart.addAreaSeries({
        lineColor: "#22c55e",
        topColor: "rgba(34,197,94,0.25)",
        bottomColor: "rgba(34,197,94,0.02)",
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        autoscaleInfoProvider: (original: any) => {
          const ov = priceOverride.current;
          if (ov && ov.to > ov.from) {
            return { priceRange: { minValue: ov.from, maxValue: ov.to } };
          }
          try {
            return typeof original === "function" ? original() : original;
          } catch {
            return null;
          }
        },
      } as any);
    } else {
      candleRef.current = chart.addCandlestickSeries({
        upColor: "#22c55e",
        downColor: "#ef4444",
        borderVisible: false,
        wickUpColor: "#22c55e",
        wickDownColor: "#ef4444",
        priceLineVisible: false,
        lastValueVisible: true,
        autoscaleInfoProvider: (original: any) => {
          const ov = priceOverride.current;
          if (ov && ov.to > ov.from) {
            return { priceRange: { minValue: ov.from, maxValue: ov.to } };
          }
          try {
            return typeof original === "function" ? original() : original;
          } catch {
            return null;
          }
        },
      } as any);
    }

    // اسکرول روی نوار قیمت سمت راست — مثل چارت اصلی
    const onWheelPrice = (e: WheelEvent) => {
      const container = ref.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const fromRight = rect.right - e.clientX;
      // کل نوار قیمت (~120px از راست)
      if (fromRight > 120 || fromRight < 0) return;
      e.preventDefault();
      e.stopPropagation();
      const s = (candleRef.current || lineRef.current) as any;
      if (!s) return;

      let delta = e.deltaY;
      if (Math.abs(delta) < 0.5 && Math.abs(e.deltaX) > Math.abs(delta)) delta = e.deltaX;
      if (e.deltaMode === 1) delta *= 16;
      if (delta === 0) return;

      let pTop: number | null = null;
      let pBot: number | null = null;
      const ov0 = priceOverride.current;
      if (ov0 && ov0.to > ov0.from) {
        pBot = ov0.from;
        pTop = ov0.to;
      } else {
        try {
          const t = s.coordinateToPrice?.(8);
          const b = s.coordinateToPrice?.(Math.max(16, container.clientHeight - 8));
          if (t != null && b != null && Number.isFinite(t) && Number.isFinite(b)) {
            pTop = Math.max(Number(t), Number(b));
            pBot = Math.min(Number(t), Number(b));
          }
        } catch {}
      }
      if (pTop == null || pBot == null || !(pTop > pBot)) return;

      const relY = Math.min(1, Math.max(0, (e.clientY - rect.top) / Math.max(1, rect.height)));
      const priceAtCursor = pTop - relY * (pTop - pBot);
      // بالا = بزرگ (zoom in) · پایین = کوچک (zoom out)
      const factor = delta < 0 ? 0.82 : 1.22;
      const newRange = Math.max((pTop - pBot) * factor, Math.abs(priceAtCursor) * 0.00005 + 0.5);
      const aboveRatio = (pTop - priceAtCursor) / Math.max(1e-12, pTop - pBot);
      const newTop = priceAtCursor + newRange * aboveRatio;
      const newBot = priceAtCursor - newRange * (1 - aboveRatio);
      if (!(newTop > newBot)) return;

      priceOverride.current = { from: newBot, to: newTop };
      try {
        const ps = s.priceScale?.() || chart.priceScale("right");
        // autoScale روشن تا provider اعمال شود
        ps?.applyOptions?.({ autoScale: true });
        ps?.setAutoScale?.(true);
        // فورس رفرش با یک setData/applyOptions خنثی
        try {
          s.applyOptions?.({});
        } catch {}
      } catch {}
    };
    // دابل‌کلیک روی قیمت = ریست زوم
    const onDblPrice = (e: MouseEvent) => {
      const container = ref.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.right - e.clientX > 120 || rect.right - e.clientX < 0) return;
      priceOverride.current = null;
      try {
        const s = (candleRef.current || lineRef.current) as any;
        const ps = s?.priceScale?.() || chart.priceScale("right");
        ps?.applyOptions?.({ autoScale: true, scaleMargins: { top: 0.08, bottom: 0.12 } });
        ps?.setAutoScale?.(true);
        s?.applyOptions?.({});
      } catch {}
    };
    ref.current.addEventListener("wheel", onWheelPrice, { passive: false, capture: true });
    ref.current.addEventListener("dblclick", onDblPrice, { capture: true });
    (chart as any).__priceWheel = onWheelPrice;
    (chart as any).__priceDbl = onDblPrice;

    const onResize = () => {
      if (ref.current && chartRef.current) {
        chartRef.current.applyOptions({ width: ref.current.clientWidth });
      }
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      try {
        const w = (chart as any).__priceWheel;
        const d = (chart as any).__priceDbl;
        if (w && ref.current) ref.current.removeEventListener("wheel", w, true as any);
        if (d && ref.current) ref.current.removeEventListener("dblclick", d, true as any);
      } catch {}
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      lineRef.current = null;
      priceLineRef.current = null;
    };
  }, [symbol, interval, lineMode]);

  useEffect(() => {
    let cancelled = false;

    const FUTURE = 800;

    const appendFuture = (candles: any[]) => {
      if (!candles.length) return candles;
      const barSec = intervalToSeconds(String(interval));
      if (barSec <= 0) return candles;
      const lastT = Number(candles[candles.length - 1].time);
      const base = Math.floor(lastT / barSec) * barSec;
      const out = candles.slice();
      for (let i = 1; i <= FUTURE; i++) {
        out.push({ time: (base + i * barSec) as any });
      }
      return out;
    };

    const load = async (isFirst: boolean) => {
      try {
        const res = await fetch(
          `/api/kline?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=1000`
        );
        const json = await res.json();
        const list = Array.isArray(json) ? json : json?.data || json?.result?.list || [];
        if (!list?.length || cancelled) return;

        if (lineMode && lineRef.current) {
          const rows = list
            .map((item: any) => ({
              time: Number(item.time),
              value: Number(item.value ?? item.close),
            }))
            .filter((r: any) => r.time && Number.isFinite(r.value));
          if (!rows.length) return;
          const last = rows[rows.length - 1];
          const lastVal = last.value;
          const { precision, minMove } = getPrecision(lastVal);
          lineRef.current.applyOptions({
            priceFormat: { type: "price", precision, minMove },
          });
          // area series can't take empty whitespace the same way — pad with last value for axis only via rightOffset
          lineRef.current.setData(rows as any);
          lastBarTimeRef.current = Number(last.time) || null;

          if (priceLineRef.current) {
            try {
              lineRef.current.removePriceLine(priceLineRef.current);
            } catch {}
          }
          if (lastBarTimeRef.current != null) {
            priceLineRef.current = lineRef.current.createPriceLine({
              price: lastVal,
              color: lastVal >= (rows[rows.length - 2]?.value ?? lastVal) ? "#22c55e" : "#ef4444",
              lineWidth: 1,
              lineStyle: 2,
              axisLabelVisible: true,
              title: formatCountdownRemaining(lastBarTimeRef.current, interval),
            });
          }
        } else if (candleRef.current) {
          const candles = list
            .map((item: any) => ({
              time: Number(item.time),
              open: Number(item.open),
              high: Number(item.high),
              low: Number(item.low),
              close: Number(item.close),
            }))
            .filter((c: any) => c.time && Number.isFinite(c.close));
          if (!candles.length) return;
          const last = candles[candles.length - 1];
          const { precision, minMove } = getPrecision(last.close);
          candleRef.current.applyOptions({
            priceFormat: { type: "price", precision, minMove },
          });
          const withFuture = appendFuture(candles);
          candleRef.current.setData(withFuture as any);
          lastBarTimeRef.current = Number(last.time) || null;

          if (priceLineRef.current) {
            try {
              candleRef.current.removePriceLine(priceLineRef.current);
            } catch {}
          }
          if (lastBarTimeRef.current != null) {
            const up = last.close >= last.open;
            priceLineRef.current = candleRef.current.createPriceLine({
              price: last.close,
              color: up ? "#22c55e" : "#ef4444",
              lineWidth: 1,
              lineStyle: 2,
              axisLabelVisible: true,
              title: formatCountdownRemaining(lastBarTimeRef.current, interval),
            });
          }
        }

        if (isFirst && chartRef.current && !fittedRef.current) {
          const bars = list.length;
          const past = Math.min(160, bars);
          try {
            chartRef.current.timeScale().setVisibleLogicalRange({
              from: Math.max(0, bars - past),
              to: bars - 1 + 120,
            });
          } catch {
            try {
              chartRef.current.timeScale().fitContent();
            } catch {}
          }
          fittedRef.current = true;
        }
      } catch {}
    };

    load(true);
    const sec = intervalToSeconds(interval);
    const pollMs = sec <= 60 ? 2000 : sec <= 900 ? 3000 : 5000;
    const id = window.setInterval(() => load(false), pollMs);

    const tick = window.setInterval(() => {
      const t = lastBarTimeRef.current;
      const series = lineMode ? lineRef.current : candleRef.current;
      if (t == null || !series || !priceLineRef.current) return;
      try {
        const title = formatCountdownRemaining(t, interval);
        priceLineRef.current.applyOptions({ title });
      } catch {}
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(id);
      clearInterval(tick);
    };
  }, [symbol, interval, lineMode]);

  return (
    <div
      ref={ref}
      className="w-full rounded-xl overflow-hidden border border-gray-800"
      style={{ height: 420 }}
    />
  );
}

/** Auth modal: Google / Email login & signup */
function AuthModal({
  open,
  onClose,
  onAuthed,
}: {
  open: boolean;
  onClose: () => void;
  onAuthed: (user: User) => void;
}) {
  const [tab, setTab] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  if (!open) return null;

  const signInGoogle = async () => {
    setBusy(true);
    setErr("");
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: typeof window !== "undefined" ? window.location.origin : undefined,
        },
      });
      if (error) setErr(error.message);
    } catch (e: any) {
      setErr(e?.message || "Google sign-in failed");
    }
    setBusy(false);
  };

  const submitEmail = async () => {
    setBusy(true);
    setErr("");
    setInfo("");
    try {
      if (!email.trim() || !password) {
        setErr("Email and password required");
        setBusy(false);
        return;
      }
      if (tab === "login") {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) {
          setErr(error.message);
        } else if (data.user) {
          onAuthed(data.user);
          onClose();
        }
      } else {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { full_name: name.trim() || undefined },
          },
        });
        if (error) {
          setErr(error.message);
        } else if (data.user) {
          if (data.session) {
            onAuthed(data.user);
            onClose();
          } else {
            setInfo("Check your email to confirm the account, then log in.");
          }
        }
      }
    } catch (e: any) {
      setErr(e?.message || "Auth failed");
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md bg-gray-950 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-lg font-semibold text-white">
            {tab === "login" ? "Sign in" : "Create account"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full text-gray-400 hover:bg-gray-800 hover:text-white"
          >
            ✕
          </button>
        </div>

        <div className="p-5 space-y-4">
          <button
            type="button"
            disabled={busy}
            onClick={signInGoogle}
            className="w-full flex items-center justify-center gap-3 py-2.5 rounded-xl bg-white text-gray-900 font-medium text-sm hover:bg-gray-100 disabled:opacity-60"
          >
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
              <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.5-.4-3.5z" />
              <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13.1 24 13.1c3 0 5.8 1.1 7.9 3l5.7-5.7C34.2 6.1 29.4 4 24 4 16.3 4 9.6 8.3 6.3 14.7z" />
              <path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.3l-6.3-5.3C29.3 35.1 26.8 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
              <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.2 5.6l.1.1 6.3 5.3C39.3 37 44 32 44 24c0-1.3-.1-2.5-.4-3.5z" />
            </svg>
            Continue with Google
          </button>

          <div className="flex items-center gap-3 text-xs text-gray-500">
            <div className="flex-1 h-px bg-gray-800" />
            or email
            <div className="flex-1 h-px bg-gray-800" />
          </div>

          {tab === "signup" && (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Display name (optional)"
              className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-orange-500"
            />
          )}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-orange-500"
            autoComplete="email"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-orange-500"
            autoComplete={tab === "login" ? "current-password" : "new-password"}
          />

          {err && <p className="text-red-400 text-xs">{err}</p>}
          {info && <p className="text-green-400 text-xs">{info}</p>}

          <button
            type="button"
            disabled={busy}
            onClick={submitEmail}
            className="w-full py-2.5 rounded-xl bg-orange-500 text-black font-semibold text-sm hover:bg-orange-400 disabled:opacity-60"
          >
            {busy ? "Please wait…" : tab === "login" ? "Sign in" : "Sign up"}
          </button>

          <p className="text-center text-xs text-gray-500">
            {tab === "login" ? (
              <>
                No account?{" "}
                <button type="button" className="text-orange-400 hover:underline" onClick={() => setTab("signup")}>
                  Sign up
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button type="button" className="text-orange-400 hover:underline" onClick={() => setTab("login")}>
                  Sign in
                </button>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

/** Top-left profile avatar + messages icon */
function ProfileBar({
  user,
  unreadCount,
  onLogin,
  onLogout,
  onMessages,
  onProfile,
}: {
  user: User | null;
  unreadCount: number;
  onLogin: () => void;
  onLogout: () => void;
  onMessages: () => void;
  onProfile: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const meta = user?.user_metadata || {};
  const avatarUrl = meta.avatar_url || meta.picture || null;
  const displayName =
    meta.full_name || meta.name || user?.email?.split("@")[0] || "User";
  const letter = (displayName[0] || "U").toUpperCase();

  return (
    <div className="flex items-center gap-2 shrink-0">
      {/* Messages */}
      <button
        type="button"
        onClick={onMessages}
        title="Messages"
        className="relative w-9 h-9 rounded-full bg-gray-900 border border-gray-700 flex items-center justify-center text-gray-300 hover:bg-white/10 hover:text-white transition-colors"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
          <polyline points="22,6 12,13 2,6" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-orange-500 text-black text-[10px] font-bold flex items-center justify-center">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {/* Avatar / Login */}
      {user ? (
        <div className="relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            title={displayName}
            className="w-9 h-9 rounded-full overflow-hidden border-2 border-orange-500/60 hover:border-orange-400 transition-colors bg-gray-800 flex items-center justify-center"
          >
            {avatarUrl ? (
              <img src={avatarUrl} alt={displayName} className="w-full h-full object-cover" />
            ) : (
              <span className="text-sm font-bold text-orange-300">{letter}</span>
            )}
          </button>
          {menuOpen && (
            <div className="absolute left-0 top-full mt-1.5 z-[90] w-52 bg-gray-950 border border-gray-700 rounded-xl shadow-xl py-1 overflow-hidden">
              <div className="px-3 py-2 border-b border-gray-800">
                <p className="text-sm font-medium text-white truncate">{displayName}</p>
                <p className="text-[11px] text-gray-500 truncate">{user.email}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onProfile();
                }}
                className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-gray-800"
              >
                Profile
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onMessages();
                }}
                className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-gray-800"
              >
                Messages
              </button>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onLogout();
                }}
                className="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-gray-800"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={onLogin}
          className="h-9 px-3 rounded-full bg-orange-500 text-black text-xs font-semibold hover:bg-orange-400"
        >
          Sign in
        </button>
      )}
    </div>
  );
}

export default function WatchlistPage() {
  const router = useRouter();
  const [lists, setLists] = useState<WatchList[]>([]);
  const [activeListId, setActiveListId] = useState<string | null>(null);
  const [listsMenuOpen, setListsMenuOpen] = useState(false);
  const [listDraggingId, setListDraggingId] = useState<string | null>(null);
  const [listDropTargetId, setListDropTargetId] = useState<string | null>(null);
  const listDragIdRef = useRef<string | null>(null);
  const listDropIdRef = useRef<string | null>(null);
  const [items, setItems] = useState<WatchItem[]>([]);
  const [newListName, setNewListName] = useState("");
  const [showNewList, setShowNewList] = useState(false);

  // بستن فرم New List با کلیک بیرون
  useEffect(() => {
    if (!showNewList) return;
    const onDown = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("[data-newlist-root]")) return;
      if (t?.closest?.("[data-newlist-btn]")) return;
      setShowNewList(false);
      setNewListName("");
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown, { passive: true } as any);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [showNewList]);

  const [interval, setIntervalTf] = useState(() => loadLS("wl_tf", "60"));
  const [viewMode, setViewMode] = useState<ViewMode>(() => loadLS("wl_view", "grid"));
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [lineMode, setLineMode] = useState(false);
  const [tfMenuOpen, setTfMenuOpen] = useState(false);

  useEffect(() => {
    if (!tfMenuOpen) return;
    const onDown = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest("[data-tf-menu-root]")) return;
      setTfMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [tfMenuOpen]);
  const [saving, setSaving] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [allSymbols, setAllSymbols] = useState<SearchHit[]>([]);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [pcts, setPcts] = useState<Record<string, number>>({});
  const [menuItemId, setMenuItemId] = useState<string | null>(null);
  const [listMenuId, setListMenuId] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<string | null>(null);

  // Auth / profile
  const [user, setUser] = useState<User | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const listsRef = useRef<WatchList[]>([]);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [floatPos, setFloatPos] = useState<{ x: number; y: number } | null>(null);
  const [floatSize, setFloatSize] = useState<{ w: number; h: number }>({ w: 200, h: 56 });
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const dropTargetIdRef = useRef<string | null>(null);
  const itemsRef = useRef<WatchItem[]>([]);
  const offsetRef = useRef({ x: 0, y: 0 });
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // کلیک بیرون از سرچ → بستن
  useEffect(() => {
    if (!showSearch) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest?.("[data-search-root]")) return;
      if (t.closest?.("[data-search-btn]")) return;
      setShowSearch(false);
      setSearchQuery("");
      setSearchHits([]);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [showSearch]);


  const listScrollRef = useRef<HTMLDivElement>(null);
  const gridScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => {
    listsRef.current = lists;
  }, [lists]);
  useEffect(() => {
    saveLS("wl_tf", interval);
  }, [interval]);
  useEffect(() => {
    saveLS("wl_view", viewMode);
  }, [viewMode]);

  // Session
  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (mounted) setUser(data.session?.user ?? null);
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((event, session: Session | null) => {
      setUser(session?.user ?? null);
      if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "INITIAL_SESSION") {
        // لیست‌ها بلافاصله بعد از لاگین لود شوند
        setTimeout(() => {
          try { /* loadLists via user effect */ } catch {}
        }, 100);
      }
      if (event === "SIGNED_OUT") {
        setLists([]);
        setItems([]);
        setActiveListId(null);
      }
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  // Optional: unread messages count (table `messages` if exists)
  useEffect(() => {
    if (!user) {
      setUnreadCount(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { count, error } = await supabase
          .from("messages")
          .select("*", { count: "exact", head: true })
          .eq("to_user", user.id)
          .eq("read", false);
        if (!error && !cancelled && typeof count === "number") setUnreadCount(count);
      } catch {
        // table may not exist yet
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // symbols from server proxy
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/symbols");
        const json = await res.json();
        if (json?.ok && Array.isArray(json.data) && json.data.length) {
          setAllSymbols(
            json.data.map((x: any) => ({
              symbol: String(x.symbol).toUpperCase(),
              baseCoin: x.baseCoin,
              quoteCoin: x.quoteCoin,
              market: (x.market as SearchHit["market"]) || "Spot",
              exchange: x.exchange || "",
            }))
          );
          return;
        }
      } catch {}
      setAllSymbols(
        ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"].map((s) => ({
          symbol: s,
          baseCoin: s.replace("USDT", ""),
          quoteCoin: "USDT",
          market: "Spot" as const,
          exchange: "BINANCE",
        }))
      );
    })();
  }, []);

  useEffect(() => {
    if (!items.length && !searchHits.length) return;
    let cancelled = false;

    const fetchPrices = async () => {
      const symbols = Array.from(
        new Set([
          ...items.map((i) => bareSymbol(i.symbol)),
          ...searchHits.map((h) => h.symbol.toUpperCase()),
        ])
      );
      if (!symbols.length) return;

      try {
        const res = await fetch(
          `/api/ticker?symbols=${encodeURIComponent(symbols.join(","))}`
        );
        const json = await res.json();
        if (!json?.ok || !json.data) return;

        const nextP: Record<string, number> = {};
        const nextPct: Record<string, number> = {};
        for (const [sym, row] of Object.entries(json.data) as any) {
          if (row?.lastPrice) nextP[sym] = row.lastPrice;
          if (row?.price24hPcnt != null && !Number.isNaN(row.price24hPcnt)) {
            nextPct[sym] = row.price24hPcnt;
          }
        }
        if (!cancelled) {
          setPrices((prev) => ({ ...prev, ...nextP }));
          setPcts((prev) => ({ ...prev, ...nextPct }));
        }
      } catch {}
    };

    fetchPrices();
    const id = setInterval(fetchPrices, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [items, searchHits]);

  const loadLists = useCallback(async () => {
    let uid: string | null = null;
    try {
      const { data: sess } = await supabase.auth.getSession();
      uid = sess?.session?.user?.id || null;
      if (!uid) {
        const { data: u } = await supabase.auth.getUser();
        uid = u?.user?.id || null;
      }
    } catch {}
    if (!uid) {
      setLists([]);
      listsRef.current = [];
      setItems([]);
      return;
    }
    const { data } = await supabase
      .from("watchlist_lists")
      .select("*")
      .eq("user_id", uid)
      .order("created_at", { ascending: true });
    // فیلتر دفاعی سمت کلاینت (اگر RLS باز باشد)
    let rows = (data || []).filter((r: any) => !r.user_id || r.user_id === uid);
    try {
      const order: string[] = loadLS("wl_list_order", []);
      if (order.length && rows.length) {
        const map = new Map(rows.map((r) => [r.id, r]));
        const ordered: WatchList[] = [];
        for (const id of order) {
          const r = map.get(id);
          if (r) {
            ordered.push(r);
            map.delete(id);
          }
        }
        for (const r of map.values()) ordered.push(r);
        rows = ordered;
      }
    } catch {}
    setLists(rows);
    listsRef.current = rows;
    let nextId = activeListId;
    try {
      const saved = loadLS(`wl_active_${uid}`, null as string | null);
      if (saved && rows.find((r) => r.id === saved)) nextId = saved;
    } catch {}
    if (nextId && rows.find((r) => r.id === nextId)) {
      setActiveListId(nextId);
    } else if (rows.length) {
      setActiveListId(rows[0].id);
    } else {
      setActiveListId(null);
    }
  }, []);

  const loadItems = useCallback(
    async (listId: string) => {
      const { data } = await supabase
        .from("watchlist_items")
        .select("*")
        .eq("list_id", listId)
        .order("sort_order", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: true });
      const rows = ((data || []) as WatchItem[]).sort(
        (a, b) => (a.sort_order ?? 9999) - (b.sort_order ?? 9999)
      );
      setItems(rows);
      if (rows.length && !selectedSymbol) setSelectedSymbol(rows[0].symbol);
      if (selectedSymbol && !rows.find((r) => r.symbol === selectedSymbol)) {
        setSelectedSymbol(rows[0]?.symbol || null);
      }
    },
    [selectedSymbol]
  );

  useEffect(() => {
    if (user) loadLists();
    else {
      setLists([]);
      setItems([]);
      setActiveListId(null);
    }
  }, [user]);

  // وقتی از چارت برمی‌گردی لیست‌ها دوباره لود شوند
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && user) loadLists();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [user]);
  useEffect(() => {
    if (activeListId) loadItems(activeListId);
  }, [activeListId]);

  useEffect(() => {
    if (!user?.id || !activeListId) return;
    try {
      saveLS(`wl_active_${user.id}`, activeListId);
    } catch {}
  }, [user?.id, activeListId]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("[data-menu-root]")) return;
      setMenuItemId(null);
      setListMenuId(null);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  const createList = async () => {
    if (!newListName.trim()) return;
    setSaving(true);
    // اول از state، بعد getSession، بعد getUser (برای iPad که session دیر می‌آید)
    let uid = user?.id || null;
    if (!uid) {
      const { data: sess } = await supabase.auth.getSession();
      uid = sess?.session?.user?.id || null;
    }
    if (!uid) {
      try {
        const { data: u } = await supabase.auth.getUser();
        uid = u?.user?.id || null;
      } catch {}
    }
    if (!uid) {
      setSaving(false);
      setAuthOpen(true);
      return;
    }
    const { data, error } = await supabase
      .from("watchlist_lists")
      .insert([{ name: newListName.trim(), user_id: uid }])
      .select()
      .single();
    setSaving(false);
    if (error) {
      console.error("createList", error);
      return;
    }
    if (data) {
      setLists((prev) => [...prev, data]);
      setActiveListId(data.id);
      setNewListName("");
      setShowNewList(false);
      try {
        saveLS(`wl_active_${uid}`, data.id);
      } catch {}
    }
  };

  const deleteList = async (id: string) => {
    await supabase.from("watchlist_items").delete().eq("list_id", id);
    await supabase.from("watchlist_lists").delete().eq("id", id);
    setListMenuId(null);
    setLists((prev) => prev.filter((l) => l.id !== id));
    if (activeListId === id) {
      const rest = lists.filter((l) => l.id !== id);
      setActiveListId(rest[0]?.id || null);
    }
  };

  const inList = (sym: string, exchange?: string) => {
    const key = storageSymbol(sym, exchange);
    // فقط همان نماد+صرافی — نه همهٔ AVAXها
    return items.some((i) => i.symbol === key);
  };

  const togglingRef = useRef(false);
  const toggleSymbol = async (sym: string, exchange?: string) => {
    if (!activeListId) return;
    // جلوگیری از double-fire لمس+کلیک در iPad
    if (togglingRef.current || saving) return;
    togglingRef.current = true;
    const key = storageSymbol(sym, exchange);
    const existing = items.find((i) => i.symbol === key);
    setSaving(true);
    try {
      if (existing) {
        await supabase.from("watchlist_items").delete().eq("id", existing.id);
        setItems((prev) => prev.filter((i) => i.id !== existing.id));
      } else {
        const uid = (await supabase.auth.getSession()).data.session?.user?.id;
        const { data, error } = await supabase
          .from("watchlist_items")
          .insert([{
            list_id: activeListId,
            symbol: key,
            sort_order: items.length,
            user_id: uid,
          }])
          .select()
          .single();
        if (!error && data) {
          setItems((prev) => {
            // اگر هم‌زمان چیزی با همین key آمده، تکراری نگذار
            if (prev.some((x) => x.symbol === key)) return prev;
            return [...prev, data];
          });
          setJustAdded(key);
          setTimeout(() => setJustAdded(null), 1200);
        }
      }
    } finally {
      setSaving(false);
      window.setTimeout(() => {
        togglingRef.current = false;
      }, 400);
    }
  };

  const deleteItem = async (id: string) => {
    await supabase.from("watchlist_items").delete().eq("id", id);
    setItems((prev) => prev.filter((i) => i.id !== id));
    setMenuItemId(null);
  };

  const goChart = (sym: string) => {
    const bare = bareSymbol(sym);
    try {
      localStorage.setItem("chart_symbol", bare);
    } catch {}
    router.push(`/dashboard?symbol=${encodeURIComponent(bare)}`);
  };

  const runSearch = (q: string) => {
    setSearchQuery(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!q.trim()) {
      setSearchHits([]);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(() => {
      const qq = q.trim().toUpperCase();
      const hits = allSymbols
        .filter(
          (h) =>
            h.symbol.includes(qq) ||
            (h.baseCoin && h.baseCoin.toUpperCase().includes(qq))
        )
        .slice(0, 40);
      setSearchHits(hits);
      setSearching(false);
    }, 200);
  };

  const startDrag = (id: string, cx: number, cy: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    dragIdRef.current = id;
    offsetRef.current = { x: cx - rect.left, y: cy - rect.top };
    setFloatSize({ w: rect.width, h: rect.height });
    setFloatPos({ x: rect.left, y: rect.top });
    setDraggingId(id);
    dropTargetIdRef.current = null;

    const scrollContainers = () =>
      [listScrollRef.current, gridScrollRef.current].filter(Boolean) as HTMLElement[];

    const onMove = (e: PointerEvent) => {
      try { e.preventDefault(); } catch {}
      setFloatPos({
        x: e.clientX - offsetRef.current.x,
        y: e.clientY - offsetRef.current.y,
      });

      // auto-scroll near edges so you can reach top/bottom of long lists
      for (const sc of scrollContainers()) {
        const r = sc.getBoundingClientRect();
        const edge = 56;
        if (e.clientY < r.top + edge) {
          sc.scrollTop -= Math.max(8, (r.top + edge - e.clientY) * 0.4);
        } else if (e.clientY > r.bottom - edge) {
          sc.scrollTop += Math.max(8, (e.clientY - (r.bottom - edge)) * 0.4);
        }
      }

      const under = document.elementFromPoint(e.clientX, e.clientY);
      const row = under?.closest?.("[data-item-id]") as HTMLElement | null;
      let tid = row?.dataset?.itemId || null;
      if (!tid) {
        for (const sc of scrollContainers()) {
          const r = sc.getBoundingClientRect();
          if (
            e.clientX >= r.left &&
            e.clientX <= r.right &&
            e.clientY >= r.top - 20 &&
            e.clientY <= r.bottom + 40
          ) {
            const rows = Array.from(sc.querySelectorAll("[data-item-id]")) as HTMLElement[];
            if (!rows.length) continue;
            let best: HTMLElement | null = null;
            let bestD = Infinity;
            for (const rowEl of rows) {
              const rr = rowEl.getBoundingClientRect();
              const mid = (rr.top + rr.bottom) / 2;
              const d = Math.abs(e.clientY - mid);
              if (d < bestD) {
                bestD = d;
                best = rowEl;
              }
            }
            tid = best?.dataset?.itemId || null;
          }
        }
      }
      dropTargetIdRef.current = tid;
      setDropTargetId(tid);
    };

    const onUp = async () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const fromId = dragIdRef.current;
      const toId = dropTargetIdRef.current;
      setDraggingId(null);
      setFloatPos(null);
      setDropTargetId(null);
      dropTargetIdRef.current = null;
      dragIdRef.current = null;
      if (!fromId || !toId || fromId === toId) return;
      const arr = [...itemsRef.current];
      const fromIdx = arr.findIndex((x) => x.id === fromId);
      const toIdx = arr.findIndex((x) => x.id === toId);
      if (fromIdx < 0 || toIdx < 0) return;
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      const withOrder = arr.map((x, i) => ({ ...x, sort_order: i }));
      setItems(withOrder);
      itemsRef.current = withOrder;
      try {
        await Promise.all(
          withOrder.map((x, i) =>
            supabase.from("watchlist_items").update({ sort_order: i }).eq("id", x.id)
          )
        );
      } catch {}
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
  };

  const startListDrag = (id: string) => {
    listDragIdRef.current = id;
    setListDraggingId(id);
    listDropIdRef.current = null;
    setListDropTargetId(null);

    const onMove = (e: PointerEvent) => {
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const row = under?.closest?.("[data-list-id]") as HTMLElement | null;
      const tid = row?.dataset?.listId || null;
      listDropIdRef.current = tid;
      setListDropTargetId(tid);
    };
    const onUp = async () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const fromId = listDragIdRef.current;
      const toId = listDropIdRef.current;
      setListDraggingId(null);
      setListDropTargetId(null);
      listDragIdRef.current = null;
      listDropIdRef.current = null;
      if (!fromId || !toId || fromId === toId) return;
      const arr = [...listsRef.current];
      const fromIdx = arr.findIndex((x) => x.id === fromId);
      const toIdx = arr.findIndex((x) => x.id === toId);
      if (fromIdx < 0 || toIdx < 0) return;
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      setLists(arr);
      listsRef.current = arr;
      try {
        saveLS(
          "wl_list_order",
          arr.map((x) => x.id)
        );
      } catch {}
      try {
        await Promise.all(
          arr.map((x, i) =>
            supabase.from("watchlist_lists").update({ sort_order: i }).eq("id", x.id)
          )
        );
      } catch {}
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const PriceBlock = ({ sym }: { sym: string }) => {
    const bare = bareSymbol(sym);
    const p = prices[bare];
    const pct = pcts[bare];
    return (
      <div className="text-right">
        <div className="text-sm font-medium tabular-nums">
          {p != null ? formatPrice(p) : "—"}
        </div>
        {pct != null && !Number.isNaN(pct) && (
          <div
            className={`text-[11px] font-medium ${
              pct >= 0 ? "text-green-400" : "text-red-400"
            }`}
          >
            {formatPct(pct)}
          </div>
        )}
      </div>
    );
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setUser(null);
  };

  return (
    <div className="min-h-screen bg-[#0b0e11] text-gray-100 p-3 md:p-4">
      {/* Header — بدون Sign in تکراری (فقط در SiteNavbar بالاست) */}
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <h1 className="text-xl font-bold">Watchlist</h1>
        <div className="relative z-[80]" data-search-root>
          <button
            type="button"
            onClick={() => setShowSearch((v) => !v)}
            className="w-9 h-9 rounded-full bg-gray-800 border-2 border-orange-500/60 hover:border-orange-400 flex items-center justify-center text-orange-300"
            title="Search symbols"
            data-search-btn
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
          </button>
          {showSearch && (
            <div className="absolute left-0 top-full mt-2 w-[min(96vw,560px)] min-h-[280px] max-h-[70vh] bg-gray-950 border-2 border-orange-500/30 rounded-2xl overflow-hidden shadow-2xl z-[90]">
              <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800">
                <span className="text-gray-500 text-sm">🔍</span>
                <input
                  autoFocus
                  value={searchQuery}
                  onChange={(e) => runSearch(e.target.value)}
                  placeholder="Search symbol (BTC, ETH…)"
                  className="flex-1 bg-transparent outline-none text-white text-sm py-1"
                />
                {searching && (
                  <span className="text-xs text-orange-400 animate-pulse">…</span>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setShowSearch(false);
                    setSearchQuery("");
                    setSearchHits([]);
                  }}
                  className="text-gray-400 text-sm px-2 hover:text-white"
                >
                  ✕
                </button>
              </div>
              <div className="max-h-72 overflow-y-auto">
                {!searchQuery.trim() && (
                  <p className="text-gray-500 text-sm p-4">Type a symbol…</p>
                )}
                {searchQuery.trim() && !searching && searchHits.length === 0 && (
                  <p className="text-gray-500 text-sm p-4">No results</p>
                )}
                {searchHits.map((hit) => {
                  const added = inList(hit.symbol, hit.exchange);
                  const flash = justAdded === storageSymbol(hit.symbol, hit.exchange);
                  const p = prices[hit.symbol];
                  const pct = pcts[hit.symbol];
                  return (
                    <div
                      key={`${hit.exchange || "X"}-${hit.market}-${hit.symbol}`}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-800 border-b border-gray-800/50"
                    >
                      <CoinIcon symbol={hit.symbol} size={28} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm">{hit.symbol}</span>
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded ${
                              hit.market === "Spot"
                                ? "bg-blue-900/60 text-blue-300"
                                : "bg-purple-900/60 text-purple-300"
                            }`}
                          >
                            {hit.market}
                          </span>
                          {hit.exchange && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-orange-300 border border-gray-700 font-medium">
                              {hit.exchange}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-right shrink-0 min-w-[72px]">
                        {p != null ? (
                          <div className="text-sm text-gray-100 font-medium">{formatPrice(p)}</div>
                        ) : (
                          <span className="text-xs text-gray-600">—</span>
                        )}
                      </div>
                      <button
                        type="button"
                        disabled={saving}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          toggleSymbol(hit.symbol, hit.exchange);
                        }}
                        onPointerUp={(e) => {
                          // iPad: prevent ghost click adding multiple
                          e.preventDefault();
                        }}
                        className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                          added || flash
                            ? "bg-green-500/20 text-green-400 border border-green-500/50"
                            : "bg-gray-800 text-gray-200 border border-gray-600 hover:bg-orange-500 hover:text-black"
                        }`}
                      >
                        {added || flash ? "✓" : "+"}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="flex-1" />

        <div className="flex items-center gap-1.5 flex-wrap justify-end">
          {/* Clock → timeframes */}
          <div className="relative" data-tf-menu-root>
            <button
              type="button"
              onClick={() => setTfMenuOpen((v) => !v)}
              title="Timeframe"
              className="h-9 px-2.5 rounded-full bg-gray-800 border-2 border-orange-500/60 hover:border-orange-400 text-orange-300 inline-flex items-center gap-1.5 text-xs font-medium"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
              <span>{TIMEFRAMES.find((t) => t.value === interval)?.label || interval}</span>
            </button>
            {tfMenuOpen && (
              <div className="absolute right-0 top-full mt-1.5 z-[90] flex flex-wrap gap-1 p-2 w-[220px] rounded-xl bg-[#0b0e11] border-2 border-orange-500/40 shadow-2xl">
                {TIMEFRAMES.map((tf) => (
                  <button
                    key={tf.value}
                    type="button"
                    onClick={() => {
                      setIntervalTf(tf.value);
                      setTfMenuOpen(false);
                    }}
                    className={`px-2.5 py-1 rounded-full text-xs border ${
                      interval === tf.value
                        ? "bg-gray-800 text-orange-300 border-orange-500"
                        : "bg-gray-900 text-gray-300 border-gray-700 hover:border-orange-500/50"
                    }`}
                  >
                    {tf.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => setViewMode("grid")}
            className={`px-3 py-1.5 rounded-full text-sm border-2 ${
              viewMode === "grid"
                ? "bg-gray-800 text-orange-300 border-orange-500"
                : "bg-gray-800 text-gray-400 border-gray-700 hover:border-orange-500/50"
            }`}
          >
            Grid
          </button>
          <button
            type="button"
            onClick={() => setViewMode("list")}
            className={`px-3 py-1.5 rounded-full text-sm border-2 ${
              viewMode === "list"
                ? "bg-gray-800 text-orange-300 border-orange-500"
                : "bg-gray-800 text-gray-400 border-gray-700 hover:border-orange-500/50"
            }`}
          >
            ≡ List
          </button>

          <label className="flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer select-none h-9 px-2.5 rounded-full bg-gray-800 border-2 border-orange-500/40">
            <input
              type="checkbox"
              checked={lineMode}
              onChange={(e) => setLineMode(e.target.checked)}
              className="accent-orange-500"
            />
            Line
          </label>
        </div>
      </div>

      {/* My List — absolute panel so layout doesn't jump */}
      <div className="mb-1 relative z-40" data-lists-menu-root>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setListsMenuOpen((v) => !v)}
            className="px-3 py-1.5 rounded-full text-sm font-medium inline-flex items-center gap-1.5 bg-gray-800 text-orange-300 border-2 border-orange-500/60 hover:border-orange-400 shrink-0"
          >
            My List
            <span
              className={`inline-block text-xs transition-transform duration-300 ${
                listsMenuOpen ? "rotate-90" : ""
              }`}
            >
              ›
            </span>
          </button>

          <div
            className={`flex flex-nowrap items-center gap-1.5 overflow-hidden transition-all duration-300 ease-out ${
              listsMenuOpen
                ? "max-w-[min(92vw,720px)] opacity-100"
                : "max-w-0 w-0 opacity-0 pointer-events-none"
            }`}
            style={{ maxHeight: listsMenuOpen ? 120 : 0 }}
          >
            <div className="flex flex-nowrap items-center gap-1.5 py-0.5 px-1 rounded-xl bg-gray-950/95 border border-orange-500/30 shadow-xl">
              {lists.map((l) => (
                <div
                  key={l.id}
                  data-list-id={l.id}
                  className={`relative flex items-center shrink-0 rounded-full transition-all ${
                    listDraggingId === l.id ? "opacity-40 scale-95" : ""
                  } ${
                    listDropTargetId === l.id && listDraggingId && listDraggingId !== l.id
                      ? "ring-2 ring-orange-500/60"
                      : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setActiveListId(l.id)}
                    className={`px-3 py-1.5 rounded-full text-sm whitespace-nowrap transition-colors ${
                      activeListId === l.id
                        ? "bg-orange-500/25 text-orange-300 border border-orange-500/50"
                        : "bg-gray-800 text-gray-300 border border-gray-700 hover:bg-gray-700"
                    }`}
                  >
                    {l.name}
                  </button>
                  <button
                    type="button"
                    data-menu-root
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setListMenuId((prev) => (prev === l.id ? null : l.id));
                    }}
                    onPointerDown={(e) => {
                      // long-press → drag reorder
                      if (e.button !== 0) return;
                      const timer = window.setTimeout(() => {
                        setListMenuId(null);
                        startListDrag(l.id);
                      }, 380);
                      const onUp = () => {
                        clearTimeout(timer);
                        window.removeEventListener("pointerup", onUp);
                      };
                      window.addEventListener("pointerup", onUp);
                    }}
                    className="ml-0.5 w-7 h-7 flex items-center justify-center rounded-full text-gray-500 hover:text-white hover:bg-gray-800 text-sm cursor-grab touch-none"
                    style={{ touchAction: "none" }}
                    title="Click: delete · Hold: reorder"
                  >
                    ⋮⋮
                  </button>
                  {listMenuId === l.id && (
                    <div
                      className="absolute top-full left-0 mt-1 z-40 bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[120px]"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteList(l.id);
                          setListMenuId(null);
                        }}
                        className="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-gray-800"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {!lists.length && (
                <span className="text-xs text-gray-500 px-2 py-1">No lists yet</span>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={() => setShowNewList((v) => !v)}
            title="New list"
            data-newlist-btn
            className={`w-8 h-8 rounded-full flex items-center justify-center text-lg font-semibold transition-all duration-200 ${
              showNewList
                ? "bg-orange-500 text-black scale-95"
                : "bg-gray-800 text-gray-200 border border-gray-700 hover:bg-orange-500 hover:text-black hover:border-orange-400"
            }`}
          >
            +
          </button>

          <div
            data-newlist-root
            className={`flex items-center gap-2 overflow-hidden transition-all duration-300 ease-out ${
              showNewList ? "max-w-[280px] opacity-100 ml-1" : "max-w-0 opacity-0 ml-0"
            }`}
          >
            <input
              autoFocus={showNewList}
              value={newListName}
              onChange={(e) => setNewListName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createList();
                if (e.key === "Escape") {
                  setShowNewList(false);
                  setNewListName("");
                }
              }}
              placeholder="List name…"
              className="w-40 bg-gray-900 border border-gray-600 focus:border-orange-500 rounded-full px-3 py-1.5 text-white text-sm outline-none"
            />
            <button
              type="button"
              onClick={createList}
              disabled={saving || !newListName.trim()}
              className="px-3 py-1.5 rounded-full text-sm bg-orange-500 text-black font-medium disabled:opacity-40 hover:bg-orange-400"
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => {
                setShowNewList(false);
                setNewListName("");
              }}
              className="w-7 h-7 rounded-full text-gray-400 hover:text-white hover:bg-gray-800 text-sm"
            >
              ✕
            </button>
          </div>
        </div>
      </div>



      {!activeListId && (
        <p className="text-gray-500 text-sm">Create a list first, then add symbols.</p>
      )}

      {viewMode === "grid" && activeListId && (
        <div
          ref={gridScrollRef}
          className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 mt-1 max-h-[70vh] overflow-y-auto"
        >
          {items.map((item) => (
            <div key={item.id}>
              {draggingId && dropTargetId === item.id && draggingId !== item.id && (
                <div className="h-3 mb-1 rounded-full bg-orange-500/40 border border-dashed border-orange-500" />
              )}
              <div
                data-item-id={item.id}
                className={`bg-gray-900 border rounded-xl p-3 select-none transition-all duration-200 ${
                  draggingId === item.id
                    ? "opacity-15 border-dashed border-orange-500/50 scale-95"
                    : dropTargetId === item.id && draggingId
                    ? "border-orange-500/60"
                    : "border-gray-800"
                }`}
                style={{ WebkitUserSelect: "none", userSelect: "none" }}
              >
                <div className="flex items-center justify-between mb-1 gap-2">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <CoinIcon symbol={bareSymbol(item.symbol)} size={26} />
                    <div className="min-w-0">
                      <div className="font-semibold text-sm truncate">{bareSymbol(item.symbol)}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <PriceBlock sym={item.symbol} />
                    <div className="relative" data-menu-root>
                      <div
                        onPointerDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const row = (e.currentTarget as HTMLElement).closest(
                            "[data-item-id]"
                          ) as HTMLElement;
                          let dragged = false;
                          const timer = setTimeout(() => {
                            dragged = true;
                            if (row) startDrag(item.id, e.clientX, e.clientY, row);
                          }, 140);
                          const onUp = () => {
                            clearTimeout(timer);
                            if (!dragged) {
                              setListMenuId(null);
                              setMenuItemId((prev) =>
                                prev === item.id ? null : item.id
                              );
                            }
                            window.removeEventListener("pointerup", onUp);
                          };
                          window.addEventListener("pointerup", onUp);
                        }}
                        className="w-8 h-8 flex items-center justify-center text-gray-500 text-lg cursor-grab touch-none"
                        style={{ touchAction: "none" }}
                      >
                        ⋮⋮
                      </div>
                      {menuItemId === item.id && (
                        <div
                          className="absolute right-0 top-full mt-1 z-50 bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[110px]"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            onClick={() => deleteItem(item.id)}
                            className="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-gray-800"
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              goChart(item.symbol);
                              setMenuItemId(null);
                            }}
                            className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-gray-800"
                          >
                            Open chart
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                {draggingId !== item.id && (
                  <MiniChart
                    symbol={bareSymbol(item.symbol)}
                    interval={interval}
                    pct={pcts[bareSymbol(item.symbol)]}
                    candleMode={!lineMode}
                  />
                )}
                <div className="flex justify-end mt-1">
                  <button
                    type="button"
                    onClick={() => goChart(item.symbol)}
                    className="text-orange-400 text-xs hover:underline"
                  >
                    Chart
                  </button>
                </div>
              </div>
            </div>
          ))}
          {!items.length && (
            <p className="text-gray-500 text-sm col-span-full">No symbols yet. Tap 🔍 to add.</p>
          )}
        </div>
      )}

      {viewMode === "list" && activeListId && (
        <div className="flex flex-col md:flex-row gap-4 min-h-[480px]">
          <div className="w-full md:w-80 shrink-0 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col max-h-[520px]">
            <div ref={listScrollRef} className="overflow-y-auto flex-1 overscroll-contain">
              {items.map((item) => (
                <div key={item.id}>
                  {draggingId &&
                    dropTargetId === item.id &&
                    draggingId !== item.id && (
                      <div
                        className="mx-2 my-1 rounded-lg border-2 border-dashed border-orange-500/70 bg-orange-500/10"
                        style={{ height: floatSize.h }}
                      />
                    )}
                  <div
                    data-item-id={item.id}
                    className={`flex items-center gap-1.5 px-2 border-b border-gray-800/80 select-none transition-all duration-150 ${
                      bareSymbol(selectedSymbol || "") === bareSymbol(item.symbol) &&
                      draggingId !== item.id
                        ? "bg-gray-800 border-l-2 border-l-orange-500"
                        : ""
                    } ${draggingId === item.id ? "opacity-20 scale-[0.98]" : ""}`}
                    style={{
                      WebkitUserSelect: "none",
                      userSelect: "none",
                      minHeight: 56,
                    }}
                  >
                    <div className="relative shrink-0" data-menu-root>
                      <div
                        onPointerDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const row = (e.currentTarget as HTMLElement).closest(
                            "[data-item-id]"
                          ) as HTMLElement;
                          let dragged = false;
                          const timer = setTimeout(() => {
                            dragged = true;
                            if (row) startDrag(item.id, e.clientX, e.clientY, row);
                          }, 140);
                          const onUp = () => {
                            clearTimeout(timer);
                            if (!dragged) {
                              setListMenuId(null);
                              setMenuItemId((prev) =>
                                prev === item.id ? null : item.id
                              );
                            }
                            window.removeEventListener("pointerup", onUp);
                          };
                          window.addEventListener("pointerup", onUp);
                        }}
                        className="w-8 h-12 flex items-center justify-center text-gray-500 cursor-grab touch-none"
                        style={{ touchAction: "none" }}
                      >
                        ⋮⋮
                      </div>
                      {menuItemId === item.id && (
                        <div
                          className="absolute left-0 top-full mt-1 z-50 bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[110px]"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            onClick={() => deleteItem(item.id)}
                            className="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-gray-800"
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              goChart(item.symbol);
                              setMenuItemId(null);
                            }}
                            className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-gray-800"
                          >
                            Open chart
                          </button>
                        </div>
                      )}
                    </div>

                    <CoinIcon symbol={bareSymbol(item.symbol)} size={28} />

                    <button
                      type="button"
                      onClick={() => {
                        if (!draggingId) setSelectedSymbol(item.symbol);
                      }}
                      className="flex-1 min-w-0 text-left py-3"
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-sm truncate">
                          {bareSymbol(item.symbol)}
                        </div>
                      </div>
                      {item.note && (
                        <div className="text-gray-500 text-xs truncate">{item.note}</div>
                      )}
                    </button>

                    <div className="shrink-0 pr-1 min-w-[88px]">
                      <PriceBlock sym={item.symbol} />
                    </div>
                  </div>
                </div>
              ))}
              {!items.length && (
                <p className="text-gray-500 text-sm p-4">No symbols yet. Tap 🔍 to add.</p>
              )}
            </div>
          </div>

          <div className="flex-1 min-w-0 min-h-[560px]">
            {selectedSymbol ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-3">
                    <CoinIcon symbol={bareSymbol(selectedSymbol)} size={32} />
                    <h2 className="text-lg font-bold">{bareSymbol(selectedSymbol)}</h2>
                    <button
                      type="button"
                      onClick={() => goChart(selectedSymbol)}
                      className="text-orange-400 text-sm hover:underline"
                    >
                      Open full chart →
                    </button>
                  </div>

                </div>

                <DetailChart
                  key={`${selectedSymbol}-${interval}-${lineMode}`}
                  symbol={bareSymbol(selectedSymbol)}
                  interval={interval}
                  lineMode={lineMode}
                />

                <div className="flex flex-wrap gap-2 mt-3">
                  {TIMEFRAMES.map((tf) => (
                    <button
                      key={tf.value}
                      type="button"
                      onClick={() => setIntervalTf(tf.value)}
                      className={`px-3 py-1.5 rounded-full text-sm border-2 ${
                        interval === tf.value
                          ? "bg-gray-800 text-orange-300 border-orange-500"
                          : "bg-gray-800 text-gray-400 border-gray-700"
                      }`}
                    >
                      {tf.label}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center h-64 text-gray-500 border border-gray-800 rounded-xl">
                Select a symbol from the list
              </div>
            )}
          </div>
        </div>
      )}

      {/* Floating drag ghost */}
      {draggingId && floatPos && (
        <div
          id="wl-drag-ghost"
          className="fixed z-[100] pointer-events-none opacity-90 shadow-2xl rounded-xl border border-orange-500/50 bg-gray-900"
          style={{
            left: floatPos.x,
            top: floatPos.y,
            width: floatSize.w,
            height: floatSize.h,
          }}
        />
      )}

      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onAuthed={(u) => setUser(u)}
      />
    </div>
  );
}

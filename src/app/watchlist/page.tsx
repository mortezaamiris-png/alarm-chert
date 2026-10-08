"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createChart, ISeriesApi } from "lightweight-charts";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";

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
  market: "Spot" | "Futures" | "Index";
}

const TIMEFRAMES = [
  { label: "1m", value: "1" },
  { label: "5m", value: "5" },
  { label: "15m", value: "15" },
  { label: "1h", value: "60" },
  { label: "4h", value: "240" },
  { label: "1D", value: "D" },
];

type ViewMode = "grid" | "list";

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
}: {
  symbol: string;
  interval: string;
  pct?: number | null;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = "";

    // green if up, red if down, orange if unknown
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
      height: 80,
      layout: { background: { color: "transparent" }, textColor: "#6b7280" },
      grid: { vertLines: { visible: false }, horzLines: { visible: false } },
      rightPriceScale: { visible: false },
      timeScale: { visible: false },
      crosshair: { mode: 0 },
      handleScroll: false,
      handleScale: false,
    });
    const series = chart.addAreaSeries({
      lineColor,
      topColor,
      bottomColor,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    (async () => {
      try {
        const res = await fetch(
          `/api/kline?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=60`
        );
        const json = await res.json();
        const list = json?.data;
        if (!list?.length) return;
        const rows = list.map((item: any) => ({
          time: item.time,
          value: item.value ?? item.close,
        }));
        series.setData(rows as any);
        chart.timeScale().fitContent();
      } catch {}
    })();

    return () => {
      chart.remove();
    };
  }, [symbol, interval, pct]);

  return <div ref={ref} className="w-full h-20 pointer-events-none" />;
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

  // Create chart once / when mode changes
  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = "";
    candleRef.current = null;
    lineRef.current = null;
    priceLineRef.current = null;
    lastBarTimeRef.current = null;

    const chart = createChart(ref.current, {
      width: ref.current.clientWidth,
      height: 420,
      layout: { background: { color: "#0f0f0f" }, textColor: "#d1d5db" },
      grid: {
        vertLines: { color: "#1f2937" },
        horzLines: { color: "#1f2937" },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true },
    });
    chartRef.current = chart;

    if (lineMode) {
      lineRef.current = chart.addAreaSeries({
        lineColor: "#22c55e",
        topColor: "rgba(34,197,94,0.25)",
        bottomColor: "rgba(34,197,94,0.02)",
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
      });
    } else {
      candleRef.current = chart.addCandlestickSeries({
        upColor: "#22c55e",
        downColor: "#ef4444",
        borderVisible: false,
        wickUpColor: "#22c55e",
        wickDownColor: "#ef4444",
        priceLineVisible: false,
        lastValueVisible: true,
      });
    }

    const onResize = () => {
      if (ref.current && chartRef.current) {
        chartRef.current.applyOptions({ width: ref.current.clientWidth });
      }
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      lineRef.current = null;
      priceLineRef.current = null;
    };
  }, [symbol, interval, lineMode]);

  // Apply countdown title on last price label
  const applyCountdown = useCallback(() => {
    const t = lastBarTimeRef.current;
    if (t == null) return;
    const title = formatCountdownRemaining(t, interval);
    const series = lineMode ? lineRef.current : candleRef.current;
    if (!series) return;
    try {
      // lightweight-charts last value label uses series options / price line
      if (priceLineRef.current) {
        try {
          series.removePriceLine(priceLineRef.current);
        } catch {}
        priceLineRef.current = null;
      }
      // Get last close from series data is hard; use price line with title
      // Instead update via applyOptions on lastValueVisible title — not supported.
      // Use a price line at last price with countdown title.
    } catch {}
  }, [interval, lineMode]);

  // Live poll candles (like main Charts page)
  useEffect(() => {
    let cancelled = false;
    let fitted = false;

    const load = async (isFirst: boolean) => {
      try {
        const res = await fetch(
          `/api/kline?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=200`
        );
        const json = await res.json();
        const list = json?.data;
        if (!list?.length || cancelled) return;

        if (lineMode && lineRef.current) {
          const rows = list.map((item: any) => ({
            time: item.time,
            value: item.value ?? item.close,
          }));
          const last = rows[rows.length - 1];
          const lastVal = last?.value || 0;
          const { precision, minMove } = getPrecision(lastVal);
          lineRef.current.applyOptions({
            priceFormat: { type: "price", precision, minMove },
          });
          lineRef.current.setData(rows as any);
          lastBarTimeRef.current = Number(last?.time) || null;

          // countdown price line
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
          const candles = list.map((item: any) => ({
            time: item.time,
            open: item.open,
            high: item.high,
            low: item.low,
            close: item.close,
          }));
          const last = candles[candles.length - 1];
          const { precision, minMove } = getPrecision(last.close);
          candleRef.current.applyOptions({
            priceFormat: { type: "price", precision, minMove },
          });
          candleRef.current.setData(candles as any);
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

        if (isFirst && chartRef.current && !fitted) {
          chartRef.current.timeScale().fitContent();
          fitted = true;
        }
      } catch {}
    };

    load(true);
    // poll live — 2s for short TF, 5s for longer
    const sec = intervalToSeconds(interval);
    const pollMs = sec <= 60 ? 2000 : sec <= 900 ? 3000 : 5000;
    const id = window.setInterval(() => load(false), pollMs);

    // tick countdown every 1s
    const tick = window.setInterval(() => {
      const t = lastBarTimeRef.current;
      const series = lineMode ? lineRef.current : candleRef.current;
      if (t == null || !series || !priceLineRef.current) return;
      try {
        const title = formatCountdownRemaining(t, interval);
        // recreate price line title by updating options if supported
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

export default function WatchlistPage() {
  const router = useRouter();
  const [lists, setLists] = useState<WatchList[]>([]);
  const [activeListId, setActiveListId] = useState<string | null>(null);
  const [items, setItems] = useState<WatchItem[]>([]);
  const [newListName, setNewListName] = useState("");
  const [showNewList, setShowNewList] = useState(false);
  const [interval, setIntervalTf] = useState(() => loadLS("wl_tf", "60"));
  const [viewMode, setViewMode] = useState<ViewMode>(() => loadLS("wl_view", "grid"));
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [lineMode, setLineMode] = useState(false);
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

  /** Drag-reorder for list tabs (⋮⋮) — lift + gap like symbol rows */
  const [draggingListId, setDraggingListId] = useState<string | null>(null);
  const [listDropTargetId, setListDropTargetId] = useState<string | null>(null);
  const [listFloatPos, setListFloatPos] = useState<{ x: number; y: number } | null>(null);
  const [listFloatSize, setListFloatSize] = useState<{ w: number; h: number }>({ w: 100, h: 36 });
  const listDragIdRef = useRef<string | null>(null);
  const listOffsetRef = useRef({ x: 0, y: 0 });
  const listsRef = useRef<WatchList[]>([]);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [floatPos, setFloatPos] = useState<{ x: number; y: number } | null>(null);
  const [floatSize, setFloatSize] = useState<{ w: number; h: number }>({ w: 200, h: 56 });
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const itemsRef = useRef<WatchItem[]>([]);
  const offsetRef = useRef({ x: 0, y: 0 });
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // symbols from server proxy (Binance+Bybit+LBank+Bitunix + indices) — no Iran IP block
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
            }))
          );
          return;
        }
      } catch {}
      // minimal offline fallback
      setAllSymbols(
        [
          "BTCUSDT",
          "ETHUSDT",
          "BNBUSDT",
          "SOLUSDT",
          "BTC.D",
          "USDT.D",
          "TOTAL2",
          "TOTAL3",
          "OTHERS.D",
        ].map((s) => ({
          symbol: s,
          baseCoin: s.replace("USDT", "").replace(".D", ""),
          quoteCoin: s.includes(".D") || s.startsWith("TOTAL") ? "IDX" : "USDT",
          market: (s.includes(".D") || s.startsWith("TOTAL")
            ? "Index"
            : "Spot") as SearchHit["market"],
        }))
      );
    })();
  }, []);

  // prices via our multi-exchange API
  useEffect(() => {
    if (!items.length && !searchHits.length) return;
    let cancelled = false;

    const fetchPrices = async () => {
      const symbols = Array.from(
        new Set([
          ...items.map((i) => i.symbol.toUpperCase()),
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
    const { data } = await supabase
      .from("watchlist_lists")
      .select("*")
      .order("created_at", { ascending: true });
    let rows = data || [];
    // Apply saved tab order (localStorage)
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
    if (!activeListId && rows.length) setActiveListId(rows[0].id);
    if (activeListId && !rows.find((r) => r.id === activeListId) && rows.length) {
      setActiveListId(rows[0].id);
    }
  }, [activeListId]);

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
    loadLists();
  }, []);
  useEffect(() => {
    if (activeListId) loadItems(activeListId);
  }, [activeListId]);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("[data-menu-root]")) return;
      setMenuItemId(null);
      setListMenuId(null);
      // close search when tapping anywhere outside search box / search button
      if (showSearch && !t.closest("[data-search-root]")) {
        setShowSearch(false);
        setSearchQuery("");
        setSearchHits([]);
      }
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [showSearch]);

  const runSearch = (q: string) => {
    setSearchQuery(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!q.trim()) {
      setSearchHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(() => {
      const up = q.toUpperCase().replace(/[^A-Z0-9.]/g, "");
      const hits = allSymbols
        .filter(
          (s) =>
            s.symbol.includes(up) ||
            (s.baseCoin || "").includes(up) ||
            (s.quoteCoin || "").includes(up)
        )
        .slice(0, 25);
      setSearchHits(hits);
      setSearching(false);
    }, 180);
  };

  const persistOrder = async (ordered: WatchItem[]) => {
    setItems(ordered);
    itemsRef.current = ordered;
    await Promise.all(
      ordered.map((item, idx) =>
        supabase
          .from("watchlist_items")
          .update({ sort_order: idx + 1 })
          .eq("id", item.id)
      )
    );
  };

  const reorderById = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const arr = [...itemsRef.current];
    const fromIdx = arr.findIndex((i) => i.id === fromId);
    const toIdx = arr.findIndex((i) => i.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = arr.splice(fromIdx, 1);
    arr.splice(toIdx, 0, moved);
    const withOrder = arr.map((item, i) => ({ ...item, sort_order: i + 1 }));
    setItems(withOrder);
    itemsRef.current = withOrder;
  };

  const finishDrag = async () => {
    const id = dragIdRef.current;
    dragIdRef.current = null;
    setDraggingId(null);
    setFloatPos(null);
    setDropTargetId(null);
    if (!id) return;
    const ordered = itemsRef.current.map((item, i) => ({
      ...item,
      sort_order: i + 1,
    }));
    await persistOrder(ordered);
  };

  const autoScroll = (clientY: number) => {
    const containers = [listScrollRef.current, gridScrollRef.current].filter(
      Boolean
    ) as HTMLDivElement[];
    for (const el of containers) {
      const rect = el.getBoundingClientRect();
      if (clientY < rect.top || clientY > rect.bottom) continue;
      const edge = 56;
      if (clientY < rect.top + edge) el.scrollTop -= 18;
      else if (clientY > rect.bottom - edge) el.scrollTop += 18;
    }
  };

  useEffect(() => {
    const onMove = (clientX: number, clientY: number) => {
      // Item drag
      if (dragIdRef.current) {
        setFloatPos({
          x: clientX - offsetRef.current.x,
          y: clientY - offsetRef.current.y,
        });
        autoScroll(clientY);
        const el = document.elementFromPoint(clientX, clientY);
        if (!el) return;
        const row = (el as HTMLElement).closest("[data-item-id]") as HTMLElement | null;
        if (!row) return;
        const targetId = row.getAttribute("data-item-id");
        if (targetId && targetId !== dragIdRef.current) {
          setDropTargetId(targetId);
          reorderById(dragIdRef.current, targetId);
        }
        return;
      }
      // List-tab drag — floating chip follows finger
      if (listDragIdRef.current) {
        setListFloatPos({
          x: clientX - listOffsetRef.current.x,
          y: clientY - listOffsetRef.current.y,
        });
        const el = document.elementFromPoint(clientX, clientY);
        if (!el) return;
        const tab = (el as HTMLElement).closest("[data-list-id]") as HTMLElement | null;
        if (!tab) return;
        const targetId = tab.getAttribute("data-list-id");
        if (targetId && targetId !== listDragIdRef.current) {
          setListDropTargetId(targetId);
          reorderListsById(listDragIdRef.current, targetId);
        }
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragIdRef.current && !listDragIdRef.current) return;
      e.preventDefault();
      onMove(e.clientX, e.clientY);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!dragIdRef.current && !listDragIdRef.current) return;
      if (e.touches[0]) {
        e.preventDefault();
        onMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    };
    const onEnd = () => {
      if (dragIdRef.current) finishDrag();
      if (listDragIdRef.current) finishListDrag();
    };
    document.addEventListener("pointermove", onPointerMove, { passive: false });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("pointerup", onEnd);
    document.addEventListener("touchend", onEnd);
    document.addEventListener("pointercancel", onEnd);
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("pointerup", onEnd);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("pointercancel", onEnd);
    };
  }, []);

  const startDrag = (
    id: string,
    clientX: number,
    clientY: number,
    rowEl: HTMLElement
  ) => {
    setMenuItemId(null);
    setListMenuId(null);
    const rect = rowEl.getBoundingClientRect();
    offsetRef.current = { x: clientX - rect.left, y: clientY - rect.top };
    setFloatSize({ w: rect.width, h: Math.max(rect.height, 56) });
    setFloatPos({ x: rect.left, y: rect.top });
    dragIdRef.current = id;
    setDraggingId(id);
    setDropTargetId(null);
  };

  const createList = async () => {
    const name = newListName.trim() || "New list";
    setSaving(true);
    try {
      const { data, error } = await supabase
        .from("watchlist_lists")
        .insert([{ name }])
        .select()
        .single();
      if (error) {
        alert(error.message);
        return;
      }
      setLists((prev) => {
        const next = [...prev, data];
        listsRef.current = next;
        saveLS(
          "wl_list_order",
          next.map((x) => x.id)
        );
        return next;
      });
      setActiveListId(data.id);
      setNewListName("");
      setShowNewList(false);
    } finally {
      setSaving(false);
    }
  };

  const deleteList = async (listId: string) => {
    if (!confirm("Delete this list and all its symbols?")) return;
    await supabase.from("watchlist_items").delete().eq("list_id", listId);
    await supabase.from("watchlist_lists").delete().eq("id", listId);
    setListMenuId(null);
    if (activeListId === listId) {
      setActiveListId(null);
      setItems([]);
    }
    // drop deleted id from saved order
    try {
      const order: string[] = loadLS("wl_list_order", []);
      saveLS(
        "wl_list_order",
        order.filter((id) => id !== listId)
      );
    } catch {}
    await loadLists();
  };

  const reorderListsById = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const arr = [...listsRef.current];
    const fromIdx = arr.findIndex((l) => l.id === fromId);
    const toIdx = arr.findIndex((l) => l.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = arr.splice(fromIdx, 1);
    arr.splice(toIdx, 0, moved);
    setLists(arr);
    listsRef.current = arr;
  };

  const finishListDrag = () => {
    const id = listDragIdRef.current;
    listDragIdRef.current = null;
    setDraggingListId(null);
    setListDropTargetId(null);
    setListFloatPos(null);
    if (!id) return;
    const order = listsRef.current.map((l) => l.id);
    saveLS("wl_list_order", order);
  };

  const startListDrag = (
    id: string,
    clientX: number,
    clientY: number,
    el: HTMLElement
  ) => {
    setMenuItemId(null);
    setListMenuId(null);
    const rect = el.getBoundingClientRect();
    listOffsetRef.current = { x: clientX - rect.left, y: clientY - rect.top };
    setListFloatSize({ w: rect.width, h: Math.max(rect.height, 32) });
    setListFloatPos({ x: rect.left, y: rect.top });
    listDragIdRef.current = id;
    setDraggingListId(id);
    setListDropTargetId(null);
  };

  const addSymbol = async (sym: string) => {
    if (!activeListId) return;
    const symbol = sym.toUpperCase();
    if (items.some((i) => i.symbol === symbol)) return;
    setSaving(true);
    try {
      const maxOrder = items.reduce((m, i) => Math.max(m, i.sort_order ?? 0), 0);
      const payload: any = {
        list_id: activeListId,
        symbol,
        note: null,
        sort_order: maxOrder + 1,
      };
      let { data, error } = await supabase
        .from("watchlist_items")
        .insert([payload])
        .select()
        .single();
      if (error && String(error.message || "").toLowerCase().includes("sort_order")) {
        delete payload.sort_order;
        const r = await supabase.from("watchlist_items").insert([payload]).select().single();
        data = r.data;
        error = r.error;
      }
      if (error) {
        alert(error.message);
        return;
      }
      setItems((prev) => [...prev, data]);
      setJustAdded(symbol);
      setTimeout(() => setJustAdded(null), 1200);
      if (!selectedSymbol) setSelectedSymbol(symbol);
    } finally {
      setSaving(false);
    }
  };

  const removeSymbol = async (sym: string) => {
    const symbol = sym.toUpperCase();
    const found = items.find((i) => i.symbol === symbol);
    if (!found) return;
    setSaving(true);
    try {
      await supabase.from("watchlist_items").delete().eq("id", found.id);
      setItems((prev) => prev.filter((i) => i.id !== found.id));
      if (selectedSymbol === symbol) setSelectedSymbol(null);
    } finally {
      setSaving(false);
    }
  };

  const toggleSymbol = async (sym: string) => {
    const symbol = sym.toUpperCase();
    if (items.some((i) => i.symbol === symbol)) await removeSymbol(symbol);
    else await addSymbol(symbol);
  };

  const deleteItem = async (id: string) => {
    await supabase.from("watchlist_items").delete().eq("id", id);
    setItems((prev) => prev.filter((i) => i.id !== id));
    setMenuItemId(null);
  };

  const goChart = (sym: string) => {
    localStorage.setItem("chart_symbol", sym);
    router.push("/dashboard");
  };

  const draggingItem = items.find((i) => i.id === draggingId);
  const inList = (sym: string) => items.some((i) => i.symbol === sym);

  const PriceBlock = ({ sym }: { sym: string }) => {
    const p = prices[sym];
    const pct = pcts[sym];
    if (p == null) return <span className="text-xs text-gray-600">—</span>;
    return (
      <div className="text-right">
        <div className="text-sm text-gray-100 font-medium">{formatPrice(p)}</div>
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

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      {draggingId && floatPos && draggingItem && (
        <div
          className="fixed z-[9999] pointer-events-none rounded-xl border-2 border-orange-500 bg-gray-900 shadow-2xl shadow-orange-500/40"
          style={{
            left: floatPos.x,
            top: floatPos.y,
            width: floatSize.w,
            minHeight: floatSize.h,
            transform: "scale(1.05) rotate(1.5deg)",
            boxShadow: "0 12px 40px rgba(249,115,22,0.35)",
          }}
        >
          <div className="flex items-center gap-2.5 px-3 py-3">
            <CoinIcon symbol={draggingItem.symbol} size={28} />
            <div className="min-w-0 flex-1 font-semibold text-sm text-white truncate">
              {draggingItem.symbol}
            </div>
            {prices[draggingItem.symbol] != null && (
              <span className="text-orange-400 text-xs font-medium">
                {formatPrice(prices[draggingItem.symbol])}
              </span>
            )}
          </div>
        </div>
      )}

      {draggingListId && listFloatPos && (
        <div
          className="fixed z-[9999] pointer-events-none rounded-full border-2 border-orange-500 bg-gray-900 px-3 py-1.5 shadow-2xl"
          style={{
            left: listFloatPos.x,
            top: listFloatPos.y,
            width: listFloatSize.w,
            minHeight: listFloatSize.h,
            transform: "scale(1.08) rotate(-2deg)",
            boxShadow: "0 10px 32px rgba(249,115,22,0.4)",
          }}
        >
          <div className="flex items-center justify-center h-full text-sm font-medium text-orange-300">
            {lists.find((x) => x.id === draggingListId)?.name || "…"}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Watchlist</h1>
          {!showSearch && (
            <button
              type="button"
              onClick={() => setShowSearch(true)} data-search-root
              className="w-10 h-10 rounded-full bg-gray-800 border border-gray-700 flex items-center justify-center text-gray-300 hover:border-orange-500"
              title="Search symbols"
            >
              🔍
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setViewMode("grid")}
            className={`px-3 py-2 rounded-lg text-sm ${
              viewMode === "grid" ? "bg-orange-500 text-white" : "bg-gray-800 text-gray-300"
            }`}
          >
            ▦ Grid
          </button>
          <button
            type="button"
            onClick={() => setViewMode("list")}
            className={`px-3 py-2 rounded-lg text-sm ${
              viewMode === "list" ? "bg-orange-500 text-white" : "bg-gray-800 text-gray-300"
            }`}
          >
            ☰ List
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        {lists.map((l) => (
          <div key={l.id} className="flex items-center gap-0">
            {draggingListId &&
              listDropTargetId === l.id &&
              draggingListId !== l.id && (
                <div
                  className="rounded-full border-2 border-dashed border-orange-500/70 bg-orange-500/10 shrink-0"
                  style={{ width: listFloatSize.w, height: listFloatSize.h }}
                />
              )}
          <div
            data-list-id={l.id}
            className={`relative flex items-center select-none transition-all duration-150 ${
              draggingListId === l.id
                ? "opacity-20 scale-90"
                : ""
            }`}
            data-menu-root
          >
            <button
              type="button"
              onClick={() => {
                if (draggingListId) return;
                setActiveListId(l.id);
                setListMenuId(null);
                setMenuItemId(null);
              }}
              className={`px-3 py-1.5 rounded-full text-sm ${
                activeListId === l.id
                  ? "bg-orange-500 text-white"
                  : "bg-gray-800 text-gray-300"
              }`}
            >
              {l.name}
            </button>
            <div
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const startX = e.clientX;
                const startY = e.clientY;
                let dragged = false;
                // start drag after small move OR 120ms hold
                const chip = (e.currentTarget as HTMLElement).closest(
                  "[data-list-id]"
                ) as HTMLElement;
                const timer = setTimeout(() => {
                  if (!dragged && chip) {
                    dragged = true;
                    startListDrag(l.id, startX, startY, chip);
                  }
                }, 120);
                const onMove = (ev: PointerEvent) => {
                  const dx = Math.abs(ev.clientX - startX);
                  const dy = Math.abs(ev.clientY - startY);
                  if (!dragged && chip && (dx > 6 || dy > 6)) {
                    dragged = true;
                    clearTimeout(timer);
                    startListDrag(l.id, startX, startY, chip);
                  }
                };
                const onUp = () => {
                  clearTimeout(timer);
                  window.removeEventListener("pointermove", onMove);
                  window.removeEventListener("pointerup", onUp);
                  if (!dragged) {
                    setMenuItemId(null);
                    setListMenuId((prev) => (prev === l.id ? null : l.id));
                  }
                };
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", onUp);
              }}
              className="ml-0.5 w-8 h-8 flex items-center justify-center rounded-full text-gray-500 hover:text-white hover:bg-gray-800 text-base leading-none cursor-grab active:cursor-grabbing touch-none"
              style={{ touchAction: "none" }}
              title="Drag to reorder lists · tap for menu"
            >
              ⋮⋮
            </div>
            {listMenuId === l.id && !draggingListId && (
              <div
                className="absolute top-full left-0 mt-1 z-[80] bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[140px]"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteList(l.id);
                  }}
                  className="w-full text-left px-3 py-2.5 text-sm text-red-400 hover:bg-gray-800"
                >
                  Delete list
                </button>
              </div>
            )}
          </div>
          </div>
        ))}
        <button
          type="button"
          onClick={() => setShowNewList(!showNewList)}
          className="px-3 py-1.5 rounded-full text-sm bg-gray-800 text-gray-300"
        >
          + New list
        </button>
      </div>

      {showNewList && (
        <div className="flex gap-2 mb-4">
          <input
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            placeholder="List name"
            className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm"
          />
          <button
            type="button"
            onClick={createList}
            disabled={saving}
            className="bg-orange-500 text-white px-4 py-2 rounded-lg text-sm"
          >
            Create
          </button>
        </div>
      )}

      {viewMode === "grid" && (
        <div className="flex flex-wrap gap-2 mb-4">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.value}
              type="button"
              onClick={() => setIntervalTf(tf.value)}
              className={`px-3 py-1.5 rounded text-sm ${
                interval === tf.value
                  ? "bg-orange-500 text-white"
                  : "bg-gray-800 text-gray-300"
              }`}
            >
              {tf.label}
            </button>
          ))}
        </div>
      )}

      {showSearch && (
        <div
          className="mb-6 relative"
          data-search-root
        >
          <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden shadow-xl">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800">
              <span className="text-gray-500">🔍</span>
              <input
                autoFocus
                value={searchQuery}
                onChange={(e) => runSearch(e.target.value)}
                placeholder="Search symbol (BTC, ETH…)"
                className="flex-1 bg-transparent outline-none text-white text-sm py-1"
              />
              {searching && (
                <span className="text-xs text-orange-400 animate-pulse">Searching…</span>
              )}
              <button
                type="button"
                onClick={() => {
                  setShowSearch(false);
                  setSearchQuery("");
                  setSearchHits([]);
                }}
                className="text-gray-400 text-sm px-2"
              >
                Close
              </button>
            </div>
            <div className="max-h-72 overflow-y-auto">
              {!searchQuery.trim() && (
                <p className="text-gray-500 text-sm p-4">Type a symbol to search…</p>
              )}
              {searchQuery.trim() && !searching && searchHits.length === 0 && (
                <p className="text-gray-500 text-sm p-4">No results</p>
              )}
              {searchHits.map((hit) => {
                const added = inList(hit.symbol);
                const flash = justAdded === hit.symbol;
                const p = prices[hit.symbol];
                const pct = pcts[hit.symbol];
                return (
                  <div
                    key={`${hit.market}-${hit.symbol}`}
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
                              : hit.market === "Index"
                              ? "bg-amber-900/60 text-amber-300"
                              : "bg-purple-900/60 text-purple-300"
                          }`}
                        >
                          {hit.market}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500">
                        {hit.baseCoin}/{hit.quoteCoin}
                      </div>
                    </div>
                    <div className="text-right shrink-0 min-w-[88px]">
                      {p != null ? (
                        <>
                          <div className="text-sm text-gray-100 font-medium">
                            {formatPrice(p)}
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
                        </>
                      ) : (
                        <span className="text-xs text-gray-600">—</span>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => toggleSymbol(hit.symbol)}
                      title={added ? "Remove from list" : "Add to list"}
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-lg font-bold shrink-0 ${
                        added || flash
                          ? "bg-green-600 text-white hover:bg-red-600"
                          : "bg-gray-700 text-gray-200 hover:bg-orange-500"
                      }`}
                    >
                      {added || flash ? "✓" : "+"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {!activeListId && (
        <p className="text-gray-500 text-sm">Create a list first, then add symbols.</p>
      )}

      {viewMode === "grid" && activeListId && (
        <div
          ref={gridScrollRef}
          className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 max-h-[70vh] overflow-y-auto"
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
                    <CoinIcon symbol={item.symbol} size={26} />
                    <div className="font-semibold text-sm truncate">{item.symbol}</div>
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
                    symbol={item.symbol}
                    interval={interval}
                    pct={pcts[item.symbol]}
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
                      selectedSymbol === item.symbol && draggingId !== item.id
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

                    <CoinIcon symbol={item.symbol} size={28} />

                    <button
                      type="button"
                      onClick={() => {
                        if (!draggingId) setSelectedSymbol(item.symbol);
                      }}
                      className="flex-1 min-w-0 text-left py-3"
                    >
                      <div className="font-medium text-sm truncate">{item.symbol}</div>
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

          <div className="flex-1 min-w-0">
            {selectedSymbol ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                  <div className="flex items-center gap-3">
                    <CoinIcon symbol={selectedSymbol} size={32} />
                    <h2 className="text-lg font-bold">{selectedSymbol}</h2>
                    <button
                      type="button"
                      onClick={() => goChart(selectedSymbol)}
                      className="text-orange-400 text-sm hover:underline"
                    >
                      Open full chart →
                    </button>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={lineMode}
                      onChange={(e) => setLineMode(e.target.checked)}
                      className="accent-orange-500"
                    />
                    Line chart
                  </label>
                </div>

                <DetailChart
                  key={`${selectedSymbol}-${interval}-${lineMode}`}
                  symbol={selectedSymbol}
                  interval={interval}
                  lineMode={lineMode}
                />

                <div className="flex flex-wrap gap-2 mt-3">
                  {TIMEFRAMES.map((tf) => (
                    <button
                      key={tf.value}
                      type="button"
                      onClick={() => setIntervalTf(tf.value)}
                      className={`px-3 py-1.5 rounded text-sm ${
                        interval === tf.value
                          ? "bg-orange-500 text-white"
                          : "bg-gray-800 text-gray-300"
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
    </div>
  );
}

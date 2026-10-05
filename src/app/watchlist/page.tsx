"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createChart, IChartApi, ISeriesApi, LineStyle } from "lightweight-charts";
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
  market: "Spot" | "Futures";
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

function MiniChart({ symbol, interval }: { symbol: string; interval: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = "";
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
      lineColor: "#f97316",
      topColor: "rgba(249,115,22,0.35)",
      bottomColor: "rgba(249,115,22,0.02)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });

    (async () => {
      try {
        const res = await fetch(
          `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${interval}&limit=60`
        );
        const data = await res.json();
        const list = data.result?.list;
        if (!list?.length) return;
        const rows = list
          .map((item: any) => ({
            time: Number(item[0]) / 1000,
            value: parseFloat(item[4]),
          }))
          .reverse();
        series.setData(rows as any);
        chart.timeScale().fitContent();
      } catch {}
    })();

    return () => {
      chart.remove();
    };
  }, [symbol, interval]);

  return <div ref={ref} className="w-full h-20 pointer-events-none" />;
}

/** lineMode = true → line chart ; false → candles */
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
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = "";

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

    let candleSeries: ISeriesApi<"Candlestick"> | null = null;
    let lineSeries: ISeriesApi<"Area"> | null = null;

    if (lineMode) {
      lineSeries = chart.addAreaSeries({
        lineColor: "#22c55e",
        topColor: "rgba(34,197,94,0.25)",
        bottomColor: "rgba(34,197,94,0.02)",
        lineWidth: 2,
        priceLineVisible: true,
        lastValueVisible: true,
      });
    } else {
      candleSeries = chart.addCandlestickSeries({
        upColor: "#22c55e",
        downColor: "#ef4444",
        borderVisible: false,
        wickUpColor: "#22c55e",
        wickDownColor: "#ef4444",
      });
    }

    const onResize = () => {
      if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
    };
    window.addEventListener("resize", onResize);

    (async () => {
      try {
        const res = await fetch(
          `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${interval}&limit=200`
        );
        const data = await res.json();
        const list = data.result?.list;
        if (!list?.length) return;

        if (lineMode && lineSeries) {
          const rows = list
            .map((item: any) => ({
              time: Number(item[0]) / 1000,
              value: parseFloat(item[4]),
            }))
            .reverse();
          const last = rows[rows.length - 1]?.value || 0;
          const { precision, minMove } = getPrecision(last);
          lineSeries.applyOptions({
            priceFormat: { type: "price", precision, minMove },
          });
          lineSeries.setData(rows as any);
        } else if (candleSeries) {
          const candles = list
            .map((item: any) => ({
              time: Number(item[0]) / 1000,
              open: parseFloat(item[1]),
              high: parseFloat(item[2]),
              low: parseFloat(item[3]),
              close: parseFloat(item[4]),
            }))
            .reverse();
          const last = candles[candles.length - 1].close;
          const { precision, minMove } = getPrecision(last);
          candleSeries.applyOptions({
            priceFormat: { type: "price", precision, minMove },
          });
          candleSeries.setData(candles as any);
        }
        chart.timeScale().fitContent();
      } catch {}
    })();

    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
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
  const [lineMode, setLineMode] = useState(false); // Price line toggle = line chart
  const [saving, setSaving] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [allSymbols, setAllSymbols] = useState<SearchHit[]>([]);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [priceTimes, setPriceTimes] = useState<Record<string, string>>({});
  const [menuItemId, setMenuItemId] = useState<string | null>(null);
  const [listMenuId, setListMenuId] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<string | null>(null);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [floatPos, setFloatPos] = useState<{ x: number; y: number } | null>(null);
  const [floatSize, setFloatSize] = useState<{ w: number; h: number }>({ w: 200, h: 52 });
  const dragIdRef = useRef<string | null>(null);
  const itemsRef = useRef<WatchItem[]>([]);
  const offsetRef = useRef({ x: 0, y: 0 });
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => {
    saveLS("wl_tf", interval);
  }, [interval]);
  useEffect(() => {
    saveLS("wl_view", viewMode);
  }, [viewMode]);

  // load Spot + Futures symbols
  useEffect(() => {
    (async () => {
      try {
        const [spotRes, futRes] = await Promise.all([
          fetch(
            "https://api.bybit.com/v5/market/instruments-info?category=spot&status=Trading&limit=1000"
          ),
          fetch(
            "https://api.bybit.com/v5/market/instruments-info?category=linear&status=Trading&limit=1000"
          ),
        ]);
        const spotData = await spotRes.json();
        const futData = await futRes.json();
        const spot = (spotData.result?.list || []).map((x: any) => ({
          symbol: x.symbol as string,
          baseCoin: x.baseCoin as string,
          quoteCoin: x.quoteCoin as string,
          market: "Spot" as const,
        }));
        const fut = (futData.result?.list || []).map((x: any) => ({
          symbol: x.symbol as string,
          baseCoin: x.baseCoin as string,
          quoteCoin: x.quoteCoin as string,
          market: "Futures" as const,
        }));
        // prefer Spot first; avoid duplicate symbols (keep Spot)
        const seen = new Set<string>();
        const merged: SearchHit[] = [];
        for (const s of [...spot, ...fut]) {
          if (seen.has(s.symbol)) continue;
          seen.add(s.symbol);
          merged.push(s);
        }
        setAllSymbols(merged);
      } catch {}
    })();
  }, []);

  // live prices + time
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
      const nextP: Record<string, number> = {};
      const nextT: Record<string, string> = {};
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(
        now.getMinutes()
      ).padStart(2, "0")}`;
      await Promise.all(
        symbols.map(async (sym) => {
          try {
            const res = await fetch(
              `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${sym}`
            );
            const data = await res.json();
            const p = parseFloat(data.result?.list?.[0]?.lastPrice);
            if (p && !Number.isNaN(p)) {
              nextP[sym] = p;
              nextT[sym] = timeStr;
            }
          } catch {}
        })
      );
      if (!cancelled) {
        setPrices((prev) => ({ ...prev, ...nextP }));
        setPriceTimes((prev) => ({ ...prev, ...nextT }));
      }
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
    const rows = data || [];
    setLists(rows);
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
    const close = () => {
      setMenuItemId(null);
      setListMenuId(null);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

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
    if (!id) return;
    const ordered = itemsRef.current.map((item, i) => ({
      ...item,
      sort_order: i + 1,
    }));
    await persistOrder(ordered);
  };

  useEffect(() => {
    const onMove = (clientX: number, clientY: number) => {
      if (!dragIdRef.current) return;
      setFloatPos({
        x: clientX - offsetRef.current.x,
        y: clientY - offsetRef.current.y,
      });
      const el = document.elementFromPoint(clientX, clientY);
      if (!el) return;
      const row = (el as HTMLElement).closest("[data-item-id]") as HTMLElement | null;
      if (!row) return;
      const targetId = row.getAttribute("data-item-id");
      if (targetId && targetId !== dragIdRef.current) {
        reorderById(dragIdRef.current, targetId);
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragIdRef.current) return;
      e.preventDefault();
      onMove(e.clientX, e.clientY);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!dragIdRef.current) return;
      if (e.touches[0]) {
        e.preventDefault();
        onMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    };
    const onEnd = () => {
      if (dragIdRef.current) finishDrag();
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
    setFloatSize({ w: rect.width, h: Math.max(rect.height, 52) });
    setFloatPos({ x: rect.left, y: rect.top });
    dragIdRef.current = id;
    setDraggingId(id);
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
      setLists((prev) => [...prev, data]);
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
    await loadLists();
  };

  const addSymbol = async (sym: string) => {
    if (!activeListId) return;
    const symbol = sym.toUpperCase();
    if (items.some((i) => i.symbol === symbol)) {
      setJustAdded(symbol);
      setTimeout(() => setJustAdded(null), 1200);
      return;
    }
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
      setTimeout(() => setJustAdded(null), 1500);
      if (!selectedSymbol) setSelectedSymbol(symbol);
    } finally {
      setSaving(false);
    }
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

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      {draggingId && floatPos && draggingItem && (
        <div
          className="fixed z-[9999] pointer-events-none rounded-xl border-2 border-orange-500 bg-gray-900 shadow-2xl shadow-orange-500/30"
          style={{
            left: floatPos.x,
            top: floatPos.y,
            width: floatSize.w,
            minHeight: floatSize.h,
            transform: "scale(1.04) rotate(1deg)",
          }}
        >
          <div className="flex items-center gap-2 px-3 py-3">
            <span className="text-gray-500">⋮⋮</span>
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

      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h1 className="text-2xl font-bold">Watchlist</h1>
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

      {/* List tabs + working ⋮ menu */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {lists.map((l) => (
          <div key={l.id} className="relative flex items-center">
            <button
              type="button"
              onClick={() => {
                setActiveListId(l.id);
                setListMenuId(null);
              }}
              className={`px-3 py-1.5 rounded-full text-sm ${
                activeListId === l.id
                  ? "bg-orange-500 text-white"
                  : "bg-gray-800 text-gray-300"
              }`}
            >
              {l.name}
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMenuItemId(null);
                setListMenuId((prev) => (prev === l.id ? null : l.id));
              }}
              className="ml-0.5 w-7 h-7 flex items-center justify-center rounded-full text-gray-400 hover:text-white hover:bg-gray-800 text-base"
            >
              ⋮
            </button>
            {listMenuId === l.id && (
              <div
                className="absolute top-full left-0 mt-1 z-[60] bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[130px]"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={() => deleteList(l.id)}
                  className="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-gray-800"
                >
                  Delete list
                </button>
              </div>
            )}
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

      {/* Search */}
      <div className="mb-6 relative">
        {!showSearch ? (
          <button
            type="button"
            onClick={() => setShowSearch(true)}
            className="w-10 h-10 rounded-full bg-gray-800 border border-gray-700 flex items-center justify-center text-gray-300 hover:border-orange-500"
          >
            🔍
          </button>
        ) : (
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
                const price = prices[hit.symbol];
                const time = priceTimes[hit.symbol];
                return (
                  <div
                    key={`${hit.market}-${hit.symbol}`}
                    className="flex items-center gap-3 px-4 py-2.5 hover:bg-gray-800 border-b border-gray-800/50"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
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
                      </div>
                      <div className="text-xs text-gray-500">
                        {hit.baseCoin}/{hit.quoteCoin}
                      </div>
                    </div>
                    {/* price + time */}
                    <div className="text-right shrink-0 min-w-[90px]">
                      {price != null ? (
                        <>
                          <div className="text-sm text-gray-100 font-medium">
                            {formatPrice(price)}
                          </div>
                          {time && (
                            <div className="text-[10px] text-gray-500">{time}</div>
                          )}
                        </>
                      ) : (
                        <span className="text-xs text-gray-600">—</span>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => addSymbol(hit.symbol)}
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-lg font-bold shrink-0 ${
                        added || flash
                          ? "bg-green-600 text-white"
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
        )}
      </div>

      {!activeListId && (
        <p className="text-gray-500 text-sm">Create a list first, then add symbols.</p>
      )}

      {/* GRID */}
      {viewMode === "grid" && activeListId && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {items.map((item) => (
            <div
              key={item.id}
              data-item-id={item.id}
              className={`bg-gray-900 border rounded-xl p-3 select-none transition-all duration-200 ${
                draggingId === item.id
                  ? "opacity-20 border-dashed border-orange-500/60"
                  : "border-gray-800"
              }`}
              style={{ WebkitUserSelect: "none", userSelect: "none" }}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="min-w-0">
                  <div className="font-semibold text-sm truncate">{item.symbol}</div>
                  {prices[item.symbol] != null && (
                    <div className="text-orange-400 text-xs">
                      {formatPrice(prices[item.symbol])}
                      {priceTimes[item.symbol] && (
                        <span className="text-gray-500 ml-1">
                          {priceTimes[item.symbol]}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div className="relative">
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
                      }, 160);
                      const onUp = () => {
                        clearTimeout(timer);
                        if (!dragged) {
                          setListMenuId(null);
                          setMenuItemId((prev) => (prev === item.id ? null : item.id));
                        }
                        window.removeEventListener("pointerup", onUp);
                      };
                      window.addEventListener("pointerup", onUp);
                    }}
                    className="w-9 h-9 flex items-center justify-center text-gray-500 text-lg cursor-grab touch-none"
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
              {draggingId !== item.id && (
                <MiniChart symbol={item.symbol} interval={interval} />
              )}
              <button
                type="button"
                onClick={() => goChart(item.symbol)}
                className="text-orange-400 text-xs hover:underline mt-2"
              >
                Chart
              </button>
            </div>
          ))}
          {!items.length && (
            <p className="text-gray-500 text-sm col-span-full">No symbols yet. Tap 🔍 to add.</p>
          )}
        </div>
      )}

      {/* LIST */}
      {viewMode === "list" && activeListId && (
        <div className="flex flex-col md:flex-row gap-4 min-h-[480px]">
          <div className="w-full md:w-80 shrink-0 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col max-h-[520px]">
            {/* help text removed */}
            <div className="overflow-y-auto flex-1">
              {items.map((item) => (
                <div
                  key={item.id}
                  data-item-id={item.id}
                  className={`flex items-center gap-1 px-2 border-b border-gray-800/80 select-none transition-all duration-150 ${
                    selectedSymbol === item.symbol && draggingId !== item.id
                      ? "bg-gray-800 border-l-2 border-l-orange-500"
                      : ""
                  } ${
                    draggingId === item.id
                      ? "opacity-25 border border-dashed border-orange-500/50"
                      : ""
                  }`}
                  style={{
                    WebkitUserSelect: "none",
                    userSelect: "none",
                    minHeight: 52,
                  }}
                >
                  <div className="relative shrink-0">
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
                        }, 150);
                        const onUp = () => {
                          clearTimeout(timer);
                          if (!dragged) {
                            setListMenuId(null);
                            setMenuItemId((prev) => (prev === item.id ? null : item.id));
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

                  <div className="text-right shrink-0 pr-1 min-w-[80px]">
                    {prices[item.symbol] != null ? (
                      <>
                        <div className="text-sm text-gray-200 font-medium">
                          {formatPrice(prices[item.symbol])}
                        </div>
                        {priceTimes[item.symbol] && (
                          <div className="text-[10px] text-gray-500">
                            {priceTimes[item.symbol]}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-xs text-gray-600">—</span>
                    )}
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

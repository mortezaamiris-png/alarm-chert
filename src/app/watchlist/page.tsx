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

function DetailChart({
  symbol,
  interval,
  showPriceLine,
}: {
  symbol: string;
  interval: string;
  showPriceLine: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lineRef = useRef<any>(null);
  const lastPriceRef = useRef<number>(0);

  // init chart once
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
    const series = chart.addCandlestickSeries({
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });
    chartRef.current = chart;
    seriesRef.current = series;

    const onResize = () => {
      if (ref.current) chart.applyOptions({ width: ref.current.clientWidth });
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      lineRef.current = null;
    };
  }, []);

  // load candles when symbol/interval change
  useEffect(() => {
    if (!seriesRef.current || !symbol) return;
    (async () => {
      try {
        const res = await fetch(
          `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${interval}&limit=200`
        );
        const data = await res.json();
        const list = data.result?.list;
        if (!list?.length) return;
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
        lastPriceRef.current = last;
        const { precision, minMove } = getPrecision(last);
        seriesRef.current!.applyOptions({
          priceFormat: { type: "price", precision, minMove },
        });
        seriesRef.current!.setData(candles as any);
        chartRef.current?.timeScale().fitContent();

        // re-apply price line after data load
        if (lineRef.current) {
          try {
            seriesRef.current!.removePriceLine(lineRef.current);
          } catch {}
          lineRef.current = null;
        }
        if (showPriceLine && last) {
          lineRef.current = seriesRef.current!.createPriceLine({
            price: last,
            color: "#f97316",
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: true,
            title: "Last",
          });
        }
      } catch {}
    })();
  }, [symbol, interval]);

  // toggle price line only (without reloading candles)
  useEffect(() => {
    if (!seriesRef.current) return;
    if (lineRef.current) {
      try {
        seriesRef.current.removePriceLine(lineRef.current);
      } catch {}
      lineRef.current = null;
    }
    if (showPriceLine && lastPriceRef.current > 0) {
      lineRef.current = seriesRef.current.createPriceLine({
        price: lastPriceRef.current,
        color: "#f97316",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "Last",
      });
    }
  }, [showPriceLine]);

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
  const [showPriceLine, setShowPriceLine] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [allSymbols, setAllSymbols] = useState<SearchHit[]>([]);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [menuItemId, setMenuItemId] = useState<string | null>(null);
  const [listMenuId, setListMenuId] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<string | null>(null);

  // Drag
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

  // preload symbol list once for search
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(
          "https://api.bybit.com/v5/market/instruments-info?category=spot&status=Trading&limit=1000"
        );
        const data = await res.json();
        const list = (data.result?.list || []).map((x: any) => ({
          symbol: x.symbol as string,
          baseCoin: x.baseCoin as string,
          quoteCoin: x.quoteCoin as string,
        }));
        setAllSymbols(list);
      } catch {}
    })();
  }, []);

  // live prices
  useEffect(() => {
    if (!items.length) return;
    let cancelled = false;
    const fetchPrices = async () => {
      const symbols = Array.from(new Set(items.map((i) => i.symbol.toUpperCase())));
      const next: Record<string, number> = {};
      await Promise.all(
        symbols.map(async (sym) => {
          try {
            const res = await fetch(
              `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${sym}`
            );
            const data = await res.json();
            const p = parseFloat(data.result?.list?.[0]?.lastPrice);
            if (p && !Number.isNaN(p)) next[sym] = p;
          } catch {}
        })
      );
      if (!cancelled) setPrices((prev) => ({ ...prev, ...next }));
    };
    fetchPrices();
    const id = setInterval(fetchPrices, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [items]);

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

  // search filter
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
      const up = q.toUpperCase().replace(/[^A-Z0-9]/g, "");
      const hits = allSymbols
        .filter(
          (s) =>
            s.symbol.includes(up) ||
            (s.baseCoin || "").includes(up) ||
            (s.quoteCoin || "").includes(up)
        )
        .slice(0, 20);
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
    const rect = rowEl.getBoundingClientRect();
    offsetRef.current = {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
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
      {/* Floating card */}
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
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-sm text-white truncate">
                {draggingItem.symbol}
              </div>
            </div>
            {prices[draggingItem.symbol] != null && (
              <span className="text-orange-400 text-xs font-medium">
                {formatPrice(prices[draggingItem.symbol])}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Title — NO Go chart */}
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

      {/* List tabs */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {lists.map((l) => (
          <div key={l.id} className="relative">
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
                setListMenuId(listMenuId === l.id ? null : l.id);
              }}
              className="ml-0.5 px-1.5 py-1 text-gray-500 hover:text-gray-300 text-xs"
            >
              ⋮
            </button>
            {listMenuId === l.id && (
              <div
                className="absolute top-full left-0 mt-1 z-50 bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[120px]"
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

      {/* Search — TradingView style */}
      <div className="mb-6 relative">
        {!showSearch ? (
          <button
            type="button"
            onClick={() => setShowSearch(true)}
            className="w-10 h-10 rounded-full bg-gray-800 border border-gray-700 flex items-center justify-center text-gray-300 hover:border-orange-500"
            title="Search"
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
                placeholder="Search symbol (BTC, ETH, SOL…)"
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
            <div className="max-h-64 overflow-y-auto">
              {!searchQuery.trim() && (
                <p className="text-gray-500 text-sm p-4">Type a symbol to search…</p>
              )}
              {searchQuery.trim() && !searching && searchHits.length === 0 && (
                <p className="text-gray-500 text-sm p-4">No results</p>
              )}
              {searchHits.map((hit) => {
                const added = inList(hit.symbol);
                const flash = justAdded === hit.symbol;
                return (
                  <div
                    key={hit.symbol}
                    className="flex items-center justify-between px-4 py-2.5 hover:bg-gray-800 border-b border-gray-800/50"
                  >
                    <div>
                      <div className="font-medium text-sm">{hit.symbol}</div>
                      <div className="text-xs text-gray-500">
                        {hit.baseCoin}/{hit.quoteCoin}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => addSymbol(hit.symbol)}
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-lg font-bold transition ${
                        added || flash
                          ? "bg-green-600 text-white"
                          : "bg-gray-700 text-gray-200 hover:bg-orange-500 hover:text-white"
                      }`}
                      title={added ? "Already in list" : "Add"}
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
                  ? "opacity-20 border-dashed border-orange-500/60 scale-[0.97]"
                  : "border-gray-800"
              }`}
              style={{
                WebkitUserSelect: "none",
                userSelect: "none",
                minHeight: draggingId === item.id ? floatSize.h : undefined,
              }}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="min-w-0">
                  <div className="font-semibold text-sm truncate">{item.symbol}</div>
                  {prices[item.symbol] != null && (
                    <div className="text-orange-400 text-xs">
                      {formatPrice(prices[item.symbol])}
                    </div>
                  )}
                  {item.note && (
                    <p className="text-gray-500 text-xs truncate">{item.note}</p>
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
                          setMenuItemId((prev) => (prev === item.id ? null : item.id));
                        }
                        window.removeEventListener("pointerup", onUp);
                      };
                      window.addEventListener("pointerup", onUp);
                    }}
                    className="w-9 h-9 flex items-center justify-center text-gray-500 text-lg cursor-grab active:cursor-grabbing touch-none"
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
              <div className="flex justify-between mt-2 text-xs">
                <button
                  type="button"
                  onClick={() => goChart(item.symbol)}
                  className="text-orange-400 hover:underline"
                >
                  Chart
                </button>
              </div>
            </div>
          ))}
          {!items.length && (
            <p className="text-gray-500 text-sm col-span-full">No symbols yet. Tap 🔍 to add.</p>
          )}
        </div>
      )}

      {/* LIST + CHART */}
      {viewMode === "list" && activeListId && (
        <div className="flex flex-col md:flex-row gap-4 min-h-[480px]">
          <div className="w-full md:w-80 shrink-0 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col max-h-[520px]">
            <div className="px-3 py-2 border-b border-gray-800 text-xs text-gray-400">
              Hold ⋮⋮ to drag · Tap ⋮⋮ for menu · Tap name to preview
            </div>
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
                      ? "opacity-25 border border-dashed border-orange-500/50 bg-gray-950"
                      : ""
                  }`}
                  style={{
                    WebkitUserSelect: "none",
                    userSelect: "none",
                    minHeight: 52,
                    height: draggingId === item.id ? floatSize.h : undefined,
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
                            setMenuItemId((prev) => (prev === item.id ? null : item.id));
                          }
                          window.removeEventListener("pointerup", onUp);
                        };
                        window.addEventListener("pointerup", onUp);
                      }}
                      className="w-8 h-12 flex items-center justify-center text-gray-500 cursor-grab active:cursor-grabbing touch-none"
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

                  <div className="text-right shrink-0 pr-1 min-w-[72px]">
                    {prices[item.symbol] != null ? (
                      <span className="text-sm text-gray-200 font-medium">
                        {formatPrice(prices[item.symbol])}
                      </span>
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
                      checked={showPriceLine}
                      onChange={(e) => setShowPriceLine(e.target.checked)}
                      className="accent-orange-500"
                    />
                    Price line
                  </label>
                </div>

                <DetailChart
                  key={`${selectedSymbol}-${interval}`}
                  symbol={selectedSymbol}
                  interval={interval}
                  showPriceLine={showPriceLine}
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

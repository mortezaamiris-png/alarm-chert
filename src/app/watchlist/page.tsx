"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createChart, IChartApi, ISeriesApi, LineStyle } from "lightweight-charts";
import { supabase } from "@/lib/supabase";
import Link from "next/link";
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
        const { precision, minMove } = getPrecision(last);
        seriesRef.current!.applyOptions({
          priceFormat: { type: "price", precision, minMove },
        });
        seriesRef.current!.setData(candles as any);
        chartRef.current?.timeScale().fitContent();

        if (lineRef.current) {
          try {
            seriesRef.current!.removePriceLine(lineRef.current);
          } catch {}
          lineRef.current = null;
        }
        if (showPriceLine) {
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
  }, [symbol, interval, showPriceLine]);

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
  const [symbolInput, setSymbolInput] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const [newListName, setNewListName] = useState("");
  const [showNewList, setShowNewList] = useState(false);
  const [interval, setIntervalTf] = useState(() => loadLS("wl_tf", "60"));
  const [viewMode, setViewMode] = useState<ViewMode>(() => loadLS("wl_view", "grid"));
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [showPriceLine, setShowPriceLine] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    saveLS("wl_tf", interval);
  }, [interval]);
  useEffect(() => {
    saveLS("wl_view", viewMode);
  }, [viewMode]);

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

  const persistOrder = async (ordered: WatchItem[]) => {
    setItems(ordered);
    await Promise.all(
      ordered.map((item, idx) =>
        supabase
          .from("watchlist_items")
          .update({ sort_order: idx + 1 })
          .eq("id", item.id)
      )
    );
  };

  /** Move item up or down by one step — works on iPad */
  const moveItem = async (id: string, direction: "up" | "down") => {
    const idx = items.findIndex((i) => i.id === id);
    if (idx < 0) return;
    const newIdx = direction === "up" ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= items.length) return;
    const arr = [...items];
    const [moved] = arr.splice(idx, 1);
    arr.splice(newIdx, 0, moved);
    const withOrder = arr.map((item, i) => ({ ...item, sort_order: i + 1 }));
    await persistOrder(withOrder);
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

  const deleteList = async () => {
    if (!activeListId) return;
    if (!confirm("Delete this list and all its symbols?")) return;
    await supabase.from("watchlist_items").delete().eq("list_id", activeListId);
    await supabase.from("watchlist_lists").delete().eq("id", activeListId);
    setActiveListId(null);
    setItems([]);
    await loadLists();
  };

  const addItem = async () => {
    if (!activeListId) return;
    const sym = symbolInput.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!sym || sym.length < 5) {
      alert("Enter a valid symbol e.g. BTCUSDT");
      return;
    }
    if (items.some((i) => i.symbol === sym)) {
      alert("Already in list");
      return;
    }
    setSaving(true);
    try {
      const maxOrder = items.reduce((m, i) => Math.max(m, i.sort_order ?? 0), 0);
      const payload: any = {
        list_id: activeListId,
        symbol: sym,
        note: noteInput.trim() || null,
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
      setSymbolInput("");
      setNoteInput("");
      if (!selectedSymbol) setSelectedSymbol(sym);
    } finally {
      setSaving(false);
    }
  };

  const deleteItem = async (id: string) => {
    await supabase.from("watchlist_items").delete().eq("id", id);
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  const goChart = (sym: string) => {
    localStorage.setItem("chart_symbol", sym);
    router.push("/dashboard");
  };

  /** Reorder controls — works on touch + mouse */
  const MoveButtons = ({ id, index }: { id: string; index: number }) => (
    <div className="flex flex-col gap-0.5 shrink-0">
      <button
        type="button"
        disabled={index === 0}
        onClick={(e) => {
          e.stopPropagation();
          moveItem(id, "up");
        }}
        className={`w-7 h-7 rounded text-xs leading-none ${
          index === 0
            ? "bg-gray-800 text-gray-600"
            : "bg-gray-700 text-white active:bg-orange-500"
        }`}
        title="Move up"
      >
        ▲
      </button>
      <button
        type="button"
        disabled={index === items.length - 1}
        onClick={(e) => {
          e.stopPropagation();
          moveItem(id, "down");
        }}
        className={`w-7 h-7 rounded text-xs leading-none ${
          index === items.length - 1
            ? "bg-gray-800 text-gray-600"
            : "bg-gray-700 text-white active:bg-orange-500"
        }`}
        title="Move down"
      >
        ▼
      </button>
    </div>
  );

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <Link href="/dashboard" className="text-orange-400 text-sm hover:underline">
            ← Back to Chart
          </Link>
          <h1 className="text-2xl font-bold">Watchlist</h1>
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
          <button
            key={l.id}
            type="button"
            onClick={() => setActiveListId(l.id)}
            className={`px-3 py-1.5 rounded-full text-sm ${
              activeListId === l.id
                ? "bg-orange-500 text-white"
                : "bg-gray-800 text-gray-300"
            }`}
          >
            {l.name}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setShowNewList(!showNewList)}
          className="px-3 py-1.5 rounded-full text-sm bg-gray-800 text-gray-300"
        >
          + New list
        </button>
        {activeListId && (
          <button
            type="button"
            onClick={deleteList}
            className="px-3 py-1.5 rounded-full text-sm text-red-400"
          >
            Delete list
          </button>
        )}
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

      <div className="flex flex-wrap gap-2 mb-6 bg-gray-900 border border-gray-800 rounded-xl p-3">
        <input
          value={symbolInput}
          onChange={(e) =>
            setSymbolInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))
          }
          placeholder="Symbol (BTCUSDT)"
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm flex-1 min-w-[120px]"
        />
        <input
          value={noteInput}
          onChange={(e) => setNoteInput(e.target.value)}
          placeholder="Note (optional)"
          className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm flex-1 min-w-[120px]"
        />
        <button
          type="button"
          onClick={addItem}
          disabled={saving || !activeListId}
          className="bg-orange-500 text-white px-5 py-2 rounded-lg text-sm font-medium"
        >
          Add
        </button>
      </div>

      {!activeListId && (
        <p className="text-gray-500 text-sm">Create a list first, then add symbols.</p>
      )}

      {/* GRID */}
      {viewMode === "grid" && activeListId && (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {items.map((item, index) => (
            <div
              key={item.id}
              className="bg-gray-900 border border-gray-800 rounded-xl p-3 select-none"
              style={{ WebkitUserSelect: "none", userSelect: "none" }}
            >
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="min-w-0">
                  <div className="font-semibold text-sm truncate">{item.symbol}</div>
                  {item.note && (
                    <p className="text-gray-500 text-xs truncate">{item.note}</p>
                  )}
                </div>
                <MoveButtons id={item.id} index={index} />
              </div>
              <MiniChart symbol={item.symbol} interval={interval} />
              <div className="flex justify-between mt-2 text-xs">
                <button
                  type="button"
                  onClick={() => goChart(item.symbol)}
                  className="text-orange-400 hover:underline"
                >
                  Chart
                </button>
                <button
                  type="button"
                  onClick={() => deleteItem(item.id)}
                  className="text-red-400 hover:underline"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
          {!items.length && (
            <p className="text-gray-500 text-sm col-span-full">No symbols yet. Add one above.</p>
          )}
        </div>
      )}

      {/* LIST + CHART */}
      {viewMode === "list" && activeListId && (
        <div className="flex flex-col md:flex-row gap-4 min-h-[480px]">
          <div className="w-full md:w-80 shrink-0 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden flex flex-col max-h-[520px]">
            <div className="px-3 py-2 border-b border-gray-800 text-xs text-gray-400">
              Use ▲ ▼ to reorder · Tap name to preview
            </div>
            <div className="overflow-y-auto flex-1">
              {items.map((item, index) => (
                <div
                  key={item.id}
                  className={`flex items-center gap-2 px-2 py-2 border-b border-gray-800/80 select-none ${
                    selectedSymbol === item.symbol
                      ? "bg-gray-800 border-l-2 border-l-orange-500"
                      : "hover:bg-gray-800/50"
                  }`}
                  style={{ WebkitUserSelect: "none", userSelect: "none" }}
                >
                  <MoveButtons id={item.id} index={index} />
                  <button
                    type="button"
                    onClick={() => setSelectedSymbol(item.symbol)}
                    className="flex-1 min-w-0 text-left py-1"
                  >
                    <div className="font-medium text-sm truncate">{item.symbol}</div>
                    {item.note && (
                      <div className="text-gray-500 text-xs truncate">{item.note}</div>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteItem(item.id)}
                    className="text-red-400 text-sm shrink-0 w-8 h-8"
                  >
                    ✕
                  </button>
                </div>
              ))}
              {!items.length && (
                <p className="text-gray-500 text-sm p-4">No symbols yet.</p>
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
                  <label className="flex items-center gap-2 text-sm text-gray-300">
                    <input
                      type="checkbox"
                      checked={showPriceLine}
                      onChange={(e) => setShowPriceLine(e.target.checked)}
                    />
                    Price line
                  </label>
                </div>

                <DetailChart
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

"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { createChart, IChartApi, ISeriesApi } from "lightweight-charts";

interface WatchList {
  id: string;
  name: string;
}

interface WatchItem {
  id: string;
  list_id: string;
  symbol: string;
  note: string | null;
}

const TIMEFRAMES = [
  { label: "1m", value: "1" },
  { label: "5m", value: "5" },
  { label: "15m", value: "15" },
  { label: "1h", value: "60" },
  { label: "4h", value: "240" },
  { label: "1D", value: "D" },
];

function MiniChart({ symbol, interval }: { symbol: string; interval: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!ref.current) return;

    const chart = createChart(ref.current, {
      width: ref.current.clientWidth,
      height: 80,
      layout: {
        background: { color: "transparent" },
        textColor: "#6b7280",
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { visible: false },
      },
      rightPriceScale: { visible: false },
      timeScale: { visible: false },
      crosshair: { mode: 0 },
      handleScroll: false,
      handleScale: false,
    });

    const series = chart.addAreaSeries({
      lineColor: "#f97316",
      topColor: "rgba(249, 115, 22, 0.3)",
      bottomColor: "rgba(249, 115, 22, 0.0)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    chartRef.current = chart;

    const load = async () => {
      try {
        const res = await fetch(
          `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${interval}&limit=40`
        );
        const data = await res.json();
        if (data.result?.list) {
          const candles = data.result.list
            .map((item: any) => ({
              time: Number(item[0]) / 1000,
              value: parseFloat(item[4]),
            }))
            .reverse();
          series.setData(candles);
          chart.timeScale().fitContent();
        }
      } catch {}
    };
    load();

    return () => {
      chart.remove();
    };
  }, [symbol, interval]);

  return <div ref={ref} className="w-full h-20" />;
}

export default function WatchlistPage() {
  const router = useRouter();
  const [lists, setLists] = useState<WatchList[]>([]);
  const [activeListId, setActiveListId] = useState<string | null>(null);
  const [items, setItems] = useState<WatchItem[]>([]);
  const [symbol, setSymbol] = useState("");
  const [note, setNote] = useState("");
  const [newListName, setNewListName] = useState("");
  const [showNewList, setShowNewList] = useState(false);
  const [interval, setIntervalTf] = useState("60");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchLists();
  }, []);

  useEffect(() => {
    if (activeListId) fetchItems(activeListId);
  }, [activeListId]);

  const fetchLists = async () => {
    const { data } = await supabase
      .from("watchlist_lists")
      .select("*")
      .order("created_at", { ascending: true });
    const listData = data || [];
    setLists(listData);
    if (listData.length > 0 && !activeListId) {
      setActiveListId(listData[0].id);
    }
  };

  const fetchItems = async (listId: string) => {
    const { data } = await supabase
      .from("watchlist_items")
      .select("*")
      .eq("list_id", listId)
      .order("created_at", { ascending: false });
    setItems(data || []);
  };

  const addList = async () => {
    const name = newListName.trim();
    if (!name) return;
    setLoading(true);
    const { data, error } = await supabase
      .from("watchlist_lists")
      .insert([{ name }])
      .select()
      .single();
    setLoading(false);
    if (error) {
      alert(error.code === "23505" ? "این نام قبلاً هست" : error.message);
      return;
    }
    setLists((prev) => [...prev, data]);
    setActiveListId(data.id);
    setNewListName("");
    setShowNewList(false);
  };

  const deleteList = async (id: string) => {
    if (!confirm("این لیست و همه کوین‌هایش حذف شوند؟")) return;
    await supabase.from("watchlist_lists").delete().eq("id", id);
    const remaining = lists.filter((l) => l.id !== id);
    setLists(remaining);
    setActiveListId(remaining[0]?.id || null);
    setItems([]);
  };

  const addItem = async () => {
    const sym = symbol.trim().toUpperCase();
    if (!sym || !activeListId) {
      alert("نماد و لیست را مشخص کن");
      return;
    }
    setLoading(true);
    const { error } = await supabase.from("watchlist_items").insert([
      {
        list_id: activeListId,
        symbol: sym,
        note: note.trim() || null,
      },
    ]);
    setLoading(false);
    if (error) {
      alert(error.code === "23505" ? "این کوین در این لیست هست" : error.message);
      return;
    }
    setSymbol("");
    setNote("");
    fetchItems(activeListId);
  };

  const deleteItem = async (id: string) => {
    await supabase.from("watchlist_items").delete().eq("id", id);
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  const goToChart = (sym: string) => {
    localStorage.setItem("chart_symbol", sym.toUpperCase());
    localStorage.setItem("chart_interval", interval);
    router.push("/dashboard");
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      {/* هدر */}
      <div className="mb-6">
        <Link href="/dashboard" className="text-orange-400 hover:underline text-sm">
          ← بازگشت به چارت
        </Link>
        <h1 className="text-3xl font-bold mt-2">واچ‌لیست</h1>
      </div>

      {/* تب‌های لیست */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        {lists.map((list) => (
          <button
            key={list.id}
            onClick={() => setActiveListId(list.id)}
            className={`px-4 py-2 rounded-full text-sm font-medium transition ${
              activeListId === list.id
                ? "bg-orange-500 text-white"
                : "bg-gray-800 text-gray-300 hover:bg-gray-700"
            }`}
          >
            {list.name}
          </button>
        ))}
        <button
          onClick={() => setShowNewList(!showNewList)}
          className="px-3 py-2 rounded-full text-sm bg-gray-800 text-orange-400 hover:bg-gray-700"
        >
          + لیست جدید
        </button>
        {activeListId && lists.length > 1 && (
          <button
            onClick={() => deleteList(activeListId)}
            className="px-3 py-2 rounded-full text-sm text-red-400 hover:bg-gray-800"
          >
            حذف لیست
          </button>
        )}
      </div>

      {/* ساخت لیست جدید */}
      {showNewList && (
        <div className="flex gap-2 mb-6">
          <input
            type="text"
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addList()}
            placeholder="نام لیست (مثلاً حمایت‌ها)"
            className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white flex-1"
          />
          <button
            onClick={addList}
            disabled={loading}
            className="bg-orange-500 hover:bg-orange-600 px-5 py-2 rounded-lg text-white"
          >
            ساخت
          </button>
        </div>
      )}

      {/* تایم‌فریم */}
      <div className="flex flex-wrap gap-2 mb-6">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf.value}
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

      {/* فرم افزودن کوین */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-8">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <input
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && addItem()}
            placeholder="نماد (BTCUSDT)"
            className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white"
          />
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addItem()}
            placeholder="یادداشت (اختیاری)"
            className="bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white"
          />
          <button
            onClick={addItem}
            disabled={loading || !activeListId}
            className="bg-orange-500 hover:bg-orange-600 text-white font-medium py-2 rounded-lg disabled:opacity-50"
          >
            افزودن
          </button>
        </div>
      </div>

      {/* گرید کارت‌ها */}
      {items.length === 0 ? (
        <div className="text-center text-gray-500 py-16 border border-dashed border-gray-700 rounded-xl">
          هنوز کوینی در این لیست نیست
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {items.map((item) => (
            <div
              key={item.id}
              className="bg-gray-900 border border-gray-800 rounded-xl p-3 hover:border-orange-500/50 transition-colors cursor-pointer group"
            >
              <div
                onClick={() => goToChart(item.symbol)}
                className="mb-1"
              >
                <div className="font-bold text-white group-hover:text-orange-400 text-sm">
                  {item.symbol}
                </div>
                {item.note && (
                  <div className="text-xs text-gray-500 truncate">{item.note}</div>
                )}
              </div>

              <div onClick={() => goToChart(item.symbol)}>
                <MiniChart symbol={item.symbol} interval={interval} />
              </div>

              <div className="flex justify-between items-center mt-1">
                <button
                  onClick={() => goToChart(item.symbol)}
                  className="text-xs text-blue-400"
                >
                  چارت
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteItem(item.id);
                  }}
                  className="text-xs text-red-400"
                >
                  حذف
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

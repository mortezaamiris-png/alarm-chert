"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

interface WatchItem {
  id: string;
  symbol: string;
  note: string | null;
  created_at: string;
}

export default function WatchlistPage() {
  const router = useRouter();
  const [items, setItems] = useState<WatchItem[]>([]);
  const [symbol, setSymbol] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchItems();
  }, []);

  const fetchItems = async () => {
    const { data, error } = await supabase
      .from("watchlist")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      console.error(error);
      return;
    }
    setItems(data || []);
  };

  const addItem = async () => {
    const sym = symbol.trim().toUpperCase();
    if (!sym) {
      alert("نماد را وارد کن");
      return;
    }
    setLoading(true);
    const { error } = await supabase.from("watchlist").insert([
      {
        symbol: sym,
        note: note.trim() || null,
      },
    ]);
    setLoading(false);
    if (error) {
      if (error.code === "23505") {
        alert("این کوین قبلاً اضافه شده");
      } else {
        alert("خطا: " + error.message);
      }
      return;
    }
    setSymbol("");
    setNote("");
    fetchItems();
  };

  const deleteItem = async (id: string) => {
    await supabase.from("watchlist").delete().eq("id", id);
    setItems((prev) => prev.filter((i) => i.id !== id));
  };

  const goToChart = (sym: string) => {
    localStorage.setItem("chart_symbol", sym.toUpperCase());
    router.push("/dashboard");
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <div className="mb-8">
        <Link href="/dashboard" className="text-orange-400 hover:underline text-sm">
          ← بازگشت به چارت
        </Link>
        <h1 className="text-3xl font-bold mt-2">واچ‌لیست</h1>
        <p className="text-gray-400 text-sm mt-1">
          کوین‌ها را اضافه کن • روی هر کدام بزن تا چارت باز شود
        </p>
      </div>

      {/* فرم اضافه کردن */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-8">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">نماد (مثلاً BTCUSDT)</label>
            <input
              type="text"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && addItem()}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white"
              placeholder="OPUSDT"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">یادداشت (اختیاری)</label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addItem()}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white"
              placeholder="نگاه به حمایت"
            />
          </div>
        </div>
        <button
          onClick={addItem}
          disabled={loading}
          className="mt-5 w-full bg-orange-500 hover:bg-orange-600 text-white font-medium py-3 rounded-lg disabled:opacity-50"
        >
          {loading ? "در حال ذخیره..." : "افزودن به واچ‌لیست"}
        </button>
      </div>

      {/* لیست */}
      <div>
        <h2 className="text-xl font-semibold mb-4 text-orange-400">
          کوین‌های من ({items.length})
        </h2>

        {items.length === 0 ? (
          <div className="text-center text-gray-500 py-12 border border-dashed border-gray-700 rounded-xl">
            هنوز کوینی اضافه نکردی
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {items.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-xl px-5 py-4 hover:border-orange-500/50 transition-colors"
              >
                <button
                  onClick={() => goToChart(item.symbol)}
                  className="text-left flex-1"
                >
                  <div className="font-bold text-lg text-white hover:text-orange-400">
                    {item.symbol}
                  </div>
                  {item.note && (
                    <div className="text-sm text-gray-400 mt-1">{item.note}</div>
                  )}
                </button>
                <div className="flex gap-3 text-sm">
                  <button
                    onClick={() => goToChart(item.symbol)}
                    className="text-blue-400 hover:text-blue-300"
                  >
                    چارت
                  </button>
                  <button
                    onClick={() => deleteItem(item.id)}
                    className="text-red-400 hover:text-red-300"
                  >
                    حذف
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

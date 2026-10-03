"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";

interface Alert {
  id: string;
  symbol: string;
  price: number;
  condition: "above" | "below" | "cross";
  created_at: string;
  is_active: boolean;
  triggered: boolean;
  triggered_at: string | null;
  repeat: boolean;
}

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [price, setPrice] = useState("");
  const [condition, setCondition] = useState<"above" | "below" | "cross">("above");
  const [repeat, setRepeat] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetchAlerts();
  }, []);

  const fetchAlerts = async () => {
    const { data, error } = await supabase
      .from("alarms")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error fetching alerts:", error);
      return;
    }
    setAlerts(data || []);
  };

  const addAlert = async () => {
    if (!price || isNaN(Number(price))) {
      alert("لطفاً قیمت معتبر وارد کن");
      return;
    }

    setLoading(true);

    const { error } = await supabase.from("alarms").insert([
      {
        symbol: symbol.toUpperCase(),
        price: Number(price),
        condition,
        is_active: true,
        triggered: false,
        repeat: repeat,
        note: "آلارم از سایت",
      },
    ]);

    setLoading(false);

    if (error) {
      console.error("Error adding alert:", error);
      alert("خطا در ذخیره آلارم: " + error.message);
      return;
    }

    setPrice("");
    setRepeat(false);
    fetchAlerts();
  };

  const deleteAlert = async (id: string) => {
    const { error } = await supabase
      .from("alarms")
      .update({ is_active: false })
      .eq("id", id);

    if (error) {
      console.error("Error deleting alert:", error);
      return;
    }
    fetchAlerts();
  };

  const activeAlerts = alerts.filter((a) => a.is_active && !a.triggered);
  const triggeredAlerts = alerts.filter((a) => a.triggered || !a.is_active);

  const getConditionSymbol = (cond: string) => {
    if (cond === "above") return "≥";
    if (cond === "below") return "≤";
    return "≈";
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <div className="mb-8">
        <Link href="/dashboard" className="text-orange-400 hover:underline text-sm">
          ← بازگشت به چارت
        </Link>
        <h1 className="text-3xl font-bold mt-2">تنظیم آلارم</h1>
        <p className="text-gray-400 mt-1">
          قیمت خطی که کشیدی رو اینجا وارد کن تا برات نوتیفیکیشن بیاد
        </p>
      </div>

      {/* فرم */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-8">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">نماد</label>
            <input
              type="text"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white"
              placeholder="BTCUSDT"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">قیمت</label>
            <input
              type="number"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white"
              placeholder="65000"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">شرط</label>
            <select
              value={condition}
              onChange={(e) => setCondition(e.target.value as "above" | "below" | "cross")}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white"
            >
              <option value="above">بالای این قیمت (≥)</option>
              <option value="below">پایین این قیمت (≤)</option>
              <option value="cross">برخورد (هر طرف ≈)</option>
            </select>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <input
            type="checkbox"
            id="repeat"
            checked={repeat}
            onChange={(e) => setRepeat(e.target.checked)}
            className="w-4 h-4 accent-orange-500"
          />
          <label htmlFor="repeat" className="text-sm text-gray-300">
            آلارم تکراری (هر بار که قیمت رد شد دوباره پیام بده)
          </label>
        </div>

        <button
          onClick={addAlert}
          disabled={loading}
          className="mt-5 w-full bg-orange-500 hover:bg-orange-600 text-white font-medium py-3 rounded-lg transition disabled:opacity-50"
        >
          {loading ? "در حال ذخیره..." : "افزودن آلارم"}
        </button>
      </div>

      {/* آلارم‌های فعال */}
      <div className="mb-10">
        <h2 className="text-xl font-semibold mb-4 text-green-400">
          آلارم‌های فعال ({activeAlerts.length})
        </h2>

        {activeAlerts.length === 0 ? (
          <div className="text-center text-gray-500 py-8 border border-dashed border-gray-700 rounded-xl">
            هنوز آلارم فعالی نیست
          </div>
        ) : (
          <div className="space-y-3">
            {activeAlerts.map((alert) => (
              <div
                key={alert.id}
                className="flex items-center justify-between bg-gray-900 border border-green-800/50 rounded-xl px-5 py-4"
              >
                <div>
                  <div className="font-medium">
                    {alert.symbol}{" "}
                    <span className="text-orange-400">
                      {getConditionSymbol(alert.condition)} {alert.price.toLocaleString()}
                    </span>
                    {alert.repeat && (
                      <span className="ml-2 text-xs bg-blue-900/50 text-blue-300 px-2 py-0.5 rounded">
                        تکراری
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-gray-500 mt-1">
                    {new Date(alert.created_at).toLocaleString("fa-IR")}
                  </div>
                </div>
                <button
                  onClick={() => deleteAlert(alert.id)}
                  className="text-red-400 hover:text-red-300 text-sm"
                >
                  حذف
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* تاریخچه */}
      <div>
        <h2 className="text-xl font-semibold mb-4 text-gray-400">
          تاریخچه / تریگر شده ({triggeredAlerts.length})
        </h2>

        {triggeredAlerts.length === 0 ? (
          <div className="text-center text-gray-600 py-6 text-sm">
            هنوز آلارمی تریگر نشده
          </div>
        ) : (
          <div className="space-y-3">
            {triggeredAlerts.map((alert) => (
              <div
                key={alert.id}
                className="flex items-center justify-between bg-gray-900/50 border border-gray-800 rounded-xl px-5 py-4 opacity-70"
              >
                <div>
                  <div className="font-medium text-gray-300">
                    {alert.symbol}{" "}
                    <span className="text-gray-500">
                      {getConditionSymbol(alert.condition)} {alert.price.toLocaleString()}
                    </span>
                  </div>
                  <div className="text-sm text-gray-600 mt-1">
                    {alert.triggered_at
                      ? `تریگر: ${new Date(alert.triggered_at).toLocaleString("fa-IR")}`
                      : new Date(alert.created_at).toLocaleString("fa-IR")}
                  </div>
                </div>
                <span className="text-xs text-gray-500">غیرفعال</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

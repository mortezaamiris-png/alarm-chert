"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface Alert {
  id: string;
  symbol: string;
  price: number;
  condition: "above" | "below";
  createdAt: string;
}

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [price, setPrice] = useState("");
  const [condition, setCondition] = useState<"above" | "below">("above");

  // بارگذاری آلارم‌ها از localStorage (موقت)
  useEffect(() => {
    const saved = localStorage.getItem("alerts");
    if (saved) {
      setAlerts(JSON.parse(saved));
    }
  }, []);

  // ذخیره آلارم‌ها
  const saveAlerts = (newAlerts: Alert[]) => {
    setAlerts(newAlerts);
    localStorage.setItem("alerts", JSON.stringify(newAlerts));
  };

  const addAlert = () => {
    if (!price || isNaN(Number(price))) {
      alert("لطفاً قیمت معتبر وارد کن");
      return;
    }

    const newAlert: Alert = {
      id: Date.now().toString(),
      symbol: symbol.toUpperCase(),
      price: Number(price),
      condition,
      createdAt: new Date().toLocaleString("fa-IR"),
    };

    saveAlerts([newAlert, ...alerts]);
    setPrice("");
  };

  const deleteAlert = (id: string) => {
    saveAlerts(alerts.filter((a) => a.id !== id));
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

      {/* فرم اضافه کردن آلارم */}
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
              onChange={(e) => setCondition(e.target.value as "above" | "below")}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white"
            >
              <option value="above">بالای این قیمت</option>
              <option value="below">پایین این قیمت</option>
            </select>
          </div>
        </div>

        <button
          onClick={addAlert}
          className="mt-5 w-full bg-orange-500 hover:bg-orange-600 text-white font-medium py-3 rounded-lg transition"
        >
          افزودن آلارم
        </button>
      </div>

      {/* لیست آلارم‌ها */}
      <div>
        <h2 className="text-xl font-semibold mb-4">آلارم‌های فعال ({alerts.length})</h2>

        {alerts.length === 0 ? (
          <div className="text-center text-gray-500 py-10 border border-dashed border-gray-700 rounded-xl">
            هنوز آلارمی ثبت نشده
          </div>
        ) : (
          <div className="space-y-3">
            {alerts.map((alert) => (
              <div
                key={alert.id}
                className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-xl px-5 py-4"
              >
                <div>
                  <div className="font-medium">
                    {alert.symbol}{" "}
                    <span className="text-orange-400">
                      {alert.condition === "above" ? "≥" : "≤"} {alert.price.toLocaleString()}
                    </span>
                  </div>
                  <div className="text-sm text-gray-500 mt-1">{alert.createdAt}</div>
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
    </div>
  );
}

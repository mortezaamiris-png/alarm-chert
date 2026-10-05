"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  repeat?: boolean;
  note?: string | null;
}

export default function AlertsPage() {
  const router = useRouter();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [price, setPrice] = useState("");
  const [condition, setCondition] = useState<"above" | "below" | "cross">("above");
  const [repeat, setRepeat] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    fetchAlerts();
  }, []);

  const fetchAlerts = async () => {
    setFetching(true);
    setErrorMsg(null);
    try {
      const { data, error } = await supabase
        .from("alarms")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) {
        console.error(error);
        setErrorMsg(error.message || "Failed to load alerts");
        setAlerts([]);
        return;
      }
      setAlerts((data as Alert[]) || []);
    } catch (e: any) {
      console.error(e);
      setErrorMsg(e?.message || "Network error");
      setAlerts([]);
    } finally {
      setFetching(false);
    }
  };

  const addAlert = async () => {
    if (!price || isNaN(Number(price))) {
      alert("Enter a valid price");
      return;
    }
    setLoading(true);
    setErrorMsg(null);
    try {
      const { error } = await supabase.from("alarms").insert([
        {
          symbol: symbol.toUpperCase().trim(),
          price: Number(price),
          condition,
          is_active: true,
          triggered: false,
          repeat,
          note: "Alert from site",
        },
      ]);
      if (error) {
        setErrorMsg(error.message);
        alert("Error: " + error.message);
        return;
      }
      setPrice("");
      setRepeat(false);
      await fetchAlerts();
    } catch (e: any) {
      setErrorMsg(e?.message || "Insert failed");
      alert("Error: " + (e?.message || "Insert failed"));
    } finally {
      setLoading(false);
    }
  };

  const deleteAlert = async (id: string) => {
    try {
      // soft delete
      const { error } = await supabase
        .from("alarms")
        .update({ is_active: false })
        .eq("id", id);
      if (error) {
        // fallback hard delete
        await supabase.from("alarms").delete().eq("id", id);
      }
      await fetchAlerts();
    } catch (e: any) {
      alert("Delete failed: " + (e?.message || ""));
    }
  };

  const goToChart = (sym: string) => {
    try {
      localStorage.setItem("chart_symbol", sym.toUpperCase());
    } catch {}
    router.push("/dashboard");
  };

  const activeAlerts = alerts.filter((a) => a.is_active && !a.triggered);
  const triggeredAlerts = alerts.filter((a) => a.triggered || !a.is_active);

  const getConditionSymbol = (cond: string) => {
    if (cond === "above") return "≥";
    if (cond === "below") return "≤";
    return "≈";
  };

  const getConditionLabel = (cond: string) => {
    if (cond === "above") return "Above";
    if (cond === "below") return "Below";
    return "Cross";
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <div className="mb-6">
        <Link href="/dashboard" className="text-orange-400 hover:underline text-sm">
          ← Back to chart
        </Link>
        <h1 className="text-3xl font-bold mt-2">Alerts</h1>
        <p className="text-gray-500 text-sm mt-1">
          Create price alerts. Telegram + site notify when triggered.
        </p>
      </div>

      {errorMsg && (
        <div className="mb-4 rounded-xl border border-red-800/60 bg-red-950/40 text-red-300 text-sm px-4 py-3">
          {errorMsg}
          <button
            type="button"
            onClick={fetchAlerts}
            className="ml-3 underline text-orange-400"
          >
            Retry
          </button>
        </div>
      )}

      {/* Add form */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-8">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">Symbol</label>
            <input
              type="text"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="BTCUSDT"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white outline-none focus:border-orange-500"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Price</label>
            <input
              type="number"
              step="any"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="86000"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white outline-none focus:border-orange-500"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Condition</label>
            <select
              value={condition}
              onChange={(e) =>
                setCondition(e.target.value as "above" | "below" | "cross")
              }
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white outline-none focus:border-orange-500"
            >
              <option value="above">Above (≥)</option>
              <option value="below">Below (≤)</option>
              <option value="cross">Cross (≈)</option>
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
            Repeat (alert again every time price crosses)
          </label>
        </div>

        <button
          type="button"
          onClick={addAlert}
          disabled={loading}
          className="mt-5 w-full bg-orange-500 hover:bg-orange-600 text-white font-medium py-3 rounded-lg disabled:opacity-50"
        >
          {loading ? "Saving…" : "Add alert"}
        </button>
      </div>

      {/* Active */}
      <div className="mb-10">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-semibold text-green-400">
            Active ({activeAlerts.length})
          </h2>
          <button
            type="button"
            onClick={fetchAlerts}
            className="text-xs text-gray-400 hover:text-white"
          >
            Refresh
          </button>
        </div>

        {fetching ? (
          <div className="text-center text-gray-500 py-8">Loading…</div>
        ) : activeAlerts.length === 0 ? (
          <div className="text-center text-gray-500 py-8 border border-dashed border-gray-700 rounded-xl">
            No active alerts
          </div>
        ) : (
          <div className="space-y-3">
            {activeAlerts.map((alert) => (
              <div
                key={alert.id}
                className="flex items-center justify-between gap-3 bg-gray-900 border border-green-800/40 rounded-xl px-4 py-3.5"
              >
                <div className="min-w-0">
                  <div className="font-medium flex flex-wrap items-center gap-2">
                    <span>{alert.symbol}</span>
                    <span className="text-orange-400">
                      {getConditionSymbol(alert.condition)} {alert.price}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">
                      {getConditionLabel(alert.condition)}
                    </span>
                    {alert.repeat && (
                      <span className="text-[10px] bg-blue-900/50 text-blue-300 px-2 py-0.5 rounded">
                        Repeat
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {alert.created_at
                      ? new Date(alert.created_at).toLocaleString()
                      : ""}
                  </div>
                </div>
                <div className="flex gap-3 text-sm shrink-0">
                  <button
                    type="button"
                    onClick={() => goToChart(alert.symbol)}
                    className="text-blue-400 hover:text-blue-300"
                  >
                    Chart
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteAlert(alert.id)}
                    className="text-red-400 hover:text-red-300"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* History */}
      <div>
        <h2 className="text-xl font-semibold mb-4 text-gray-400">
          History / Triggered ({triggeredAlerts.length})
        </h2>
        {triggeredAlerts.length === 0 ? (
          <div className="text-center text-gray-600 py-6 text-sm">Empty</div>
        ) : (
          <div className="space-y-3">
            {triggeredAlerts.slice(0, 40).map((alert) => (
              <div
                key={alert.id}
                className="flex items-center justify-between gap-3 bg-gray-900/50 border border-gray-800 rounded-xl px-4 py-3.5 opacity-75"
              >
                <div className="min-w-0">
                  <div className="font-medium text-gray-300">
                    {alert.symbol}{" "}
                    <span className="text-gray-500">
                      {getConditionSymbol(alert.condition)} {alert.price}
                    </span>
                  </div>
                  {alert.triggered_at && (
                    <div className="text-xs text-gray-600 mt-0.5">
                      {new Date(alert.triggered_at).toLocaleString()}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => goToChart(alert.symbol)}
                  className="text-blue-400 text-sm shrink-0"
                >
                  Chart
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
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
  color?: string | null;
}

function formatAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatPrice(n: number) {
  if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return n.toLocaleString(undefined, { maximumFractionDigits: 8 });
}

export default function AlertsPage() {
  const router = useRouter();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [price, setPrice] = useState("");
  const [condition, setCondition] = useState<"above" | "below" | "cross">("cross");
  const [repeat, setRepeat] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [filterSym, setFilterSym] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const fetchAlerts = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

  // live "ago" refresh every 15s
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 15000);
    return () => clearInterval(id);
  }, []);

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
      const { error } = await supabase.from("alarms").delete().eq("id", id);
      if (error) {
        await supabase.from("alarms").update({ is_active: false }).eq("id", id);
      }
      setAlerts((prev) => prev.filter((a) => a.id !== id));
    } catch (e: any) {
      alert("Delete failed: " + (e?.message || ""));
    }
  };

  const deleteAllHistory = async () => {
    const hist = alerts.filter((a) => a.triggered || !a.is_active);
    if (!hist.length) return;
    if (!confirm(`Delete ${hist.length} history alerts?`)) return;
    try {
      const ids = hist.map((a) => a.id);
      await supabase.from("alarms").delete().in("id", ids);
      setAlerts((prev) => prev.filter((a) => !(a.triggered || !a.is_active)));
    } catch (e: any) {
      alert("Delete failed: " + (e?.message || ""));
    }
  };

  const softDeactivate = async (id: string) => {
    try {
      await supabase.from("alarms").update({ is_active: false }).eq("id", id);
      setAlerts((prev) =>
        prev.map((a) => (a.id === id ? { ...a, is_active: false } : a))
      );
    } catch {
      await deleteAlert(id);
    }
  };

  const goToChart = (sym: string) => {
    try {
      localStorage.setItem("chart_symbol", sym.toUpperCase().split("@")[0]);
    } catch {}
    router.push("/dashboard");
  };

  const activeAlerts = useMemo(
    () => alerts.filter((a) => a.is_active && !a.triggered),
    [alerts]
  );
  const historyAlerts = useMemo(
    () =>
      alerts
        .filter((a) => a.triggered || !a.is_active)
        .sort((a, b) => {
          const ta = new Date(a.triggered_at || a.created_at).getTime();
          const tb = new Date(b.triggered_at || b.created_at).getTime();
          return tb - ta;
        }),
    [alerts]
  );

  // group active by symbol
  const groupedActive = useMemo(() => {
    const map = new Map<string, Alert[]>();
    for (const a of activeAlerts) {
      const s = a.symbol.toUpperCase();
      if (!map.has(s)) map.set(s, []);
      map.get(s)!.push(a);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [activeAlerts]);

  const filteredHistory = filterSym
    ? historyAlerts.filter((a) => a.symbol.toUpperCase() === filterSym)
    : historyAlerts;

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
    <div className="max-w-6xl mx-auto px-3 sm:px-4 py-6 sm:py-8">
      <div className="mb-5">
        <Link href="/dashboard" className="text-orange-400 hover:underline text-sm">
          ← Back to chart
        </Link>
        <h1 className="text-2xl sm:text-3xl font-bold mt-2">Alerts</h1>
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
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 sm:p-5 mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
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
              <option value="cross">Cross (≈)</option>
              <option value="above">Above (≥)</option>
              <option value="below">Below (≤)</option>
            </select>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-3">
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
          className="mt-4 w-full bg-orange-500 hover:bg-orange-600 text-white font-medium py-3 rounded-lg disabled:opacity-50"
        >
          {loading ? "Saving…" : "Add alert"}
        </button>
      </div>

      {/* Two columns: Active | History */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* LEFT — Active by symbol */}
        <div className="min-w-0">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-green-400">
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
            <div className="text-center text-gray-500 py-10">Loading…</div>
          ) : groupedActive.length === 0 ? (
            <div className="text-center text-gray-500 py-10 border border-dashed border-gray-700 rounded-xl text-sm">
              No active alerts
            </div>
          ) : (
            <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
              {groupedActive.map(([sym, list]) => (
                <div
                  key={sym}
                  className="bg-gray-900/80 border border-gray-800 rounded-xl overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => goToChart(sym)}
                    className="w-full flex items-center justify-between px-3.5 py-2.5 bg-gray-800/60 hover:bg-gray-800 border-b border-gray-800"
                  >
                    <span className="font-semibold text-sm text-white">{sym}</span>
                    <span className="text-[11px] text-gray-500">
                      {list.length} alert{list.length > 1 ? "s" : ""} · Chart →
                    </span>
                  </button>
                  <div className="divide-y divide-gray-800/80">
                    {list.map((alert) => (
                      <div
                        key={alert.id}
                        className="relative flex items-center gap-2 px-3 py-2.5 group"
                      >
                        {/* small X top-right */}
                        <button
                          type="button"
                          title="Delete"
                          onClick={() => softDeactivate(alert.id)}
                          className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full flex items-center justify-center text-gray-500 hover:text-red-400 hover:bg-red-950/40 text-xs leading-none opacity-70 group-hover:opacity-100"
                        >
                          ×
                        </button>

                        <div
                          className="w-2.5 h-2.5 rounded-full shrink-0"
                          style={{
                            background: alert.color || "#f97316",
                          }}
                        />
                        <div className="min-w-0 flex-1 pr-5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-orange-400 font-medium text-sm">
                              {getConditionSymbol(alert.condition)}{" "}
                              {formatPrice(alert.price)}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">
                              {getConditionLabel(alert.condition)}
                            </span>
                            {alert.repeat && (
                              <span className="text-[10px] bg-blue-900/50 text-blue-300 px-1.5 py-0.5 rounded">
                                Repeat
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-gray-600 mt-0.5">
                            {alert.created_at
                              ? new Date(alert.created_at).toLocaleString()
                              : ""}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* RIGHT — History */}
        <div className="min-w-0">
          <div className="flex items-center justify-between mb-3 gap-2">
            <h2 className="text-lg font-semibold text-gray-300">
              History
              {filterSym ? ` — ${filterSym}` : ""} ({filteredHistory.length})
            </h2>
            <div className="flex items-center gap-2">
              {filterSym && (
                <button
                  type="button"
                  onClick={() => setFilterSym(null)}
                  className="text-[11px] text-orange-400 hover:underline"
                >
                  Clear filter
                </button>
              )}
              {historyAlerts.length > 0 && (
                <button
                  type="button"
                  onClick={deleteAllHistory}
                  className="text-[11px] text-red-400 hover:text-red-300 border border-red-900/50 rounded-md px-2 py-0.5"
                >
                  Delete all
                </button>
              )}
            </div>
          </div>

          {/* symbol chips for filter */}
          {historyAlerts.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {Array.from(new Set(historyAlerts.map((a) => a.symbol.toUpperCase())))
                .sort()
                .map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setFilterSym(filterSym === s ? null : s)}
                    className={`text-[11px] px-2 py-0.5 rounded-full border ${
                      filterSym === s
                        ? "bg-orange-500/20 border-orange-500 text-orange-300"
                        : "border-gray-700 text-gray-400 hover:border-gray-500"
                    }`}
                  >
                    {s}
                  </button>
                ))}
            </div>
          )}

          {filteredHistory.length === 0 ? (
            <div className="text-center text-gray-600 py-10 border border-dashed border-gray-800 rounded-xl text-sm">
              Empty
            </div>
          ) : (
            <div className="space-y-2 max-h-[70vh] overflow-y-auto pr-1">
              {filteredHistory.slice(0, 80).map((alert) => {
                const when = alert.triggered_at || alert.created_at;
                return (
                  <div
                    key={alert.id}
                    className="relative group flex items-center gap-3 bg-gray-900/70 border border-gray-800 rounded-xl px-3.5 py-2.5"
                  >
                    {/* small X */}
                    <button
                      type="button"
                      title="Delete"
                      onClick={() => deleteAlert(alert.id)}
                      className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full flex items-center justify-center text-gray-600 hover:text-red-400 hover:bg-red-950/40 text-xs leading-none opacity-60 group-hover:opacity-100"
                    >
                      ×
                    </button>

                    <div className="min-w-0 flex-1 pr-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => goToChart(alert.symbol)}
                          className="font-medium text-sm text-white hover:text-orange-400"
                        >
                          {alert.symbol}
                        </button>
                        <span className="text-gray-400 text-sm">
                          {getConditionSymbol(alert.condition)}{" "}
                          {formatPrice(alert.price)}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-500">
                          {getConditionLabel(alert.condition)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-[11px] text-gray-600">
                        {when && (
                          <span>
                            {new Date(when).toLocaleString()}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* reverse time — how long ago */}
                    <div className="text-right shrink-0 pr-4">
                      <div className="text-xs font-medium text-orange-400/90 tabular-nums">
                        {formatAgo(when)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

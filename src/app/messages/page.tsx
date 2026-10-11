"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { User } from "@supabase/supabase-js";
import { useRouter } from "next/navigation";

/** Triggered alarm shown as an inbox item for this user */
interface AlarmMsg {
  id: string;
  symbol: string;
  price: number;
  last_price?: number | null;
  triggered_at?: string | null;
  created_at?: string | null;
  note?: string | null;
  condition?: string | null;
}

export default function MessagesPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [items, setItems] = useState<AlarmMsg[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      const u = data.session?.user ?? null;
      setUser(u);
      if (!u) {
        setLoading(false);
        return;
      }

      // 1) Per-user triggered alarms (needs user_id on alarms table)
      try {
        const withUser = await supabase
          .from("alarms")
          .select("id, symbol, price, last_price, triggered_at, created_at, note, condition")
          .eq("triggered", true)
          .eq("user_id", u.id)
          .order("triggered_at", { ascending: false })
          .limit(50);
        if (!withUser.error && withUser.data) {
          setItems(withUser.data as AlarmMsg[]);
          setLoading(false);
          return;
        }
      } catch {}

      // 2) messages table
      try {
        const { data: rows, error } = await supabase
          .from("messages")
          .select("*")
          .eq("to_user", u.id)
          .order("created_at", { ascending: false })
          .limit(50);
        if (!error && rows?.length) {
          setItems(
            rows.map((r: any) => ({
              id: r.id,
              symbol: r.symbol || "ALERT",
              price: r.price ?? 0,
              last_price: r.price,
              triggered_at: r.created_at,
              note: r.body,
            }))
          );
          try {
            await supabase
              .from("messages")
              .update({ read: true })
              .eq("to_user", u.id)
              .eq("read", false);
          } catch {}
          setLoading(false);
          return;
        }
      } catch {}

      // 3) Legacy: all triggered (until user_id is added)
      try {
        const { data: all } = await supabase
          .from("alarms")
          .select("id, symbol, price, last_price, triggered_at, created_at, note, condition")
          .eq("triggered", true)
          .order("triggered_at", { ascending: false })
          .limit(30);
        if (all) setItems(all as AlarmMsg[]);
      } catch {}

      setLoading(false);
    })();
  }, []);

  if (!user) {
    return (
      <div className="min-h-screen bg-[#0b0e11] text-gray-100 flex items-center justify-center p-6">
        <div className="text-center space-y-4 max-w-sm">
          <p className="text-gray-300 text-lg font-medium">Sign in required</p>
          <p className="text-gray-500 text-sm">
            Log in first to see your personal alarm messages.
          </p>
          <p className="text-xs text-orange-400">
            Use the orange <strong>Sign in</strong> button at the top left.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0b0e11] text-gray-100 p-4 md:p-8">
      <div className="max-w-lg mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">Alarm messages</h1>
            <p className="text-xs text-gray-500 mt-0.5">Triggered alerts for your account</p>
          </div>
          <button
            type="button"
            onClick={() => router.back()}
            className="text-sm text-gray-400 hover:text-white"
          >
            ← Back
          </button>
        </div>

        {loading && <p className="text-gray-500 text-sm">Loading…</p>}

        {!loading && !items.length && (
          <div className="rounded-xl border border-gray-800 bg-gray-950 p-6 text-center text-gray-500 text-sm">
            No triggered alarms yet.
            <p className="mt-2 text-xs text-gray-600">
              When one of your price alarms hits, it will appear here.
            </p>
          </div>
        )}

        <div className="space-y-2">
          {items.map((m) => {
            const when = m.triggered_at || m.created_at;
            return (
              <div
                key={m.id}
                className="rounded-xl border border-gray-800 bg-gray-950 px-4 py-3 hover:border-orange-500/40 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold text-orange-300">{m.symbol}</p>
                    <p className="text-sm text-gray-200 mt-0.5">
                      Alarm hit @ {Number(m.price).toLocaleString()}
                      {m.last_price != null && Number(m.last_price) !== Number(m.price) && (
                        <span className="text-gray-500">
                          {" "}
                          → {Number(m.last_price).toLocaleString()}
                        </span>
                      )}
                    </p>
                    {m.condition && (
                      <p className="text-[11px] text-gray-500 mt-0.5">Condition: {m.condition}</p>
                    )}
                    {m.note && !String(m.note).startsWith("__") && (
                      <p className="text-xs text-gray-400 mt-1">{m.note}</p>
                    )}
                  </div>
                  <span className="text-[11px] text-gray-500 shrink-0">
                    {when ? new Date(when).toLocaleString() : ""}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

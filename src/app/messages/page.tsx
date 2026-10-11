"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { User } from "@supabase/supabase-js";
import { useRouter } from "next/navigation";

interface Message {
  id: string;
  from_user?: string | null;
  to_user: string;
  body: string;
  read?: boolean;
  created_at?: string;
}

export default function MessagesPage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
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
      try {
        const { data: rows, error } = await supabase
          .from("messages")
          .select("*")
          .eq("to_user", u.id)
          .order("created_at", { ascending: false })
          .limit(50);
        if (!error && rows) {
          setMessages(rows as Message[]);
          // mark read
          await supabase
            .from("messages")
            .update({ read: true })
            .eq("to_user", u.id)
            .eq("read", false);
        }
      } catch {
        // table may not exist
      }
      setLoading(false);
    })();
  }, []);

  if (!user) {
    return (
      <div className="min-h-screen bg-[#0b0e11] text-gray-100 flex items-center justify-center p-6">
        <div className="text-center space-y-3">
          <p className="text-gray-400">Sign in to view messages</p>
          <button
            type="button"
            onClick={() => router.push("/watchlist")}
            className="px-4 py-2 rounded-lg bg-orange-500 text-black text-sm font-semibold"
          >
            Go to Watchlist
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0b0e11] text-gray-100 p-4 md:p-8">
      <div className="max-w-lg mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold">Messages</h1>
          <button
            type="button"
            onClick={() => router.back()}
            className="text-sm text-gray-400 hover:text-white"
          >
            ← Back
          </button>
        </div>

        {loading && <p className="text-gray-500 text-sm">Loading…</p>}

        {!loading && !messages.length && (
          <div className="rounded-xl border border-gray-800 bg-gray-950 p-6 text-center text-gray-500 text-sm">
            No messages yet.
            <p className="mt-2 text-xs text-gray-600">
              Create a <code className="text-orange-400">messages</code> table in Supabase to enable inbox.
            </p>
          </div>
        )}

        <div className="space-y-2">
          {messages.map((m) => (
            <div
              key={m.id}
              className="rounded-xl border border-gray-800 bg-gray-950 px-4 py-3"
            >
              <p className="text-sm text-gray-200 whitespace-pre-wrap">{m.body}</p>
              <p className="text-[11px] text-gray-500 mt-1">
                {m.created_at ? new Date(m.created_at).toLocaleString() : ""}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

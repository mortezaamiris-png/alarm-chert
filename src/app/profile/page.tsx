"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { User } from "@supabase/supabase-js";
import { useRouter } from "next/navigation";

/** Bot username without @ — set NEXT_PUBLIC_TELEGRAM_BOT_USERNAME in Vercel */
const BOT_USERNAME =
  (typeof process !== "undefined" &&
    process.env?.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME) ||
  "YOUR_BOT_USERNAME";

export default function ProfilePage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [tgLinked, setTgLinked] = useState<boolean | null>(null);
  const [tgChatId, setTgChatId] = useState<string | null>(null);

  const loadTg = async (uid: string) => {
    try {
      const { data } = await supabase
        .from("profiles")
        .select("telegram_chat_id, full_name")
        .eq("id", uid)
        .maybeSingle();
      if (data?.telegram_chat_id) {
        setTgLinked(true);
        setTgChatId(String(data.telegram_chat_id));
      } else {
        setTgLinked(false);
        setTgChatId(null);
      }
      if (data?.full_name) setName((n) => n || data.full_name);
    } catch {
      setTgLinked(false);
    }
  };

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      const u = data.session?.user ?? null;
      setUser(u);
      if (u) {
        setName(u.user_metadata?.full_name || u.user_metadata?.name || "");
        await loadTg(u.id);
      }
    })();
  }, []);

  if (!user) {
    return (
      <div className="min-h-screen bg-[#0b0e11] text-gray-100 flex items-center justify-center p-6">
        <div className="text-center space-y-3">
          <p className="text-gray-400">Sign in to view your profile</p>
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

  const meta = user.user_metadata || {};
  const avatarUrl = meta.avatar_url || meta.picture || null;
  const letter = ((name || user.email || "U")[0] || "U").toUpperCase();

  const save = async () => {
    setSaving(true);
    setMsg("");
    const { error } = await supabase.auth.updateUser({
      data: { full_name: name.trim() },
    });
    if (!error) {
      try {
        await supabase.from("profiles").upsert({
          id: user.id,
          email: user.email,
          full_name: name.trim(),
          updated_at: new Date().toISOString(),
        });
      } catch {}
    }
    setSaving(false);
    setMsg(error ? error.message : "Saved");
  };

  const logout = async () => {
    await supabase.auth.signOut();
    router.push("/watchlist");
  };

  const connectTelegram = () => {
    const url = `https://t.me/${BOT_USERNAME}?start=${user.id}`;
    window.open(url, "_blank", "noopener,noreferrer");
    setMsg("Press Start in Telegram, then tap Check status here.");
  };

  const refreshTg = async () => {
    await loadTg(user.id);
    setMsg("Telegram status updated");
  };

  const unlinkTelegram = async () => {
    await supabase
      .from("profiles")
      .update({ telegram_chat_id: null, updated_at: new Date().toISOString() })
      .eq("id", user.id);
    setTgLinked(false);
    setTgChatId(null);
    setMsg("Telegram unlinked");
  };

  return (
    <div className="min-h-screen bg-[#0b0e11] text-gray-100 p-4 md:p-8">
      <div className="max-w-md mx-auto space-y-6">
        <h1 className="text-xl font-bold">Profile</h1>

        <div className="flex items-center gap-4">
          <div className="w-16 h-16 rounded-full overflow-hidden border-2 border-orange-500/60 bg-gray-800 flex items-center justify-center">
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="text-2xl font-bold text-orange-300">{letter}</span>
            )}
          </div>
          <div>
            <p className="font-medium">{name || "—"}</p>
            <p className="text-sm text-gray-500">{user.email}</p>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs text-gray-400">Display name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2.5 text-sm outline-none focus:border-orange-500"
          />
        </div>

        {/* Connect Telegram — deep link /start USER_ID */}
        <div className="rounded-2xl border border-gray-800 bg-gray-900/50 p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Telegram alerts</p>
            <span
              className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${
                tgLinked
                  ? "bg-emerald-500/20 text-emerald-300"
                  : "bg-gray-800 text-gray-400"
              }`}
            >
              {tgLinked === null ? "…" : tgLinked ? "Linked ✅" : "Not linked"}
            </span>
          </div>
          <p className="text-xs text-gray-500 leading-relaxed">
            Tap the button below, then press Start in Telegram so alarms go only to your chat.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={connectTelegram}
              className="px-3 py-2 rounded-xl bg-[#229ED9] text-white text-sm font-semibold"
            >
              Connect Telegram
            </button>
            <button
              type="button"
              onClick={refreshTg}
              className="px-3 py-2 rounded-xl bg-gray-800 text-gray-200 text-sm"
            >
              Check status
            </button>
            {tgLinked && (
              <button
                type="button"
                onClick={unlinkTelegram}
                className="px-3 py-2 rounded-xl bg-gray-800 text-red-400 text-sm"
              >
                Unlink
              </button>
            )}
          </div>
          {tgChatId && (
            <p className="text-[11px] text-gray-600 break-all">chat_id: {tgChatId}</p>
          )}
        </div>

        {msg && <p className="text-xs text-gray-400">{msg}</p>}

        <div className="flex gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={save}
            className="px-4 py-2 rounded-xl bg-orange-500 text-black text-sm font-semibold disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={logout}
            className="px-4 py-2 rounded-xl bg-gray-800 text-red-400 text-sm"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

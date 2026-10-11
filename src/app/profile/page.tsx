"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import type { User } from "@supabase/supabase-js";
import { useRouter } from "next/navigation";

export default function ProfilePage() {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      const u = data.session?.user ?? null;
      setUser(u);
      if (u) {
        setName(u.user_metadata?.full_name || u.user_metadata?.name || "");
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
    setSaving(false);
    setMsg(error ? error.message : "Saved");
  };

  const logout = async () => {
    await supabase.auth.signOut();
    router.push("/watchlist");
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

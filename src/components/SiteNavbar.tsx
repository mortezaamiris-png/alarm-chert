"use client";

/**
 * Shared top navbar: Profile + Messages (left) | Home Watchlist Charts Alerts (center) | Bell (right)
 * Put this in your layout so it appears on every page.
 *
 * Replace / integrate into: src/components/Navbar.tsx  OR  src/app/layout.tsx header
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import type { User, Session } from "@supabase/supabase-js";

const NAV = [
  { href: "/", label: "Home" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/dashboard", label: "Charts" },
  { href: "/alerts", label: "Alerts" },
];

function AuthModal({
  open,
  onClose,
  onAuthed,
}: {
  open: boolean;
  onClose: () => void;
  onAuthed: (user: User) => void;
}) {
  const [tab, setTab] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  if (!open) return null;

  const signInGoogle = async () => {
    setBusy(true);
    setErr("");
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: typeof window !== "undefined" ? window.location.origin : undefined,
        },
      });
      if (error) setErr(error.message);
    } catch (e: any) {
      setErr(e?.message || "Google sign-in failed");
    }
    setBusy(false);
  };

  const submitEmail = async () => {
    setBusy(true);
    setErr("");
    setInfo("");
    try {
      if (!email.trim() || !password) {
        setErr("Email and password required");
        setBusy(false);
        return;
      }
      if (tab === "login") {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        if (error) setErr(error.message);
        else if (data.user) {
          onAuthed(data.user);
          onClose();
        }
      } else {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { full_name: name.trim() || undefined } },
        });
        if (error) setErr(error.message);
        else if (data.user) {
          if (data.session) {
            onAuthed(data.user);
            onClose();
          } else {
            setInfo("Check your email to confirm, then log in.");
          }
        }
      }
    } catch (e: any) {
      setErr(e?.message || "Auth failed");
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md bg-gray-950 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-lg font-semibold text-white">
            {tab === "login" ? "Sign in" : "Create account"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-full text-gray-400 hover:bg-gray-800 hover:text-white"
          >
            ✕
          </button>
        </div>
        <div className="p-5 space-y-4">
          <button
            type="button"
            disabled={busy}
            onClick={signInGoogle}
            className="w-full flex items-center justify-center gap-3 py-2.5 rounded-xl bg-white text-gray-900 font-medium text-sm hover:bg-gray-100 disabled:opacity-60"
          >
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
              <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34.2 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.5-.4-3.5z" />
              <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 13.1 24 13.1c3 0 5.8 1.1 7.9 3l5.7-5.7C34.2 6.1 29.4 4 24 4 16.3 4 9.6 8.3 6.3 14.7z" />
              <path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.3l-6.3-5.3C29.3 35.1 26.8 36 24 36c-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
              <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.2 5.6l.1.1 6.3 5.3C39.3 37 44 32 44 24c0-1.3-.1-2.5-.4-3.5z" />
            </svg>
            Continue with Google
          </button>
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <div className="flex-1 h-px bg-gray-800" />
            or email
            <div className="flex-1 h-px bg-gray-800" />
          </div>
          {tab === "signup" && (
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Display name (optional)"
              className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-orange-500"
            />
          )}
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-orange-500"
            autoComplete="email"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-white outline-none focus:border-orange-500"
            autoComplete={tab === "login" ? "current-password" : "new-password"}
          />
          {err && <p className="text-red-400 text-xs">{err}</p>}
          {info && <p className="text-green-400 text-xs">{info}</p>}
          <button
            type="button"
            disabled={busy}
            onClick={submitEmail}
            className="w-full py-2.5 rounded-xl bg-orange-500 text-black font-semibold text-sm hover:bg-orange-400 disabled:opacity-60"
          >
            {busy ? "Please wait…" : tab === "login" ? "Sign in" : "Sign up"}
          </button>
          <p className="text-center text-xs text-gray-500">
            {tab === "login" ? (
              <>
                No account?{" "}
                <button type="button" className="text-orange-400 hover:underline" onClick={() => setTab("signup")}>
                  Sign up
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button type="button" className="text-orange-400 hover:underline" onClick={() => setTab("login")}>
                  Sign in
                </button>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

export default function SiteNavbar() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    let mounted = true;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (mounted) setUser(data.session?.user ?? null);
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session: Session | null) => {
      setUser(session?.user ?? null);
    });
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!user) {
      setUnreadCount(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { count, error } = await supabase
          .from("messages")
          .select("*", { count: "exact", head: true })
          .eq("to_user", user.id)
          .eq("read", false);
        if (!error && !cancelled && typeof count === "number") setUnreadCount(count);
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const meta = user?.user_metadata || {};
  const avatarUrl = meta.avatar_url || meta.picture || null;
  const displayName =
    meta.full_name || meta.name || user?.email?.split("@")[0] || "User";
  const letter = (displayName[0] || "U").toUpperCase();

  const logout = async () => {
    setMenuOpen(false);
    await supabase.auth.signOut();
    setUser(null);
  };

  return (
    <>
      <header className="sticky top-0 z-50 w-full border-b border-white/5 bg-[#0b0e11]/90 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-3 h-12 flex items-center gap-2">
          {/* LEFT — Profile + Messages (جایی که علامت زدی) */}
          <div className="flex items-center gap-1.5 shrink-0 min-w-[88px]">
            <button
              type="button"
              onClick={() => router.push("/messages")}
              title="Messages"
              className="relative w-9 h-9 rounded-full bg-gray-900 border border-gray-700 flex items-center justify-center text-gray-300 hover:bg-white/10 hover:text-white"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                <polyline points="22,6 12,13 2,6" />
              </svg>
              {unreadCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-3.5 px-1 rounded-full bg-orange-500 text-black text-[9px] font-bold flex items-center justify-center">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </button>

            {user ? (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setMenuOpen((v) => !v)}
                  title={displayName}
                  className="w-9 h-9 rounded-full overflow-hidden border-2 border-orange-500/60 hover:border-orange-400 bg-gray-800 flex items-center justify-center"
                >
                  {avatarUrl ? (
                    <img src={avatarUrl} alt="" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-sm font-bold text-orange-300">{letter}</span>
                  )}
                </button>
                {menuOpen && (
                  <div className="absolute left-0 top-full mt-1.5 z-[90] w-52 bg-gray-950 border border-gray-700 rounded-xl shadow-xl py-1">
                    <div className="px-3 py-2 border-b border-gray-800">
                      <p className="text-sm font-medium text-white truncate">{displayName}</p>
                      <p className="text-[11px] text-gray-500 truncate">{user.email}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        router.push("/profile");
                      }}
                      className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-gray-800"
                    >
                      Profile
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMenuOpen(false);
                        router.push("/messages");
                      }}
                      className="w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-gray-800"
                    >
                      Messages
                    </button>
                    <button
                      type="button"
                      onClick={logout}
                      className="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-gray-800"
                    >
                      Sign out
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAuthOpen(true)}
                className="h-8 px-2.5 rounded-full bg-orange-500 text-black text-[11px] font-semibold hover:bg-orange-400"
              >
                Sign in
              </button>
            )}
          </div>

          {/* CENTER — main nav */}
          <nav className="flex-1 flex justify-center">
            <div className="inline-flex items-center gap-0.5 rounded-full bg-gray-900/80 border border-gray-700/80 p-0.5">
              {NAV.map((item) => {
                const active =
                  item.href === "/"
                    ? pathname === "/"
                    : pathname?.startsWith(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`px-3 sm:px-4 py-1.5 rounded-full text-xs sm:text-sm font-medium transition-colors ${
                      active
                        ? "bg-gray-700 text-white"
                        : "text-gray-400 hover:text-white"
                    }`}
                  >
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </nav>

          {/* RIGHT — spacer / push notifications slot (keep your existing Bell if needed) */}
          <div className="min-w-[88px] flex justify-end">
            {/* Your existing Bell button can stay here in layout if separate */}
          </div>
        </div>
      </header>

      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} onAuthed={setUser} />
    </>
  );
}

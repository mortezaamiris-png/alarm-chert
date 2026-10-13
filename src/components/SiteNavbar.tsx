"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

type AuthUser = {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, any>;
};

/** VAPID public key — must match server private key */
const VAPID_PUBLIC_KEY_FALLBACK =
  "BNxMii5i6PgIObzAV3J3V0RHCKZMcsuraoOisgNXJL58IL9IzWKAClubnW8QFYtNFL07-D32iZctMZGGNw7LVpg";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function ensurePushSubscription(): Promise<"ok" | "denied" | "unsupported" | "no-key" | "error"> {
  if (typeof window === "undefined") return "unsupported";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return "unsupported";
  }
  const vapid =
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_VAPID_PUBLIC_KEY) ||
    VAPID_PUBLIC_KEY_FALLBACK;
  if (!vapid) return "no-key";
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    let permission = Notification.permission;
    if (permission === "default") {
      permission = await Notification.requestPermission();
    }
    if (permission !== "granted") return "denied";
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid),
      });
    }
    const json = sub.toJSON();
    const endpoint = json.endpoint || "";
    const p256dh = json.keys?.p256dh || "";
    const auth = json.keys?.auth || "";
    if (!endpoint || !p256dh || !auth) return "error";
    const { data: existing } = await supabase
      .from("push_subscriptions")
      .select("id")
      .eq("endpoint", endpoint)
      .maybeSingle();
    if (existing?.id) {
      await supabase
        .from("push_subscriptions")
        .update({
          p256dh,
          auth,
          user_agent: navigator.userAgent,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
    } else {
      await supabase.from("push_subscriptions").insert([
        { endpoint, p256dh, auth, user_agent: navigator.userAgent },
      ]);
    }
    return "ok";
  } catch (e) {
    console.warn("Push subscribe failed", e);
    return "error";
  }
}

async function disablePushSubscription() {
  try {
    if (!("serviceWorker" in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      try {
        await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
      } catch {}
    }
  } catch {}
}

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
  onAuthed: (user: AuthUser) => void;
}) {
  const [tab, setTab] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");

  if (!open) return null;

  const finishAuth = (user: AuthUser) => {
    onAuthed(user);
    onClose();
    window.setTimeout(() => window.location.reload(), 150);
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
      if (password.length < 6) {
        setErr("Password must be at least 6 characters");
        setBusy(false);
        return;
      }

      // فقط از سرور خودمان — نه مستقیم supabase.co
      const endpoint = tab === "login" ? "/api/auth/login" : "/api/auth/signup";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          email: email.trim(),
          password,
          name: name.trim() || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));

      if (!res.ok) {
        setErr(json.error || "Request failed");
        setBusy(false);
        return;
      }

      if (tab === "signup" && json.needsEmailConfirm) {
        setInfo(
          json.message ||
            "Account created. Please check your email and confirm, then Sign in."
        );
        setTab("login");
        setBusy(false);
        return;
      }

      if (json.user) {
        finishAuth(json.user as AuthUser);
      } else {
        setErr("No user returned");
      }
    } catch (e: any) {
      setErr(e?.message || "Network error");
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
          <div className="relative">
            <input
              type={showPass ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password (min 6 chars)"
              className="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2.5 pr-12 text-sm text-white outline-none focus:border-orange-500"
              autoComplete={tab === "login" ? "current-password" : "new-password"}
            />
            <button
              type="button"
              onClick={() => setShowPass((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-1 text-xs text-gray-400 hover:text-white"
            >
              {showPass ? "Hide" : "Show"}
            </button>
          </div>
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
                <button
                  type="button"
                  className="text-orange-400 hover:underline"
                  onClick={() => {
                    setTab("signup");
                    setErr("");
                    setInfo("");
                  }}
                >
                  Sign up
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button
                  type="button"
                  className="text-orange-400 hover:underline"
                  onClick={() => {
                    setTab("login");
                    setErr("");
                    setInfo("");
                  }}
                >
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
  const [user, setUser] = useState<AuthUser | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  /** idle | ok | denied | unsupported | no-key | error */
  const [pushStatus, setPushStatus] = useState<string>("idle");

  // Restore push status if permission already granted (iPad PWA)
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      setPushStatus("unsupported");
      return;
    }
    if (Notification.permission === "granted") {
      ensurePushSubscription().then(setPushStatus);
    } else if (Notification.permission === "denied") {
      setPushStatus("denied");
    }
  }, []);

  const togglePush = async () => {
    if (pushStatus === "ok") {
      await disablePushSubscription();
      setPushStatus("idle");
      return;
    }
    setPushStatus("idle");
    const result = await ensurePushSubscription();
    setPushStatus(result);
    if (result === "ok") {
      try {
        new Notification("Alarm Chart", {
          body: "Notifications ON — you will get alerts when alarms hit",
          icon: "/icon-192.png",
        });
      } catch {}
    }
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch("/api/auth/me", { credentials: "same-origin" });
        const json = await res.json();
        if (mounted) setUser(json.user ?? null);
      } catch {
        if (mounted) setUser(null);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!user) setUnreadCount(0);
  }, [user]);

  const meta = user?.user_metadata || {};
  const avatarUrl = meta.avatar_url || meta.picture || null;
  const displayName =
    meta.full_name || meta.name || user?.email?.split("@")[0] || "User";
  const letter = (displayName[0] || "U").toUpperCase();

  const logout = async () => {
    setMenuOpen(false);
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
    } catch {}
    setUser(null);
    window.location.reload();
  };

  return (
    <>
      <header className="sticky top-0 z-50 w-full border-b border-white/5 bg-[#0b0e11]/90 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-3 h-12 flex items-center gap-2">
          {/* LEFT: Sign in / Profile + Messages */}
          <div className="flex items-center gap-1.5 shrink-0 min-w-[88px]">
            {user ? (
              <>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setMenuOpen((v) => !v)}
                    title={displayName}
                    className="w-9 h-9 rounded-full overflow-hidden border-2 border-orange-500/60 hover:border-orange-400 bg-gray-800 flex items-center justify-center"
                  >
                    {avatarUrl ? (
                      <img
                        src={avatarUrl}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-sm font-bold text-orange-300">
                        {letter}
                      </span>
                    )}
                  </button>
                  {menuOpen && (
                    <div className="absolute left-0 top-full mt-1.5 z-[90] w-52 bg-gray-950 border border-gray-700 rounded-xl shadow-xl py-1">
                      <div className="px-3 py-2 border-b border-gray-800">
                        <p className="text-sm font-medium text-white truncate">
                          {displayName}
                        </p>
                        <p className="text-[11px] text-gray-500 truncate">
                          {user.email}
                        </p>
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
                <button
                  type="button"
                  onClick={() => router.push("/messages")}
                  title="Messages"
                  className="relative w-9 h-9 rounded-full bg-gray-900 border border-gray-700 flex items-center justify-center text-gray-300 hover:bg-white/10 hover:text-white"
                >
                  <svg
                    width="17"
                    height="17"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                    <polyline points="22,6 12,13 2,6" />
                  </svg>
                  {unreadCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-3.5 px-1 rounded-full bg-orange-500 text-black text-[9px] font-bold flex items-center justify-center">
                      {unreadCount > 9 ? "9+" : unreadCount}
                    </span>
                  )}
                </button>
              </>
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

          {/* CENTER: Nav */}
          <nav className="flex-1 flex items-center justify-center gap-1">
            {NAV.map((item) => {
              const active =
                item.href === "/"
                  ? pathname === "/"
                  : pathname?.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`px-3 py-1.5 rounded-full text-sm ${
                    active
                      ? "bg-gray-800 text-white"
                      : "text-gray-400 hover:text-white hover:bg-white/5"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          {/* RIGHT: Push notifications On/Off (global — all pages) */}
          <div className="w-[100px] shrink-0 flex items-center justify-end">
            <button
              type="button"
              onClick={togglePush}
              title={
                pushStatus === "ok"
                  ? "Notifications ON — tap to turn off"
                  : pushStatus === "denied"
                  ? "Blocked — enable in iPad Settings → Notifications"
                  : pushStatus === "unsupported"
                  ? "Add to Home Screen (Safari Share) then enable"
                  : "Enable alarm notifications"
              }
              className={`h-8 px-2.5 rounded-full text-xs font-medium inline-flex items-center gap-1.5 border transition-all ${
                pushStatus === "ok"
                  ? "bg-emerald-500/20 border-emerald-500 text-emerald-300"
                  : pushStatus === "denied"
                  ? "bg-red-500/15 border-red-500/60 text-red-300"
                  : "bg-gray-900 border-gray-700 text-gray-300 hover:bg-white/10 hover:text-white"
              }`}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill={pushStatus === "ok" ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              <span>
                {pushStatus === "ok"
                  ? "On"
                  : pushStatus === "denied"
                  ? "Blocked"
                  : "Off"}
              </span>
            </button>
          </div>
        </div>
      </header>

      <AuthModal
        open={authOpen}
        onClose={() => setAuthOpen(false)}
        onAuthed={(u) => setUser(u)}
      />
    </>
  );
}

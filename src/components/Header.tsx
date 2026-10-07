"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

const NAV = [
  { href: "/", label: "Home" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/dashboard", label: "Charts" },
  { href: "/alerts", label: "Alerts" },
];

const VAPID_PUBLIC_KEY =
  (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_VAPID_PUBLIC_KEY) ||
  "BNxMii5i6PgIObzAV3J3V0RHCKZMcsuraoOisgNXJL58IL9IzWKAClubnW8QFYtNFL07-D32iZctMZGGNw7LVpg";

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function subscribePush(): Promise<boolean> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return false;
  }
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;

  let permission = Notification.permission;
  if (permission === "default") {
    permission = await Notification.requestPermission();
  }
  if (permission !== "granted") return false;

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
  }

  const json = sub.toJSON();
  const endpoint = json.endpoint!;
  const p256dh = json.keys?.p256dh!;
  const auth = json.keys?.auth!;

  await supabase.from("push_subscriptions").upsert(
    {
      endpoint,
      p256dh,
      auth,
      user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "endpoint" }
  );

  return true;
}

async function unsubscribePush(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
    }
  } catch {}
}

export default function Header() {
  const pathname = usePathname();
  const [pushOn, setPushOn] = useState(false);
  const [busy, setBusy] = useState(false);

  // Check real subscription status (not just Notification.permission)
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (alive) setPushOn(!!sub && Notification.permission === "granted");
      } catch {
        if (alive && typeof Notification !== "undefined") {
          setPushOn(Notification.permission === "granted");
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const togglePush = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (pushOn) {
        await unsubscribePush();
        setPushOn(false);
      } else {
        const ok = await subscribePush();
        setPushOn(ok);
        if (!ok) alert("Could not enable push. Allow notifications and try again.");
      }
    } catch (e) {
      console.warn(e);
      alert("Push toggle failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="sticky top-0 z-50 border-b border-gray-800 bg-[#0a0a0a]/95 backdrop-blur">
      <div className="max-w-7xl mx-auto px-3 h-12 flex items-center justify-between gap-2">
        <div className="w-10 sm:w-16 shrink-0" />

        <nav className="flex items-center gap-0.5 sm:gap-1 bg-gray-900/80 border border-gray-800 rounded-full px-1 py-0.5">
          {NAV.map((item) => {
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`px-2.5 sm:px-3.5 py-1.5 rounded-full text-xs sm:text-sm font-medium transition ${
                  active
                    ? "bg-gray-700 text-white"
                    : "text-gray-400 hover:text-white"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Real Push On/Off — works every time */}
        <div className="flex items-center justify-end shrink-0">
          <button
            type="button"
            onClick={togglePush}
            disabled={busy}
            title={pushOn ? "Click to turn OFF push notifications" : "Click to turn ON push notifications"}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs sm:text-sm border transition ${
              pushOn
                ? "bg-green-900/40 border-green-700 text-green-300 hover:bg-red-900/40 hover:border-red-600 hover:text-red-300"
                : "bg-gray-900 border-gray-700 text-gray-300 hover:border-blue-600 hover:text-white"
            } ${busy ? "opacity-60 cursor-wait" : ""}`}
          >
            <span>🔔</span>
            <span>{busy ? "..." : pushOn ? "On" : "Off"}</span>
          </button>
        </div>
      </div>
    </header>
  );
}

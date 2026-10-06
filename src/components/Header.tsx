"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const NAV = [
  { href: "/", label: "Home" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/dashboard", label: "Charts" },
  { href: "/alerts", label: "Alerts" },
];

function playBeep() {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g);
    g.connect(ctx.destination);
    o.frequency.value = 880;
    o.type = "sine";
    g.gain.setValueAtTime(0.2, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
    o.start();
    o.stop(ctx.currentTime + 0.35);
  } catch {}
}

export default function Header() {
  const pathname = usePathname();
  const [notifOn, setNotifOn] = useState(false);

  useEffect(() => {
    if (typeof Notification !== "undefined") {
      setNotifOn(Notification.permission === "granted");
    }
  }, []);

  const enableNotif = async () => {
    try {
      if (typeof Notification === "undefined") {
        alert("Notifications not supported");
        return;
      }
      const p = await Notification.requestPermission();
      setNotifOn(p === "granted");
      if (p === "granted") {
        playBeep();
        new Notification("Alarm Chert", {
          body: "Notifications enabled",
          icon: "/icon-192.png",
        });
      }
    } catch {
      alert("Could not enable notifications");
    }
  };

  return (
    <header className="sticky top-0 z-50 border-b border-gray-800 bg-[#0a0a0a]/95 backdrop-blur">
      <div className="max-w-7xl mx-auto px-3 h-12 flex items-center justify-between gap-2">
        {/* left spacer for balance on desktop */}
        <div className="w-10 sm:w-16 shrink-0" />

        {/* CENTER nav — TradingView style */}
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

        {/* RIGHT — Notify only (no Alarm Chert text) */}
        <div className="flex items-center justify-end shrink-0">
          <button
            type="button"
            onClick={enableNotif}
            title={notifOn ? "Notifications on" : "Enable notifications"}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs sm:text-sm border ${
              notifOn
                ? "bg-green-900/40 border-green-700 text-green-300"
                : "bg-gray-900 border-gray-700 text-gray-300 hover:text-white"
            }`}
          >
            <span>🔔</span>
            <span className="hidden sm:inline">{notifOn ? "On" : "Notify"}</span>
          </button>
        </div>
      </div>
    </header>
  );
}

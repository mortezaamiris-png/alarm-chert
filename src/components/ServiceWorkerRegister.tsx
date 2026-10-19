"use client";

import { useEffect } from "react";

/**
 * Register SW for push + soft update.
 * Reloads at most ONCE per browser tab session after a new SW takes control.
 * Avoids the infinite refresh loop (waiting → skipWaiting → controllerchange → reload → …).
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    const RELOAD_KEY = "sw_one_reload_v6";

    const reloadOnce = () => {
      try {
        if (sessionStorage.getItem(RELOAD_KEY)) return;
        sessionStorage.setItem(RELOAD_KEY, "1");
      } catch (_) {
        return;
      }
      // Normal reload — not replace with changing query (that felt like endless refresh)
      window.location.reload();
    };

    const onControllerChange = () => {
      reloadOnce();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    const SW_URL = "/sw.js?v=2026-10-19-v6";

    navigator.serviceWorker
      .register(SW_URL, { scope: "/", updateViaCache: "none" })
      .then((reg) => {
        const kickWaiting = () => {
          if (reg.waiting) {
            reg.waiting.postMessage({ type: "SKIP_WAITING" });
          }
        };

        try {
          reg.update();
        } catch (_) {}

        kickWaiting();

        reg.addEventListener("updatefound", () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener("statechange", () => {
            if (nw.state === "installed") {
              kickWaiting();
            }
          });
        });
      })
      .catch(() => {});

    // Soft update check every 10 minutes (not every minute — reduces churn)
    const t = window.setInterval(() => {
      navigator.serviceWorker.getRegistration().then((reg) => {
        try {
          reg?.update();
        } catch (_) {}
      });
    }, 10 * 60 * 1000);

    return () => {
      window.clearInterval(t);
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange
      );
    };
  }, []);

  return null;
}

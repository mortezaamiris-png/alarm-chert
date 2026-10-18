"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js and forces update check on every load.
 * When a new SW activates, reloads once so users get the new deploy without a new URL.
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    let reloading = false;

    const onControllerChange = () => {
      // New SW took control → one reload to pick up new assets
      if (reloading) return;
      reloading = true;
      window.location.reload();
    };

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    const onMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === "SW_UPDATED" && !reloading) {
        reloading = true;
        window.location.reload();
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);

    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        // Check for updates on every page load
        try {
          reg.update();
        } catch (_) {}

        // If there's a waiting worker, activate it
        if (reg.waiting) {
          reg.waiting.postMessage({ type: "SKIP_WAITING" });
        }

        reg.addEventListener("updatefound", () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener("statechange", () => {
            if (nw.state === "installed" && navigator.serviceWorker.controller) {
              // New version ready → activate
              if (reg.waiting) {
                reg.waiting.postMessage({ type: "SKIP_WAITING" });
              }
            }
          });
        });
      })
      .catch(() => {
        /* ignore */
      });

    // Periodic update check while tab stays open (every 5 min)
    const t = window.setInterval(() => {
      navigator.serviceWorker.getRegistration().then((reg) => {
        try {
          reg?.update();
        } catch (_) {}
      });
    }, 5 * 60 * 1000);

    return () => {
      window.clearInterval(t);
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange
      );
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, []);

  return null;
}

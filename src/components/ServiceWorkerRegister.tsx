"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js with cache-bust, forces update, activates waiting SW, one reload.
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    let reloading = false;

    const safeReload = () => {
      if (reloading) return;
      reloading = true;
      // full reload bypassing HTTP cache
      const url = new URL(window.location.href);
      url.searchParams.set("_sw", String(Date.now()));
      window.location.replace(url.toString());
    };

    const onControllerChange = () => {
      safeReload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    const onMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === "SW_UPDATED") {
        safeReload();
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);

    // Cache-bust so browser must re-fetch sw.js after each deploy (version in query)
    const SW_URL = "/sw.js?v=2026-10-19-v6";

    navigator.serviceWorker
      .register(SW_URL, { scope: "/", updateViaCache: "none" })
      .then(async (reg) => {
        try {
          await reg.update();
        } catch (_) {}

        if (reg.waiting) {
          reg.waiting.postMessage({ type: "SKIP_WAITING" });
        }

        reg.addEventListener("updatefound", () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener("statechange", () => {
            if (nw.state === "installed") {
              if (reg.waiting) {
                reg.waiting.postMessage({ type: "SKIP_WAITING" });
              }
            }
          });
        });
      })
      .catch(() => {});

    const t = window.setInterval(() => {
      navigator.serviceWorker.getRegistration().then((reg) => {
        try {
          reg?.update();
          if (reg?.waiting) {
            reg.waiting.postMessage({ type: "SKIP_WAITING" });
          }
        } catch (_) {}
      });
    }, 60 * 1000);

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

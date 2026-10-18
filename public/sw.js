/* Alarm Chart — Service Worker
 * Push notifications only. Do NOT cache app HTML/JS (always network for navigations).
 * On activate: drop any old Cache Storage so deploys show up after refresh.
 *
 * Multi-device:
 * - If a tab is focused → postMessage to page (no second system notification on that device)
 * - If no focused tab → show system notification (desktop closed / phone background)
 */
const SW_VERSION = "2026-10-18-v4-multidevice";

self.addEventListener("install", (event) => {
  // Activate immediately on new deploy
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Delete every Cache Storage entry from older SW versions
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch (_) {}
      await self.clients.claim();
      // Tell open tabs a new SW is active
      try {
        const clients = await self.clients.matchAll({ type: "window" });
        for (const c of clients) {
          c.postMessage({ type: "SW_UPDATED", version: SW_VERSION });
        }
      } catch (_) {}
    })()
  );
});

// Never serve stale HTML/JS from Cache Storage — always network for page loads
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Same-origin navigations + Next data: network only (no cache put)
  const isNavigate = req.mode === "navigate";
  const isNext = url.pathname.startsWith("/_next/");
  const isDoc =
    req.destination === "document" ||
    req.headers.get("accept")?.includes("text/html");

  if (isNavigate || isDoc) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req).then((r) => r || Response.error()))
    );
    return;
  }

  // Let browser handle static/_next with normal HTTP cache (hashed filenames)
  // Do not put responses into Cache Storage
});

self.addEventListener("push", (event) => {
  let data = {
    title: "Alarm Chart",
    body: "Alarm triggered",
    url: "/dashboard",
    tag: "alarm-chert",
    alarmId: "",
  };
  try {
    if (event.data) {
      const j = event.data.json();
      data = { ...data, ...j };
    }
  } catch {
    try {
      data.body = event.data ? event.data.text() : data.body;
    } catch {}
  }

  event.waitUntil(
    (async () => {
      // تب فوکوس‌شده روی همین دستگاه؟ → نوتیف سیستم نده (صفحه خودش لوکال نشان می‌دهد)
      // بقیه دستگاه‌ها (ایپد/گوشی) تب فوکوس ندارند → نوتیف سیستم می‌گیرند
      let focused = [];
      try {
        const all = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        focused = all.filter((c) => {
          try {
            return !!c.focused;
          } catch {
            return false;
          }
        });
      } catch (_) {}

      if (focused.length > 0) {
        for (const c of focused) {
          try {
            c.postMessage({
              type: "ALARM_PUSH",
              title: data.title,
              body: data.body,
              alarmId: data.alarmId || "",
              url: data.url || "/dashboard",
            });
          } catch (_) {}
        }
        return;
      }

      await self.registration.showNotification(data.title || "Alarm Chart", {
        body: data.body || "Alarm triggered",
        icon: data.icon || "/icon-192.png",
        badge: data.badge || "/icon-192.png",
        tag: data.tag || (data.alarmId ? "alarm-" + data.alarmId : "alarm-chert"),
        renotify: true,
        requireInteraction: true,
        data: { url: data.url || "/dashboard", alarmId: data.alarmId || "" },
        vibrate: [200, 100, 200],
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target =
    (event.notification.data && event.notification.data.url) || "/dashboard";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if ("focus" in client) {
            try {
              client.navigate(target);
            } catch (_) {}
            return client.focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(target);
      })
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

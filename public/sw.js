/* Alarm Chart — Service Worker
 * Push only. No Cache Storage for app shell.
 * Version bump forces browsers to fetch a new SW file.
 */
const SW_VERSION = "2026-10-19-v6-force";

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch (_) {}
      await self.clients.claim();
      try {
        const clients = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        });
        for (const c of clients) {
          c.postMessage({ type: "SW_UPDATED", version: SW_VERSION });
        }
      } catch (_) {}
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const isNavigate = req.mode === "navigate";
  const isDoc =
    req.destination === "document" ||
    (req.headers.get("accept") || "").includes("text/html");

  if (isNavigate || isDoc) {
    event.respondWith(
      fetch(req, { cache: "no-store" }).catch(() => Response.error())
    );
    return;
  }

  try {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/_next/data/")) {
      event.respondWith(
        fetch(req, { cache: "no-store" }).catch(() => Response.error())
      );
    }
  } catch (_) {}
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
        silent: false,
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

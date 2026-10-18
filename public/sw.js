/* Alarm Chart — Service Worker
 * Push notifications only. Do NOT cache app HTML/JS (always network for navigations).
 * On activate: drop any old Cache Storage so deploys show up after refresh.
 */
const SW_VERSION = "2026-10-16-v3";

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
  let data = { title: "Alarm Chart", body: "Alarm triggered", url: "/dashboard" };
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
    self.registration.showNotification(data.title || "Alarm Chart", {
      body: data.body || "Alarm triggered",
      icon: data.icon || "/icon-192.png",
      badge: data.badge || "/icon-192.png",
      tag: data.tag || "alarm-chert",
      renotify: true,
      requireInteraction: true,
      data: { url: data.url || "/dashboard" },
      vibrate: [200, 100, 200],
    })
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
            client.navigate(target);
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

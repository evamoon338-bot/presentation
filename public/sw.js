/* Yap service worker: handles Web Push delivery for calls and messages. */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (error) {
    payload = { title: "Yap", body: event.data ? event.data.text() : "New activity" };
  }

  const title = payload.title || "Yap";
  const isCall = payload.type === "call";
  const options = {
    body: payload.body || "New activity",
    icon: payload.icon || "/icons/circle-192.png",
    badge: "/icons/circle-192.png",
    tag: payload.tag || (isCall ? "yap-call" : "yap-notification"),
    renotify: true,
    requireInteraction: isCall,
    vibrate: isCall ? [400, 200, 400, 200, 400] : [120],
    data: { url: payload.url || "/", type: payload.type || "" },
    actions: isCall
      ? [
          { action: "open", title: "Open" },
          { action: "dismiss", title: "Dismiss" },
        ]
      : [],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "dismiss") return;

  const targetUrl = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          if (client.url.includes(self.location.origin)) {
            client.navigate(targetUrl).catch(() => {});
            return client.focus();
          }
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});

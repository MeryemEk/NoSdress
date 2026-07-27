const CACHE = "dressing-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.pathname.startsWith("/api/")) return;
  if (url.origin !== self.location.origin && !url.hostname.includes("fonts.")) return;
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const garde = await c.match(e.request);
      const reseau = fetch(e.request)
        .then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; })
        .catch(() => garde);
      return garde || reseau;
    })
  );
});

/* Version du cache. À incrémenter si la stratégie change : à l'activation, tous
   les caches d'une autre version sont supprimés. */
const VERSION = "v2";
const CACHE = `dressing-${VERSION}`;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const noms = await caches.keys();
    await Promise.all(noms.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.pathname.startsWith("/api/")) return;
  if (url.origin !== self.location.origin && !url.hostname.includes("fonts.")) return;

  /* Le document HTML : réseau d'abord. C'est lui qui désigne la version des
     fichiers à charger, donc le servir depuis le cache fige l'application sur
     une version périmée. Le cache ne sert plus que de secours hors ligne. */
  if (e.request.mode === "navigate") {
    e.respondWith((async () => {
      try {
        const r = await fetch(e.request);
        if (r.ok) (await caches.open(CACHE)).put(e.request, r.clone());
        return r;
      } catch (err) {
        const c = await caches.open(CACHE);
        return (await c.match(e.request)) || (await c.match("/")) || Response.error();
      }
    })());
    return;
  }

  /* Fichiers produits par le build : leur nom contient une empreinte, donc un
     nom donné désigne toujours le même contenu. Le cache est sûr. */
  if (url.origin === self.location.origin && url.pathname.startsWith("/assets/")) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const garde = await c.match(e.request);
      if (garde) return garde;
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    })());
    return;
  }

  /* Le reste, aux noms fixes : on sert le cache tout de suite et on le
     rafraîchit derrière, pour ne pas figer une icône ou le manifeste. */
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const garde = await c.match(e.request);
    const reseau = fetch(e.request)
      .then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; })
      .catch(() => garde);
    return garde || reseau;
  })());
});

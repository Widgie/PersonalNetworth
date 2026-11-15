// App shell cache-first; prices network-first so the latest file is used when online.
const CACHE = "nw-v7";
const SHELL = ["./", "index.html", "app.js", "calc.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-180.png", "fonts/sans.woff2", "fonts/serif.woff2"];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return; // CoinGecko etc. go straight to network
  const networkFirst = u.pathname.endsWith("prices.json") || e.request.mode === "navigate" || /\.(js|html)$/.test(u.pathname);
  if (networkFirst) {
    e.respondWith(fetch(e.request, { cache: "no-cache" }).then((r) => {
      const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })));
  } else {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
  }
});

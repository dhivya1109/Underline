// Keeps the app opening instantly and working offline. Quotes themselves are cached by app.js.
// Bump VERSION whenever any of these files change so everyone gets the update.
const VERSION = "underline-v5";
const FILES = [
  "./",
  "index.html",
  "app.css",
  "app.js",
  "config.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
  "icons/favicon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(FILES)));
  self.skipWaiting();
});

const SHARE_CACHE = "underline-share";

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== SHARE_CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Android "Share → Underline" posts here (see share_target in manifest.webmanifest).
// GitHub Pages can't receive a POST, so handle it here: keep any image for the app to read,
// then open the app with the shared text in the address.
async function receiveShare(request) {
  const form = await request.formData();
  const params = new URLSearchParams();
  for (const key of ["title", "text", "url"]) {
    const value = form.get(key);
    if (value) params.set(key, value);
  }
  const image = form.get("image");
  if (image && image.size) {
    const cache = await caches.open(SHARE_CACHE);
    await cache.put("shared-image", new Response(image, { headers: { "Content-Type": image.type || "image/png" } }));
    params.set("image", "1");
  }
  return Response.redirect(new URL("./?" + params, self.registration.scope).href, 303);
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.method === "POST" && url.origin === location.origin && url.pathname.endsWith("/share")) {
    event.respondWith(receiveShare(event.request));
    return;
  }

  // Only the app's own files; Google (quotes, fonts) always goes to the network
  if (event.request.method !== "GET" || url.origin !== location.origin) return;

  // Network first so updates show up, falling back to the cache when offline.
  // Share links (./?text=...) are served the cached app page.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(VERSION).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});

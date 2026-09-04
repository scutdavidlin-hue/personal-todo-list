const CACHE_NAME = "personal-os-shell-v1.2.0";
const APP_SHELL = [
  "./",
  "./index.html",
  "./today.html",
  "./styles.css",
  "./today.css",
  "./app.js",
  "./today.js",
  "./runtime-config.js",
  "./src/core.js",
  "./src/goals.js",
  "./src/cloud-client.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});

async function networkFirst(request, fallbackPath) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return (await cache.match(request, { ignoreSearch: true })) || cache.match(fallbackPath);
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    const fallback = url.pathname.endsWith("today.html") ? "./today.html" : "./index.html";
    event.respondWith(networkFirst(request, fallback));
    return;
  }

  if (url.pathname.endsWith("runtime-config.js")) {
    event.respondWith(networkFirst(request, "./runtime-config.js"));
    return;
  }

  event.respondWith(caches.open(CACHE_NAME).then(async (cache) => {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  }));
});

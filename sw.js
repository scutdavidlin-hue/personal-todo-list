const CACHE_NAME = "personal-os-shell-v1.3.4-live-speech";
const APP_SHELL = [
  "./",
  "./index.html",
  "./today.html",
  "./styles.css",
  "./today.css",
  "./app-loader.js",
  "./app.js",
  "./today.js",
  "./runtime-config.js",
  "./src/core.js",
  "./src/goals.js",
  "./src/cloud-client.js",
  "./src/task-conversation.js",
  "./task-conversation.css",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("personal-os-shell-") && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

async function networkFirst(request, fallbackPath) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request, { cache: "no-cache" });
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

  if (/\.(?:js|css)$/.test(url.pathname)) {
    event.respondWith(networkFirst(request, url.pathname));
    return;
  }

  event.respondWith(caches.open(CACHE_NAME).then(async (cache) => {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    const response = await fetch(request, { cache: "no-cache" });
    if (response.ok) cache.put(request, response.clone());
    return response;
  }));
});

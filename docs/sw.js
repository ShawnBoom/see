"use strict";

importScripts("./lut-pack-sw.js?v=1");

const CORE_CACHE = "see-core-v61";
const PREVIOUS_CORE_CACHE = "see-core-v60";
const RELEASE_SCRIPT = "./app-v61.js";
const ROOT = new URL("./", self.registration.scope).href;
const LUT_MANIFEST_URL = new URL("./lut-pack-v1.json", ROOT).href;
const CORE_APP_SHELL = [
  ROOT,
  new URL("./index.html", ROOT).href,
  new URL("./styles.css?v=61", ROOT).href,
  new URL("./app-v61.js", ROOT).href,
  new URL("./gpu-preview-v60.js", ROOT).href,
  new URL("./gpu-export-v60.js", ROOT).href,
  new URL("./export-processor-v60.js", ROOT).href,
  new URL("./export-worker-v60.js", ROOT).href,
  new URL("./edit-state-v60.js", ROOT).href,
  new URL("./image-engine-v60.js", ROOT).href,
  new URL("./lut-loader-v60.js", ROOT).href,
  new URL("./lut-pack-sw.js?v=1", ROOT).href,
  LUT_MANIFEST_URL,
  new URL("./manifest.webmanifest?v=60", ROOT).href,
  new URL("./apple-touch-icon.png?v=60", ROOT).href,
  new URL("./icons/see-apple-touch-icon-120.png", ROOT).href,
  new URL("./icons/see-apple-touch-icon-152.png", ROOT).href,
  new URL("./icons/see-apple-touch-icon-167.png", ROOT).href,
  new URL("./icons/see-apple-touch-icon-180.png", ROOT).href,
  new URL("./icons/see-icon-192.png", ROOT).href,
  new URL("./icons/see-icon-512.png", ROOT).href,
  new URL("./see-logo.png", ROOT).href,
  new URL("./see-welcome.png", ROOT).href,
  new URL("./see-cover.png", ROOT).href,
  new URL("./s-film-social.png", ROOT).href,
  new URL("./og.png", ROOT).href,
];

async function fetchAndCache(request, cacheName, cacheKey = request) {
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(cacheName);
    await cache.put(cacheKey, response.clone());
  }
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil(Promise.all([
    (async () => {
      const cache = await caches.open(CORE_CACHE);
      await cache.addAll(CORE_APP_SHELL.map((url) => new Request(url, { cache: "reload" })));
      const shell = await cache.match(ROOT);
      if (!shell || !(await shell.text()).includes(RELEASE_SCRIPT)) {
        await caches.delete(CORE_CACHE);
        throw new Error("See. v61 shell has not propagated yet");
      }
    })(),
    self.skipWaiting(),
  ]));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key !== CORE_CACHE && key !== PREVIOUS_CORE_CACHE && !self.SeeLutPackSW.protectedCacheNames.has(key))
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const message = event.data;
  if (!message) return;
  if (message.type === "SEE_PREPARE_LUT_PACK") {
    event.waitUntil(self.SeeLutPackSW.preparePack(message.manifestUrl || LUT_MANIFEST_URL, ROOT).catch(() => {}));
  } else if (message.type === "SEE_GET_LUT_PACK_STATUS") {
    event.waitUntil(self.SeeLutPackSW.postStoredStatus(ROOT, event.source));
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    const coreCachePromise = caches.open(CORE_CACHE);
    const networkUpdate = coreCachePromise.then((cache) => fetch(request).then(async (response) => {
      if (response.ok && (await response.clone().text()).includes(RELEASE_SCRIPT)) {
        return cache.put(ROOT, response.clone()).then(() => response);
      }
      return response;
    }));
    event.waitUntil(networkUpdate.then(() => undefined).catch(() => undefined));
    event.respondWith(coreCachePromise.then(async (cache) => (
      await cache.match(ROOT)
      || networkUpdate
    )).catch(() => fetch(request)));
    return;
  }

  if (self.SeeLutPackSW.isBinaryLutRequest(url)) {
    event.respondWith(self.SeeLutPackSW.handleBinaryRequest(request, LUT_MANIFEST_URL, ROOT));
    return;
  }

  if (self.SeeLutPackSW.isLegacyLutRequest(url)) {
    event.respondWith(self.SeeLutPackSW.handleLegacyRequest(request));
    return;
  }

  if (["script", "worker", "style", "image", "font", "manifest"].includes(request.destination)
      || url.href === LUT_MANIFEST_URL) {
    event.respondWith(caches.open(CORE_CACHE).then(async (cache) => (
      await cache.match(request, { ignoreSearch: false })
      || (url.searchParams.get("v") === "60" && await (await caches.open(PREVIOUS_CORE_CACHE)).match(request))
      || fetchAndCache(request, CORE_CACHE)
    )));
  }
});

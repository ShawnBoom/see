"use strict";

importScripts("/lut-pack-sw.js?v=1");

const CORE_CACHE = "see-core-v61";
const RUNTIME_CACHE = "see-runtime-v61";
const ROOT = new URL("/", self.registration.scope).href;
const LUT_MANIFEST_URL = new URL("/lut-pack-v1.json", ROOT).href;
const APP_SHELL = [
  "/",
  "/manifest.webmanifest",
  "/lut-pack-v1.json",
  "/lut-pack-sw.js?v=1",
  "/apple-touch-icon.png",
  "/icons/see-apple-touch-icon-120.png",
  "/icons/see-apple-touch-icon-152.png",
  "/icons/see-apple-touch-icon-167.png",
  "/icons/see-apple-touch-icon-180.png",
  "/icons/see-icon-192.png",
  "/icons/see-icon-512.png",
  "/see-logo.png",
  "/see-welcome.png",
  "/see-cover.png",
  "/og.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(Promise.all([
    caches.open(CORE_CACHE).then((cache) => cache.addAll(APP_SHELL)),
    self.skipWaiting(),
  ]));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => (
        key !== CORE_CACHE
        && key !== RUNTIME_CACHE
        && !self.SeeLutPackSW.protectedCacheNames.has(key)
      ))
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
    const cachePromise = caches.open(CORE_CACHE);
    const networkUpdate = cachePromise.then((cache) => fetch(request).then((response) => {
      if (response.ok) return cache.put(ROOT, response.clone()).then(() => response);
      return response;
    }));
    event.waitUntil(networkUpdate.then(() => undefined).catch(() => undefined));
    event.respondWith(cachePromise.then(async (cache) => (
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

  if (["script", "style", "image", "font", "manifest"].includes(request.destination)
      || url.href === LUT_MANIFEST_URL) {
    event.respondWith(caches.open(RUNTIME_CACHE).then(async (cache) => (
      await cache.match(request)
      || fetch(request).then((response) => {
        if (response.ok) return cache.put(request, response.clone()).then(() => response);
        return response;
      })
    )));
  }
});

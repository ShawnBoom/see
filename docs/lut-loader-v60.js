import { getFilterLut, registerFilterLut } from "./image-engine-v60.js";

export const LUT_ARCHITECTURE = "binary";
export const LUT_PACK_VERSION = "1";
const runtimeRoot = globalThis.location?.href
  ? new URL("./", globalThis.location.href)
  : new URL(/* @vite-ignore */ "../public/", import.meta.url);
export const LUT_PACK_MANIFEST_URL = new URL(`lut-pack-v${LUT_PACK_VERSION}.json`, runtimeRoot).href;
export const LUT_BINARY_CACHE = `see-luts-bin-v${LUT_PACK_VERSION}`;

const LEGACY_LUT_MODULES = Object.freeze({
  classic: ["s01-classic-neg-lut.js", "S01_LUT", "S01_LUT_SIZE"],
  gold: ["s02-classic-chrome-lut.js", "S02_LUT", "S02_LUT_SIZE"],
  youth: ["s03-classic-chrome-lut.js", "S03_LUT", "S03_LUT_SIZE"],
  slot04: ["s04-pro400h-lut.js", "S04_LUT", "S04_LUT_SIZE"],
  slot05: ["s05-superia400-lut.js", "S05_LUT", "S05_LUT_SIZE"],
  slot06: ["s06-color100-lut.js", "S06_LUT", "S06_LUT_SIZE"],
  slot07: ["s07-color800z-lut.js", "S07_LUT", "S07_LUT_SIZE"],
  slot08: ["s08-gold-blue-lut.js", "S08_LUT", "S08_LUT_SIZE"],
  slot09: ["s09-portra-cool-lut.js", "S09_LUT", "S09_LUT_SIZE"],
  slot10: ["s10-proimage-original-lut.js", "S10_LUT", "S10_LUT_SIZE"],
  slot11: ["s11-ektar100-lut.js", "S11_LUT", "S11_LUT_SIZE"],
  slot12: ["s12-portra400-lut.js", "S12_LUT", "S12_LUT_SIZE"],
  slot13: ["s13-gold200-lut.js", "S13_LUT", "S13_LUT_SIZE"],
  slot14: ["s14-chrome64-lut.js", "S14_LUT", "S14_LUT_SIZE"],
});

const pendingLoads = new Map();
const statusListeners = new Set();
let manifestPromise = null;
let serviceWorkerMessagesInstalled = false;
let packStatus = Object.freeze({
  architecture: LUT_ARCHITECTURE,
  packVersion: LUT_PACK_VERSION,
  cachedCount: 0,
  totalCount: 14,
  cachedBytes: 0,
  totalBytes: 0,
  ready: false,
  preparation: "idle",
  currentLut: "—",
  currentDimension: "—",
  currentSource: "—",
  error: "",
});

function updateStatus(patch) {
  packStatus = Object.freeze({ ...packStatus, ...patch });
  for (const listener of statusListeners) listener(packStatus);
}

export function getLutPackStatus() {
  return packStatus;
}

export function subscribeLutPackStatus(listener) {
  statusListeners.add(listener);
  listener(packStatus);
  return () => statusListeners.delete(listener);
}

function validateManifest(manifest) {
  if (!manifest || String(manifest.packVersion) !== LUT_PACK_VERSION) {
    throw new Error(`Unexpected LUT pack version: ${manifest?.packVersion ?? "missing"}`);
  }
  if (manifest.format !== "float32-le-rgb" || !Array.isArray(manifest.luts) || manifest.luts.length !== 14) {
    throw new Error("Malformed LUT pack manifest");
  }
  const ids = new Set();
  for (const entry of manifest.luts) {
    if (!entry?.id || ids.has(entry.id)) throw new Error("Duplicate or missing LUT ID");
    ids.add(entry.id);
    const expectedFloatCount = entry.dimension ** 3 * 3;
    if (entry.floatCount !== expectedFloatCount || entry.byteLength !== expectedFloatCount * 4) {
      throw new Error(`Malformed LUT metadata: ${entry.id}`);
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error(`Missing LUT checksum: ${entry.id}`);
  }
  return Object.freeze({
    ...manifest,
    luts: Object.freeze(manifest.luts.map((entry) => Object.freeze({ ...entry }))),
  });
}

export function loadLutPackManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(LUT_PACK_MANIFEST_URL, { cache: "no-cache" })
      .then((response) => {
        if (!response.ok) throw new Error(`LUT manifest HTTP ${response.status}`);
        return response.json();
      })
      .then(validateManifest)
      .then((manifest) => {
        updateStatus({ totalCount: manifest.lutCount, totalBytes: manifest.totalBytes });
        return manifest;
      })
      .catch((error) => {
        manifestPromise = null;
        throw error;
      });
  }
  return manifestPromise;
}

async function sha256Hex(buffer) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function decodeBinaryLut(buffer, entry) {
  if (!(buffer instanceof ArrayBuffer)) throw new Error(`${entry.id}: LUT payload is not an ArrayBuffer`);
  if (buffer.byteLength !== entry.byteLength) {
    throw new Error(`${entry.id}: expected ${entry.byteLength} bytes, received ${buffer.byteLength}`);
  }
  const digest = await sha256Hex(buffer);
  if (digest !== entry.sha256) throw new Error(`${entry.id}: LUT checksum mismatch`);
  const data = new Float32Array(buffer);
  if (data.length !== entry.floatCount || data.length !== entry.dimension ** 3 * 3) {
    throw new Error(`${entry.id}: LUT Float32 count mismatch`);
  }
  return data;
}

async function storeValidatedNetworkResponse(url, buffer, entry) {
  if (!("caches" in globalThis)) return;
  const cache = await caches.open(LUT_BINARY_CACHE);
  const headers = new Headers({
    "content-type": "application/octet-stream",
    "content-length": String(entry.byteLength),
    "x-see-lut-sha256": entry.sha256,
  });
  await cache.put(url, new Response(buffer.slice(0), { status: 200, headers }));
}

async function loadBinaryEntry(entry) {
  const url = new URL(entry.url, LUT_PACK_MANIFEST_URL).href;
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`${entry.id}: LUT HTTP ${response.status}`);
  const source = response.headers.get("x-see-lut-source") || "network";
  const deliveredVersion = response.headers.get("x-see-lut-pack-version") || entry.version;
  const deliveredDimension = Number(response.headers.get("x-see-lut-dimension")) || entry.dimension;
  const deliveredByteLength = Number(response.headers.get("content-length")) || entry.byteLength;
  const deliveredChecksum = response.headers.get("x-see-lut-sha256") || entry.sha256;
  const deliveredEntry = deliveredVersion === entry.version
    ? entry
    : {
      ...entry,
      dimension: deliveredDimension,
      byteLength: deliveredByteLength,
      floatCount: deliveredDimension ** 3 * 3,
      sha256: deliveredChecksum,
      version: deliveredVersion,
    };
  const buffer = await response.arrayBuffer();
  const data = await decodeBinaryLut(buffer, deliveredEntry);
  if (source === "network") await storeValidatedNetworkResponse(url, buffer, entry).catch(() => {});
  return { data, source, dimension: deliveredEntry.dimension };
}

async function loadLegacyEntry(filter, entry, binaryError) {
  const legacy = LEGACY_LUT_MODULES[filter];
  if (!legacy) throw binaryError;
  const [moduleName, dataExport, sizeExport] = legacy;
  try {
    const moduleUrl = new URL(moduleName, import.meta.url);
    moduleUrl.searchParams.set("legacy", LUT_PACK_VERSION);
    const lutModule = await import(/* @vite-ignore */ moduleUrl.href);
    const data = lutModule[dataExport];
    const size = lutModule[sizeExport];
    if (!(data instanceof Float32Array) || size !== entry.dimension || data.length !== entry.floatCount) {
      throw new Error(`${filter}: invalid legacy LUT fallback`);
    }
    return { data, source: "legacy Cache Storage", dimension: size };
  } catch {
    throw binaryError;
  }
}

export function isFilterLutLoaded(filter) {
  return Boolean(getFilterLut(filter));
}

export function loadFilterLut(filter) {
  if (!filter) return Promise.resolve(null);
  const cached = getFilterLut(filter);
  if (cached) {
    updateStatus({ currentLut: filter, currentDimension: cached.size, currentSource: "memory" });
    return Promise.resolve(cached);
  }
  const pending = pendingLoads.get(filter);
  if (pending) return pending;

  const request = loadLutPackManifest()
    .then(async (manifest) => {
      const entry = manifest.luts.find((candidate) => candidate.id === filter);
      if (!entry) throw new Error(`Unknown filter LUT: ${filter}`);
      let loaded;
      try {
        loaded = await loadBinaryEntry(entry);
      } catch (binaryError) {
        loaded = await loadLegacyEntry(filter, entry, binaryError);
      }
      const registered = registerFilterLut(filter, loaded.data, loaded.dimension);
      updateStatus({
        currentLut: filter,
        currentDimension: loaded.dimension,
        currentSource: loaded.source,
        error: "",
      });
      return registered;
    })
    .catch((error) => {
      updateStatus({ currentLut: filter, currentSource: "error", error: String(error?.message ?? error) });
      throw error;
    })
    .finally(() => pendingLoads.delete(filter));
  pendingLoads.set(filter, request);
  return request;
}

function installServiceWorkerMessages() {
  if (serviceWorkerMessagesInstalled || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  serviceWorkerMessagesInstalled = true;
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "SEE_LUT_PACK_STATUS") return;
    updateStatus({
      ...event.data.status,
      architecture: LUT_ARCHITECTURE,
      packVersion: LUT_PACK_VERSION,
    });
  });
}

export async function prepareOfflineLutPack(registration) {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    updateStatus({ preparation: "error", error: "Service Worker unavailable" });
    return packStatus;
  }
  installServiceWorkerMessages();
  let readyRegistration = registration ?? await navigator.serviceWorker.ready;
  const pendingWorker = readyRegistration.installing || readyRegistration.waiting;
  if (pendingWorker && pendingWorker.state !== "activated" && pendingWorker.state !== "redundant") {
    await new Promise((resolve) => {
      pendingWorker.addEventListener("statechange", () => {
        if (pendingWorker.state === "activated" || pendingWorker.state === "redundant") resolve();
      });
    });
  }
  if (!readyRegistration.active) readyRegistration = await navigator.serviceWorker.ready;
  const worker = readyRegistration.active || navigator.serviceWorker.controller || readyRegistration.waiting;
  if (!worker) {
    updateStatus({ preparation: "interrupted", error: "Service Worker not active" });
    return packStatus;
  }
  updateStatus({ preparation: "running", error: "" });
  worker.postMessage({ type: "SEE_PREPARE_LUT_PACK", manifestUrl: LUT_PACK_MANIFEST_URL });
  worker.postMessage({ type: "SEE_GET_LUT_PACK_STATUS", manifestUrl: LUT_PACK_MANIFEST_URL });
  return packStatus;
}

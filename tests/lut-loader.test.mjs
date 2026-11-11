import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import "./install-file-fetch.mjs";

import { getFilterLut } from "../lib/image-engine.js";
import {
  LUT_ARCHITECTURE,
  LUT_PACK_VERSION,
  loadFilterLut,
  loadLutPackManifest,
} from "../lib/lut-loader.js";

const EXPECTED = [
  ["classic", "Nostalgic Neg", 33, "s01-classic-neg-lut.js"],
  ["gold", "Classic Neg", 33, "s02-classic-chrome-lut.js"],
  ["youth", "Classic Chrome", 33, "s03-classic-chrome-lut.js"],
  ["slot07", "Color 800Z", 33, "s07-color800z-lut.js"],
  ["slot06", "Color 100", 33, "s06-color100-lut.js"],
  ["slot04", "Provia 400H", 33, "s04-pro400h-lut.js"],
  ["slot05", "Superia 400", 33, "s05-superia400-lut.js"],
  ["slot12", "Portra 400", 64, "s12-portra400-lut.js"],
  ["slot09", "Portra Cool", 64, "s09-portra-cool-lut.js"],
  ["slot13", "Gold 200", 64, "s13-gold200-lut.js"],
  ["slot08", "Gold Blue", 64, "s08-gold-blue-lut.js"],
  ["slot10", "Proimage 100", 25, "s10-proimage-original-lut.js"],
  ["slot11", "Ektar 100", 64, "s11-ektar100-lut.js"],
  ["slot14", "Chrome 64", 64, "s14-chrome64-lut.js"],
];

test("uses the versioned binary manifest as the exact 14-filter authority", async () => {
  const manifest = await loadLutPackManifest();
  assert.equal(LUT_ARCHITECTURE, "binary");
  assert.equal(manifest.packVersion, LUT_PACK_VERSION);
  assert.deepEqual(
    manifest.luts.map((entry) => [entry.id, entry.displayName, entry.dimension, entry.legacy.url.slice(2)]),
    EXPECTED,
  );
});

test("loads one requested binary LUT, coalesces in-flight work, and reuses decoded memory", async () => {
  assert.equal(getFilterLut("classic"), null);
  const originalFetch = globalThis.fetch;
  let binaryRequests = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input).includes("nostalgic-neg") && String(input).endsWith(".bin")) binaryRequests += 1;
    return originalFetch(input, init);
  };
  try {
    const first = loadFilterLut("classic");
    const duplicate = loadFilterLut("classic");
    assert.equal(duplicate, first);
    const loaded = await first;
    assert.equal(loaded.size, 33);
    assert.equal(loaded.data.length, 33 ** 3 * 3);
    assert.equal(binaryRequests, 1);
    assert.equal(getFilterLut("classic"), loaded);
    assert.equal(await loadFilterLut("classic"), loaded);
    assert.equal(binaryRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the lightweight image engine and loader have no LUT payload dependency graph", async () => {
  const files = await Promise.all([
    readFile(new URL("../lib/image-engine.js", import.meta.url), "utf8"),
    readFile(new URL("../docs/image-engine-v60.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/lut-loader.js", import.meta.url), "utf8"),
    readFile(new URL("../docs/lut-loader-v60.js", import.meta.url), "utf8"),
  ]);
  for (const engine of files.slice(0, 2)) {
    assert.doesNotMatch(engine, /from "\.\/s(?:0[1-9]|1[0-4])-[^"]+-lut\.js/);
    assert.match(engine, /const FILTER_LUTS = new Map\(\)/);
  }
  for (const loader of files.slice(2)) {
    assert.doesNotMatch(loader, /import\("\.\/s(?:0[1-9]|1[0-4])-[^"]+-lut\.js/);
    assert.match(loader, /ArrayBuffer/);
    assert.match(loader, /Float32Array/);
  }
});

test("invalid filter IDs fail without poisoning later loader work", async () => {
  await assert.rejects(loadFilterLut("unknown-filter"), /Unknown filter LUT/);
  await assert.rejects(loadFilterLut("unknown-filter"), /Unknown filter LUT/);
});

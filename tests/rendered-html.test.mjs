import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the See experience", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /src="\/see-logo\.png"/);
  assert.match(html, /alt="See"/);
  assert.match(html, /FUJI Nostalgic Neg/);
  assert.match(html, /FUJI Classic Neg/);
  assert.match(html, /FUJI Classic Chrome/);
  assert.match(html, /FUJI Pro 400H/);
  assert.match(html, /FUJI Superia 400/);
  assert.match(html, /FUJI Color 100/);
  assert.match(html, /FUJI Color 800Z/);
  assert.match(html, /KODAK Gold Blue/);
  assert.match(html, /KODAK Portra Cool/);
  assert.match(html, /KODAK Proimage 100/);
  assert.match(html, /KODAK Ektar 100/);
  assert.match(html, /KODAK Portra 400/);
  assert.match(html, /KODAK Gold 200/);
  assert.match(html, /KODAK Chrome 64/);
  assert.match(html, />Nostalgic<\/span><span>Neg</);
  assert.match(html, />Classic<\/span><span>Neg</);
  assert.match(html, />Classic<\/span><span>Chrome</);
  assert.match(html, />Provia<\/span><span>400H</);
  assert.match(html, />Superia<\/span><span>400</);
  assert.match(html, />Color<\/span><span>100</);
  assert.match(html, />Color<\/span><span>800Z</);
  assert.match(html, />Gold<\/span><span>Blue</);
  assert.match(html, />Portra<\/span><span>Cool</);
  assert.match(html, />Proimage<\/span><span>100</);
  assert.match(html, />Ektar<\/span><span>100</);
  assert.match(html, />Portra<\/span><span>400</);
  assert.match(html, />Gold<\/span><span>200</);
  assert.match(html, />Chrome<\/span><span>64</);
  assert.equal(Array.from(html.matchAll(/class="filter-button/g)).length, 14);
  assert.doesNotMatch(html, />S0[1-9]</);
  assert.doesNotMatch(html, />#S(?:0[1-9]|1[0-4])</);
  assert.match(html, /照片仅在本机处理/);
  assert.match(html, /src="\/see-welcome\.png"/);
  assert.doesNotMatch(html, /class="empty-upload"/);
  assert.doesNotMatch(html, />添加照片<\/button>/);
  assert.match(html, />Reset</);
  assert.match(html, />Apply All</);
  assert.match(html, />Save</);
});

test("keeps photo processing local, independent per photo, and batch-capable", async () => {
  const [page, engine, staticApp, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/image-engine.js", import.meta.url), "utf8"),
    readFile(new URL("../docs/app-v60.js", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /processPixels/);
  assert.match(page, /edit:\s*EditState/);
  assert.match(page, /filter:\s*null,\s*strength:\s*100,\s*brightness:\s*0,\s*color:\s*0,\s*grain:\s*0/);
  assert.match(page, /type="file"[^>]*multiple/);
  assert.match(page, /navigator\.share/);
  assert.match(page, /createZip/);
  assert.match(page, /applyToAll/);
  assert.match(page, /deleteCurrent/);
  assert.match(page, /requestAnimationFrame/);
  assert.match(page, /visibleEditLabel\(currentEdit, showOriginal\)/);
  assert.match(page, /if \(currentHasEdits\) setShowOriginal/);
  assert.match(staticApp, /visibleEditLabel\(edit, state\.showOriginal\)/);
  assert.match(staticApp, /value && photo && hasEdits\(photo\.edit\)/);
  assert.match(page, /type="number"/);
  assert.match(page, /updateAdjustmentValue/);
  assert.match(page, /MAX_PHOTOS = 20/);
  assert.match(page, /createElement\("canvas"\)/);
  assert.match(page, /0\.95/);
  assert.match(engine, /lightPort\(r, g, b, brightness \/ 100\)/);
  assert.match(engine, /colorPort\(r, g, b, color \/ 100\)/);
  assert.match(engine, /grainFieldAt/);
  assert.doesNotMatch(engine, /particleField|finePopulation|mediumPopulation|coarsePopulation/);
  assert.doesNotMatch(engine, /correlatedExcitation|correlatedGrainField|primaryScale|scanned.*grain/i);
  assert.match(engine, /strength === 0/);
  assert.match(staticApp, /edit:\s*createNeutralEdit\(\)/);
  assert.match(staticApp, /navigator\.canShare/);
  assert.match(staticApp, /See_Photos\.zip/);
  assert.match(layout, /manifest:\s*"\/manifest\.webmanifest"/);
  assert.match(layout, /PwaRegister/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});

test("ships the requested iOS and PWA app icons", async () => {
  const [layout, appManifest, staticHtml, staticManifestText] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/manifest.ts", import.meta.url), "utf8"),
    readFile(new URL("../docs/index.html", import.meta.url), "utf8"),
    readFile(new URL("../docs/manifest.webmanifest", import.meta.url), "utf8"),
  ]);
  const staticManifest = JSON.parse(staticManifestText);

  assert.match(layout, /apple-touch-icon\.png/);
  assert.match(layout, /title:\s*"See\."/);
  assert.match(layout, /applicationName:\s*"See\."/);
  assert.match(appManifest, /see-icon-192\.png/);
  assert.match(appManifest, /see-icon-512\.png/);
  assert.match(appManifest, /name:\s*"See\."/);
  assert.match(appManifest, /short_name:\s*"See\."/);
  assert.match(staticHtml, /see-apple-touch-icon-120\.png/);
  assert.match(staticHtml, /see-apple-touch-icon-152\.png/);
  assert.match(staticHtml, /see-apple-touch-icon-167\.png/);
  assert.match(staticHtml, /see-apple-touch-icon-180\.png/);
  assert.match(staticHtml, /apple-mobile-web-app-title" content="See\."/);
  assert.match(staticHtml, /<title>See\.<\/title>/);
  assert.doesNotMatch(staticHtml, /S-Film Mobile|See｜手机胶片滤镜/);
  assert.equal(staticManifest.name, "See.");
  assert.equal(staticManifest.short_name, "See.");
  assert.deepEqual(staticManifest.icons.map(({ sizes }) => sizes), ["192x192", "512x512"]);

  const icons = [
    ["../public/apple-touch-icon.png", 180],
    ["../public/icons/see-apple-touch-icon-120.png", 120],
    ["../public/icons/see-apple-touch-icon-152.png", 152],
    ["../public/icons/see-apple-touch-icon-167.png", 167],
    ["../public/icons/see-apple-touch-icon-180.png", 180],
    ["../public/icons/see-icon-192.png", 192],
    ["../public/icons/see-icon-512.png", 512],
    ["../docs/apple-touch-icon.png", 180],
    ["../docs/icons/see-apple-touch-icon-120.png", 120],
    ["../docs/icons/see-apple-touch-icon-152.png", 152],
    ["../docs/icons/see-apple-touch-icon-167.png", 167],
    ["../docs/icons/see-apple-touch-icon-180.png", 180],
    ["../docs/icons/see-icon-192.png", 192],
    ["../docs/icons/see-icon-512.png", 512],
  ];

  for (const [path, size] of icons) {
    const png = await readFile(new URL(path, import.meta.url));
    assert.equal(png.subarray(1, 4).toString("ascii"), "PNG", path);
    assert.equal(png.readUInt32BE(16), size, `${path} width`);
    assert.equal(png.readUInt32BE(20), size, `${path} height`);
  }
});

test("preserves the supplied logo, cover, and welcome image bytes", async () => {
  const assets = [
    ["../public/see-logo.png", "e7d3f9b0e02fa8fc70d8c3ca8624b0a50b76b06967cd3e2958b9fb0a541b597a"],
    ["../docs/see-logo.png", "e7d3f9b0e02fa8fc70d8c3ca8624b0a50b76b06967cd3e2958b9fb0a541b597a"],
    ["../public/see-cover.png", "9b326205899b9e9f55c98a1f0a5e5083d4195a5e634a8cc234056033c2028b54"],
    ["../docs/see-cover.png", "9b326205899b9e9f55c98a1f0a5e5083d4195a5e634a8cc234056033c2028b54"],
    ["../public/see-welcome.png", "45d245f23b5ca47780c1592707eeed632c4b685ea4688a62a8b017ded626e6d4"],
    ["../docs/see-welcome.png", "45d245f23b5ca47780c1592707eeed632c4b685ea4688a62a8b017ded626e6d4"],
  ];

  for (const [path, expectedHash] of assets) {
    const bytes = await readFile(new URL(path, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedHash, path);
  }
});

test("uses the requested filter labels and interface colors", async () => {
  const [page, appStyles, staticHtml, staticStyles, layout] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../docs/index.html", import.meta.url), "utf8"),
    readFile(new URL("../docs/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /label:\s*"Nostalgic Neg"/);
  assert.match(page, /label:\s*"Classic Neg"/);
  assert.match(page, /label:\s*"Classic Chrome"/);
  assert.match(page, /label:\s*"Provia 400H"/);
  assert.match(page, /label:\s*"Superia 400"/);
  assert.match(page, /label:\s*"Color 100"/);
  assert.match(page, /label:\s*"Color 800Z"/);
  assert.match(page, /label:\s*"Gold Blue"/);
  assert.match(page, /label:\s*"Portra Cool"/);
  assert.match(page, /label:\s*"Proimage 100"/);
  assert.match(page, /label:\s*"Ektar 100"/);
  assert.match(page, /label:\s*"Portra 400"/);
  assert.match(page, /label:\s*"Gold 200"/);
  assert.match(page, /label:\s*"Chrome 64"/);
  assert.match(staticHtml, />Nostalgic<\/span><span>Neg</);
  assert.match(staticHtml, />Classic<\/span><span>Neg</);
  assert.match(staticHtml, />Classic<\/span><span>Chrome</);
  assert.match(staticHtml, />Provia<\/span><span>400H</);
  assert.match(staticHtml, />Superia<\/span><span>400</);
  assert.match(staticHtml, />Color<\/span><span>100</);
  assert.match(staticHtml, />Color<\/span><span>800Z</);
  assert.match(staticHtml, />Gold<\/span><span>Blue</);
  assert.match(staticHtml, />Portra<\/span><span>Cool</);
  assert.match(staticHtml, />Proimage<\/span><span>100</);
  assert.match(staticHtml, />Ektar<\/span><span>100</);
  assert.match(staticHtml, />Portra<\/span><span>400</);
  assert.match(staticHtml, />Gold<\/span><span>200</);
  assert.match(staticHtml, />Chrome<\/span><span>64</);
  const firstRowMappings = [
    ["classic", "Nostalgic Neg"],
    ["gold", "Classic Neg"],
    ["youth", "Classic Chrome"],
    ["slot07", "Color 800Z"],
    ["slot06", "Color 100"],
    ["slot04", "Provia 400H"],
    ["slot05", "Superia 400"],
  ];
  const secondRowMappings = [
    ["slot12", "Portra 400"],
    ["slot09", "Portra Cool"],
    ["slot13", "Gold 200"],
    ["slot08", "Gold Blue"],
    ["slot10", "Proimage 100"],
    ["slot11", "Ektar 100"],
    ["slot14", "Chrome 64"],
  ];
  let previousPageIndex = -1;
  let previousStaticIndex = -1;
  for (const [id, label] of [...firstRowMappings, ...secondRowMappings]) {
    const pageIndex = page.indexOf(`{ id: "${id}", label: "${label}"`);
    const staticIndex = staticHtml.indexOf(`data-filter="${id}"`);
    assert.ok(pageIndex > previousPageIndex, `${label} order in app`);
    assert.ok(staticIndex > previousStaticIndex, `${label} order in static page`);
    previousPageIndex = pageIndex;
    previousStaticIndex = staticIndex;
  }
  assert.doesNotMatch(page, /label:\s*"S0[1-9]"/);
  assert.doesNotMatch(page, /label:\s*"#S(?:0[1-9]|1[0-4])"/);
  assert.doesNotMatch(staticHtml, />S0[1-9]</);
  assert.doesNotMatch(staticHtml, />#S(?:0[1-9]|1[0-4])</);
  for (const styles of [appStyles, staticStyles]) {
    assert.match(styles, /:root\s*\{[^}]*color-scheme:\s*dark[^}]*--paper:\s*#1b1c1a[^}]*--ink:\s*#f1f0ea[^}]*--panel:\s*#242522/s);
    assert.doesNotMatch(styles, /prefers-color-scheme/);
    assert.match(styles, /--accent:\s*#ffc926/i);
    assert.match(styles, /--privacy-dot:\s*#d52518/i);
    assert.match(styles, /--control-surface:\s*#f3e8cc/i);
    assert.match(styles, /--font-schoolbook:[^;]*Century Schoolbook/i);
    assert.match(styles, /HarmonyOS Sans SC/i);
    assert.doesNotMatch(styles, /--font-clarendon/);
    assert.match(styles, /\.filter-button\s*\{[^}]*color:\s*rgba\(243, 232, 204, 0\.5\)[^}]*font-family:\s*var\(--font-schoolbook\)[^}]*font-size:\s*12px[^}]*font-style:\s*normal/s);
    assert.match(styles, /\.filter-label\s*\{[^}]*flex-direction:\s*column[^}]*align-items:\s*center[^}]*justify-content:\s*center[^}]*text-align:\s*center/s);
    assert.match(styles, /background:\s*var\(--privacy-dot\)/);
    assert.match(styles, /\.filter-button\.is-active\s*\{[^}]*color:\s*var\(--privacy-dot\)[^}]*font-style:\s*italic/s);
    assert.match(styles, /\.filter-row\s*\{[^}]*grid-template-columns:\s*repeat\(7, minmax\(0, 1fr\)\)[^}]*grid-template-rows:\s*repeat\(2, minmax\(0, 1fr\)\)[^}]*flex:\s*0 0 68px[^}]*min-height:\s*68px/s);
    assert.doesNotMatch(styles, /\.filter-button\s*\{[^}]*border-right/s);
    assert.doesNotMatch(styles, /\.filter-button:nth-child\(7n\)/);
    assert.match(styles, /\.filter-button:nth-child\(-n \+ 7\)\s*\{[^}]*border-bottom:\s*0\.5px solid rgba\(243, 232, 204, 0\.08\)/s);
    assert.match(styles, /\.adjustment-tab\.is-active\s*\{[^}]*background:\s*var\(--accent\)[^}]*color:\s*var\(--privacy-dot\)/s);
    assert.match(styles, /\.adjustment-tab\s*\{[^}]*width:\s*70px[^}]*min-height:\s*26px[^}]*justify-self:\s*center[^}]*color:\s*rgba\(243, 232, 204, 0\.5\)[^}]*font-size:\s*12px/s);
    assert.match(styles, /\.bottom-action\s*\{[^}]*width:\s*fit-content[^}]*padding:\s*0 8px[^}]*justify-self:\s*center[^}]*border-radius:\s*999px[^}]*background:\s*transparent[^}]*color:\s*rgba\(243, 232, 204, 0\.5\)/s);
    assert.match(styles, /\.bottom-action\s*\{[^}]*font-size:\s*12px/s);
    assert.match(styles, /\.save-action\s*\{[^}]*background:\s*transparent[^}]*color:\s*rgba\(243, 232, 204, 0\.5\)/s);
    assert.match(styles, /\.compare-button\s*\{[^}]*border:\s*0[^}]*border-radius:\s*999px[^}]*color:\s*var\(--control-surface\)/s);
    assert.match(styles, /\.compare-button\.is-active\s*\{[^}]*color:\s*var\(--privacy-dot\)/s);
    assert.doesNotMatch(styles, /\.compare-button\.is-active\s*\{[^}]*border-color/s);
    assert.match(styles, /\.privacy-note\s*\{[^}]*color:\s*var\(--control-surface\)/s);
    assert.match(styles, /\.compare-button\s*\{[^}]*color:\s*var\(--control-surface\)/s);
    assert.match(styles, /\.thumbnail\.add-photo\s*\{[^}]*color:\s*var\(--control-surface\)/s);
    assert.match(styles, /\.value-input\s*\{[^}]*color:\s*var\(--control-surface\)[^}]*font-size:\s*15px/s);
    assert.match(styles, /\.adjustment-panel\s*\{[^}]*flex:\s*0 0 74px[^}]*min-height:\s*74px/s);
    assert.match(styles, /\.slider-row\s*\{[^}]*min-height:\s*40px[^}]*padding-top:\s*0/s);
    assert.match(styles, /\.range-control\s*\{[^}]*height:\s*40px[^}]*touch-action:\s*none/s);
    assert.match(styles, /\.range-control::-webkit-slider-runnable-track\s*\{[^}]*height:\s*3px/s);
    assert.match(styles, /\.range-control::-webkit-slider-thumb\s*\{[^}]*width:\s*15px[^}]*height:\s*15px/s);
    assert.match(styles, /\.photo-count\s*\{[^}]*background:\s*transparent[^}]*color:\s*var\(--privacy-dot\)/s);
    assert.match(styles, /\.bottom-action:active:not\(:disabled\)\s*\{[^}]*padding-right:\s*5px[^}]*padding-left:\s*5px[^}]*border-color:\s*var\(--privacy-dot\)[^}]*background:\s*var\(--privacy-dot\)[^}]*color:\s*var\(--accent\)/s);
    assert.match(styles, /\.thumbnail-rail\s*\{[^}]*position:\s*absolute[^}]*height:\s*40px/s);
    assert.match(styles, /\.photo-stage\s*\{[^}]*flex:\s*1 1 0[^}]*min-height:\s*0/s);
    assert.match(styles, /\.preview-canvas\s*\{[^}]*width:\s*100%[^}]*height:\s*100%[^}]*min-width:\s*0[^}]*min-height:\s*0[^}]*object-fit:\s*contain/s);
    assert.match(styles, /\.welcome-image\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*width:\s*100%[^}]*height:\s*100%[^}]*object-fit:\s*cover[^}]*object-position:\s*center[^}]*pointer-events:\s*none/s);
    assert.match(styles, /\.photo-stage:not\(\.has-photo\) \.thumbnail-rail\s*\{[^}]*background:\s*transparent/s);
    assert.doesNotMatch(styles, /\.empty-upload\s*\{/);
    assert.match(styles, /\.thumbnail\.add-photo::before,[^}]*\.thumbnail\.add-photo::after\s*\{[^}]*width:\s*10px[^}]*height:\s*1\.25px/s);
    assert.match(styles, /overflow:\s*hidden/);
    assert.match(styles, /100dvh/);
  }
  assert.match(layout, /themeColor:\s*"#1b1c1a"/);
  assert.doesNotMatch(layout, /prefers-color-scheme/);
});

test("ships cache-busted, relative GitHub Pages assets", async () => {
  const [staticHtml, staticWorker, staticApp, staticEngine, staticLoader, staticPackWorker, appWorker] = await Promise.all([
    readFile(new URL("../docs/index.html", import.meta.url), "utf8"),
    readFile(new URL("../docs/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../docs/app-v60.js", import.meta.url), "utf8"),
    readFile(new URL("../docs/image-engine-v60.js", import.meta.url), "utf8"),
    readFile(new URL("../docs/lut-loader-v60.js", import.meta.url), "utf8"),
    readFile(new URL("../docs/lut-pack-sw.js", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
  ]);

  assert.match(staticHtml, /type="module" src="\.\/app-v60\.js"/);
  assert.match(staticHtml, /href="\.\/styles\.css\?v=60"/);
  assert.match(staticApp, /from "\.\/image-engine-v60\.js"/);
  assert.match(staticApp, /from "\.\/lut-loader-v60\.js"/);
  assert.match(staticWorker, /see-core-v60/);
  assert.match(staticPackWorker, /see-luts-v52/);
  assert.match(staticPackWorker, /see-luts-bin-v/);
  assert.match(staticWorker, /gpu-preview-v60\.js/);
  assert.match(staticWorker, /gpu-export-v60\.js/);
  assert.doesNotMatch(staticWorker, /gpu-export-benchmark/);
  assert.match(staticWorker, /export-processor-v60\.js/);
  assert.match(staticWorker, /export-worker-v60\.js/);
  assert.match(staticWorker, /image-engine-v60\.js/);
  assert.match(staticWorker, /edit-state-v60\.js/);
  assert.match(staticWorker, /lut-loader-v60\.js/);
  const coreShell = staticWorker.match(/const CORE_APP_SHELL = \[([\s\S]*?)\n\];/)?.[1] ?? "";
  assert.doesNotMatch(coreShell, /s(?:0[1-9]|1[0-4])-[^"']+-lut\.js/);
  assert.doesNotMatch(coreShell, /luts-bin\/v1\/[^"']+\.bin/);
  assert.match(staticWorker, /lut-pack-v1\.json/);
  assert.doesNotMatch(staticEngine, /from "\.\/s(?:0[1-9]|1[0-4])-[^"]+-lut\.js"/);
  assert.match(staticLoader, /LUT_ARCHITECTURE = "binary"/);
  assert.match(staticLoader, /ArrayBuffer/);
  assert.doesNotMatch(staticLoader, /\(\) => import\("\.\/s(?:0[1-9]|1[0-4])-[^"]+-lut\.js/);
  assert.match(staticWorker, /request\.mode === "navigate"/);
  assert.match(staticWorker, /await cache\.match\(ROOT\)[\s\S]*\|\| networkUpdate/);
  assert.match(staticWorker, /isBinaryLutRequest/);
  assert.match(staticPackWorker, /preparationPromise/);
  assert.match(staticPackWorker, /Math\.min\(2, missing\.length\)/);
  assert.match(staticWorker, /see-welcome\.png/);
  assert.match(appWorker, /see-core-v60/);
  assert.match(appWorker, /see-runtime-v60/);
  assert.match(appWorker, /see-welcome\.png/);
});

test("uses independent GPU preview and GPU-primary full-resolution export with CPU fallback", async () => {
  const [page, staticApp, gpuPreview, engine, exportWorker] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../docs/app-v60.js", import.meta.url), "utf8"),
    readFile(new URL("../docs/gpu-preview-v60.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/image-engine.js", import.meta.url), "utf8"),
    readFile(new URL("../docs/export-worker-v60.js", import.meta.url), "utf8"),
  ]);

  assert.match(page, /createGpuPreviewRenderer/);
  assert.match(page, /gpuPreviewRef\.current\.render\(currentEdit, currentPhoto\.grainSeed, showOriginal\)/);
  assert.match(staticApp, /createGpuPreviewRenderer/);
  assert.match(staticApp, /gpuPreview\.render\(photo\.edit, photo\.grainSeed, state\.showOriginal\)/);
  assert.match(gpuPreview, /canvas\.getContext\("webgl2"/);
  assert.match(gpuPreview, /uniform sampler3D uLut/);
  assert.match(gpuPreview, /grainPort\(colorPort\(lightPort\(rgb\)\)\)/);
  assert.match(gpuPreview, /uniform1ui\(this.uniforms.seed/);
  assert.doesNotMatch(gpuPreview, /grainTexture|GRAIN_FIELD_FRAGMENT_SHADER/);
  assert.match(engine, /export function getFilterLut/);
  assert.match(engine, /grainFieldAt\(x, y, grainParameters.footprint, seed, width, height\)/);
  assert.match(page, /function createSessionGrainSeed/);
  assert.match(page, /crypto\?\.getRandomValues/);
  assert.match(staticApp, /grainSeed: createSessionGrainSeed\(file, id\)/);
  assert.match(staticApp, /requestIdleCallback\(prewarm, \{ timeout: 250 \}\)/);
  assert.match(staticApp, /gpuPreview\.prewarmGrain\(photo\.grainSeed\)/);
  assert.match(staticApp, /await attemptGpuFullResolutionExport/);
  assert.match(staticApp, /await ensureExportProcessor\(\)\.process\(source, photo\.edit, photo\.grainSeed\)/);
  assert.match(staticApp, /processPixels\(source, photo\.edit, photo\.grainSeed\)/);
  assert.match(exportWorker, /import \{ processPixels \} from "\.\/image-engine-v60\.js"/);
  assert.match(exportWorker, /import \{ loadFilterLut \} from "\.\/lut-loader-v60\.js"/);
  assert.match(exportWorker, /await loadFilterLut\(message\.edit\?\.filter\)/);
  assert.match(exportWorker, /const pixels = processPixels\(source, message\.edit, message\.seed\)/);

  const sliderUpdate = staticApp.match(/function updateAdjustmentValue\(value\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(sliderUpdate, /renderAdjustmentControls/);
  assert.doesNotMatch(sliderUpdate, /renderControls\(\)/);
});

test("shows actual preview and production export diagnostics only for debug query mode", async () => {
  const [page, staticHtml, staticApp, gpuPreview, sourceGpuPreview, productionExport, staticStyles] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../docs/index.html", import.meta.url), "utf8"),
    readFile(new URL("../docs/app-v60.js", import.meta.url), "utf8"),
    readFile(new URL("../docs/gpu-preview-v60.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/gpu-preview.js", import.meta.url), "utf8"),
    readFile(new URL("../docs/gpu-export-v60.js", import.meta.url), "utf8"),
    readFile(new URL("../docs/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(staticApp, /URLSearchParams\(window\.location\.search\)\.get\("debug"\) === "1"/);
  assert.match(staticApp, /DEBUG_MODE \? createDiagnosticOverlay\(\) : null/);
  assert.match(staticHtml, /window\.__SEE_BOOT__/);
  assert.match(staticHtml, /first pointerdown/);
  assert.match(staticApp, /markStartup\("module entry"\)/);
  assert.match(staticApp, /markStartup\("listeners ready"\)/);
  assert.match(staticApp, /markStartup\("\+ functional"\)/);
  assert.match(staticApp, /dataset\.appReady = "true"/);
  assert.match(staticApp, /WebGL2 GPU/);
  assert.match(staticApp, /CPU fallback/);
  assert.match(staticApp, /GPU init failed:/);
  assert.match(staticApp, /Average submit/);
  assert.match(staticApp, /Preview size:/);
  assert.match(staticApp, /Export processor:/);
  assert.match(staticApp, /GPU full-resolution/);
  assert.match(staticApp, /Worker fallback/);
  assert.match(staticApp, /GPU fallback:/);
  assert.match(staticApp, /Build: v60/);
  assert.match(staticApp, /Processing: OpenLight Light \/ LightCraft Color \/ glsl-film-grain/);
  assert.match(staticApp, /Grain footprint:/);
  assert.match(staticApp, /Grain resources:/);
  assert.match(staticApp, /Grain prewarm submit:/);
  assert.match(staticApp, /First activation submit:/);
  assert.match(staticApp, /Slider submit:/);
  assert.match(staticApp, /grainSeed:/);
  assert.match(staticApp, /LUT architecture:/);
  assert.match(staticApp, /Offline LUTs:/);
  assert.match(staticApp, /Offline ready:/);
  assert.match(staticApp, /Background preparation:/);
  assert.match(staticApp, /Worker processPixels/);
  assert.match(staticApp, /Main-thread processPixels/);
  assert.match(staticApp, /Draw\/getImageData/);
  assert.match(staticApp, /JPEG encoding/);
  assert.match(staticApp, /File ready/);
  assert.match(staticApp, /if \(DEBUG_MODE\) recordPreviewTiming\("gpu", performance\.now\(\) - startedAt\)/);
  assert.match(staticApp, /if \(DEBUG_MODE\) recordPreviewTiming\("cpu", performance\.now\(\) - startedAt\)/);
  assert.match(gpuPreview, /onError\?\.\(\{ stage: "probe", error \}\)/);
  assert.match(gpuPreview, /onError\?\.\(\{ stage: "renderer", error \}\)/);
  assert.match(gpuPreview, /precision highp sampler3D;/);
  assert.doesNotMatch(staticApp, /gpu-export-benchmark|Run GPU A\/B/);
  assert.match(sourceGpuPreview, /createGpuFullResolutionRenderer/);
  assert.match(sourceGpuPreview, /fenceSync/);
  assert.match(sourceGpuPreview, /clientWaitSync/);
  assert.match(sourceGpuPreview, /MAX_TEXTURE_SIZE/);
  assert.match(sourceGpuPreview, /MAX_RENDERBUFFER_SIZE/);
  assert.match(sourceGpuPreview, /MAX_VIEWPORT_DIMS/);
  assert.match(sourceGpuPreview, /readPixels/);
  assert.match(sourceGpuPreview, /checkFramebufferStatus/);
  assert.match(sourceGpuPreview, /webglcontextlost/);
  assert.match(productionExport, /capabilityFailure/);
  assert.match(productionExport, /renderer\.renderPixels\(source, edit, seed\)/);
  assert.match(productionExport, /renderer\?\.destroy\(\)/);
  assert.match(staticStyles, /\.diagnostic-overlay\s*\{[^}]*position:\s*absolute[^}]*pointer-events:\s*none/s);
  assert.doesNotMatch(staticHtml, /data-preview-diagnostics/);
  assert.doesNotMatch(staticHtml, /Run GPU A\/B/);
  assert.match(page, /data-preview-diagnostics="true"/);
  assert.doesNotMatch(page, /benchmarkBusy|Run GPU A\/B/);
  assert.match(page, /new URLSearchParams\(window\.location\.search\)\.get\("debug"\) === "1"/);
});

test("paints Saving feedback before sequential GPU-primary export and preserves Worker/share fallbacks", async () => {
  const [page, staticApp, processor, worker] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../docs/app-v60.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/export-processor.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/export-worker.js", import.meta.url), "utf8"),
  ]);

  assert.match(staticApp, /elements\.exportButton\.textContent = state\.busy \? "Saving…" : "Save"/);
  assert.match(staticApp, /window\.requestAnimationFrame\(\(\) => window\.requestAnimationFrame\(resolve\)\)/);
  assert.match(staticApp, /if \(!state\.photos\.length \|\| state\.busy\) return/);
  assert.match(staticApp, /for \(let index = 0; index < state\.photos\.length; index \+= 1\)/);
  assert.match(staticApp, /navigator\.canShare/);
  assert.match(staticApp, /See_Photos\.zip/);
  assert.match(page, /exportInFlightRef\.current/);
  assert.match(page, /\{busy \? "Saving…" : "Save"\}/);
  assert.match(page, /await waitForPaint\(\)/);
  assert.match(staticApp, /attemptGpuFullResolutionExport/);
  assert.match(staticApp, /cpuResult\.processor === "worker"[\s\S]*\? "worker-fallback"/);
  assert.match(processor, /\[source\.data\.buffer\]/);
  assert.match(processor, /function ensureWorker\(\)/);
  assert.match(processor, /processor: "main-thread"/);
  assert.match(worker, /\[pixels\.buffer\]/);
  assert.doesNotMatch(worker, /OffscreenCanvas/);
});

test("preserves CPU fallback when WebGL2 initialization is forced to fail", async () => {
  const originalDocument = globalThis.document;
  const failures = [];
  globalThis.document = {
    createElement() {
      return { getContext: () => null };
    },
  };

  try {
    const moduleUrl = new URL("../lib/gpu-preview.js", import.meta.url);
    moduleUrl.searchParams.set("forced-fallback", String(Date.now()));
    const { createGpuPreviewRenderer } = await import(moduleUrl.href);
    const renderer = createGpuPreviewRenderer(
      { getContext: () => null },
      { onError: (failure) => failures.push(failure) },
    );
    assert.equal(renderer, null);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].stage, "probe");
    assert.match(String(failures[0].error), /WebGL 2 is unavailable/);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }

  const staticApp = await readFile(new URL("../docs/app-v60.js", import.meta.url), "utf8");
  assert.match(staticApp, /if \(gpuPreview\)/);
  assert.match(staticApp, /processPixels\(state\.sourceData, photo\.edit, photo\.grainSeed\)/);
});

import { createGpuPreviewRenderer } from "./gpu-preview-v60.js";
import { attemptGpuFullResolutionExport } from "./gpu-export-v60.js";
import { createExportProcessor } from "./export-processor-v60.js";
import { getGrainParameters, hashSeed, processPixels } from "./image-engine-v60.js";
import {
  getLutPackStatus,
  loadFilterLut,
  prepareOfflineLutPack,
  subscribeLutPackStatus,
} from "./lut-loader-v60.js";
import { hasEdits, visibleEditLabel } from "./edit-state-v60.js";

const MAX_PHOTOS = 20;
const PREVIEW_LONG_EDGE = 960;
const DEBUG_MODE = new URLSearchParams(window.location.search).get("debug") === "1";
const bootProbe = DEBUG_MODE ? window.__SEE_BOOT__ : null;

function markStartup(label, detail = "") {
  if (!bootProbe) return;
  bootProbe.events.push({ label, time: performance.now(), detail });
}

markStartup("module entry");

const state = {
  photos: [],
  activeIndex: 0,
  activeAdjustment: "brightness",
  showOriginal: false,
  busy: false,
  sourceData: null,
  renderFrame: 0,
  loadToken: 0,
  toastTimer: 0,
  filterSelectionToken: 0,
  loadingFilters: new Set(),
};

const elements = {
  canvas: document.querySelector("#preview"),
  stage: document.querySelector("#photo-stage"),
  compareButton: document.querySelector("#compare-button"),
  deleteButton: document.querySelector("#delete-button"),
  photoCount: document.querySelector("#photo-count"),
  thumbnailRail: document.querySelector("#thumbnail-rail"),
  input: document.querySelector("#photo-input"),
  exportButton: document.querySelector("#export-button"),
  applyAll: document.querySelector("#apply-all"),
  resetCurrent: document.querySelector("#reset-current"),
  status: document.querySelector("#status-line"),
  toast: document.querySelector("#toast"),
  slider: document.querySelector("#active-adjustment"),
  valueInput: document.querySelector("#adjustment-value"),
  filters: Array.from(document.querySelectorAll("[data-filter]")),
  adjustmentTabs: Array.from(document.querySelectorAll("[data-adjustment]")),
};

const diagnostics = {
  initError: "",
  lastPath: "",
  lastDuration: null,
  samples: { gpu: [], cpu: [] },
  exportError: "",
  lutError: "",
  exportTiming: {
    photo: "—",
    decode: null,
    drawRead: null,
    process: null,
    processor: "not-run",
    gpuFallback: "",
    put: null,
    jpeg: null,
    total: null,
  },
};

let gpuPreview = null;
let gpuPreviewAttempted = false;
let exportProcessor = null;
const diagnosticOverlay = DEBUG_MODE ? createDiagnosticOverlay() : null;
let lutPackStatus = getLutPackStatus();
if (DEBUG_MODE) {
  subscribeLutPackStatus((status) => {
    lutPackStatus = status;
    updateDiagnosticOverlay();
  });
}

function ensureGpuPreview() {
  if (gpuPreviewAttempted) return gpuPreview;
  gpuPreviewAttempted = true;
  markStartup("GPU init start");
  gpuPreview = DEBUG_MODE
    ? createGpuPreviewRenderer(elements.canvas, {
      onError({ stage, error }) {
        const message = (error instanceof Error ? error.message : String(error)).replace(/\0/g, "");
        diagnostics.initError = stage + ": " + message;
      },
    })
    : createGpuPreviewRenderer(elements.canvas);
  markStartup("GPU init end", gpuPreview ? "WebGL2 GPU" : "CPU fallback");
  if (DEBUG_MODE) updateDiagnosticOverlay();
  return gpuPreview;
}

function ensureExportProcessor() {
  if (exportProcessor) return exportProcessor;
  exportProcessor = createExportProcessor({
    createWorker: () => new Worker(
      new URL("./export-worker-v60.js", import.meta.url),
      { type: "module" },
    ),
    onWorkerCreated() {
      markStartup("Worker created");
      if (DEBUG_MODE) updateDiagnosticOverlay();
    },
    onFailure(error) {
      diagnostics.exportError = error instanceof Error ? error.message : String(error);
      queueMicrotask(() => {
        if (DEBUG_MODE) updateDiagnosticOverlay();
      });
    },
  });
  return exportProcessor;
}

function destroyExportProcessor() {
  exportProcessor?.destroy();
  exportProcessor = null;
}

function createDiagnosticOverlay() {
  const overlay = document.createElement("aside");
  overlay.className = "diagnostic-overlay";
  overlay.dataset.previewDiagnostics = "true";
  overlay.setAttribute("aria-label", "Preview diagnostics");
  const output = document.createElement("pre");
  overlay.append(output);
  document.querySelector(".editor-card")?.append(overlay);
  return { root: overlay, output };
}

function updateDiagnosticOverlay() {
  if (!diagnosticOverlay) return;
  const photo = currentPhoto();
  const edit = photo?.edit ?? createNeutralEdit();
  const path = gpuPreview ? "gpu" : "cpu";
  const previewLabel = gpuPreview
    ? "WebGL2 GPU"
    : gpuPreviewAttempted
      ? "CPU fallback"
      : "Not initialized";
  const samples = diagnostics.samples[path];
  const average = samples.length
    ? samples.reduce((sum, duration) => sum + duration, 0) / samples.length
    : null;
  const timingLabel = path === "gpu" ? "Submit" : "Render";
  const averageLabel = path === "gpu" ? "Average submit" : "Average";
  const size = state.sourceData
    ? state.sourceData.width + " × " + state.sourceData.height
    : "—";
  const grainParameters = getGrainParameters(
    edit.grain,
    state.sourceData?.width ?? 1,
    state.sourceData?.height ?? 1,
  );
  const grainGpuDiagnostics = gpuPreview?.getGrainDiagnostics() ?? {
    state: gpuPreviewAttempted ? "CPU fallback" : "cold",
    prewarm: null,
    firstActivation: null,
    sliderUpdate: null,
  };
  const filterActive = Boolean(edit.filter && edit.strength > 0);
  const exportTiming = diagnostics.exportTiming;
  const exportProcessorLabel = exportTiming.processor === "gpu"
    ? "GPU"
    : exportTiming.processor === "worker-fallback"
      ? "Worker fallback"
      : exportTiming.processor === "main-thread-fallback"
        ? "Main-thread fallback"
        : "Not run";
  const exportProcessLabel = exportTiming.processor === "gpu"
    ? "GPU full-resolution"
    : exportTiming.processor === "worker-fallback"
      ? "Worker processPixels"
      : "Main-thread processPixels";
  const duration = (value) => value === null ? "—" : value.toFixed(1) + " ms";
  const bootOrigin = bootProbe?.origin ?? 0;
  const bootLines = (bootProbe?.events ?? []).map((event) => {
    const elapsed = Math.max(0, event.time - bootOrigin).toFixed(1);
    return `${event.label}: ${elapsed} ms${event.detail ? " — " + event.detail : ""}`;
  });

  diagnosticOverlay.output.textContent = [
    "Startup",
    ...bootLines,
    "appReady: " + (document.documentElement.dataset.appReady === "true" ? "true" : "false"),
    "",
    "Preview: " + previewLabel,
    gpuPreview
      ? "GPU init: OK"
      : gpuPreviewAttempted
        ? "GPU init failed: " + (diagnostics.initError || "Unknown error")
        : "GPU init: Not started",
    timingLabel + ": " + (diagnostics.lastPath === path && diagnostics.lastDuration !== null
      ? diagnostics.lastDuration.toFixed(1) + " ms"
      : "—"),
    averageLabel + ": " + (average === null ? "—" : average.toFixed(1) + " ms"),
    "Preview size: " + size,
    "Filter: " + (filterActive ? "on" : "off"),
    "Light: " + edit.brightness,
    "Color: " + edit.color,
    "Grain: " + edit.grain,
    "Build: v60",
    "Processing: OpenLight Light / LightCraft Color / glsl-film-grain",
    "Grain footprint: " + grainParameters.footprint.toFixed(3) + " cells per pixel",
    "Grain resources: " + grainGpuDiagnostics.state,
    "Grain prewarm submit: " + duration(grainGpuDiagnostics.prewarm),
    "First activation submit: " + duration(grainGpuDiagnostics.firstActivation),
    "Slider submit: " + duration(grainGpuDiagnostics.sliderUpdate),
    "grainSeed: " + (photo ? photo.grainSeed : "—"),
    "",
    "LUT architecture: " + lutPackStatus.architecture,
    "LUT pack version: " + lutPackStatus.packVersion,
    "Offline LUTs: " + lutPackStatus.cachedCount + " / " + lutPackStatus.totalCount,
    "Offline ready: " + (lutPackStatus.ready ? "YES" : "NO"),
    "Pack bytes: " + lutPackStatus.cachedBytes + " / " + lutPackStatus.totalBytes,
    "Current LUT: " + lutPackStatus.currentLut,
    "Current LUT dimension: " + lutPackStatus.currentDimension,
    "Current LUT source: " + lutPackStatus.currentSource,
    "Background preparation: " + lutPackStatus.preparation,
    ...(lutPackStatus.error ? ["LUT pack error: " + lutPackStatus.error] : []),
    "",
    "Export processor: " + exportProcessorLabel,
    ...(exportTiming.gpuFallback ? ["GPU fallback: " + exportTiming.gpuFallback] : []),
    ...(diagnostics.lutError ? ["LUT load failed: " + diagnostics.lutError] : []),
    ...(diagnostics.exportError ? ["Export Worker failed: " + diagnostics.exportError] : []),
    "Export photo: " + exportTiming.photo,
    "Decode: " + duration(exportTiming.decode),
    "Draw/getImageData: " + duration(exportTiming.drawRead),
    exportProcessLabel + ": " + duration(exportTiming.process),
    "putImageData: " + duration(exportTiming.put),
    "JPEG encoding: " + duration(exportTiming.jpeg),
    "File ready: " + duration(exportTiming.total),
  ].join("\n");
}

function updateExportDiagnostics(patch) {
  if (!DEBUG_MODE) return;
  Object.assign(diagnostics.exportTiming, patch);
  updateDiagnosticOverlay();
}

function recordPreviewTiming(path, duration) {
  if (!DEBUG_MODE) return;
  const samples = diagnostics.samples[path];
  samples.push(duration);
  if (samples.length > 10) samples.shift();
  diagnostics.lastPath = path;
  diagnostics.lastDuration = duration;
  updateDiagnosticOverlay();
}

if (DEBUG_MODE) updateDiagnosticOverlay();

function createNeutralEdit() {
  return { filter: null, strength: 100, brightness: 0, color: 0, grain: 0 };
}

function createSessionGrainSeed(file, instanceId) {
  const randomValues = new Uint32Array(1);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(randomValues);
    return randomValues[0];
  }
  return hashSeed(
    file.name + ":" + file.size + ":" + instanceId + ":" + Date.now() + ":" + Math.random(),
  );
}

function currentPhoto() {
  return state.photos[state.activeIndex] || null;
}

function setStatus(message) {
  elements.status.textContent = message;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 1800);
}

async function loadImage(url) {
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  await image.decode();
  return image;
}

function sliderConfig(edit) {
  if (state.activeAdjustment === "strength") {
    return { label: "Strength", min: 0, max: 100, value: edit.strength };
  }
  if (state.activeAdjustment === "brightness") {
    return { label: "Light", min: -100, max: 100, value: edit.brightness };
  }
  if (state.activeAdjustment === "color") {
    return { label: "Color", min: -100, max: 100, value: edit.color };
  }
  return { label: "Grain", min: 0, max: 100, value: edit.grain };
}

function clampAdjustment(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function renderCompareState(photo = currentPhoto()) {
  const edit = photo ? photo.edit : createNeutralEdit();
  if (!photo || !hasEdits(edit)) state.showOriginal = false;
  const label = visibleEditLabel(edit, state.showOriginal);
  elements.compareButton.classList.toggle("is-active", label === "Edited");
  elements.compareButton.setAttribute("aria-pressed", String(state.showOriginal));
  elements.compareButton.textContent = label;
}

function setShowOriginal(value) {
  const photo = currentPhoto();
  state.showOriginal = Boolean(value && photo && hasEdits(photo.edit));
  renderCompareState(photo);
  queuePreview();
}

function updateCurrentEdit(patch) {
  const photo = currentPhoto();
  if (!photo) return;
  Object.assign(photo.edit, patch);
  setShowOriginal(false);
  renderControls();
  queuePreview();
}

async function selectFilter(filter) {
  const photo = currentPhoto();
  if (!photo || !filter) return;
  const photoId = photo.id;
  const token = ++state.filterSelectionToken;
  const firstRequest = !bootProbe?.events.some((event) => event.label === "first LUT requested");
  if (firstRequest) markStartup("first LUT requested", filter);
  state.loadingFilters.add(filter);
  diagnostics.lutError = "";
  renderControls();

  try {
    await loadFilterLut(filter);
    if (firstRequest) markStartup("first LUT loaded", filter);
    if (token !== state.filterSelectionToken || currentPhoto()?.id !== photoId) return;
    updateCurrentEdit({ filter });
  } catch (error) {
    diagnostics.lutError = `${filter}: ${error instanceof Error ? error.message : String(error)}`;
    if (token === state.filterSelectionToken && currentPhoto()?.id === photoId) {
      setStatus("滤镜载入失败，请重试");
      showToast("滤镜载入失败，请重试");
    }
  } finally {
    state.loadingFilters.delete(filter);
    renderControls();
    if (DEBUG_MODE) updateDiagnosticOverlay();
  }
}

function updateAdjustmentValue(value) {
  const photo = currentPhoto();
  if (!photo) return;
  const config = sliderConfig(photo.edit);
  const clamped = clampAdjustment(value, config.min, config.max);
  photo.edit[state.activeAdjustment] = clamped;
  state.showOriginal = false;
  renderCompareState(photo);
  renderAdjustmentControls(photo, photo.edit);
  queuePreview();
}

function renderThumbnails() {
  elements.thumbnailRail.replaceChildren();
  state.photos.forEach((photo, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "thumbnail" + (index === state.activeIndex ? " is-active" : "");
    button.setAttribute("aria-label", "选择第 " + (index + 1) + " 张照片");
    button.setAttribute("aria-pressed", String(index === state.activeIndex));
    const image = document.createElement("img");
    image.src = photo.url;
    image.alt = "";
    image.draggable = false;
    button.append(image);
    button.addEventListener("click", () => selectPhoto(index));
    elements.thumbnailRail.append(button);
  });

  if (state.photos.length < MAX_PHOTOS) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "thumbnail add-photo";
    add.setAttribute("aria-label", state.photos.length ? "继续添加照片" : "添加照片");
    add.addEventListener("click", () => elements.input.click());
    elements.thumbnailRail.append(add);
  }
}

function renderAdjustmentControls(photo, edit) {
  elements.adjustmentTabs.forEach((button) => {
    const id = button.dataset.adjustment;
    const active = id === state.activeAdjustment;
    button.disabled = !photo || (id === "strength" && !edit.filter);
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  const config = sliderConfig(edit);
  const sliderDisabled = !photo || (state.activeAdjustment === "strength" && !edit.filter);
  elements.slider.setAttribute("aria-label", config.label);
  elements.slider.min = String(config.min);
  elements.slider.max = String(config.max);
  elements.slider.value = String(config.value);
  elements.slider.disabled = sliderDisabled;
  elements.valueInput.min = String(config.min);
  elements.valueInput.max = String(config.max);
  elements.valueInput.value = String(config.value);
  elements.valueInput.disabled = sliderDisabled;
  elements.valueInput.setAttribute("aria-label", config.label + " value");
  elements.valueInput.closest("label").setAttribute("aria-label", config.label + " value");
  const progress = ((config.value - config.min) / (config.max - config.min)) * 100;
  elements.slider.style.setProperty("--range-progress", progress + "%");
}

function renderControls() {
  const photo = currentPhoto();
  const edit = photo ? photo.edit : createNeutralEdit();
  elements.stage.classList.toggle("has-photo", Boolean(photo));
  elements.compareButton.hidden = !photo;
  renderCompareState(photo);
  elements.deleteButton.hidden = !photo;
  elements.photoCount.hidden = !photo;
  elements.photoCount.textContent = photo ? state.activeIndex + 1 + " / " + state.photos.length : "";
  elements.exportButton.disabled = !photo || state.busy;
  elements.exportButton.textContent = state.busy ? "Saving…" : "Save";
  elements.exportButton.setAttribute("aria-busy", String(state.busy));
  elements.applyAll.disabled = state.photos.length < 2;
  elements.resetCurrent.disabled = !photo;
  elements.filters.forEach((button) => {
    const active = edit.filter === button.dataset.filter;
    const loading = state.loadingFilters.has(button.dataset.filter);
    button.disabled = !photo || loading;
    button.setAttribute("aria-busy", String(loading));
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  renderAdjustmentControls(photo, edit);
  renderThumbnails();
}

async function prepareSource() {
  const photo = currentPhoto();
  const token = ++state.loadToken;
  state.sourceData = null;
  if (!photo) {
    const context = elements.canvas.getContext("2d");
    context?.clearRect(0, 0, elements.canvas.width, elements.canvas.height);
    renderControls();
    return;
  }

  try {
    const image = await loadImage(photo.url);
    if (token !== state.loadToken) return;
    const scale = Math.min(1, PREVIEW_LONG_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = width;
    sourceCanvas.height = height;
    const context = sourceCanvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas unavailable");
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    state.sourceData = context.getImageData(0, 0, width, height);
    ensureGpuPreview();
    if (gpuPreview) {
      gpuPreview.setSource(state.sourceData);
    } else {
      elements.canvas.width = width;
      elements.canvas.height = height;
      const previewContext = elements.canvas.getContext("2d", { willReadFrequently: true });
      if (!previewContext) throw new Error("Canvas unavailable");
      previewContext.putImageData(state.sourceData, 0, 0);
    }
    photo.width = image.naturalWidth;
    photo.height = image.naturalHeight;
    setStatus("照片已载入");
    if (DEBUG_MODE) updateDiagnosticOverlay();
    queuePreview();
    const prewarm = () => {
      if (token !== state.loadToken || !gpuPreview) return;
      gpuPreview.prewarmGrain(photo.grainSeed);
      if (DEBUG_MODE) updateDiagnosticOverlay();
    };
    if (window.requestIdleCallback) window.requestIdleCallback(prewarm, { timeout: 250 });
    else window.setTimeout(prewarm, 0);
  } catch {
    if (token === state.loadToken) setStatus("照片载入失败，请换一张照片");
  }
}

function queuePreview() {
  window.cancelAnimationFrame(state.renderFrame);
  state.renderFrame = window.requestAnimationFrame(() => {
    const photo = currentPhoto();
    if (!photo || !state.sourceData) return;
    if (gpuPreview) {
      const startedAt = DEBUG_MODE ? performance.now() : 0;
      gpuPreview.render(photo.edit, photo.grainSeed, state.showOriginal);
      if (DEBUG_MODE) recordPreviewTiming("gpu", performance.now() - startedAt);
      return;
    }
    const context = elements.canvas.getContext("2d");
    if (!context) return;
    const startedAt = DEBUG_MODE ? performance.now() : 0;
    const pixels = state.showOriginal
      ? new Uint8ClampedArray(state.sourceData.data)
      : processPixels(state.sourceData, photo.edit, photo.grainSeed);
    context.putImageData(
      new ImageData(pixels, state.sourceData.width, state.sourceData.height),
      0,
      0,
    );
    if (DEBUG_MODE) recordPreviewTiming("cpu", performance.now() - startedAt);
  });
}

function selectPhoto(index) {
  if (index < 0 || index >= state.photos.length) return;
  state.activeIndex = index;
  setShowOriginal(false);
  renderControls();
  void prepareSource();
}

function handleFiles(files) {
  const selected = Array.from(files).filter((file) => file.type.startsWith("image/"));
  if (!selected.length) return;
  const room = Math.max(0, MAX_PHOTOS - state.photos.length);
  const accepted = selected.slice(0, room);
  if (!accepted.length) {
    showToast("最多添加 " + MAX_PHOTOS + " 张照片");
    return;
  }
  const startIndex = state.photos.length;
  const stamp = Date.now();
  accepted.forEach((file, index) => {
    const id = stamp + "-" + index + "-" + file.lastModified;
    state.photos.push({
      id,
      file,
      url: URL.createObjectURL(file),
      filename: file.name,
      width: 0,
      height: 0,
      grainSeed: createSessionGrainSeed(file, id),
      edit: createNeutralEdit(),
    });
  });
  state.activeIndex = startIndex;
  setShowOriginal(false);
  setStatus("已添加 " + accepted.length + " 张照片");
  renderControls();
  void prepareSource();
  if (accepted.length < selected.length) showToast("最多保留 " + MAX_PHOTOS + " 张照片");
}

function deleteCurrent() {
  const photo = currentPhoto();
  if (!photo) return;
  URL.revokeObjectURL(photo.url);
  state.photos.splice(state.activeIndex, 1);
  state.activeIndex = Math.max(0, Math.min(state.activeIndex, state.photos.length - 1));
  state.sourceData = null;
  setShowOriginal(false);
  renderControls();
  void prepareSource();
  showToast("已移除当前照片");
}

function applyToAll() {
  const photo = currentPhoto();
  if (!photo || state.photos.length < 2) return;
  state.photos.forEach((item) => {
    item.edit = { ...photo.edit };
  });
  setShowOriginal(false);
  renderControls();
  queuePreview();
  showToast("已应用到全部照片");
}

function resetCurrent() {
  const photo = currentPhoto();
  if (!photo) return;
  photo.edit = {
    ...photo.edit,
    strength: 100,
    brightness: 0,
    color: 0,
    grain: 0,
  };
  setShowOriginal(false);
  renderControls();
  queuePreview();
  showToast("当前照片已重置");
}

function canvasToJpeg(canvas, quality = 0.95) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("无法生成照片文件"))),
      "image/jpeg",
      quality,
    );
  });
}

function waitForPaint() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
  });
}

async function processPhoto(photo, index, total) {
  const totalStartedAt = performance.now();
  await loadFilterLut(photo.edit.filter);
  updateExportDiagnostics({
    photo: index + 1 + " / " + total,
    decode: null,
    drawRead: null,
    process: null,
    processor: "not-run",
    gpuFallback: "",
    put: null,
    jpeg: null,
    total: null,
  });

  const decodeStartedAt = performance.now();
  let image = await loadImage(photo.url);
  updateExportDiagnostics({ decode: performance.now() - decodeStartedAt });

  const drawStartedAt = performance.now();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("当前浏览器无法处理照片");
  context.drawImage(image, 0, 0);
  image = null;
  let source = context.getImageData(0, 0, canvas.width, canvas.height);
  let drawReadDuration = performance.now() - drawStartedAt;
  updateExportDiagnostics({ drawRead: drawReadDuration });

  let processed;
  let processMode;
  let gpuFallback = "";
  let gpuAttempt = await attemptGpuFullResolutionExport(
    source,
    photo.edit,
    photo.grainSeed,
  );
  if (gpuAttempt.ok) {
    processed = { pixels: gpuAttempt.pixels, duration: gpuAttempt.duration };
    processMode = "gpu";
  } else {
    gpuFallback = gpuAttempt.reason;
    try {
      const cpuResult = await ensureExportProcessor().process(source, photo.edit, photo.grainSeed);
      processed = cpuResult;
      processMode = cpuResult.processor === "worker"
        ? "worker-fallback"
        : "main-thread-fallback";
    } catch {
      const fallbackReadStartedAt = performance.now();
      source = context.getImageData(0, 0, canvas.width, canvas.height);
      drawReadDuration += performance.now() - fallbackReadStartedAt;
      const fallbackStartedAt = performance.now();
      processed = {
        pixels: processPixels(source, photo.edit, photo.grainSeed),
        duration: performance.now() - fallbackStartedAt,
      };
      processMode = "main-thread-fallback";
    }
  }
  gpuAttempt = null;
  let pixels = processed.pixels;
  const processDuration = processed.duration;
  processed = null;
  source = null;
  updateExportDiagnostics({
    drawRead: drawReadDuration,
    process: processDuration,
    processor: processMode,
    gpuFallback,
  });

  const putStartedAt = performance.now();
  context.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
  pixels = null;
  updateExportDiagnostics({ put: performance.now() - putStartedAt });

  const jpegStartedAt = performance.now();
  const blob = await canvasToJpeg(canvas, 0.95);
  updateExportDiagnostics({ jpeg: performance.now() - jpegStartedAt });
  canvas.width = 1;
  canvas.height = 1;
  const base = photo.filename.replace(/\.[^.]+$/, "") || "photo";
  const file = new File([blob], base + "_See.jpg", {
    type: "image/jpeg",
    lastModified: Date.now(),
  });
  updateExportDiagnostics({ total: performance.now() - totalStartedAt });
  return file;
}

function zipNumber(view, offset, value, bytes) {
  if (bytes === 2) view.setUint16(offset, value, true);
  else view.setUint32(offset, value, true);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function createZip(files) {
  const encoder = new TextEncoder();
  const body = [];
  const directory = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const crc = crc32(bytes);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    zipNumber(localView, 0, 0x04034b50, 4);
    zipNumber(localView, 4, 20, 2);
    zipNumber(localView, 6, 0x0800, 2);
    zipNumber(localView, 8, 0, 2);
    zipNumber(localView, 14, crc, 4);
    zipNumber(localView, 18, bytes.length, 4);
    zipNumber(localView, 22, bytes.length, 4);
    zipNumber(localView, 26, name.length, 2);
    local.set(name, 30);
    body.push(local, bytes);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    zipNumber(centralView, 0, 0x02014b50, 4);
    zipNumber(centralView, 4, 20, 2);
    zipNumber(centralView, 6, 20, 2);
    zipNumber(centralView, 8, 0x0800, 2);
    zipNumber(centralView, 10, 0, 2);
    zipNumber(centralView, 16, crc, 4);
    zipNumber(centralView, 20, bytes.length, 4);
    zipNumber(centralView, 24, bytes.length, 4);
    zipNumber(centralView, 28, name.length, 2);
    zipNumber(centralView, 42, offset, 4);
    central.set(name, 46);
    directory.push(central);
    offset += local.length + bytes.length;
  }

  const directorySize = directory.reduce((sum, bytes) => sum + bytes.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  zipNumber(endView, 0, 0x06054b50, 4);
  zipNumber(endView, 8, files.length, 2);
  zipNumber(endView, 10, files.length, 2);
  zipNumber(endView, 12, directorySize, 4);
  zipNumber(endView, 16, offset, 4);
  return new Blob([...body, ...directory, end], { type: "application/zip" });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportPhotos() {
  if (!state.photos.length || state.busy) return;
  setShowOriginal(false);
  state.busy = true;
  renderControls();
  setStatus("正在准备保存");
  await waitForPaint();

  try {
    const files = [];
    for (let index = 0; index < state.photos.length; index += 1) {
      setStatus("正在处理 " + (index + 1) + " / " + state.photos.length);
      files.push(await processPhoto(state.photos[index], index, state.photos.length));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }

    const shareData = { files, title: "See.", text: "See. 处理的照片" };
    if (navigator.share && navigator.canShare?.(shareData)) {
      await navigator.share(shareData);
      setStatus("照片已分享");
    } else if (files.length === 1) {
      downloadBlob(files[0], files[0].name);
      setStatus("照片已保存");
    } else {
      downloadBlob(await createZip(files), "See_Photos.zip");
      setStatus("照片包已保存");
    }
  } catch (error) {
    if (DEBUG_MODE) diagnostics.exportError = `Save: ${error instanceof Error ? error.message : String(error)}`;
    if (error?.name === "AbortError") setStatus("已取消分享");
    else setStatus("保存失败，请减少照片数量后重试");
  } finally {
    state.busy = false;
    renderControls();
  }
}

elements.input.addEventListener("change", (event) => {
  handleFiles(event.target.files);
  event.target.value = "";
});
document.querySelector("#add-photo")?.addEventListener("click", () => elements.input.click());
elements.compareButton.addEventListener("click", () => setShowOriginal(!state.showOriginal));
elements.deleteButton.addEventListener("click", deleteCurrent);
elements.applyAll.addEventListener("click", applyToAll);
elements.resetCurrent.addEventListener("click", resetCurrent);
elements.exportButton.addEventListener("click", exportPhotos);

elements.filters.forEach((button) => {
  button.addEventListener("click", () => void selectFilter(button.dataset.filter));
});

elements.adjustmentTabs.forEach((button) => {
  button.addEventListener("click", () => {
    const photo = currentPhoto();
    if (!photo || (button.dataset.adjustment === "strength" && !photo.edit.filter)) return;
    state.activeAdjustment = button.dataset.adjustment;
    setShowOriginal(false);
    renderControls();
  });
});

elements.slider.addEventListener("input", (event) => {
  updateAdjustmentValue(Number(event.target.value));
});

elements.valueInput.addEventListener("focus", (event) => event.target.select());

elements.valueInput.addEventListener("input", (event) => {
  const raw = event.target.value;
  if (raw === "" || raw === "-" || raw === "+") return;
  const parsed = Number(raw);
  if (Number.isFinite(parsed)) updateAdjustmentValue(parsed);
});

elements.valueInput.addEventListener("blur", () => {
  const photo = currentPhoto();
  if (!photo) return;
  const config = sliderConfig(photo.edit);
  const parsed = Number(elements.valueInput.value);
  if (elements.valueInput.value === "" || !Number.isFinite(parsed)) {
    elements.valueInput.value = String(config.value);
  } else {
    updateAdjustmentValue(parsed);
  }
});

elements.valueInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") event.target.blur();
});

document.querySelector(".interaction-surface").addEventListener("contextmenu", (event) => {
  if (event.target.closest("button, canvas, img")) event.preventDefault();
});

document.querySelector(".interaction-surface").addEventListener("dragstart", (event) => {
  if (event.target.closest("img")) event.preventDefault();
});

markStartup("listeners ready");

window.addEventListener("pagehide", (event) => {
  markStartup("pagehide", event.persisted ? "persisted" : "not persisted");
  destroyExportProcessor();
});

window.addEventListener("pageshow", (event) => {
  markStartup("pageshow", event.persisted ? "persisted" : "not persisted");
  if (DEBUG_MODE) updateDiagnosticOverlay();
});

document.addEventListener("visibilitychange", () => {
  markStartup("visibilitychange", document.visibilityState);
  if (DEBUG_MODE) updateDiagnosticOverlay();
});

window.addEventListener("beforeunload", () => {
  state.photos.forEach((photo) => URL.revokeObjectURL(photo.url));
  gpuPreview?.destroy();
  destroyExportProcessor();
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    markStartup("window load");
    window.requestAnimationFrame(() => window.setTimeout(async () => {
      try {
        const registration = await navigator.serviceWorker.register("./sw.js?v=60", { scope: "./", updateViaCache: "none" });
        markStartup("LUT preparation start");
        await prepareOfflineLutPack(registration);
      } catch (error) {
        if (DEBUG_MODE) diagnostics.lutError = `offline pack: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (DEBUG_MODE) updateDiagnosticOverlay();
    }, 0));
    if (DEBUG_MODE) updateDiagnosticOverlay();
  });
}

renderControls();
markStartup("+ functional");
document.documentElement.dataset.appReady = "true";
markStartup("app ready");
if (DEBUG_MODE) updateDiagnosticOverlay();

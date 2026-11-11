"use client";

/* Blob-backed thumbnails and the supplied transparent wordmark intentionally use native images. */
/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties } from "react";
import { createExportProcessor } from "../lib/export-processor.js";
import { attemptGpuFullResolutionExport } from "../lib/gpu-export.js";
import { createGpuPreviewRenderer } from "../lib/gpu-preview.js";
import { getGrainParameters, hashSeed, processPixels } from "../lib/image-engine.js";
import { getLutPackStatus, loadFilterLut, subscribeLutPackStatus } from "../lib/lut-loader.js";
import { hasEdits, visibleEditLabel } from "../lib/edit-state.js";

const FILTERS = [
  { id: "classic", label: "Nostalgic Neg", name: "FUJI Nostalgic Neg" },
  { id: "gold", label: "Classic Neg", name: "FUJI Classic Neg" },
  { id: "youth", label: "Classic Chrome", name: "FUJI Classic Chrome" },
  { id: "slot07", label: "Color 800Z", name: "FUJI Color 800Z" },
  { id: "slot06", label: "Color 100", name: "FUJI Color 100" },
  { id: "slot04", label: "Provia 400H", name: "FUJI Pro 400H" },
  { id: "slot05", label: "Superia 400", name: "FUJI Superia 400" },
  { id: "slot12", label: "Portra 400", name: "KODAK Portra 400" },
  { id: "slot09", label: "Portra Cool", name: "KODAK Portra Cool" },
  { id: "slot13", label: "Gold 200", name: "KODAK Gold 200" },
  { id: "slot08", label: "Gold Blue", name: "KODAK Gold Blue" },
  { id: "slot10", label: "Proimage 100", name: "KODAK Proimage 100" },
  { id: "slot11", label: "Ektar 100", name: "KODAK Ektar 100" },
  { id: "slot14", label: "Chrome 64", name: "KODAK Chrome 64" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];
type AdjustmentId = "strength" | "brightness" | "color" | "grain";
type EditState = {
  filter: FilterId | null;
  strength: number;
  brightness: number;
  color: number;
  grain: number;
};
type PhotoItem = {
  id: string;
  file: File;
  url: string;
  filename: string;
  width: number;
  height: number;
  grainSeed: number;
  edit: EditState;
};

const MAX_PHOTOS = 20;
const PREVIEW_LONG_EDGE = 960;

function createNeutralEdit(): EditState {
  return { filter: null, strength: 100, brightness: 0, color: 0, grain: 0 };
}

function createSessionGrainSeed(file: File, instanceId: string) {
  const randomValues = new Uint32Array(1);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(randomValues);
    return randomValues[0];
  }
  return hashSeed(
    file.name + ":" + file.size + ":" + instanceId + ":" + Date.now() + ":" + Math.random(),
  );
}

async function loadImage(url: string) {
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  await image.decode();
  return image;
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality = 0.95) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("无法生成照片文件"))),
      "image/jpeg",
      quality,
    );
  });
}

function waitForPaint() {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
}

function rangeStyle(value: number, min: number, max: number): CSSProperties {
  const progress = ((value - min) / (max - min)) * 100;
  return { "--range-progress": progress + "%" } as CSSProperties;
}

function clampAdjustment(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function markStartup(label: string, detail = "") {
  if (typeof window === "undefined") return;
  const probe = (window as typeof window & {
    __SEE_BOOT__?: { events: Array<{ label: string; time: number; detail: string }> };
  }).__SEE_BOOT__;
  probe?.events.push({ label, time: performance.now(), detail });
}

markStartup("module entry");

function zipNumber(view: DataView, offset: number, value: number, bytes: number) {
  if (bytes === 2) view.setUint16(offset, value, true);
  else view.setUint32(offset, value, true);
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function createZip(files: File[]) {
  const encoder = new TextEncoder();
  const body: BlobPart[] = [];
  const directory: BlobPart[] = [];
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

  const directorySize = directory.reduce(
    (sum, part) => sum + (part as Uint8Array).byteLength,
    0,
  );
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  zipNumber(endView, 0, 0x06054b50, 4);
  zipNumber(endView, 8, files.length, 2);
  zipNumber(endView, 10, files.length, 2);
  zipNumber(endView, 12, directorySize, 4);
  zipNumber(endView, 16, offset, 4);
  return new Blob([...body, ...directory, end], { type: "application/zip" });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Home() {
  const [photos, setPhotos] = useState<PhotoItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [activeAdjustment, setActiveAdjustment] =
    useState<AdjustmentId>("brightness");
  const [sourceVersion, setSourceVersion] = useState(0);
  const [showOriginal, setShowOriginal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("等待添加照片");
  const [toast, setToast] = useState("");
  const [adjustmentDraft, setAdjustmentDraft] = useState("0");
  const [debugMode] = useState(() => (
    typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("debug") === "1"
  ));
  const [debugVersion, setDebugVersion] = useState(0);
  const [lutPackStatus, setLutPackStatus] = useState(() => getLutPackStatus());
  const [loadingFilters, setLoadingFilters] = useState<Set<FilterId>>(() => new Set());

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sourceDataRef = useRef<ImageData | null>(null);
  const gpuPreviewRef = useRef<ReturnType<typeof createGpuPreviewRenderer>>(null);
  const exportProcessorRef = useRef<ReturnType<typeof createExportProcessor>>(null);
  const exportInFlightRef = useRef(false);
  const filterSelectionTokenRef = useRef(0);
  const firstLutRequestedRef = useRef(false);
  const gpuPreviewAttemptedRef = useRef(false);
  const renderFrameRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const photosRef = useRef<PhotoItem[]>([]);
  const diagnosticsRef = useRef({
    initError: "",
    lastPath: "" as "" | "gpu" | "cpu",
    lastDuration: null as number | null,
    samples: { gpu: [] as number[], cpu: [] as number[] },
    exportError: "",
    lutError: "",
    exportTiming: {
      photo: "—",
      decode: null as number | null,
      drawRead: null as number | null,
      process: null as number | null,
      processor: "not-run" as "not-run" | "gpu" | "worker-fallback" | "main-thread-fallback",
      gpuFallback: "",
      put: null as number | null,
      jpeg: null as number | null,
      total: null as number | null,
    },
  });

  const currentPhoto = photos[activeIndex] ?? null;
  const currentEdit = currentPhoto?.edit ?? createNeutralEdit();
  const currentHasEdits = Boolean(currentPhoto && hasEdits(currentEdit));
  const currentVisibleLabel = visibleEditLabel(currentEdit, showOriginal);
  const currentPhotoId = currentPhoto?.id ?? "";
  const sourceUrl = currentPhoto?.url ?? "";

  useEffect(() => {
    markStartup("listeners ready");
    document.documentElement.dataset.appReady = "true";
    markStartup("+ functional");
    markStartup("app ready");
  }, []);

  useEffect(() => {
    if (!debugMode) return undefined;
    return subscribeLutPackStatus(setLutPackStatus);
  }, [debugMode]);

  useEffect(() => {
    const handlePageHide = (event: PageTransitionEvent) => {
      markStartup("pagehide", event.persisted ? "persisted" : "not persisted");
      exportProcessorRef.current?.destroy();
      exportProcessorRef.current = null;
    };
    const handlePageShow = (event: PageTransitionEvent) => {
      markStartup("pageshow", event.persisted ? "persisted" : "not persisted");
      document.documentElement.dataset.appReady = "true";
    };
    const handleVisibility = () => markStartup("visibilitychange", document.visibilityState);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
      document.removeEventListener("visibilitychange", handleVisibility);
      exportProcessorRef.current?.destroy();
      exportProcessorRef.current = null;
    };
  }, []);

  const adjustmentConfig = useMemo(() => {
    if (activeAdjustment === "strength") {
      return {
        label: "Strength",
        min: 0,
        max: 100,
        value: currentEdit.strength,
        disabled: !currentPhoto || !currentEdit.filter,
      };
    }
    if (activeAdjustment === "brightness") {
      return {
        label: "Light",
        min: -100,
        max: 100,
        value: currentEdit.brightness,
        disabled: !currentPhoto,
      };
    }
    if (activeAdjustment === "color") {
      return {
        label: "Color",
        min: -100,
        max: 100,
        value: currentEdit.color,
        disabled: !currentPhoto,
      };
    }
    return {
      label: "Grain",
      min: 0,
      max: 100,
      value: currentEdit.grain,
      disabled: !currentPhoto,
    };
  }, [activeAdjustment, currentEdit, currentPhoto]);

  useEffect(() => {
    setAdjustmentDraft(String(adjustmentConfig.value));
  }, [activeAdjustment, adjustmentConfig.value, currentPhotoId]);

  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);

  useEffect(() => {
    return () => {
      for (const photo of photosRef.current) URL.revokeObjectURL(photo.url);
      gpuPreviewRef.current?.destroy();
      if (renderFrameRef.current) cancelAnimationFrame(renderFrameRef.current);
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let grainWarmHandle: number | null = null;
    let grainWarmUsesIdle = false;
    sourceDataRef.current = null;

    async function prepareSource() {
      const canvas = canvasRef.current;
      if (!canvas || !currentPhotoId) return;

      try {
        const image = await loadImage(sourceUrl);
        if (cancelled) return;
        const scale = Math.min(1, PREVIEW_LONG_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));
        const sourceCanvas = document.createElement("canvas");
        sourceCanvas.width = width;
        sourceCanvas.height = height;
        const context = sourceCanvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("当前浏览器无法处理照片");
        context.clearRect(0, 0, width, height);
        context.drawImage(image, 0, 0, width, height);
        const sourceData = context.getImageData(0, 0, width, height);
        sourceDataRef.current = sourceData;

        if (!gpuPreviewAttemptedRef.current) {
          gpuPreviewAttemptedRef.current = true;
          markStartup("GPU init start");
          gpuPreviewRef.current = debugMode
            ? createGpuPreviewRenderer(canvas, {
              onError({ stage, error }: { stage: string; error: unknown }) {
                const message = (error instanceof Error ? error.message : String(error)).replace(/\0/g, "");
                diagnosticsRef.current.initError = stage + ": " + message;
                setDebugVersion((version) => version + 1);
              },
            })
            : createGpuPreviewRenderer(canvas);
          markStartup(
            "GPU init end",
            gpuPreviewRef.current ? "WebGL2 GPU" : "CPU fallback",
          );
        }
        if (gpuPreviewRef.current) {
          gpuPreviewRef.current.setSource(sourceData);
        } else {
          canvas.width = width;
          canvas.height = height;
          const previewContext = canvas.getContext("2d", { willReadFrequently: true });
          if (!previewContext) throw new Error("当前浏览器无法处理照片");
          previewContext.putImageData(sourceData, 0, 0);
        }
        setPhotos((items) =>
          items.map((item) =>
            item.id === currentPhotoId
              ? { ...item, width: image.naturalWidth, height: image.naturalHeight }
              : item,
          ),
        );
        setSourceVersion((version) => version + 1);
        if (debugMode) setDebugVersion((version) => version + 1);
        setStatus("照片已载入");
        if (gpuPreviewRef.current) {
          const preview = gpuPreviewRef.current;
          const grainSeed = photosRef.current.find((item) => item.id === currentPhotoId)?.grainSeed;
          const prewarm = () => {
            if (cancelled || grainSeed === undefined) return;
            preview.prewarmGrain(grainSeed);
            if (debugMode) setDebugVersion((version) => version + 1);
          };
          const idleWindow = window as typeof window & {
            requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
            cancelIdleCallback?: (handle: number) => void;
          };
          if (idleWindow.requestIdleCallback) {
            grainWarmUsesIdle = true;
            grainWarmHandle = idleWindow.requestIdleCallback(prewarm, { timeout: 250 });
          } else {
            grainWarmHandle = window.setTimeout(prewarm, 0);
          }
        }
      } catch {
        if (!cancelled) setStatus("照片载入失败，请换一张照片");
      }
    }

    void prepareSource();
    return () => {
      cancelled = true;
      if (grainWarmHandle !== null) {
        const idleWindow = window as typeof window & {
          cancelIdleCallback?: (handle: number) => void;
        };
        if (grainWarmUsesIdle) idleWindow.cancelIdleCallback?.(grainWarmHandle);
        else window.clearTimeout(grainWarmHandle);
      }
    };
  }, [currentPhotoId, sourceUrl, debugMode]);

  useEffect(() => {
    if (renderFrameRef.current) cancelAnimationFrame(renderFrameRef.current);
    renderFrameRef.current = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      const source = sourceDataRef.current;
      if (!canvas || !source || !currentPhoto) return;
      if (gpuPreviewRef.current) {
        const startedAt = debugMode ? performance.now() : 0;
        gpuPreviewRef.current.render(currentEdit, currentPhoto.grainSeed, showOriginal);
        if (debugMode) {
          const duration = performance.now() - startedAt;
          const samples = diagnosticsRef.current.samples.gpu;
          samples.push(duration);
          if (samples.length > 10) samples.shift();
          diagnosticsRef.current.lastPath = "gpu";
          diagnosticsRef.current.lastDuration = duration;
          setDebugVersion((version) => version + 1);
        }
        return;
      }
      const context = canvas.getContext("2d");
      if (!context) return;
      const startedAt = debugMode ? performance.now() : 0;
      const pixels = showOriginal
        ? new Uint8ClampedArray(source.data)
        : processPixels(source, currentEdit, currentPhoto.grainSeed);
      context.putImageData(new ImageData(pixels, source.width, source.height), 0, 0);
      if (debugMode) {
        const duration = performance.now() - startedAt;
        const samples = diagnosticsRef.current.samples.cpu;
        samples.push(duration);
        if (samples.length > 10) samples.shift();
        diagnosticsRef.current.lastPath = "cpu";
        diagnosticsRef.current.lastDuration = duration;
        setDebugVersion((version) => version + 1);
      }
    });
    return () => {
      if (renderFrameRef.current) cancelAnimationFrame(renderFrameRef.current);
    };
  }, [currentPhoto, currentEdit, showOriginal, sourceVersion, debugMode]);

  function showToast(message: string) {
    setToast(message);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(""), 1800);
  }

  function ensureExportProcessor() {
    if (exportProcessorRef.current) return exportProcessorRef.current;
    exportProcessorRef.current = createExportProcessor({
      onWorkerCreated() {
        markStartup("Worker created");
        setDebugVersion((version) => version + 1);
      },
      onFailure(error: unknown) {
        diagnosticsRef.current.exportError = error instanceof Error
          ? error.message
          : String(error);
        setDebugVersion((version) => version + 1);
      },
    });
    return exportProcessorRef.current;
  }

  function updateCurrentEdit(patch: Partial<EditState>) {
    if (!currentPhoto) return;
    setShowOriginal(false);
    setPhotos((items) =>
      items.map((item, index) =>
        index === activeIndex ? { ...item, edit: { ...item.edit, ...patch } } : item,
      ),
    );
  }

  async function selectFilter(filter: FilterId) {
    if (!currentPhoto) return;
    const photoId = currentPhoto.id;
    const token = ++filterSelectionTokenRef.current;
    const firstRequest = !firstLutRequestedRef.current;
    if (firstRequest) {
      firstLutRequestedRef.current = true;
      markStartup("first LUT requested", filter);
    }
    setLoadingFilters((current) => new Set(current).add(filter));
    diagnosticsRef.current.lutError = "";

    try {
      await loadFilterLut(filter);
      if (firstRequest) markStartup("first LUT loaded", filter);
      if (token !== filterSelectionTokenRef.current) return;
      setShowOriginal(false);
      setPhotos((items) => items.map((item) => (
        item.id === photoId ? { ...item, edit: { ...item.edit, filter } } : item
      )));
    } catch (error) {
      diagnosticsRef.current.lutError = `${filter}: ${error instanceof Error ? error.message : String(error)}`;
      if (token === filterSelectionTokenRef.current) {
        setStatus("滤镜载入失败，请重试");
        showToast("滤镜载入失败，请重试");
      }
    } finally {
      setLoadingFilters((current) => {
        const next = new Set(current);
        next.delete(filter);
        return next;
      });
      if (debugMode) setDebugVersion((version) => version + 1);
    }
  }

  function updateAdjustmentValue(value: number) {
    const clamped = clampAdjustment(
      value,
      adjustmentConfig.min,
      adjustmentConfig.max,
    );
    setAdjustmentDraft(String(clamped));
    updateCurrentEdit({
      [activeAdjustment]: clamped,
    } as Partial<EditState>);
  }

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.target.files ?? []).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (!selected.length) return;
    const room = Math.max(0, MAX_PHOTOS - photos.length);
    const accepted = selected.slice(0, room);
    if (!accepted.length) {
      showToast("最多添加 " + MAX_PHOTOS + " 张照片");
      event.target.value = "";
      return;
    }
    const stamp = Date.now();
    const incoming = accepted.map((file, index) => {
      const id = stamp + "-" + index + "-" + file.lastModified;
      return {
        id,
        file,
        url: URL.createObjectURL(file),
        filename: file.name,
        width: 0,
        height: 0,
        grainSeed: createSessionGrainSeed(file, id),
        edit: createNeutralEdit(),
      };
    });
    setPhotos((items) => [...items, ...incoming]);
    setActiveIndex(photos.length);
    setShowOriginal(false);
    setStatus("已添加 " + incoming.length + " 张照片");
    event.target.value = "";
    if (accepted.length < selected.length) showToast("最多保留 " + MAX_PHOTOS + " 张照片");
  }

  function selectPhoto(index: number) {
    setActiveIndex(index);
    setShowOriginal(false);
  }

  function deleteCurrent() {
    if (!currentPhoto) return;
    URL.revokeObjectURL(currentPhoto.url);
    const remaining = photos.filter((_, index) => index !== activeIndex);
    setPhotos(remaining);
    setActiveIndex(Math.max(0, Math.min(activeIndex, remaining.length - 1)));
    setShowOriginal(false);
    sourceDataRef.current = null;
    showToast("已移除当前照片");
  }

  function applyToAll() {
    if (!currentPhoto || photos.length < 2) return;
    const edit = { ...currentPhoto.edit };
    setPhotos((items) => items.map((item) => ({ ...item, edit: { ...edit } })));
    setShowOriginal(false);
    showToast("已应用到全部照片");
  }

  function resetCurrent() {
    if (!currentPhoto) return;
    updateCurrentEdit({
      strength: 100,
      brightness: 0,
      color: 0,
      grain: 0,
    });
    showToast("当前照片已重置");
  }

  function updateExportDiagnostics(
    patch: Partial<typeof diagnosticsRef.current.exportTiming>,
  ) {
    if (!debugMode) return;
    Object.assign(diagnosticsRef.current.exportTiming, patch);
    setDebugVersion((version) => version + 1);
  }

  async function processPhoto(photo: PhotoItem, index: number, total: number) {
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
    let image: HTMLImageElement | null = await loadImage(photo.url);
    updateExportDiagnostics({ decode: performance.now() - decodeStartedAt });

    const drawStartedAt = performance.now();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("当前浏览器无法处理照片");
    context.drawImage(image, 0, 0);
    image = null;
    let source: ImageData | null = context.getImageData(0, 0, canvas.width, canvas.height);
    let drawReadDuration = performance.now() - drawStartedAt;
    updateExportDiagnostics({ drawRead: drawReadDuration });

    let processed: { pixels: Uint8ClampedArray; duration: number } | null = null;
    let processMode: "gpu" | "worker-fallback" | "main-thread-fallback";
    let gpuFallback = "";
    let gpuAttempt: Awaited<ReturnType<typeof attemptGpuFullResolutionExport>> | null =
      await attemptGpuFullResolutionExport(
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
        const cpuResult = await ensureExportProcessor().process(
          source,
          photo.edit,
          photo.grainSeed,
        );
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
    let pixels: Uint8ClampedArray | null = processed.pixels;
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

  async function exportPhotos() {
    if (!photos.length || exportInFlightRef.current) return;
    exportInFlightRef.current = true;
    setShowOriginal(false);
    setBusy(true);
    setStatus("正在准备保存");
    await waitForPaint();

    try {
      const files: File[] = [];
      for (let index = 0; index < photos.length; index += 1) {
        setStatus("正在处理 " + (index + 1) + " / " + photos.length);
        files.push(await processPhoto(photos[index], index, photos.length));
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }

      const shareData = { files, title: "See.", text: "See. 处理的照片" };
      if (navigator.share && navigator.canShare?.(shareData)) {
        await navigator.share(shareData);
        setStatus("照片已分享");
      } else if (files.length === 1) {
        downloadBlob(files[0], files[0].name);
        setStatus("照片已保存");
      } else {
        const zip = await createZip(files);
        downloadBlob(zip, "See_Photos.zip");
        setStatus("照片包已保存");
      }
    } catch (error) {
      if (debugMode) {
        diagnosticsRef.current.exportError = `Save: ${error instanceof Error ? error.message : String(error)}`;
        setDebugVersion((version) => version + 1);
      }
      if ((error as DOMException)?.name === "AbortError") {
        setStatus("已取消分享");
      } else {
        setStatus("保存失败，请减少照片数量后重试");
      }
    } finally {
      exportInFlightRef.current = false;
      setBusy(false);
    }
  }

  const diagnosticPath = gpuPreviewRef.current ? "gpu" : "cpu";
  const diagnosticSamples = diagnosticsRef.current.samples[diagnosticPath];
  const diagnosticAverage = diagnosticSamples.length
    ? diagnosticSamples.reduce((sum, duration) => sum + duration, 0) / diagnosticSamples.length
    : null;
  const diagnosticTimingLabel = diagnosticPath === "gpu" ? "Submit" : "Render";
  const diagnosticAverageLabel = diagnosticPath === "gpu" ? "Average submit" : "Average";
  const diagnosticSource = sourceDataRef.current;
  const diagnosticGrain = getGrainParameters(
    currentEdit.grain,
    currentPhoto?.width ?? 1,
    currentPhoto?.height ?? 1,
  );
  const diagnosticGrainGpu = gpuPreviewRef.current?.getGrainDiagnostics() ?? {
    state: gpuPreviewAttemptedRef.current ? "CPU fallback" : "cold",
    prewarm: null,
    firstActivation: null,
    sliderUpdate: null,
  };
  const diagnosticFilterActive = Boolean(currentEdit.filter && currentEdit.strength > 0);
  const exportTiming = diagnosticsRef.current.exportTiming;
  const exportDuration = (value: number | null) => value === null ? "—" : value.toFixed(1) + " ms";
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
  const bootProbe = typeof window === "undefined" ? null : (window as typeof window & {
    __SEE_BOOT__?: {
      origin: number;
      events: Array<{ label: string; time: number; detail: string }>;
    };
  }).__SEE_BOOT__;
  const startupLines = (bootProbe?.events ?? []).map((event) => (
    `${event.label}: ${Math.max(0, event.time - bootProbe!.origin).toFixed(1)} ms`
      + (event.detail ? " — " + event.detail : "")
  ));
  const diagnosticText = [
    "Startup",
    ...startupLines,
    "appReady: " + (typeof document !== "undefined" && document.documentElement.dataset.appReady === "true"),
    "",
    "Preview: " + (gpuPreviewRef.current
      ? "WebGL2 GPU"
      : gpuPreviewAttemptedRef.current
        ? "CPU fallback"
        : "Not initialized"),
    gpuPreviewRef.current
      ? "GPU init: OK"
      : "GPU init failed: " + (diagnosticsRef.current.initError || "Not initialized"),
    diagnosticTimingLabel + ": "
      + (diagnosticsRef.current.lastPath === diagnosticPath && diagnosticsRef.current.lastDuration !== null
        ? diagnosticsRef.current.lastDuration.toFixed(1) + " ms"
        : "—"),
    diagnosticAverageLabel + ": "
      + (diagnosticAverage === null ? "—" : diagnosticAverage.toFixed(1) + " ms"),
    "Preview size: " + (diagnosticSource
      ? diagnosticSource.width + " × " + diagnosticSource.height
      : "—"),
    "Filter: " + (diagnosticFilterActive ? "on" : "off"),
    "Light: " + currentEdit.brightness,
    "Color: " + currentEdit.color,
    "Grain: " + currentEdit.grain,
    "Processing: OpenLight Light / LightCraft Color / glsl-film-grain",
    "Grain footprint: " + diagnosticGrain.footprint.toFixed(3) + " cells per pixel",
    "Grain resources: " + diagnosticGrainGpu.state,
    "Grain prewarm submit: " + exportDuration(diagnosticGrainGpu.prewarm),
    "First activation submit: " + exportDuration(diagnosticGrainGpu.firstActivation),
    "Slider submit: " + exportDuration(diagnosticGrainGpu.sliderUpdate),
    "grainSeed: " + (currentPhoto ? currentPhoto.grainSeed : "—"),
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
    ...(exportTiming.gpuFallback
      ? ["GPU fallback: " + exportTiming.gpuFallback]
      : []),
    ...(diagnosticsRef.current.exportError
      ? ["Export Worker failed: " + diagnosticsRef.current.exportError]
      : []),
    ...(diagnosticsRef.current.lutError
      ? ["LUT load failed: " + diagnosticsRef.current.lutError]
      : []),
    "Export photo: " + exportTiming.photo,
    "Decode: " + exportDuration(exportTiming.decode),
    "Draw/getImageData: " + exportDuration(exportTiming.drawRead),
    exportProcessLabel + ": " + exportDuration(exportTiming.process),
    "putImageData: " + exportDuration(exportTiming.put),
    "JPEG encoding: " + exportDuration(exportTiming.jpeg),
    "File ready: " + exportDuration(exportTiming.total),
  ].join("\n");
  void debugVersion;

  return (
    <main className="app-shell">
      <section className="editor-card interaction-surface" aria-label="See 照片滤镜">
        <header className="topbar">
          <img className="brand-logo" src="/see-logo.png" alt="See" draggable="false" />
          <p className="privacy-note">
            <span aria-hidden="true" />
            照片仅在本机处理
          </p>
        </header>

        {debugMode && (
          <aside
            className="diagnostic-overlay"
            data-preview-diagnostics="true"
            aria-label="Preview diagnostics"
          >
            <pre>{diagnosticText}</pre>
          </aside>
        )}

        <section className={"photo-stage" + (currentPhoto ? " has-photo" : "")}>
          {!currentPhoto && (
            <img
              className="welcome-image"
              src="/see-welcome.png"
              alt="See."
              draggable="false"
            />
          )}
          <canvas
            ref={canvasRef}
            className="preview-canvas"
            aria-label="照片滤镜预览"
            onContextMenu={(event) => event.preventDefault()}
          />

          {currentPhoto && (
            <>
              <button
                className={"compare-button" + (currentVisibleLabel === "Edited" ? " is-active" : "")}
                type="button"
                aria-pressed={showOriginal}
                onClick={() => {
                  if (currentHasEdits) setShowOriginal((value) => !value);
                }}
              >
                {currentVisibleLabel}
              </button>
              <button
                className="delete-button"
                type="button"
                aria-label="删除当前照片"
                onClick={deleteCurrent}
              />
              <span className="photo-count" aria-hidden="true">
                {activeIndex + 1} / {photos.length}
              </span>
            </>
          )}
          <section className="thumbnail-rail" aria-label="照片列表">
            {photos.map((photo, index) => (
              <button
                className={"thumbnail" + (index === activeIndex ? " is-active" : "")}
                type="button"
                key={photo.id}
                aria-label={"选择第 " + (index + 1) + " 张照片"}
                aria-pressed={index === activeIndex}
                onClick={() => selectPhoto(index)}
              >
                <img src={photo.url} alt="" draggable="false" />
              </button>
            ))}
            {photos.length < MAX_PHOTOS && (
              <button
                className="thumbnail add-photo"
                type="button"
                aria-label={photos.length ? "继续添加照片" : "添加照片"}
                onClick={() => inputRef.current?.click()}
              />
            )}
          </section>
        </section>

        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          accept="image/*"
          multiple
          onChange={handleFiles}
        />

        <section className="filter-row" aria-label="滤镜">
          {FILTERS.map((filter) => (
            <button
              className={"filter-button" + (currentEdit.filter === filter.id ? " is-active" : "")}
              type="button"
              key={filter.id}
              aria-label={filter.name ? filter.label + " " + filter.name : filter.label}
              aria-pressed={currentEdit.filter === filter.id}
              aria-busy={loadingFilters.has(filter.id)}
              disabled={!currentPhoto || loadingFilters.has(filter.id)}
              onClick={() => void selectFilter(filter.id)}
            >
              <span className="filter-label">
                {filter.label.split(" ").map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </span>
            </button>
          ))}
        </section>

        <section className="adjustment-panel">
          <nav className="adjustment-tabs" aria-label="微调项目">
            {(
              [
                ["strength", "Strength"],
                ["brightness", "Light"],
                ["color", "Color"],
                ["grain", "Grain"],
              ] as const
            ).map(([id, label]) => (
              <button
                className={"adjustment-tab" + (activeAdjustment === id ? " is-active" : "")}
                type="button"
                key={id}
                aria-pressed={activeAdjustment === id}
                disabled={!currentPhoto || (id === "strength" && !currentEdit.filter)}
                onClick={() => {
                  setShowOriginal(false);
                  setActiveAdjustment(id);
                }}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="slider-row">
            <input
              id="active-adjustment"
              className="range-control"
              aria-label={adjustmentConfig.label}
              type="range"
              min={adjustmentConfig.min}
              max={adjustmentConfig.max}
              value={adjustmentConfig.value}
              disabled={adjustmentConfig.disabled}
              style={rangeStyle(
                adjustmentConfig.value,
                adjustmentConfig.min,
                adjustmentConfig.max,
              )}
              onChange={(event) => updateAdjustmentValue(Number(event.target.value))}
            />
            <label className="value-input" aria-label={adjustmentConfig.label + " value"}>
              <input
                type="number"
                inputMode="numeric"
                min={adjustmentConfig.min}
                max={adjustmentConfig.max}
                step="1"
                value={adjustmentDraft}
                disabled={adjustmentConfig.disabled}
                aria-label={adjustmentConfig.label + " value"}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => {
                  const raw = event.target.value;
                  setAdjustmentDraft(raw);
                  if (raw === "" || raw === "-" || raw === "+") return;
                  const parsed = Number(raw);
                  if (Number.isFinite(parsed)) updateAdjustmentValue(parsed);
                }}
                onBlur={() => {
                  const parsed = Number(adjustmentDraft);
                  if (adjustmentDraft === "" || !Number.isFinite(parsed)) {
                    setAdjustmentDraft(String(adjustmentConfig.value));
                  } else {
                    updateAdjustmentValue(parsed);
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
              <span aria-hidden="true">%</span>
            </label>
          </div>
        </section>

        <div className="bottom-actions">
          <button
            className="bottom-action reset-action"
            type="button"
            disabled={!currentPhoto}
            onClick={resetCurrent}
          >
            Reset
          </button>
          <button
            className="bottom-action apply-action"
            type="button"
            disabled={photos.length < 2}
            onClick={applyToAll}
          >
            Apply All
          </button>
          <button
            className="bottom-action save-action"
            type="button"
            disabled={!photos.length || busy}
            aria-busy={busy}
            onClick={() => void exportPhotos()}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
        <p className="visually-hidden" role="status" aria-live="polite">
          {status}
        </p>
        {toast && <div className="toast" role="status">{toast}</div>}
      </section>
    </main>
  );
}

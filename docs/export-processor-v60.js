import { processPixels } from "./image-engine-v60.js";

function errorFrom(value, fallback = "Export Worker failed") {
  if (value instanceof Error) return value;
  if (value?.message) return new Error(String(value.message));
  return new Error(value ? String(value) : fallback);
}

export function createExportProcessor(options = {}) {
  const processPixelsFn = options.processPixelsFn ?? processPixels;
  const createWorker = options.createWorker
    ?? (() => new Worker(new URL("./export-worker-v60.js", import.meta.url), { type: "module" }));
  const pending = new Map();
  let worker = null;
  let failed = false;
  let nextId = 1;
  let readyPromise = null;
  let settleReady = () => {};

  function reportFailure(value, rejectPending = true) {
    const error = errorFrom(value);
    if (!failed) options.onFailure?.(error);
    failed = true;
    settleReady(false);
    worker?.terminate();
    worker = null;
    if (rejectPending) {
      for (const task of pending.values()) task.reject(error);
      pending.clear();
    }
    return error;
  }

  function processOnMainThread(source, edit, seed) {
    const startedAt = performance.now();
    const pixels = processPixelsFn(source, edit, seed);
    return {
      pixels,
      processor: "main-thread",
      duration: performance.now() - startedAt,
    };
  }

  function ensureWorker() {
    if (readyPromise) return readyPromise;
    if (failed) return Promise.resolve(false);
    readyPromise = new Promise((resolve) => {
      settleReady = resolve;
    });

    try {
      worker = createWorker();
      options.onWorkerCreated?.();
    } catch (error) {
      reportFailure(error);
      return readyPromise;
    }

    worker.addEventListener("message", (event) => {
      const message = event.data;
      if (message?.type === "ready") {
        settleReady(true);
        return;
      }

      const task = pending.get(message?.id);
      if (!task) return;
      pending.delete(message.id);

      if (message.type === "result") {
        task.resolve({
          pixels: new Uint8ClampedArray(message.buffer),
          processor: "worker",
          duration: message.duration,
        });
        return;
      }

      if (message.type === "error") {
        const error = reportFailure(message.message);
        try {
          const restoredSource = {
            data: new Uint8ClampedArray(message.buffer),
            width: task.width,
            height: task.height,
          };
          task.resolve(processOnMainThread(restoredSource, task.edit, task.seed));
        } catch (fallbackError) {
          task.reject(errorFrom(fallbackError, error.message));
        }
      }
    });
    worker.addEventListener("error", (event) => {
      event.preventDefault?.();
      reportFailure(event.error ?? event.message);
    });
    worker.addEventListener("messageerror", (event) => {
      reportFailure(event.data ?? "Export Worker message failed");
    });
    return readyPromise;
  }

  return {
    get mode() {
      if (worker && !failed) return "worker";
      return failed ? "main-thread" : "idle";
    },
    async process(source, edit, seed) {
      const ready = await ensureWorker();
      if (!ready || !worker || failed) return processOnMainThread(source, edit, seed);

      const id = nextId;
      nextId += 1;
      const task = new Promise((resolve, reject) => {
        pending.set(id, {
          resolve,
          reject,
          width: source.width,
          height: source.height,
          edit,
          seed,
        });
      });

      try {
        worker.postMessage(
          {
            type: "process",
            id,
            width: source.width,
            height: source.height,
            edit,
            seed,
            buffer: source.data.buffer,
          },
          [source.data.buffer],
        );
      } catch (error) {
        pending.delete(id);
        reportFailure(error);
        if (source.data.byteLength) return processOnMainThread(source, edit, seed);
        throw errorFrom(error);
      }

      return task;
    },
    destroy() {
      failed = true;
      settleReady(false);
      worker?.terminate();
      worker = null;
      const error = new Error("Export Worker was destroyed");
      for (const task of pending.values()) task.reject(error);
      pending.clear();
    },
  };
}

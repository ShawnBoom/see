import { processPixels } from "./image-engine-v60.js";
import { loadFilterLut } from "./lut-loader-v60.js";

self.postMessage({ type: "ready" });

self.addEventListener("message", async (event) => {
  const message = event.data;
  if (!message || message.type !== "process") return;

  const source = {
    data: new Uint8ClampedArray(message.buffer),
    width: message.width,
    height: message.height,
  };

  try {
    await loadFilterLut(message.edit?.filter);
    const startedAt = performance.now();
    const pixels = processPixels(source, message.edit, message.seed);
    const duration = performance.now() - startedAt;
    self.postMessage(
      {
        type: "result",
        id: message.id,
        buffer: pixels.buffer,
        duration,
      },
      [pixels.buffer],
    );
  } catch (error) {
    self.postMessage(
      {
        type: "error",
        id: message.id,
        message: error instanceof Error ? error.message : String(error),
        buffer: source.data.buffer,
      },
      [source.data.buffer],
    );
  }
});

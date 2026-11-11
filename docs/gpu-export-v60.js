import { createGpuFullResolutionRenderer } from "./gpu-preview-v60.js";

function messageFrom(error) {
  return (error instanceof Error ? error.message : String(error || "Unknown GPU export failure"))
    .replace(/\0/g, "")
    .trim();
}

export function capabilityFailure(capability, width, height) {
  if (width > capability.maxTextureSize || height > capability.maxTextureSize) {
    return `MAX_TEXTURE_SIZE exceeded (${width} × ${height} > ${capability.maxTextureSize})`;
  }
  if (width > capability.maxRenderbufferSize || height > capability.maxRenderbufferSize) {
    return `MAX_RENDERBUFFER_SIZE exceeded (${width} × ${height} > ${capability.maxRenderbufferSize})`;
  }
  if (width > capability.maxViewportWidth || height > capability.maxViewportHeight) {
    return `MAX_VIEWPORT_DIMS exceeded (${width} × ${height} > ${capability.maxViewportWidth} × ${capability.maxViewportHeight})`;
  }
  return "";
}

export async function attemptGpuFullResolutionExport(source, edit, seed, options = {}) {
  const createRenderer = options.createRenderer ?? createGpuFullResolutionRenderer;
  let initializationError = "";
  let renderer = null;

  try {
    renderer = createRenderer({
      onError(error) {
        initializationError = messageFrom(error);
      },
    });
    if (!renderer) {
      return {
        ok: false,
        reason: `WebGL2 initialization failed: ${initializationError || "renderer unavailable"}`,
      };
    }

    const capability = renderer.capabilities(source.width, source.height);
    const unsupportedReason = capabilityFailure(capability, source.width, source.height);
    if (unsupportedReason) return { ok: false, reason: unsupportedReason, capability };

    const result = await renderer.renderPixels(source, edit, seed);
    if (!(result?.pixels instanceof Uint8ClampedArray)
      || result.pixels.length !== source.width * source.height * 4) {
      throw new Error("GPU export returned an invalid pixel buffer");
    }

    return {
      ok: true,
      pixels: result.pixels,
      processor: "gpu",
      duration: result.timings.totalPixelsReady,
      timings: result.timings,
      capability,
    };
  } catch (error) {
    return { ok: false, reason: messageFrom(error) };
  } finally {
    try {
      renderer?.destroy();
    } catch {
      // A lost context may reject cleanup calls. The export result or CPU fallback remains valid.
    }
  }
}

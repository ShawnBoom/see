import { getFilterLut, getGrainParameters, OPENLIGHT_GLSL } from "./image-engine-v60.js";

const VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 aPosition;
out vec2 vUv;

void main() {
  gl_Position = vec4(aPosition, 0.0, 1.0);
  vUv = vec2(aPosition.x * 0.5 + 0.5, 0.5 - aPosition.y * 0.5);
}
`;

const COLOR_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uSource;
uniform sampler3D uLut;
uniform bool uHasLut;
uniform bool uShowOriginal;
uniform int uLutSize;
uniform float uStrength;
vec3 srgbToLinear(vec3 value) {
  vec3 low = value / 12.92;
  vec3 high = pow((value + 0.055) / 1.055, vec3(2.4));
  return mix(high, low, lessThanEqual(value, vec3(0.04045)));
}

vec3 linearToSrgb(vec3 value) {
  vec3 channel = clamp(value, 0.0, 1.0);
  vec3 low = channel * 12.92;
  vec3 high = 1.055 * pow(channel, vec3(1.0 / 2.4)) - 0.055;
  return mix(high, low, lessThanEqual(channel, vec3(0.0031308)));
}

vec3 applyLut(vec3 rgb) {
  float scale = float(uLutSize - 1);
  vec3 scaled = clamp(rgb, 0.0, 1.0) * scale;
  ivec3 p0 = ivec3(floor(scaled));
  ivec3 p1 = min(p0 + ivec3(1), ivec3(uLutSize - 1));
  vec3 t = fract(scaled);

  vec3 c000 = texelFetch(uLut, ivec3(p0.x, p0.y, p0.z), 0).rgb;
  vec3 c100 = texelFetch(uLut, ivec3(p1.x, p0.y, p0.z), 0).rgb;
  vec3 c010 = texelFetch(uLut, ivec3(p0.x, p1.y, p0.z), 0).rgb;
  vec3 c110 = texelFetch(uLut, ivec3(p1.x, p1.y, p0.z), 0).rgb;
  vec3 c001 = texelFetch(uLut, ivec3(p0.x, p0.y, p1.z), 0).rgb;
  vec3 c101 = texelFetch(uLut, ivec3(p1.x, p0.y, p1.z), 0).rgb;
  vec3 c011 = texelFetch(uLut, ivec3(p0.x, p1.y, p1.z), 0).rgb;
  vec3 c111 = texelFetch(uLut, ivec3(p1.x, p1.y, p1.z), 0).rgb;

  vec3 c00 = mix(c000, c100, t.x);
  vec3 c10 = mix(c010, c110, t.x);
  vec3 c01 = mix(c001, c101, t.x);
  vec3 c11 = mix(c011, c111, t.x);
  return clamp(mix(mix(c00, c10, t.y), mix(c01, c11, t.y), t.z), 0.0, 1.0);
}

${OPENLIGHT_GLSL}

void main() {
  vec4 source = texture(uSource, vUv);
  if (uShowOriginal) {
    outColor = source;
    return;
  }

  vec3 rgb = srgbToLinear(source.rgb);
  if (uHasLut && uStrength > 0.0) {
    vec3 preset = srgbToLinear(applyLut(source.rgb));
    rgb = mix(rgb, preset, clamp(uStrength / 100.0, 0.0, 1.0));
  }

  rgb = grainPort(colorPort(lightPort(rgb)));
  outColor = vec4(linearToSrgb(rgb), source.a);
}
`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to create preview shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "Preview shader compilation failed";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl, fragmentSource) {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error("Unable to create preview program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "Preview shader linking failed";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

function location(gl, program, name) {
  const value = gl.getUniformLocation(program, name);
  if (value === null) throw new Error(`Missing preview uniform: ${name}`);
  return value;
}

class GpuPreviewRenderer {
  constructor(canvas, contextOptions = {}) {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: false,
      powerPreference: "high-performance",
      preserveDrawingBuffer: false,
      stencil: false,
      ...contextOptions,
    });
    if (!gl) throw new Error("WebGL 2 is unavailable");

    this.canvas = canvas;
    this.gl = gl;
    this.program = createProgram(gl, COLOR_FRAGMENT_SHADER);
    this.sourceTexture = gl.createTexture();
    this.lutTexture = gl.createTexture();
    this.vertexArray = gl.createVertexArray();
    this.positionBuffer = gl.createBuffer();
    this.filter = undefined;
    this.hasSource = false;
    this.presentationFramebuffer = null;
    this.grainFirstActivationDuration = null;
    this.grainSliderUpdateDuration = null;
    this.grainHasActivated = false;

    if (!this.sourceTexture
      || !this.lutTexture
      || !this.vertexArray
      || !this.positionBuffer) {
      throw new Error("Unable to allocate preview GPU resources");
    }

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(this.program, "aPosition");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    this.uniforms = {
      source: location(gl, this.program, "uSource"),
      lut: location(gl, this.program, "uLut"),
      hasLut: location(gl, this.program, "uHasLut"),
      showOriginal: location(gl, this.program, "uShowOriginal"),
      lutSize: location(gl, this.program, "uLutSize"),
      strength: location(gl, this.program, "uStrength"),
      light: location(gl, this.program, "uLightAmount"),
      color: location(gl, this.program, "uColorAmount"),
      grain: location(gl, this.program, "uGrainAmount"),
      footprint: location(gl, this.program, "uGrainFootprint"),
      seed: location(gl, this.program, "uGrainSeed"),
      height: location(gl, this.program, "uOutputHeight"),
    };

    gl.uniform1i(this.uniforms.source, 0);
    gl.uniform1i(this.uniforms.lut, 1);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTexture);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.RGBA32F,
      1,
      1,
      1,
      0,
      gl.RGBA,
      gl.FLOAT,
      new Float32Array([0, 0, 0, 1]),
    );
    gl.uniform1i(this.uniforms.lutSize, 1);
    gl.useProgram(this.program);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
  }

  setSource(source) {
    const { gl } = this;
    this.canvas.width = source.width;
    this.canvas.height = source.height;
    gl.viewport(0, 0, source.width, source.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      source.width,
      source.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      source.data,
    );
    this.hasSource = true;
    this.grainFirstActivationDuration = null;
    this.grainSliderUpdateDuration = null;
    this.grainHasActivated = false;
  }

  setFilter(filter) {
    if (filter === this.filter) return Boolean(filter);
    this.filter = filter;
    const lut = getFilterLut(filter);
    if (!lut) return false;

    const rgba = new Float32Array(lut.size ** 3 * 4);
    for (let sourceIndex = 0, targetIndex = 0; sourceIndex < lut.data.length; sourceIndex += 3) {
      rgba[targetIndex] = lut.data[sourceIndex];
      rgba[targetIndex + 1] = lut.data[sourceIndex + 1];
      rgba[targetIndex + 2] = lut.data[sourceIndex + 2];
      rgba[targetIndex + 3] = 1;
      targetIndex += 4;
    }

    const { gl } = this;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTexture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.RGBA32F,
      lut.size,
      lut.size,
      lut.size,
      0,
      gl.RGBA,
      gl.FLOAT,
      rgba,
    );
    gl.uniform1i(this.uniforms.lutSize, lut.size);
    return true;
  }

  bindPresentationTarget() {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.presentationFramebuffer);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  render(edit, seed, showOriginal = false) {
    if (!this.hasSource) return;
    const startedAt = performance.now();
    const { gl } = this;
    this.bindPresentationTarget();

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vertexArray);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sourceTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, this.lutTexture);

    const hasLut = this.setFilter(edit.filter ?? null);
    gl.uniform1i(this.uniforms.hasLut, hasLut ? 1 : 0);
    gl.uniform1i(this.uniforms.showOriginal, showOriginal ? 1 : 0);
    gl.uniform1f(this.uniforms.strength, edit.strength ?? 100);
    const amount = edit.grain ?? 0;
    const grain = getGrainParameters(amount, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uniforms.light, (edit.brightness ?? 0) / 100);
    gl.uniform1f(this.uniforms.color, (edit.color ?? 0) / 100);
    gl.uniform1f(this.uniforms.grain, amount / 100);
    gl.uniform1f(this.uniforms.footprint, grain.footprint);
    gl.uniform1ui(this.uniforms.seed, seed >>> 0);
    gl.uniform1f(this.uniforms.height, this.canvas.height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (showOriginal || !grain.active) return;
    const duration = performance.now() - startedAt;
    this.grainSliderUpdateDuration = duration;
    if (!this.grainHasActivated) {
      this.grainHasActivated = true;
      this.grainFirstActivationDuration = duration;
    }
  }

  prewarmGrain() {
    // The fused shader is linked at renderer creation and needs no grain texture.
    return this.hasSource;
  }

  getGrainDiagnostics() {
    return {
      state: "procedural / no grain texture",
      prewarm: null,
      firstActivation: this.grainFirstActivationDuration,
      sliderUpdate: this.grainSliderUpdateDuration,
    };
  }

  destroy() {
    const { gl } = this;
    gl.deleteTexture(this.sourceTexture);
    gl.deleteTexture(this.lutTexture);
    gl.deleteBuffer(this.positionBuffer);
    gl.deleteVertexArray(this.vertexArray);
    gl.deleteProgram(this.program);
  }
}

function flipRowsInPlace(pixels, width, height) {
  const rowLength = width * 4;
  const temporary = new Uint8Array(rowLength);
  for (let top = 0, bottom = height - 1; top < bottom; top += 1, bottom -= 1) {
    const topOffset = top * rowLength;
    const bottomOffset = bottom * rowLength;
    temporary.set(pixels.subarray(topOffset, topOffset + rowLength));
    pixels.copyWithin(topOffset, bottomOffset, bottomOffset + rowLength);
    pixels.set(temporary, bottomOffset);
  }
}

async function waitForGpu(gl, isContextLost = () => gl.isContextLost()) {
  const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
  if (!sync) {
    const startedAt = performance.now();
    gl.finish();
    return performance.now() - startedAt;
  }

  const startedAt = performance.now();
  gl.flush();
  try {
    while (true) {
      if (isContextLost()) throw new Error("WebGL context lost");
      const status = gl.clientWaitSync(sync, 0, 0);
      if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
        return performance.now() - startedAt;
      }
      if (status === gl.WAIT_FAILED) throw new Error("GPU export synchronization failed");
      if (performance.now() - startedAt > 30000) {
        throw new Error("GPU export synchronization timed out");
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    gl.deleteSync(sync);
  }
}

class GpuFullResolutionRenderer extends GpuPreviewRenderer {
  constructor(canvas) {
    super(canvas, { premultipliedAlpha: false });
    const { gl } = this;
    this.framebuffer = gl.createFramebuffer();
    this.renderTargetTexture = gl.createTexture();
    this.contextLost = false;
    this.handleContextLost = (event) => {
      event.preventDefault?.();
      this.contextLost = true;
    };
    canvas.addEventListener?.("webglcontextlost", this.handleContextLost, false);
    if (!this.framebuffer || !this.renderTargetTexture) {
      throw new Error("Unable to allocate GPU export render target");
    }
  }

  assertNoError(stage) {
    if (this.contextLost || this.gl.isContextLost()) throw new Error("WebGL context lost");
    const error = this.gl.getError();
    if (error === this.gl.OUT_OF_MEMORY) throw new Error(`${stage}: WebGL out of memory`);
    if (error !== this.gl.NO_ERROR) throw new Error(`${stage}: WebGL error 0x${error.toString(16)}`);
  }

  capabilities(width, height) {
    const { gl } = this;
    const maxViewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    const limits = {
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
      maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
      maxViewportWidth: maxViewport[0],
      maxViewportHeight: maxViewport[1],
    };
    return {
      ...limits,
      fullSizeRenderPossible: width <= limits.maxTextureSize
        && height <= limits.maxTextureSize
        && width <= limits.maxRenderbufferSize
        && height <= limits.maxRenderbufferSize
        && width <= limits.maxViewportWidth
        && height <= limits.maxViewportHeight,
    };
  }

  verifyFilters(filters) {
    this.gl.useProgram(this.program);
    return filters.map((filter) => {
      const available = this.setFilter(filter);
      this.assertNoError(`LUT ${filter}`);
      return { filter, available };
    });
  }

  createRenderTarget(width, height) {
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.renderTargetTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    this.assertNoError("Render target allocation");

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.renderTargetTexture,
      0,
    );
    this.assertNoError("Framebuffer attachment");
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Framebuffer incomplete: 0x${status.toString(16)}`);
    }
    this.presentationFramebuffer = this.framebuffer;
  }

  async renderPixels(source, edit, seed) {
    const totalStartedAt = performance.now();

    const uploadStartedAt = performance.now();
    this.setSource(source);
    this.assertNoError("Source upload");
    const upload = performance.now() - uploadStartedAt;

    const lutStartedAt = performance.now();
    const hasLut = this.setFilter(edit.filter ?? null);
    this.assertNoError("LUT preparation");
    const lut = performance.now() - lutStartedAt;
    if (edit.filter && !hasLut) throw new Error(`GPU export LUT is unavailable: ${edit.filter}`);

    this.createRenderTarget(source.width, source.height);
    this.gl.viewport(0, 0, source.width, source.height);

    const submissionStartedAt = performance.now();
    this.render(edit, seed, false);
    this.assertNoError("Draw submission");
    const submission = performance.now() - submissionStartedAt;
    const completion = await waitForGpu(
      this.gl,
      () => this.contextLost || this.gl.isContextLost(),
    );

    const readPixelsStartedAt = performance.now();
    const bytes = new Uint8ClampedArray(source.width * source.height * 4);
    this.gl.readPixels(
      0,
      0,
      source.width,
      source.height,
      this.gl.RGBA,
      this.gl.UNSIGNED_BYTE,
      bytes,
    );
    this.assertNoError("Pixel readback");
    const readPixels = performance.now() - readPixelsStartedAt;

    const rowFlipStartedAt = performance.now();
    flipRowsInPlace(bytes, source.width, source.height);
    const rowFlip = performance.now() - rowFlipStartedAt;

    return {
      pixels: bytes,
      timings: {
        upload,
        lut,
        submission,
        completion,
        processing: submission + completion,
        readPixels,
        rowFlip,
        readback: readPixels + rowFlip,
        totalPixelsReady: performance.now() - totalStartedAt,
      },
    };
  }

  destroy() {
    const { gl } = this;
    this.canvas.removeEventListener?.("webglcontextlost", this.handleContextLost, false);
    if (!gl.isContextLost()) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(this.framebuffer);
      gl.deleteTexture(this.renderTargetTexture);
    }
    super.destroy();
    this.canvas.width = 1;
    this.canvas.height = 1;
  }
}

export function createGpuPreviewRenderer(canvas, options = {}) {
  const onError = typeof options.onError === "function" ? options.onError : null;
  try {
    const probe = document.createElement("canvas");
    const probeRenderer = new GpuPreviewRenderer(probe);
    probeRenderer.destroy();
  } catch (error) {
    onError?.({ stage: "probe", error });
    return null;
  }

  try {
    return new GpuPreviewRenderer(canvas);
  } catch (error) {
    onError?.({ stage: "renderer", error });
    return null;
  }
}

export function createGpuExportBenchmarkRenderer(options = {}) {
  const onError = typeof options.onError === "function" ? options.onError : null;
  try {
    const canvas = document.createElement("canvas");
    return new GpuFullResolutionRenderer(canvas);
  } catch (error) {
    onError?.(error);
    return null;
  }
}

export function createGpuFullResolutionRenderer(options = {}) {
  return createGpuExportBenchmarkRenderer(options);
}

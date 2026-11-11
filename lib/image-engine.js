import { grainPort, lightPort } from "./openlight-port.js";
import { colorPort } from "./lightcraft-color.js";
import { grainFieldAt, grainFootprint } from "./film-grain-port.js";

const FILTER_LUTS = new Map();

const SRGB_TO_LINEAR = Array.from({ length: 256 }, (_, value) => {
  const channel = value / 255;
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
});

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function linearToSrgb(value) {
  const channel = clamp01(value);
  return channel <= 0.0031308
    ? channel * 12.92
    : 1.055 * channel ** (1 / 2.4) - 0.055;
}

function lutIndex(size, r, g, b) {
  return ((b * size + g) * size + r) * 3;
}

function applyLut(lut, size, r, g, b) {
  const scale = size - 1;
  const scaledR = clamp01(r) * scale;
  const scaledG = clamp01(g) * scale;
  const scaledB = clamp01(b) * scale;
  const r0 = Math.floor(scaledR);
  const g0 = Math.floor(scaledG);
  const b0 = Math.floor(scaledB);
  const r1 = Math.min(r0 + 1, scale);
  const g1 = Math.min(g0 + 1, scale);
  const b1 = Math.min(b0 + 1, scale);
  const tr = scaledR - r0;
  const tg = scaledG - g0;
  const tb = scaledB - b0;
  const output = [0, 0, 0];

  const i000 = lutIndex(size, r0, g0, b0);
  const i100 = lutIndex(size, r1, g0, b0);
  const i010 = lutIndex(size, r0, g1, b0);
  const i110 = lutIndex(size, r1, g1, b0);
  const i001 = lutIndex(size, r0, g0, b1);
  const i101 = lutIndex(size, r1, g0, b1);
  const i011 = lutIndex(size, r0, g1, b1);
  const i111 = lutIndex(size, r1, g1, b1);

  for (let channel = 0; channel < 3; channel += 1) {
    const c00 = lut[i000 + channel]
      + (lut[i100 + channel] - lut[i000 + channel]) * tr;
    const c10 = lut[i010 + channel]
      + (lut[i110 + channel] - lut[i010 + channel]) * tr;
    const c01 = lut[i001 + channel]
      + (lut[i101 + channel] - lut[i001 + channel]) * tr;
    const c11 = lut[i011 + channel]
      + (lut[i111 + channel] - lut[i011 + channel]) * tr;
    const c0 = c00 + (c10 - c00) * tg;
    const c1 = c01 + (c11 - c01) * tg;
    output[channel] = clamp01(c0 + (c1 - c0) * tb);
  }

  return output;
}

export function getFilterLut(filter) {
  return FILTER_LUTS.get(filter) ?? null;
}

export function registerFilterLut(filter, data, size) {
  if (!filter || !(data instanceof Float32Array) || !Number.isInteger(size) || size < 2) {
    throw new TypeError("Invalid filter LUT registration");
  }
  if (data.length !== size ** 3 * 3) {
    throw new RangeError(`Invalid LUT data length for ${filter}`);
  }
  const current = FILTER_LUTS.get(filter);
  if (current && (current.data !== data || current.size !== size)) {
    throw new Error(`Conflicting LUT registration for ${filter}`);
  }
  const entry = current ?? Object.freeze({ data, size });
  FILTER_LUTS.set(filter, entry);
  return entry;
}

function applyPresetSrgb(r, g, b, filter) {
  const lut = getFilterLut(filter);
  if (!lut) throw new Error(`Filter LUT not loaded: ${filter}`);
  return applyLut(lut.data, lut.size, r, g, b);
}

export function getGrainParameters(grain, width, height) {
  return {
    engine: "glsl-film-grain",
    active: grain > 0,
    footprint: grainFootprint(width, height),
  };
}

export function hashSeed(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function createNeutralEdit() {
  return { filter: null, strength: 100, brightness: 0, color: 0, grain: 0 };
}

export function processPixels(source, edit, seed = 1) {
  const filter = edit.filter ?? null;
  const strength = Math.max(0, Math.min(100, edit.strength ?? 100));
  const brightness = Math.max(-100, Math.min(100, edit.brightness ?? 0));
  const color = Math.max(-100, Math.min(100, edit.color ?? 0));
  const grain = Math.max(0, Math.min(100, edit.grain ?? 0));
  const neutral = (!filter || strength === 0) && brightness === 0 && color === 0 && grain === 0;
  if (neutral) return new Uint8ClampedArray(source.data);

  const output = new Uint8ClampedArray(source.data.length);
  const presetMix = filter ? strength / 100 : 0;
  const width = source.width;
  const height = source.height;
  const grainParameters = getGrainParameters(grain, width, height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const originalR = source.data[offset] / 255;
      const originalG = source.data[offset + 1] / 255;
      const originalB = source.data[offset + 2] / 255;
      let r = SRGB_TO_LINEAR[source.data[offset]];
      let g = SRGB_TO_LINEAR[source.data[offset + 1]];
      let b = SRGB_TO_LINEAR[source.data[offset + 2]];

      if (presetMix > 0) {
        const preset = applyPresetSrgb(originalR, originalG, originalB, filter);
        const presetR = preset[0] <= 0.04045 ? preset[0] / 12.92 : ((preset[0] + 0.055) / 1.055) ** 2.4;
        const presetG = preset[1] <= 0.04045 ? preset[1] / 12.92 : ((preset[1] + 0.055) / 1.055) ** 2.4;
        const presetB = preset[2] <= 0.04045 ? preset[2] / 12.92 : ((preset[2] + 0.055) / 1.055) ** 2.4;
        r += (presetR - r) * presetMix;
        g += (presetG - g) * presetMix;
        b += (presetB - b) * presetMix;
      }

      if (brightness !== 0) [r, g, b] = lightPort(r, g, b, brightness / 100);
      if (color !== 0) [r, g, b] = colorPort(r, g, b, color / 100);
      if (grainParameters.active) {
        const field = grainFieldAt(x, y, grainParameters.footprint, seed, width, height);
        [r, g, b] = grainPort(r, g, b, grain / 100, field);
      }
      output[offset] = Math.round(linearToSrgb(r) * 255);
      output[offset + 1] = Math.round(linearToSrgb(g) * 255);
      output[offset + 2] = Math.round(linearToSrgb(b) * 255);
      output[offset + 3] = source.data[offset + 3];
    }
  }

  return output;
}

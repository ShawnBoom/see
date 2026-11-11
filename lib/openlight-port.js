import { LIGHTCRAFT_GLSL } from "./lightcraft-color.js";
import { FILM_GRAIN_GLSL } from "./film-grain-port.js";

// Ports of OpenLight (MIT) and @vgpu/wgsl-std (MIT).
// Exact upstream locations and license notices are in ENGINE_EVALUATION.
const WEIGHTS = [0.2126, 0.7152, 0.0722];

function smoothstep(lo, hi, x) {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}
function luminance(r, g, b) {
  return r * WEIGHTS[0] + g * WEIGHTS[1] + b * WEIGHTS[2];
}
function toSrgb(x) {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
}
function toLinear(x) {
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}
export function lightPort(r, g, b, amount) {
  if (amount === 0) return [r, g, b];
  if (amount < 0) {
    const gain = 2 ** (1.5 * amount);
    return [r * gain, g * gain, b * gain];
  }
  const light = Math.min(1, Math.max(0, luminance(r, g, b)));
  const stops = smoothstep(0, 0.175, toSrgb(light)) * (0.38 + 2.42 * light * light);
  const gain = 2 ** stops;
  const peak = Math.min(1, Math.max(r, g, b));
  const ratio = peak < 0.0001 ? gain : (1 - (1 - peak) ** gain) / peak;
  const scale = 1 + (ratio - 1) * amount;
  return [r * scale, g * scale, b * scale];
}
export function grainPort(r, g, b, amount, field) {
  const light = luminance(r, g, b);
  if (light <= 0 || light >= 1) return [r, g, b];
  const tone = toSrgb(light);
  const strength = amount * 0.08 * Math.sqrt(4 * tone * (1 - tone));
  const grained = Math.max(tone + strength * field, 0);
  const scale = Math.min(toLinear(grained) / light, 1 / Math.max(r, g, b));
  return [r * scale, g * scale, b * scale];
}

export const OPENLIGHT_GLSL = `
uniform float uLightAmount;
uniform float uColorAmount;
uniform float uGrainAmount;
uniform float uGrainFootprint;
uniform uint uGrainSeed;
uniform float uOutputHeight;

float photoLuminance(vec3 rgb) {
  return dot(rgb, vec3(0.2126, 0.7152, 0.0722));
}
vec3 lightPort(vec3 rgb) {
  if (uLightAmount == 0.0) return rgb;
  if (uLightAmount < 0.0) return rgb * exp2(1.5 * uLightAmount);
  float light = clamp(photoLuminance(rgb), 0.0, 1.0);
  float tone = linearToSrgb(vec3(light)).r;
  float gain = exp2(smoothstep(0.0, 0.175, tone) * (0.38 + 2.42 * light * light));
  float peak = min(1.0, max(rgb.r, max(rgb.g, rgb.b)));
  float ratio = peak < 0.0001 ? gain : (1.0 - pow(1.0 - peak, gain)) / peak;
  return rgb * mix(1.0, ratio, uLightAmount);
}
${LIGHTCRAFT_GLSL}
${FILM_GRAIN_GLSL}
vec3 grainPort(vec3 rgb) {
  if (uGrainAmount == 0.0) return rgb;
  float light = photoLuminance(rgb);
  if (light <= 0.0 || light >= 1.0) return rgb;
  float tone = linearToSrgb(vec3(light)).r;
  float strength = uGrainAmount * 0.08 * sqrt(4.0 * tone * (1.0 - tone));
  vec2 center = vec2(gl_FragCoord.x, uOutputHeight - gl_FragCoord.y) * uGrainFootprint;
  vec2 resolution = vec2(textureSize(uSource,0))*uGrainFootprint;
  float field = sampleFilmField(center,resolution);
  float grained = max(tone + strength * field, 0.0);
  float scale = min(srgbToLinear(vec3(grained)).r / light, 1.0 / max(rgb.r, max(rgb.g, rgb.b)));
  return rgb * scale;
}
`;

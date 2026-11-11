// LightCraft (MIT). See ENGINE_EVALUATION/LICENSE-LightCraft.txt.
// Compose linear sRGB → Rec.2020 → XYZ → LMS into one matrix.
const TO_LMS = [[0.4121764592172327,0.5362739742937673,0.0514403723146077],[0.21190919961508367,0.6807178710130037,0.10739984391238905],[0.08834481407142164,0.281853963111285,0.6302808687803242]];
const TO_LAB = [[.2104542553,.793617785,-.0040720468],[1.9779984951,-2.428592205,.4505937099],[.0259040371,.7827717662,-.808675766]];
function invert(m) {
  const [a,b,c] = m;
  const cross = (x,y) => [x[1]*y[2]-x[2]*y[1], x[2]*y[0]-x[0]*y[2], x[0]*y[1]-x[1]*y[0]];
  const columns = [cross(b,c),cross(c,a),cross(a,b)];
  const determinant = a.reduce((sum,value,i) => sum+value*columns[0][i],0);
  return a.map((_,i) => columns.map(col => col[i]/determinant));
}
const FROM_LMS = invert(TO_LMS);
const FROM_LAB = invert(TO_LAB);
const mul = (m, v) => m.map(([a,b,c]) => a*v[0]+b*v[1]+c*v[2]);
const toLab = rgb => mul(TO_LAB, mul(TO_LMS,rgb).map(Math.cbrt));
const skinLab = toLab([1,((25/60+.055)/1.055)**2.4,0]);
const skinHue = Math.atan2(skinLab[2], skinLab[1]);
const LUMA = [.2126,.7152,.0722];

export function colorPort(r,g,b,amount) {
  if (amount === 0) return [r,g,b];
  const [l,a,c] = toLab([r,g,b]);
  let factor = 1 + amount;
  if (amount > 0) {
    const low = 1 - Math.min(1, Math.sqrt(a*a+c*c)/.22);
    let delta = Math.atan2(c,a) - skinHue;
    delta -= Math.floor((delta+Math.PI)/(2*Math.PI))*2*Math.PI;
    const skin = 1 - .6 * Math.exp(-((delta/.35)**2));
    factor = 1 + amount * low * low * skin * 1.2;
  }
  const rgb = mul(FROM_LMS,mul(FROM_LAB,[l,a*factor,c*factor]).map(v => v*v*v));
  const y = Math.min(1, Math.max(0,LUMA.reduce((sum,w,i)=>sum+w*rgb[i],0)));
  let t=1;
  for (const v of rgb) {
    if (v<0) t=Math.min(t,y/Math.max(y-v,1e-9));
    else if (v>1) t=Math.min(t,(1-y)/Math.max(v-y,1e-9));
  }
  return t<1 ? rgb.map(v=>y+(v-y)*t) : rgb;
}
const matrix = m => 'mat3('+m.flatMap((_,i)=>m.map(row=>row[i].toFixed(11))).join(',')+')';
export const LIGHTCRAFT_GLSL = `
vec3 colorPort(vec3 rgb) {
  if (uColorAmount == 0.0) return rgb;
  vec3 lms = ${matrix(TO_LMS)} * rgb;
  vec3 lab = ${matrix(TO_LAB)} * (sign(lms) * pow(abs(lms),vec3(1.0/3.0)));
  float factor = 1.0 + uColorAmount;
  if (uColorAmount > 0.0) {
    float low = 1.0 - clamp(length(lab.yz)/0.22,0.0,1.0);
    float hue = lab.y == 0.0 && lab.z == 0.0 ? 0.0 : atan(lab.z,lab.y);
    float delta = mod(hue-${skinHue.toFixed(11)}+3.141592653589793,6.283185307179586)-3.141592653589793;
    float skin = 1.0 - 0.6*exp(-delta*delta/(0.35*0.35));
    factor = 1.0 + uColorAmount * low * low * skin * 1.2;
  }
  lab.yz *= factor;
  lms = ${matrix(FROM_LAB)} * lab;
  rgb = ${matrix(FROM_LMS)} * (lms*lms*lms);
  float y = clamp(dot(rgb,vec3(0.2126,0.7152,0.0722)),0.0,1.0);
  float low = min(rgb.r,min(rgb.g,rgb.b));
  float high = max(rgb.r,max(rgb.g,rgb.b));
  float t = 1.0;
  if (low < 0.0) t = min(t,y/max(y-low,1e-9));
  if (high > 1.0) t = min(t,(1.0-y)/max(high-y,1e-9));
  return t < 1.0 ? vec3(y)+(rgb-vec3(y))*t : rgb;
}
`;

// glsl-film-grain 1.0.4 and glsl-noise 0.0.0 (MIT).
// CPU scalar equivalents for the bundled upstream GLSL below.
const fract = v => v-Math.floor(v);
const mod = (v,d) => v-Math.floor(v/d)*d;
const perm = v => mod((v*34+1)*v,289);
const norm = (x,y,z) => 1.79284291400159-.85373472095314*(x*x+y*y+z*z);
const simplexGrad = [];
const perlinGrad = [];
for (let n=0;n<289;n++) {
  const index = n % 49;
  const row = Math.floor(index/7);
  const col = index % 7;
  const sx = row*4-13, sy = col*4-13;
  const sz = 14-Math.abs(sx)-Math.abs(sy);
  let x=sx/14, y=sy/14, z=sz/14;
  if (sz<=0) {
    x -= Math.floor(x)*2+1;
    y -= Math.floor(y)*2+1;
  }
  let scale=norm(x,y,z);
  simplexGrad.push([x*scale,y*scale,z*scale]);
  const px=2*(n%7), py=2*(Math.floor(n/7)%7)-7;
  const pz=7-px-Math.abs(py);
  x=px/14; y=py/14; z=pz/14;
  if (pz<=0) {
    x-=.5;
    y-=y>=0 ? .5 : -.5;
  }
  scale=norm(x,y,z);
  perlinGrad.push([x*scale,y*scale,z*scale]);
}
function contribution(ix,iy,iz,x,y,z) {
  const t=.6-x*x-y*y-z*z;
  if(t<=0)return 0;
  const g=simplexGrad[perm(perm(perm(iz)+iy)+ix)];
  return t*t*t*t*(g[0]*x+g[1]*y+g[2]*z);
}
function simplex(x,y,z) {
  const skew=(x+y+z)/3;
  let ix=Math.floor(x+skew), iy=Math.floor(y+skew), iz=Math.floor(z+skew);
  const unskew=(ix+iy+iz)/6;
  x=x-ix+unskew; y=y-iy+unskew; z=z-iz+unskew;
  ix=mod(ix,289); iy=mod(iy,289); iz=mod(iz,289);
  const a=+(x>=y),b=+(y>=z),c=+(z>=x);
  const x1=Math.min(a,1-c),y1=Math.min(b,1-a),z1=Math.min(c,1-b);
  const x2=Math.max(a,1-c),y2=Math.max(b,1-a),z2=Math.max(c,1-b);
  return 42*(contribution(ix,iy,iz,x,y,z)
    + contribution(ix+x1,iy+y1,iz+z1,x-x1+1/6,y-y1+1/6,z-z1+1/6)
    + contribution(ix+x2,iy+y2,iz+z2,x-x2+1/3,y-y2+1/3,z-z2+1/3)
    + contribution(ix+1,iy+1,iz+1,x-.5,y-.5,z-.5));
}
const fade = t => t*t*t*(t*(t*6-15)+10);
const lerp = (a,b,t) => a+(b-a)*t;
function gradient(ix,iy,x,y,z) {
  const g=perlinGrad[perm(perm(perm(ix)+iy))];
  return g[0]*x+g[1]*y+g[2]*z;
}
function periodic(x,y,z,repX,repY) {
  let ix=Math.floor(x), iy=Math.floor(y);
  x=fract(x); y=fract(y); z=fract(z);
  const ix0=mod(mod(ix,repX),289), ix1=mod(mod(mod(ix,repX)+1,repX),289);
  const iy0=mod(mod(iy,repY),289), iy1=mod(mod(mod(iy,repY)+1,repY),289);
  // Upstream rep.z is 1: both layers use the same gradient. Interpolating
  // their dot products is equivalent to subtracting fade(z) from z once.
  z-=fade(z);
  return 2.2*lerp(
    lerp(gradient(ix0,iy0,x,y,z),gradient(ix0,iy1,x,y-1,z),fade(y)),
    lerp(gradient(ix1,iy0,x-1,y,z),gradient(ix1,iy1,x-1,y-1,z),fade(y)),fade(x));
}
const SPACING = 1.20;
const QUADRATURE = .2886751345948129;
const STRENGTH = 3.2;
export function grainFootprint(width,height) {
  return Math.min(1,960/Math.max(width,height))*SPACING;
}
function filmSample(x,y,refWidth,refHeight,frame) {
  const offset=simplex(x/2.5,y/2.5,frame);
  return periodic(x,y,offset,Math.ceil(refWidth*refWidth/x),Math.ceil(refHeight*refHeight/y));
}
export function grainFieldAt(x,y,footprint,seed,width,height) {
  const cx=(x+.5)*footprint, cy=(y+.5)*footprint;
  const radius=footprint*QUADRATURE;
  const frame=(seed>>>0)%65521/4096;
  const w=width*footprint, h=height*footprint;
  return STRENGTH*.25*(filmSample(cx-radius,cy-radius,w,h,frame)
    +filmSample(cx+radius,cy-radius,w,h,frame)
    +filmSample(cx-radius,cy+radius,w,h,frame)
    +filmSample(cx+radius,cy+radius,w,h,frame));
}

export const FILM_GRAIN_GLSL = `
//
// GLSL textureless classic 3D noise "cnoise",
// with an RSL-style periodic variant "pnoise".
// Author:  Stefan Gustavson (stefan.gustavson@liu.se)
// Version: 2011-10-11
//
// Many thanks to Ian McEwan of Ashima Arts for the
// ideas for permutation and gradient selection.
//
// Copyright (c) 2011 Stefan Gustavson. All rights reserved.
// Distributed under the MIT license. See LICENSE file.
// https://github.com/ashima/webgl-noise
//

vec3 mod289(vec3 x)
{
  return vec3((ivec3(x) % 289 + 289) % 289);
}

vec4 mod289(vec4 x)
{
  return vec4((ivec4(x) % 289 + 289) % 289);
}

vec4 permute(vec4 x)
{
  return mod289(((x*34.0)+1.0)*x);
}

vec4 taylorInvSqrt(vec4 r)
{
  return 1.79284291400159 - 0.85373472095314 * r;
}

vec3 fade(vec3 t) {
  return t*t*t*(t*(t*6.0-15.0)+10.0);
}

// Classic Perlin noise, periodic variant
float pnoise(vec3 P, vec3 rep)
{
  vec3 Pi0 = mod(floor(P), rep); // Integer part, modulo period
  vec3 Pi1 = mod(Pi0 + vec3(1.0), rep); // Integer part + 1, mod period
  Pi0 = mod289(Pi0);
  Pi1 = mod289(Pi1);
  vec3 Pf0 = fract(P); // Fractional part for interpolation
  vec3 Pf1 = Pf0 - vec3(1.0); // Fractional part - 1.0
  vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x);
  vec4 iy = vec4(Pi0.yy, Pi1.yy);
  vec4 iz0 = Pi0.zzzz;
  vec4 iz1 = Pi1.zzzz;

  vec4 ixy = permute(permute(ix) + iy);
  vec4 ixy0 = permute(ixy + iz0);
  vec4 ixy1 = permute(ixy + iz1);

  ivec4 ix0 = ivec4(ixy0);
  ivec4 ix1 = ivec4(ixy1);
  vec4 gx0 = vec4(ix0 % 7) / 7.0;
  vec4 gx1 = vec4(ix1 % 7) / 7.0;
  ivec4 gyI0 = 2 * ((ix0 / 7) % 7) - 7;
  ivec4 gyI1 = 2 * ((ix1 / 7) % 7) - 7;
  vec4 gy0 = vec4(gyI0) / 14.0;
  vec4 gy1 = vec4(gyI1) / 14.0;
  vec4 gz0 = vec4(7 - 2 * (ix0 % 7) - abs(gyI0)) / 14.0;
  vec4 gz1 = vec4(7 - 2 * (ix1 % 7) - abs(gyI1)) / 14.0;
  vec4 sz0 = step(gz0, vec4(0.0));
  vec4 sz1 = step(gz1, vec4(0.0));
  gx0 -= sz0 * (step(0.0, gx0) - 0.5);
  gy0 -= sz0 * (step(0.0, gy0) - 0.5);
  gx1 -= sz1 * (step(0.0, gx1) - 0.5);
  gy1 -= sz1 * (step(0.0, gy1) - 0.5);

  vec3 g000 = vec3(gx0.x,gy0.x,gz0.x);
  vec3 g100 = vec3(gx0.y,gy0.y,gz0.y);
  vec3 g010 = vec3(gx0.z,gy0.z,gz0.z);
  vec3 g110 = vec3(gx0.w,gy0.w,gz0.w);
  vec3 g001 = vec3(gx1.x,gy1.x,gz1.x);
  vec3 g101 = vec3(gx1.y,gy1.y,gz1.y);
  vec3 g011 = vec3(gx1.z,gy1.z,gz1.z);
  vec3 g111 = vec3(gx1.w,gy1.w,gz1.w);

  vec4 norm0 = taylorInvSqrt(vec4(dot(g000, g000), dot(g010, g010), dot(g100, g100), dot(g110, g110)));
  g000 *= norm0.x;
  g010 *= norm0.y;
  g100 *= norm0.z;
  g110 *= norm0.w;
  vec4 norm1 = taylorInvSqrt(vec4(dot(g001, g001), dot(g011, g011), dot(g101, g101), dot(g111, g111)));
  g001 *= norm1.x;
  g011 *= norm1.y;
  g101 *= norm1.z;
  g111 *= norm1.w;

  float n000 = dot(g000, Pf0);
  float n100 = dot(g100, vec3(Pf1.x, Pf0.yz));
  float n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z));
  float n110 = dot(g110, vec3(Pf1.xy, Pf0.z));
  float n001 = dot(g001, vec3(Pf0.xy, Pf1.z));
  float n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z));
  float n011 = dot(g011, vec3(Pf0.x, Pf1.yz));
  float n111 = dot(g111, Pf1);

  vec3 fade_xyz = fade(Pf0);
  vec4 n_z = mix(vec4(n000, n100, n010, n110), vec4(n001, n101, n011, n111), fade_xyz.z);
  vec2 n_yz = mix(n_z.xy, n_z.zw, fade_xyz.y);
  float n_xyz = mix(n_yz.x, n_yz.y, fade_xyz.x);
  return 2.2 * n_xyz;
}
//
// Description : Array and textureless GLSL 2D/3D/4D simplex
//               noise functions.
//      Author : Ian McEwan, Ashima Arts.
//  Maintainer : ijm
//     Lastmod : 20110822 (ijm)
//     License : Copyright (C) 2011 Ashima Arts. All rights reserved.
//               Distributed under the MIT License. See LICENSE file.
//               https://github.com/ashima/webgl-noise
//

float snoise(vec3 v)
  {
  const vec2  C = vec2(1.0/6.0, 1.0/3.0) ;
  const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);

// First corner
  vec3 i  = floor(v + dot(v, C.yyy) );
  vec3 x0 =   v - i + dot(i, C.xxx) ;

// Other corners
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min( g.xyz, l.zxy );
  vec3 i2 = max( g.xyz, l.zxy );

  //   x0 = x0 - 0.0 + 0.0 * C.xxx;
  //   x1 = x0 - i1  + 1.0 * C.xxx;
  //   x2 = x0 - i2  + 2.0 * C.xxx;
  //   x3 = x0 - 1.0 + 3.0 * C.xxx;
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy; // 2.0*C.x = 1/3 = C.y
  vec3 x3 = x0 - D.yyy;      // -1.0+3.0*C.x = -0.5 = -D.y

// Permutations
  i = mod289(i);
  vec4 p = permute( permute( permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0 ))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0 ))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0 ));

// Gradients: 7x7 points over a square, mapped onto an octahedron.
// The ring size 17*17 = 289 is close to a multiple of 49 (49*6 = 294)
  ivec4 j = ivec4(p) % 49;
  ivec4 ix = 4 * (j / 7) - 13;
  ivec4 iy = 4 * (j % 7) - 13;
  vec4 x = vec4(ix) / 14.0;
  vec4 y = vec4(iy) / 14.0;
  vec4 h = vec4(14 - abs(ix) - abs(iy)) / 14.0;

  vec4 b0 = vec4( x.xy, y.xy );
  vec4 b1 = vec4( x.zw, y.zw );

  //vec4 s0 = vec4(lessThan(b0,0.0))*2.0 - 1.0;
  //vec4 s1 = vec4(lessThan(b1,0.0))*2.0 - 1.0;
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy ;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww ;

  vec3 p0 = vec3(a0.xy,h.x);
  vec3 p1 = vec3(a0.zw,h.y);
  vec3 p2 = vec3(a1.xy,h.z);
  vec3 p3 = vec3(a1.zw,h.w);

//Normalise gradients
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2, p2), dot(p3,p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;

// Mix final noise value
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot( m*m, vec4( dot(p0,x0), dot(p1,x1),
                                dot(p2,x2), dot(p3,x3) ) );
  }
float filmGrain(vec2 texCoord, vec2 resolution, float frame) {
  vec2 mult = texCoord * resolution;
  float offset = snoise(vec3(mult / 2.5, frame));
  float n1 = pnoise(vec3(mult, offset), vec3(ceil(resolution / texCoord), 1.0));
  return n1 / 2.0 + 0.5;
}
float centeredFilmGrain(vec2 position, vec2 resolution, float frame) {
  return 2.0 * (filmGrain(position / resolution, resolution, frame) - 0.5);
}
float sampleFilmField(vec2 center, vec2 resolution) {
  float frame = float(uGrainSeed % 65521u) / 4096.0;
  float d = uGrainFootprint * 0.2886751345948129;
  return 0.8 * (centeredFilmGrain(center + vec2(-d,-d), resolution, frame)
    + centeredFilmGrain(center + vec2(d,-d), resolution, frame)
    + centeredFilmGrain(center + vec2(-d,d), resolution, frame)
    + centeredFilmGrain(center + vec2(d,d), resolution, frame));
}
`;

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

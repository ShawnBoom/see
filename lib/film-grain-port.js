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

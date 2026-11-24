// GLSL sources for the ink bleed pipeline (WebGL2).
//
// Pipeline:
//   paper     → RGB paper colour + A paper "height" (0 = valley/absorbent, 1 = peak)
//   mask      → R ink coverage from the artwork, domain-warped by noise and the paper
//               gradient (ink creeps along fibres); G per-pixel absorbency
//   core blur → separable gaussian, sigma scaled per pixel by absorbency
//   halo blur → same at 1/4 resolution, for the wide feathered spread
//   composite → stochastic threshold (spray grain), paper tooth, speckles, multiply

export const VERT = /* glsl */ `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const NOISE = /* glsl */ `
uniform float uSeed;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031 + uSeed * 0.0137);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973) + uSeed * 0.0137);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = r * p * 2.03 + 17.1;
    a *= 0.5;
  }
  return s / 0.96875;
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

// ---------------------------------------------------------------------------
export const PAPER = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
${NOISE}
uniform vec2 uRes;
uniform float uUnit;        // px per 1000px-reference unit (resolution independence)
uniform int uMode;          // 0 procedural, 1 image, 2 flat
uniform vec3 uColor;
uniform float uScale;       // texture scale
uniform float uFiber;       // fibre strength
uniform float uRough;       // tooth / fine grain
uniform float uMottle;      // low-frequency cloudiness
uniform float uDust;        // dark dust specks on the sheet
uniform sampler2D uImage;
uniform vec2 uImageSize;
uniform float uContrast;
uniform float uTint;        // how much the texture image colour is kept

float fibres(vec2 p) {
  float f = 0.0;
  for (int i = 0; i < 4; i++) {
    float ang = float(i) * 1.37 + uSeed * 0.31;
    mat2 r = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
    vec2 q = r * p;
    // stretched noise → long thin fibres
    float n = vnoise(q * vec2(0.06, 1.1) + float(i) * 31.7);
    f += smoothstep(0.62, 0.95, n) * (0.5 + 0.5 * vnoise(q * 0.05));
  }
  return clamp(f, 0.0, 1.0);
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 p = px / (uUnit * uScale);
  vec3 col = uColor;
  float h = 0.5;

  if (uMode == 0) {
    float mottle = fbm(p * 0.012) - 0.5;
    float tooth = fbm(p * 0.45) - 0.5;
    float fine = hash12(floor(px)) - 0.5;
    float fib = fibres(p);
    h = 0.5 + mottle * 0.9 * uMottle + tooth * 0.9 * uRough + fine * 0.25 * uRough + fib * 0.45 * uFiber;
    h = clamp(h, 0.0, 1.0);
    col *= 0.93 + 0.12 * h;
  } else if (uMode == 1) {
    vec2 tuv = px / (uRes.x * uScale) * vec2(1.0, uImageSize.x / uImageSize.y);
    vec3 t = texture(uImage, tuv).rgb;
    float l = luma(t);
    h = clamp((l - 0.5) * uContrast + 0.5, 0.0, 1.0);
    col = mix(uColor * (0.85 + 0.25 * l), t, uTint);
  }

  // dust: sparse tiny dark specks baked in the sheet
  if (uDust > 0.0) {
    vec2 cell = floor(px / (6.0 * uUnit));
    vec2 rnd = hash22(cell + 91.0);
    float on = step(1.0 - uDust * 0.02, hash12(cell + 7.0));
    vec2 c = (cell + rnd) * 6.0 * uUnit;
    float r = (0.4 + rnd.x * 1.2) * uUnit;
    float d = smoothstep(r, r * 0.4, length(px - c)) * on;
    col *= 1.0 - d * 0.8;
  }

  outColor = vec4(col, h);
}`;

// ---------------------------------------------------------------------------
export const MASK = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
${NOISE}
uniform sampler2D uSrc;
uniform sampler2D uPaper;
uniform vec2 uRes;
uniform float uUnit;
uniform float uWarp;        // noise displacement (px @1000)
uniform float uWarpScale;   // noise feature size (px @1000)
uniform float uFiberPull;   // displacement along paper gradient
uniform float uInfluence;   // how much paper modulates absorbency
uniform float uBlotch;      // low-frequency uneven absorbency
uniform float uBlotchScale;
uniform bool uInvert;

float coverage(vec2 uv) {
  vec4 s = texture(uSrc, uv);
  float c = (1.0 - luma(s.rgb)) * s.a;
  return uInvert ? 1.0 - c : c;
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 texel = 1.0 / uRes;

  float h  = texture(uPaper, vUv).a;
  float hx = texture(uPaper, vUv + vec2(texel.x * 2.0, 0.0)).a - texture(uPaper, vUv - vec2(texel.x * 2.0, 0.0)).a;
  float hy = texture(uPaper, vUv + vec2(0.0, texel.y * 2.0)).a - texture(uPaper, vUv - vec2(0.0, texel.y * 2.0)).a;
  vec2 grad = vec2(hx, hy);

  vec2 wp = px / (uWarpScale * uUnit);
  vec2 warp = vec2(fbm(wp), fbm(wp + vec2(41.3, 17.9))) - 0.5;
  // ink is pulled downhill into the valleys of the sheet
  vec2 offset = warp * uWarp * uUnit - grad * uFiberPull * uUnit * 4.0;

  float ink = coverage(vUv + offset * texel);

  // absorbency: valleys + blotchy sizing variations soak more ink
  float blotch = fbm(px / (uBlotchScale * uUnit) + 5.0);
  float absorb = mix(1.0, 0.35 + 1.3 * (1.0 - h), uInfluence);
  absorb *= mix(1.0, 0.3 + 1.4 * blotch, uBlotch);

  outColor = vec4(ink, clamp(absorb * 0.5, 0.0, 1.0), 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------
// 4×4 box downsample (bilinear taps) for the low-res halo pass.
export const DOWN = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform vec2 uSrcTexel;
void main() {
  vec4 s = vec4(0.0);
  for (int y = 0; y < 2; y++)
  for (int x = 0; x < 2; x++) {
    vec2 o = (vec2(float(x), float(y)) * 2.0 - 1.0) * uSrcTexel;
    s += texture(uTex, vUv + o);
  }
  outColor = s * 0.25;
}`;

// ---------------------------------------------------------------------------
export const BLUR = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform sampler2D uAbsorb;  // G channel = absorbency * 0.5
uniform vec2 uDir;          // texel step along blur axis
uniform float uSigma;       // in target pixels
const int N = 24;
void main() {
  float a = texture(uAbsorb, vUv).g * 2.0;
  float s = uSigma * a;
  vec4 c0 = texture(uTex, vUv);
  if (s < 0.35) { outColor = vec4(c0.r, c0.g, 0.0, 1.0); return; }
  float sum = 0.0;
  float wsum = 0.0;
  float stepLen = max(s * 3.0 / float(N), 1.0);
  for (int i = -N; i <= N; i++) {
    float x = float(i) * stepLen;
    float w = exp(-0.5 * x * x / (s * s));
    sum += texture(uTex, vUv + uDir * x).r * w;
    wsum += w;
  }
  outColor = vec4(sum / wsum, c0.g, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------
export const COMPOSITE = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
${NOISE}
uniform sampler2D uPaper;
uniform sampler2D uMask;
uniform sampler2D uCore;
uniform sampler2D uHalo;
uniform sampler2D uSrc;
uniform vec2 uRes;
uniform float uUnit;
uniform vec3 uInk;
uniform float uDensity;
uniform float uThreshold;
uniform float uSoftness;
uniform float uHaloAmt;
uniform float uGrain;
uniform float uGrainSize;
uniform float uClump;       // clustered vs. per-pixel grain
uniform float uTooth;       // paper peaks/valleys resisting ink
uniform float uPooling;     // darker ink where it pools at edges
uniform float uSpeckle;
uniform float uSpeckleSize;
uniform float uSpeckleReach;
uniform int uView;          // 0 result, 1 input, 2 paper, 3 ink field
uniform bool uTransparent;

float speckles(vec2 px, float near) {
  float cellSize = 10.0 * uSpeckleSize * uUnit;
  vec2 cell = floor(px / cellSize);
  float acc = 0.0;
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec2 c = cell + vec2(float(x), float(y));
    vec2 r = hash22(c + 3.1);
    float p = hash12(c + 11.7);
    float on = step(p, uSpeckle * near);
    vec2 center = (c + r) * cellSize;
    float rad = (0.35 + 0.9 * r.y * r.y) * cellSize * 0.22;
    acc = max(acc, on * smoothstep(rad, rad * 0.55, length(px - center)));
  }
  return acc;
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec4 paper = texture(uPaper, vUv);
  float h = paper.a;

  if (uView == 1) {
    vec4 s = texture(uSrc, vUv);
    outColor = vec4(mix(vec3(1.0), s.rgb, s.a), 1.0);
    return;
  }
  if (uView == 2) { outColor = vec4(uTransparent ? vec3(h) : paper.rgb, 1.0); return; }

  float sharp = texture(uMask, vUv).r;
  float core = texture(uCore, vUv).r;
  float halo = texture(uHalo, vUv).r;

  float field = core + halo * uHaloAmt * (1.0 - core);

  if (uView == 3) { outColor = vec4(vec3(1.0 - field), 1.0); return; }

  // spray grain: mix of per-pixel and clumped noise
  float gs = max(uGrainSize * uUnit, 0.5);
  // fine grain: per-pixel hash blended with small-scale value noise (no square cells)
  float gPix = mix(hash12(floor(px)), vnoise(px / gs + 3.7), smoothstep(1.0, 3.0, gs));
  float gClump = fbm(px / (gs * 4.0));
  float g = mix(gPix, gClump, uClump) - 0.5;
  // grain bites hardest in the mid-tones of the bleed, interior stays solid
  float edge = 4.0 * field * (1.0 - field);
  float v = field + g * uGrain * (0.35 + edge);

  float ink = smoothstep(uThreshold - uSoftness, uThreshold + uSoftness, v);

  // paper tooth: valleys resist the ink in light passes, peaks in heavy ones
  ink *= 1.0 - uTooth * (1.0 - h) * (1.0 - 0.6 * ink);

  // pooling: ink accumulates where the sharp shape meets its bleed
  float pool = clamp(sharp - core, 0.0, 1.0) + clamp(core - halo, 0.0, 1.0) * 0.5;
  float dens = uDensity * (1.0 + uPooling * pool);

  // flying speckles near the strokes
  float near = smoothstep(0.0, uSpeckleReach, halo) * (1.0 - smoothstep(0.6, 0.95, core));
  ink = max(ink, speckles(px, near));

  float a = clamp(ink * dens, 0.0, 1.0);

  if (uTransparent) {
    outColor = vec4(uInk, a);
  } else {
    vec3 col = paper.rgb * mix(vec3(1.0), uInk, a);
    outColor = vec4(col, 1.0);
  }
}`;

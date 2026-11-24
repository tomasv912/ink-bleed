import { BLUR, COMPOSITE, DOWN, MASK, PAPER, VERT } from "./shaders";

type Uniforms = Record<string, number | boolean | number[] | WebGLTexture | null>;

interface Program {
  prog: WebGLProgram;
  locs: Map<string, WebGLUniformLocation | null>;
}

interface Target {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

export interface PaperParams {
  mode: 0 | 1 | 2;
  color: [number, number, number];
  scale: number;
  fiber: number;
  rough: number;
  mottle: number;
  dust: number;
  contrast: number;
  tint: number;
}

export interface BleedParams {
  warp: number;
  warpScale: number;
  fiberPull: number;
  influence: number;
  blotch: number;
  blotchScale: number;
  core: number;
  halo: number;
  haloAmt: number;
  threshold: number;
  softness: number;
  grain: number;
  grainSize: number;
  clump: number;
  tooth: number;
  pooling: number;
  speckle: number;
  speckleSize: number;
  speckleReach: number;
  density: number;
  ink: [number, number, number];
  invert: boolean;
}

export interface RenderParams {
  seed: number;
  view: 0 | 1 | 2 | 3;
  transparent: boolean;
  paper: PaperParams;
  bleed: BleedParams;
}

export class InkRenderer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;
  private quad: WebGLVertexArrayObject;
  private programs: Record<"paper" | "mask" | "down" | "blur" | "composite", Program>;
  private targets: Record<string, Target> = {};
  private srcTex: WebGLTexture;
  private paperImgTex: WebGLTexture;
  private paperImgSize: [number, number] = [1, 1];
  private floatFormat: { internal: number; type: number };
  private w = 0;
  private h = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      antialias: false,
    });
    if (!gl) throw new Error("WebGL2 is not available in this browser.");
    this.gl = gl;

    const half = gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float");
    gl.getExtension("OES_texture_float_linear");
    this.floatFormat = half
      ? { internal: gl.RGBA16F, type: gl.HALF_FLOAT }
      : { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };

    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.quad = vao;

    this.programs = {
      paper: this.compile(PAPER),
      mask: this.compile(MASK),
      down: this.compile(DOWN),
      blur: this.compile(BLUR),
      composite: this.compile(COMPOSITE),
    };

    this.srcTex = this.makeTex(true);
    this.paperImgTex = this.makeTex(true);
    gl.bindTexture(gl.TEXTURE_2D, this.paperImgTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
  }

  private compile(frag: string): Program {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(s) ?? "shader compile error");
      }
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, frag));
    gl.bindAttribLocation(prog, 0, "aPos");
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) ?? "program link error");
    }
    return { prog, locs: new Map() };
  }

  private makeTex(linear: boolean): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private target(name: string, w: number, h: number): Target {
    const gl = this.gl;
    const existing = this.targets[name];
    if (existing && existing.w === w && existing.h === h) return existing;
    if (existing) {
      gl.deleteFramebuffer(existing.fbo);
      gl.deleteTexture(existing.tex);
    }
    const tex = this.makeTex(true);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.floatFormat.internal, w, h, 0, gl.RGBA, this.floatFormat.type, null);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const t = { fbo, tex, w, h };
    this.targets[name] = t;
    return t;
  }

  setSize(w: number, h: number) {
    this.w = w;
    this.h = h;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  setSource(src: TexImageSource) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  setPaperImage(img: HTMLImageElement | null) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.paperImgTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    if (img) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      this.paperImgSize = [img.naturalWidth, img.naturalHeight];
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
      this.paperImgSize = [1, 1];
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  private run(p: Program, out: Target | null, uniforms: Uniforms) {
    const gl = this.gl;
    gl.useProgram(p.prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fbo : null);
    gl.viewport(0, 0, out ? out.w : this.w, out ? out.h : this.h);
    let unit = 0;
    for (const [name, value] of Object.entries(uniforms)) {
      let loc = p.locs.get(name);
      if (loc === undefined) {
        loc = gl.getUniformLocation(p.prog, name);
        p.locs.set(name, loc);
      }
      if (loc === null) continue;
      if (typeof value === "number") gl.uniform1f(loc, value);
      else if (typeof value === "boolean") gl.uniform1i(loc, value ? 1 : 0);
      else if (Array.isArray(value)) {
        if (value.length === 2) gl.uniform2fv(loc, value);
        else if (value.length === 3) gl.uniform3fv(loc, value);
        else gl.uniform4fv(loc, value);
      } else {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, value);
        gl.uniform1i(loc, unit);
        unit++;
      }
    }
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private setInt(p: Program, name: string, v: number) {
    const gl = this.gl;
    gl.useProgram(p.prog);
    gl.uniform1i(gl.getUniformLocation(p.prog, name), v);
  }

  render(params: RenderParams) {
    const { w, h } = this;
    if (!w || !h) return;
    const P = this.programs;
    const unit = Math.max(w, h) / 1000;
    const res = [w, h];
    const pp = params.paper;
    const b = params.bleed;
    const seed = params.seed;

    // 1. paper
    const paper = this.target("paper", w, h);
    this.setInt(P.paper, "uMode", pp.mode);
    this.run(P.paper, paper, {
      uSeed: seed,
      uRes: res,
      uUnit: unit,
      uColor: pp.color,
      uScale: pp.scale,
      uFiber: pp.fiber,
      uRough: pp.rough,
      uMottle: pp.mottle,
      uDust: pp.dust,
      uImage: this.paperImgTex,
      uImageSize: this.paperImgSize,
      uContrast: pp.contrast,
      uTint: pp.tint,
    });

    // 2. warped mask + absorbency
    const mask = this.target("mask", w, h);
    this.run(P.mask, mask, {
      uSeed: seed,
      uSrc: this.srcTex,
      uPaper: paper.tex,
      uRes: res,
      uUnit: unit,
      uWarp: b.warp,
      uWarpScale: b.warpScale,
      uFiberPull: b.fiberPull,
      uInfluence: b.influence,
      uBlotch: b.blotch,
      uBlotchScale: b.blotchScale,
      uInvert: b.invert,
    });

    // 3. core blur at full res
    const tmp = this.target("tmp", w, h);
    const core = this.target("core", w, h);
    const coreSigma = b.core * unit;
    this.run(P.blur, tmp, { uTex: mask.tex, uAbsorb: mask.tex, uDir: [1 / w, 0], uSigma: coreSigma });
    this.run(P.blur, core, { uTex: tmp.tex, uAbsorb: mask.tex, uDir: [0, 1 / h], uSigma: coreSigma });

    // 4. halo blur at 1/4 res
    const qw = Math.max(1, Math.ceil(w / 4));
    const qh = Math.max(1, Math.ceil(h / 4));
    const half = this.target("half", Math.ceil(w / 2), Math.ceil(h / 2));
    const quarter = this.target("quarter", qw, qh);
    const qtmp = this.target("qtmp", qw, qh);
    const halo = this.target("halo", qw, qh);
    this.run(P.down, half, { uTex: mask.tex, uSrcTexel: [0.5 / w, 0.5 / h] });
    this.run(P.down, quarter, { uTex: half.tex, uSrcTexel: [0.5 / half.w, 0.5 / half.h] });
    const haloSigma = (b.halo * unit) / 4;
    this.run(P.blur, qtmp, { uTex: quarter.tex, uAbsorb: quarter.tex, uDir: [1 / qw, 0], uSigma: haloSigma });
    this.run(P.blur, halo, { uTex: qtmp.tex, uAbsorb: quarter.tex, uDir: [0, 1 / qh], uSigma: haloSigma });

    // 5. composite to screen
    this.setInt(P.composite, "uView", params.view);
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.run(P.composite, null, {
      uSeed: seed,
      uPaper: paper.tex,
      uMask: mask.tex,
      uCore: core.tex,
      uHalo: halo.tex,
      uSrc: this.srcTex,
      uRes: res,
      uUnit: unit,
      uInk: b.ink,
      uDensity: b.density,
      uThreshold: b.threshold,
      uSoftness: b.softness,
      uHaloAmt: b.haloAmt,
      uGrain: b.grain,
      uGrainSize: b.grainSize,
      uClump: b.clump,
      uTooth: b.tooth,
      uPooling: b.pooling,
      uSpeckle: b.speckle,
      uSpeckleSize: b.speckleSize,
      uSpeckleReach: b.speckleReach,
      uTransparent: params.transparent,
    });
  }
}

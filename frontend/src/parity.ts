// Parity section: the same three frame-time tests in every webview.
// Table exercises layout, particles the 2D rasterizer, raster the GPU path.
import { mulberry32, rows } from "./payload";
import { nextFrame, summarize, type Summary } from "./stats";

export interface FrameResult {
  test: "table" | "particles" | "raster";
  warmupFrames: number;
  frames: number;
  refreshHz: number;
  refreshIntervalMs: number;
  jankFrames: number;
  jankPct: number;
  samplesMs: number[];
  summary: Summary;
}

export interface ParityParams { warmupFrames: number; frames: number }

const W = 1280, H = 720;

export async function detectRefreshHz(): Promise<number> {
  const ts: number[] = [];
  let t = await nextFrame();
  for (let i = 0; i < 60; i++) { const n = await nextFrame(); ts.push(n - t); t = n; }
  ts.sort((a, b) => a - b);
  const median = ts[Math.floor(ts.length / 2)];
  return Math.round(1000 / median);
}

async function measure(test: FrameResult["test"], p: ParityParams, refreshHz: number, step: (frame: number) => void): Promise<FrameResult> {
  const interval = 1000 / refreshHz;
  const samples: number[] = [];
  let prev = await nextFrame();
  for (let i = 0; i < p.warmupFrames + p.frames; i++) {
    step(i);
    const t = await nextFrame();
    if (i >= p.warmupFrames) samples.push(t - prev);
    prev = t;
  }
  const jank = samples.filter((s) => s > interval * 1.5).length;
  return { test, warmupFrames: p.warmupFrames, frames: p.frames, refreshHz, refreshIntervalMs: interval, jankFrames: jank, jankPct: (100 * jank) / samples.length, samplesMs: samples, summary: summarize(samples) };
}

export function mountTable(stage: HTMLElement): { step: (f: number) => void; unmount: () => void } {
  const ROWS = 100_000, ROW_H = 24;
  const data = rows(7, ROWS);
  const el = document.createElement("div");
  el.id = "table";
  const spacer = document.createElement("div");
  spacer.className = "spacer";
  spacer.style.height = `${ROWS * ROW_H}px`;
  el.appendChild(spacer);
  stage.appendChild(el);
  const visible = Math.ceil(H / ROW_H) + 2;
  const nodes: HTMLDivElement[] = [];
  for (let i = 0; i < visible; i++) {
    const r = document.createElement("div");
    r.className = "row";
    for (let c = 0; c < 6; c++) r.appendChild(document.createElement("span"));
    spacer.appendChild(r);
    nodes.push(r);
  }
  const render = (scrollTop: number) => {
    const first = Math.floor(scrollTop / ROW_H);
    for (let i = 0; i < visible; i++) {
      const idx = first + i;
      const node = nodes[i];
      node.style.transform = `translateY(${idx * ROW_H}px)`;
      const d = data[idx % ROWS];
      const cells = node.children;
      (cells[0] as HTMLElement).textContent = String(d.id);
      (cells[1] as HTMLElement).textContent = d.x.toFixed(3);
      (cells[2] as HTMLElement).textContent = d.y.toFixed(3);
      (cells[3] as HTMLElement).textContent = d.z.toFixed(3);
      (cells[4] as HTMLElement).textContent = d.s;
      (cells[5] as HTMLElement).textContent = d.nested.b ? d.nested.c : String(d.nested.a);
    }
  };
  // Scroll 5 rows per frame; wraps well inside 100k rows for 600+ frames.
  return { step: (f) => { const top = (f * ROW_H * 5) % (ROWS * ROW_H - H); el.scrollTop = top; render(top); }, unmount: () => el.remove() };
}

export function mountParticles(stage: HTMLElement): { step: (f: number) => void; unmount: () => void } {
  const N = 20_000;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  stage.appendChild(c);
  const ctx = c.getContext("2d")!;
  const rand = mulberry32(11);
  const px = new Float32Array(N), py = new Float32Array(N), vx = new Float32Array(N), vy = new Float32Array(N);
  for (let i = 0; i < N; i++) { px[i] = rand() * W; py[i] = rand() * H; vx[i] = (rand() - 0.5) * 4; vy[i] = (rand() - 0.5) * 4; }
  return {
    step: () => {
      ctx.fillStyle = "rgba(17,17,17,0.35)";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#e8b04b";
      for (let i = 0; i < N; i++) {
        px[i] += vx[i]; py[i] += vy[i];
        if (px[i] < 0 || px[i] > W) vx[i] = -vx[i];
        if (py[i] < 0 || py[i] > H) vy[i] = -vy[i];
        ctx.fillRect(px[i], py[i], 2, 2);
      }
    },
    unmount: () => c.remove(),
  };
}

const VS = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p,0.,1.); }`;
const FS = `#version 300 es
precision highp float; out vec4 o; uniform float t; uniform vec2 res;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x), u.y); }
void main(){ vec2 uv = gl_FragCoord.xy / res; float v = 0.; float a = .5; vec2 q = uv*6. + t*.1;
  for(int i=0;i<8;i++){ v += a*noise(q); q = q*2.03 + vec2(1.7,9.2); a*=.5; }
  o = vec4(v*.9, v*.7, v*.4, 1.); }`;

export function mountRaster(stage: HTMLElement): { step: (f: number) => void; unmount: () => void; renderer: string } {
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  stage.appendChild(c);
  const gl = c.getContext("webgl2", { antialias: false, preserveDrawingBuffer: false })!;
  if (!gl) throw new Error("no webgl2");
  const prog = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]] as const) {
    const sh = gl.createShader(type)!; gl.shaderSource(sh, src); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader");
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog); gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uT = gl.getUniformLocation(prog, "t"), uR = gl.getUniformLocation(prog, "res");
  gl.uniform2f(uR, W, H); gl.viewport(0, 0, W, H);
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  return { step: (f) => { gl.uniform1f(uT, f); gl.drawArrays(gl.TRIANGLES, 0, 3); }, unmount: () => c.remove(), renderer };
}

export async function runParity(stage: HTMLElement, p: ParityParams, status: (s: string) => void) {
  const refreshHz = await detectRefreshHz();
  const results: FrameResult[] = [];
  let renderer = "";
  status("parity table");
  const t = mountTable(stage); results.push(await measure("table", p, refreshHz, t.step)); t.unmount();
  status("parity particles");
  const pa = mountParticles(stage); results.push(await measure("particles", p, refreshHz, pa.step)); pa.unmount();
  status("parity raster");
  const r = mountRaster(stage); renderer = r.renderer; results.push(await measure("raster", p, refreshHz, r.step)); r.unmount();
  return { refreshHz, renderer, results };
}

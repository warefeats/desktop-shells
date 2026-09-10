// IPC section: round trips across the boundary on the idiomatic and raw
// paths at four payload sizes, plus push at a fixed rate on both paths.
import type { Bridge } from "./bridge";
import { bytes, rows, rowsForBytes } from "./payload";
import { summarize, sleep, type Summary } from "./stats";

export const PAYLOAD_BYTES = [1024, 64 * 1024, 1024 * 1024, 16 * 1024 * 1024];
export const SEED = 20260910;

export interface CellResult {
  path: "idiomatic" | "raw";
  targetBytes: number;
  actualBytes: number;
  rows?: number;
  warmups: number;
  /** Round trips timed together per sample; samples are divided by it. */
  batch: number;
  samplesMs: number[];
  summary: Summary;
}

/** Smallest non-zero step performance.now() reports, in ms. WKWebView coarsens to 1 ms. */
export function timerResolutionMs(): number {
  let min = Infinity;
  for (let i = 0; i < 2000; i++) {
    const a = performance.now();
    let b = performance.now();
    while (b === a) b = performance.now();
    if (b - a < min) min = b - a;
  }
  return min;
}

/** Enough round trips per sample that one sample spans at least 50 timer ticks. */
function batchFor(oneMs: number, resolution: number): number {
  return Math.max(1, Math.min(200, Math.ceil((resolution * 50) / Math.max(oneMs, 1e-6))));
}

async function timeBatch(fn: () => Promise<void>, batch: number): Promise<number> {
  const t0 = performance.now();
  for (let i = 0; i < batch; i++) await fn();
  return (performance.now() - t0) / batch;
}

export interface PushResult {
  path: "idiomatic" | "raw";
  rate: number;
  size: number;
  requested: number;
  delivered: number;
  durationMs: number;
  deliveredPerSecond: number;
  gapsMs: Summary;
}

export interface IpcParams { warmups: number; iterations: number; pushRate: number; pushSize: number; pushSeconds: number }

export async function runIpc(b: Bridge, p: IpcParams, status: (s: string) => void) {
  const resolution = timerResolutionMs();
  const cells: CellResult[] = [];
  for (const target of PAYLOAD_BYTES) {
    // idiomatic
    const n = rowsForBytes(SEED, target);
    const payload = rows(SEED, n);
    const actual = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    status(`ipc idiomatic ${target} (${n} rows, ${actual} B)`);
    const once = async () => {
      const back = await b.rows(payload);
      if (back.length !== payload.length) throw new Error(`rows length mismatch ${back.length} vs ${payload.length}`);
    };
    const probe = await timeBatch(once, 5);
    const batch = batchFor(probe, resolution);
    const samples: number[] = [];
    for (let i = 0; i < p.warmups + p.iterations; i++) {
      const t = await timeBatch(once, batch);
      if (i >= p.warmups) samples.push(t);
    }
    cells.push({ path: "idiomatic", targetBytes: target, actualBytes: actual, rows: n, warmups: p.warmups, batch, samplesMs: samples, summary: summarize(samples) });

    // raw
    const data = bytes(SEED, target);
    status(`ipc raw ${target}`);
    const onceRaw = async () => {
      const back = await b.bytes(data);
      if (back.byteLength !== data.byteLength) throw new Error(`bytes length mismatch ${back.byteLength} vs ${data.byteLength}`);
    };
    const rprobe = await timeBatch(onceRaw, 5);
    const rbatch = batchFor(rprobe, resolution);
    const rsamples: number[] = [];
    for (let i = 0; i < p.warmups + p.iterations; i++) {
      const t = await timeBatch(onceRaw, rbatch);
      if (i >= p.warmups) rsamples.push(t);
    }
    cells.push({ path: "raw", targetBytes: target, actualBytes: target, warmups: p.warmups, batch: rbatch, samplesMs: rsamples, summary: summarize(rsamples) });
  }

  const pushes: PushResult[] = [];
  for (const path of ["idiomatic", "raw"] as const) {
    status(`push ${path}`);
    const count = p.pushRate * p.pushSeconds;
    const arrivals: number[] = [];
    let last = -1, outOfOrder = 0;
    const onSeq = (seq: number) => {
      arrivals.push(performance.now());
      if (seq < last) outOfOrder++;
      last = seq;
    };
    const t0 = performance.now();
    if (path === "idiomatic") await b.pushStart(p.pushRate, p.pushSize, count, (seq) => onSeq(seq));
    else await b.pushRawStart(p.pushRate, p.pushSize, count, onSeq);
    // Wait for the expected duration plus grace; whatever arrived counts.
    await sleep(p.pushSeconds * 1000 + 2000);
    const t1 = arrivals.length ? arrivals[arrivals.length - 1] : performance.now();
    const gaps: number[] = [];
    for (let i = 1; i < arrivals.length; i++) gaps.push(arrivals[i] - arrivals[i - 1]);
    const durationMs = t1 - t0;
    pushes.push({
      path, rate: p.pushRate, size: p.pushSize, requested: count, delivered: arrivals.length,
      durationMs, deliveredPerSecond: arrivals.length / (durationMs / 1000),
      gapsMs: gaps.length ? summarize(gaps) : summarize([NaN]),
    });
    if (outOfOrder) console.warn(`${path} push: ${outOfOrder} out-of-order events`);
  }
  return { timerResolutionMs: resolution, cells, pushes };
}

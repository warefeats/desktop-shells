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
  samplesMs: number[];
  summary: Summary;
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
  const cells: CellResult[] = [];
  for (const target of PAYLOAD_BYTES) {
    // idiomatic
    const n = rowsForBytes(SEED, target);
    const payload = rows(SEED, n);
    const actual = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    status(`ipc idiomatic ${target} (${n} rows, ${actual} B)`);
    const samples: number[] = [];
    for (let i = 0; i < p.warmups + p.iterations; i++) {
      const t0 = performance.now();
      const back = await b.rows(payload);
      const t1 = performance.now();
      if (back.length !== payload.length) throw new Error(`rows length mismatch ${back.length} vs ${payload.length}`);
      if (i >= p.warmups) samples.push(t1 - t0);
    }
    cells.push({ path: "idiomatic", targetBytes: target, actualBytes: actual, rows: n, warmups: p.warmups, samplesMs: samples, summary: summarize(samples) });

    // raw
    const data = bytes(SEED, target);
    status(`ipc raw ${target}`);
    const rsamples: number[] = [];
    for (let i = 0; i < p.warmups + p.iterations; i++) {
      const t0 = performance.now();
      const back = await b.bytes(data);
      const t1 = performance.now();
      if (back.byteLength !== data.byteLength) throw new Error(`bytes length mismatch ${back.byteLength} vs ${data.byteLength}`);
      if (i >= p.warmups) rsamples.push(t1 - t0);
    }
    cells.push({ path: "raw", targetBytes: target, actualBytes: target, warmups: p.warmups, samplesMs: rsamples, summary: summarize(rsamples) });
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
  return { cells, pushes };
}

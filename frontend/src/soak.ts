// Soak: cycle the three parity tests thirty seconds each with a 1 MB
// idiomatic round trip every five seconds. Memory is sampled by the harness
// from outside; the frontend only drives the work and reports what it did.
import type { Bridge } from "./bridge";
import { mountParticles, mountRaster, mountTable } from "./parity";
import { rows, rowsForBytes } from "./payload";
import { nextFrame } from "./stats";
import { SEED } from "./ipc";

export interface SoakParams { seconds: number; segmentSeconds: number; ipcEverySeconds: number }

export async function runSoak(b: Bridge, stage: HTMLElement, p: SoakParams, status: (s: string) => void) {
  const payload = rows(SEED, rowsForBytes(SEED, 1024 * 1024));
  const mounts = [mountTable, mountParticles, mountRaster] as const;
  const start = performance.now();
  let frames = 0, roundTrips = 0, segment = 0, lastIpc = start;
  while (performance.now() - start < p.seconds * 1000) {
    const m = mounts[segment % mounts.length](stage);
    status(`soak segment ${segment} ${["table", "particles", "raster"][segment % 3]}`);
    const segStart = performance.now();
    let f = 0;
    while (performance.now() - segStart < p.segmentSeconds * 1000 && performance.now() - start < p.seconds * 1000) {
      m.step(f++); frames++;
      await nextFrame();
      if (performance.now() - lastIpc >= p.ipcEverySeconds * 1000) {
        lastIpc = performance.now();
        await b.rows(payload); roundTrips++;
      }
    }
    m.unmount();
    segment++;
  }
  return { seconds: (performance.now() - start) / 1000, frames, roundTrips, segments: segment };
}

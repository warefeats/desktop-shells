// results.json -> runs/<date>-<rig>.json, registered in benchmark.json.
// Four sections. Section winners are ranked by the mean of the charted series,
// which is what the site's scorecard shows; the IPC headline alone follows ADR 0002.
// The section series the site charts are: IPC = idiomatic 1 MB
// round trip; Parity = main-thread step time per frame pooled over the three
// tests; Lifecycle = cold start; Size = installer bytes. The verdict rule for
// the headline is ADR 0002 and is computed here, not chosen after the fact.
// Every test says which statistic its value is and every result carries one
// sample per measured pass, so the site can recompute the value and show the
// spread; a value the site cannot recompute from the per-pass numbers is "other".
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { geomean, mean, median, quantile, round } from "./stats";

export type Id = "tauri" | "electron";

// The harness's results file (src/run.ts), the parts the importer reads. Every
// per-candidate array is in pass order: the harness appends a pass as it finishes.
export interface RawCell { path: "idiomatic" | "raw"; targetBytes: number; actualBytes: number; rows?: number; batch: number; samplesMs: number[] }
export interface RawPush { path: "idiomatic" | "raw"; requested: number; delivered: number; deliveredPerSecond: number; gapsMs: { p99: number } }
export interface RawIpcPass { timerResolutionMs: number; cells: RawCell[]; pushes: RawPush[] }
export interface RawFrame { test: string; refreshHz: number; jankPct: number; samplesMs: number[]; summary: { p50: number; p99: number }; stepMs: { p50: number; p99: number; mean: number } }
export interface RawParityPass { refreshHz: number; renderer: string; results: RawFrame[] }
export interface RawStart { spawnToFirstFrameMs: number; hostToFirstFrameMs: number }
export interface RawSoak { samples: Array<{ tMs: number; bytes: number }> }
export interface RawProtocol {
  coldStarts: number; warmStarts: number; ipcPasses: number; ipcWarmups: number; ipcIterations: number; pushRate: number; pushSize: number; pushSeconds: number;
  parityPasses: number; parityWarmupFrames: number; parityFrames: number; soaks: number; soakSeconds: number; soakIpcEverySeconds: number;
  attributionRule: string; purge: "ok" | "unavailable"; launcher: string;
}
export interface Raw {
  startedAt: string; finishedAt?: string; smoke: boolean;
  rig: Record<string, unknown>;
  protocol: RawProtocol;
  candidates: Array<{ id: string; version: string; homepage: string; color: string; webview?: string }>;
  gate: { ok: boolean };
  cold: Record<Id, RawStart[]>; warm: Record<Id, RawStart[]>;
  ipc: Record<Id, RawIpcPass[]>; parity: Record<Id, RawParityPass[]>; soak: Record<Id, RawSoak[]>;
  size: Record<Id, { installerBytes: number; installedBytes: number }>;
}

/** How a test's `value` summarizes each candidate's samples. "other": a value the site cannot recompute from the per-pass numbers (a median pooled over every batch sample of every pass, a percentile of the per-pass numbers, a ratio); the test's description says what it is. */
export type TestStatistic = "mean" | "median" | "min" | "max" | "other";
/** `samples`: one measurement per measured pass, in the test's unit, in pass order. */
export interface TestResult { candidateId: string; value: number; samples?: number[] }
export interface BenchmarkTest { id: string; title: string; description: string; unit: string; lowerIsBetter: boolean; results: TestResult[]; statistic?: TestStatistic }
export interface Metric { value: number; unit: string; label: string }
export type Candidate = ReturnType<typeof cand>;
export interface Section { id: string; title: string; deck: string; unit: string; lowerIsBetter: boolean; verdict: { winnerId: Id; headline: string; summary: string }; candidates: Candidate[]; tests: BenchmarkTest[] }
/** The part of a run file the samples contract touches. */
export interface RunTests { sections: Array<{ id: string; tests: Array<{ id: string; statistic?: TestStatistic; results: TestResult[] }> }> }
export interface Run extends RunTests {
  schemaVersion: 1; id: string; label: string; publishedAt: string;
  environment: Record<string, unknown>;
  protocol: { warmups: number; runs: number; processModel: string; cacheState: string; output: string };
  candidates: never[];
  sections: Section[];
}

const ids: Id[] = ["tauri", "electron"];
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { medianMs: round(quantile(s, 0.5)), meanMs: round(mean(s)), minMs: round(s[0]), maxMs: round(s[s.length - 1]) };
};
const candidate = (r: Raw, id: Id) => {
  const c = r.candidates.find((x) => x.id === id);
  if (!c) throw new Error(`no ${id} candidate in the results`);
  return c;
};
const cand = (r: Raw, id: Id, samples: number[], metrics: Record<string, Metric>) => {
  const c = candidate(r, id);
  return { id, name: id === "tauri" ? "Tauri" : "Electron", version: c.version, color: c.color, homepage: c.homepage, statistics: stats(samples), samplesMs: samples.map((x) => round(x)), metrics };
};
const MB = (b: number) => round(b / 2 ** 20, 1);
const lower = (vals: Record<Id, number>) => (vals.tauri <= vals.electron ? "tauri" : "electron");
const name = (id: Id) => (id === "tauri" ? "Tauri" : "Electron");
const other = (id: Id): Id => (id === "tauri" ? "electron" : "tauri");
const row = (candidateId: string, value: number, samples?: number[]): TestResult => (samples ? { candidateId, value, samples } : { candidateId, value });

// Per-pass samples. A value the site recomputes (mean, median, min, max) must come back from its
// samples within half a unit of the value's last decimal, which the value's own rounding can already
// use up, so those samples are the exact per-pass numbers the value was computed from. The IPC round
// trips are "other": their value is the median pooled over every batch sample of every pass, which the
// per-pass medians cannot reproduce, so nothing recomputes them and they are rounded like the display values.

// ---------------------------------------------------------------- IPC
const ipcCells = (r: Raw, id: Id): RawCell[] => r.ipc[id].flatMap((p) => p.cells);
const cellSamples = (r: Raw, id: Id, p: RawCell["path"], bytes: number) => ipcCells(r, id).filter((c) => c.path === p && c.targetBytes === bytes).flatMap((c) => c.samplesMs);
const cellMedian = (r: Raw, id: Id, p: RawCell["path"], bytes: number) => median(cellSamples(r, id, p, bytes));
const cellPassMedians = (r: Raw, id: Id, p: RawCell["path"], bytes: number) => r.ipc[id].flatMap((pass) => pass.cells.filter((c) => c.path === p && c.targetBytes === bytes).map((c) => round(median(c.samplesMs))));
const ipcSizes = (r: Raw) => [...new Set(ipcCells(r, "tauri").map((c) => c.targetBytes))].sort((a, b) => a - b);
const pushes = (r: Raw, id: Id, p: RawPush["path"]): RawPush[] => r.ipc[id].flatMap((pass) => pass.pushes).filter((x) => x.path === p);
const pushAgg = (r: Raw, id: Id, p: RawPush["path"]) => { const ps = pushes(r, id, p); return { rate: mean(ps.map((x) => x.deliveredPerSecond)), lost: ps.reduce((a, x) => a + (x.requested - x.delivered), 0), gapP99: mean(ps.map((x) => x.gapsMs.p99)) }; };
const kb = (b: number) => (b >= 2 ** 20 ? `${b / 2 ** 20} MB` : `${b / 1024} KB`);

// ADR 0002: geometric mean over idiomatic cells of tauri/electron medians.
const ipcRatios = (r: Raw) => ipcSizes(r).map((s) => cellMedian(r, "tauri", "idiomatic", s) / cellMedian(r, "electron", "idiomatic", s));
export const ipcGeomean = (r: Raw) => geomean(ipcRatios(r));

function ipcSection(r: Raw): Section {
  const sizes = ipcSizes(r);
  const ratios = ipcRatios(r);
  const gm = geomean(ratios);
  const ipcWinner: Id = gm <= 1 ? "tauri" : "electron";
  const ipcFactor = round(gm <= 1 ? 1 / gm : gm, 2);
  return {
    id: "ipc", title: "IPC across the boundary", deck: `Round trips from the frontend to the host and back at ${sizes.map(kb).join(", ")}, on each shell's idiomatic JSON path and on its raw bytes path, plus host-to-frontend push at ${r.protocol.pushRate} events per second. The chart is the idiomatic 1 MB round trip; the headline is the geometric mean over the idiomatic sizes.`,
    unit: "ms", lowerIsBetter: true,
    verdict: {
      winnerId: ipcWinner,
      headline: `${name(ipcWinner)} moved JSON across the boundary ${ipcFactor} times faster than ${name(other(ipcWinner))} over ${sizes.map(kb).join(", ")} (geometric mean of medians)`,
      summary: `Per size, Tauri over Electron: ${sizes.map((s, i) => `${kb(s)} ${round(ratios[i], 2)}x`).join(", ")}. Raw bytes: ${sizes.map((s) => `${kb(s)} ${round(cellMedian(r, "tauri", "raw", s) / cellMedian(r, "electron", "raw", s), 2)}x`).join(", ")}.`,
    },
    candidates: ids.map((id) => cand(r, id, cellSamples(r, id, "idiomatic", 2 ** 20), Object.fromEntries([
      ...sizes.flatMap((s) => [
        [`idiomatic-${s}`, { value: round(cellMedian(r, id, "idiomatic", s)), unit: "ms", label: `Idiomatic ${kb(s)} round trip median` }],
        [`raw-${s}`, { value: round(cellMedian(r, id, "raw", s)), unit: "ms", label: `Raw ${kb(s)} round trip median` }],
      ]),
      ["push-rate", { value: round(pushAgg(r, id, "idiomatic").rate, 0), unit: "events/s", label: `Idiomatic push delivered per second (requested ${r.protocol.pushRate})` }],
      ["push-lost", { value: pushAgg(r, id, "idiomatic").lost, unit: "events", label: "Idiomatic push events lost" }],
      ["push-gap-p99", { value: round(pushAgg(r, id, "idiomatic").gapP99, 2), unit: "ms", label: "Idiomatic push inter-arrival gap p99" }],
      ["push-raw-rate", { value: round(pushAgg(r, id, "raw").rate, 0), unit: "events/s", label: `Raw push delivered per second (requested ${r.protocol.pushRate})` }],
      ["push-raw-gap-p99", { value: round(pushAgg(r, id, "raw").gapP99, 2), unit: "ms", label: "Raw push inter-arrival gap p99" }],
      ["timer-resolution", { value: round(r.ipc[id][0].timerResolutionMs, 3), unit: "ms", label: "Webview timer resolution (round trips batched to cover it)" }],
    ]))),
    tests: [
      // The value is the median over every batch sample of every pass; the samples are each pass's median of the same cell.
      ...sizes.map((s) => ({ id: `idiomatic-${s}`, title: `Idiomatic ${kb(s)}`, description: `Median round trip of a ${kb(s)} JSON payload of seeded rows, frontend to host and back, on the path each shell's docs recommend. The value is the median pooled over every batch sample of every pass.`, unit: "ms", lowerIsBetter: true, results: ids.map((id) => row(id, round(cellMedian(r, id, "idiomatic", s)), cellPassMedians(r, id, "idiomatic", s))), statistic: "other" as const })),
      ...sizes.map((s) => ({ id: `raw-${s}`, title: `Raw ${kb(s)}`, description: `Median round trip of ${kb(s)} of seeded bytes on the shell's bytes path: Tauri raw request and response, Electron Uint8Array over invoke. The value is the median pooled over every batch sample of every pass.`, unit: "ms", lowerIsBetter: true, results: ids.map((id) => row(id, round(cellMedian(r, id, "raw", s)), cellPassMedians(r, id, "raw", s))), statistic: "other" as const })),
      { id: "push-gap-p99", title: "Push inter-arrival p99", description: `Host emits ${r.protocol.pushSize} B events at ${r.protocol.pushRate} per second for ${r.protocol.pushSeconds} s over the idiomatic event path; the p99 gap between arrivals on the frontend.`, unit: "ms", lowerIsBetter: true, results: ids.map((id) => row(id, round(pushAgg(r, id, "idiomatic").gapP99, 2), pushes(r, id, "idiomatic").map((x) => x.gapsMs.p99))), statistic: "mean" },
    ],
  };
}

// ---------------------------------------------------------------- Parity
const parityPasses = (r: Raw, id: Id) => r.parity[id];
const frames = (r: Raw, id: Id, test: string) => parityPasses(r, id).flatMap((p) => p.results.filter((x) => x.test === test));
const parityTests = ["table", "particles", "raster"];
// Mean, not median: WKWebView quantizes performance.now() to 1 ms, so per-frame medians collapse to 0 or 1.
const stepPooled = (r: Raw, id: Id) => parityPasses(r, id).flatMap((p) => p.results.flatMap((x) => x.stepMs ? [x.stepMs.mean] : []));
const frameP99s = (r: Raw, id: Id, t: string) => frames(r, id, t).map((f) => f.summary.p99);
const frameP99 = (r: Raw, id: Id, t: string) => mean(frameP99s(r, id, t));
const stepMeans = (r: Raw, id: Id, t: string) => frames(r, id, t).map((f) => f.stepMs.mean);
const stepP50 = (r: Raw, id: Id, t: string) => mean(stepMeans(r, id, t));
const jank = (r: Raw, id: Id, t: string) => mean(frames(r, id, t).map((f) => f.jankPct));

function paritySection(r: Raw): Section {
  const tests = parityTests;
  const hz = parityPasses(r, "tauri")[0]?.refreshHz;
  // Site scorecards rank by the MEAN of the charted series; winners follow the same statistic so headline and table agree.
  const parityWinner = lower({ tauri: mean(stepPooled(r, "tauri")), electron: mean(stepPooled(r, "electron")) });
  return {
    id: "parity", title: "Webview parity", deck: `The same frontend, three engines: a 100,000-row virtualized table scrolled by script, 100,000 particles on Canvas 2D, and a 16-octave noise shader on WebGL2, each ${r.protocol.parityFrames} frames after ${r.protocol.parityWarmupFrames} warmup frames. Frame time is vsync-capped at ${hz} Hz so the tail and the main-thread step time carry the signal; the chart is step time per frame pooled over the three tests.`,
    unit: "ms", lowerIsBetter: true,
    verdict: { winnerId: parityWinner, headline: `${name(parityWinner)}'s webview spent ${round(mean(stepPooled(r, parityWinner)), 2)} ms of main-thread time per frame to ${round(mean(stepPooled(r, other(parityWinner))), 2)} ms, pooled over table, particles and raster`, summary: tests.map((t) => `${t}: frame p99 ${ids.map((id) => `${name(id)} ${round(frameP99(r, id, t), 1)}`).join(" / ")} ms, step p50 ${ids.map((id) => `${round(stepP50(r, id, t), 2)}`).join(" / ")} ms, jank ${ids.map((id) => `${round(jank(r, id, t), 1)}%`).join(" / ")}`).join(". ") + "." },
    candidates: ids.map((id) => cand(r, id, stepPooled(r, id), Object.fromEntries([
      ...tests.flatMap((t) => [
        [`${t}-frame-p99`, { value: round(frameP99(r, id, t), 2), unit: "ms", label: `${t}: frame time p99` }],
        [`${t}-step-p50`, { value: round(stepP50(r, id, t), 3), unit: "ms", label: `${t}: main-thread step time, mean per frame` }],
        [`${t}-jank`, { value: round(jank(r, id, t), 2), unit: "%", label: `${t}: frames over 1.5x the refresh interval` }],
      ]),
      ["refresh", { value: parityPasses(r, id)[0].refreshHz, unit: "Hz", label: "Display refresh detected by the webview" }],
    ]))),
    tests: tests.flatMap((t): BenchmarkTest[] => [
      { id: `${t}-frame-p99`, title: `${t[0].toUpperCase()}${t.slice(1)} frame p99`, description: `99th percentile interval between animation frames during the ${t} test, mean over passes.`, unit: "ms", lowerIsBetter: true, results: ids.map((id) => row(id, round(frameP99(r, id, t), 2), frameP99s(r, id, t))), statistic: "mean" },
      { id: `${t}-step-p50`, title: `${t[0].toUpperCase()}${t.slice(1)} step time`, description: `Main-thread time inside the ${t} test's per-frame step, which vsync cannot hide: each pass's mean over its frames, then the mean over passes, a mean of means and not a p50 despite the id, because WKWebView reports time in whole milliseconds and a per-frame median collapses to 0 or 1.`, unit: "ms", lowerIsBetter: true, results: ids.map((id) => row(id, round(stepP50(r, id, t), 3), stepMeans(r, id, t))), statistic: "mean" },
    ]),
  };
}

// ---------------------------------------------------------------- Lifecycle
const cold = (r: Raw, id: Id) => r.cold[id].map((s) => s.spawnToFirstFrameMs);
const warm = (r: Raw, id: Id) => r.warm[id].map((s) => s.spawnToFirstFrameMs);
const soakStat = (r: Raw, id: Id, f: (b: number[]) => number) => r.soak[id].map((s) => f(s.samples.map((x) => x.bytes)));
// First sample at or after five seconds: the first seconds are the shell booting, not the app working.
const soakStart = (r: Raw, id: Id) => mean(r.soak[id].map((s) => (s.samples.find((x) => x.tMs >= 5000) ?? s.samples[0]).bytes));
// Footprint oscillates with the soak's segments (table low, particles high), so the end sample
// only says which segment ran last. The mean over the soak after the first five seconds is the statistic.
const soakMeans = (r: Raw, id: Id) => r.soak[id].map((s) => mean(s.samples.filter((x) => x.tMs >= 5000 && x.tMs <= r.protocol.soakSeconds * 1000 - 3000).map((x) => x.bytes)));
const soakMean = (r: Raw, id: Id) => mean(soakMeans(r, id));
const soakPeaks = (r: Raw, id: Id) => soakStat(r, id, (b) => Math.max(...b));
const soakPeak = (r: Raw, id: Id) => mean(soakPeaks(r, id));
const inMB = (bytes: number[]) => bytes.map((b) => b / 2 ** 20);

function lifecycleSection(r: Raw): Section {
  const coldWinner = lower({ tauri: mean(cold(r, "tauri")), electron: mean(cold(r, "electron")) });
  const memWinner = lower({ tauri: soakMean(r, "tauri"), electron: soakMean(r, "electron") });
  const purgeNote = r.protocol.purge === "ok" ? "after the OS file cache was purged" : "WITHOUT a cache purge (purge unavailable on this rig)";
  return {
    id: "lifecycle", title: "Lifecycle", deck: `Cold start ${purgeNote}: from the launch command to the frontend's first animation frame, on one wall clock, ${r.protocol.coldStarts} launches each. Warm start immediately after a prior launch, ${r.protocol.warmStarts} each. Then a ${r.protocol.soakSeconds / 60}-minute soak cycling the three parity tests with a 1 MB round trip every ${r.protocol.soakIpcEverySeconds} s, footprint sampled every second, ${r.protocol.soaks} soaks each.`,
    unit: "ms", lowerIsBetter: true,
    verdict: { winnerId: coldWinner, headline: `${name(coldWinner)} reached its first frame in ${round(mean(cold(r, coldWinner)), 0)} ms cold (mean) to ${name(other(coldWinner))}'s ${round(mean(cold(r, other(coldWinner))), 0)}; over ten minutes of work ${name(memWinner)} averaged ${MB(soakMean(r, memWinner))} MB to ${MB(soakMean(r, other(memWinner)))} MB`, summary: `Warm start medians: ${ids.map((id) => `${name(id)} ${round(median(warm(r, id)), 0)} ms`).join(", ")}. Footprint at soak start / mean / peak, averaged over soaks: ${ids.map((id) => `${name(id)} ${MB(soakStart(r, id))} / ${MB(soakMean(r, id))} / ${MB(soakPeak(r, id))} MB`).join("; ")}. Footprint swings with the segment, around a third as much during the table as during the particles, so the mean is the figure to quote. ${r.protocol.attributionRule}` },
    candidates: ids.map((id) => cand(r, id, cold(r, id), {
      "warm-median": { value: round(median(warm(r, id)), 1), unit: "ms", label: "Warm start median" },
      "host-to-first-frame": { value: round(median(r.cold[id].map((s) => s.hostToFirstFrameMs)), 1), unit: "ms", label: "Host process start to first frame, median (excludes launcher latency)" },
      "soak-start": { value: MB(soakStart(r, id)), unit: "MB", label: "Footprint at soak start" },
      "soak-mean": { value: MB(soakMean(r, id)), unit: "MB", label: "Footprint, mean over the soak" },
      "soak-peak": { value: MB(soakPeak(r, id)), unit: "MB", label: "Footprint peak during soak" },
    })),
    tests: [
      { id: "cold", title: "Cold start", description: `Launch command to first animation frame ${purgeNote}, median of ${r.protocol.coldStarts}.`, unit: "ms", lowerIsBetter: true, results: ids.map((id) => row(id, round(median(cold(r, id)), 1), cold(r, id))), statistic: "median" },
      { id: "warm", title: "Warm start", description: `Same measurement immediately after a prior launch, median of ${r.protocol.warmStarts}.`, unit: "ms", lowerIsBetter: true, results: ids.map((id) => row(id, round(median(warm(r, id)), 1), warm(r, id))), statistic: "median" },
      { id: "soak-mean", title: "Footprint over soak", description: "Attributed memory averaged over the ten-minute soak, after the first five seconds, averaged over soaks.", unit: "MB", lowerIsBetter: true, results: ids.map((id) => row(id, MB(soakMean(r, id)), inMB(soakMeans(r, id)))), statistic: "mean" },
      { id: "soak-peak", title: "Footprint peak", description: "Highest attributed memory sampled during the soak, mean over soaks.", unit: "MB", lowerIsBetter: true, results: ids.map((id) => row(id, MB(soakPeak(r, id)), inMB(soakPeaks(r, id)))), statistic: "mean" },
    ],
  };
}

// ---------------------------------------------------------------- Size
function sizeSection(r: Raw): Section {
  const sizeWinner = lower({ tauri: r.size.tauri.installerBytes, electron: r.size.electron.installerBytes });
  return {
    id: "size", title: "Size", deck: "The installer each shell's default build produced, unsigned, and the bytes on disk once installed. Nothing tuned on either side.",
    unit: "MB", lowerIsBetter: true,
    verdict: { winnerId: sizeWinner, headline: `${name(sizeWinner)}'s installer is ${MB(r.size[sizeWinner].installerBytes)} MB to ${name(other(sizeWinner))}'s ${MB(r.size[other(sizeWinner)].installerBytes)} MB`, summary: `Installed: ${ids.map((id) => `${name(id)} ${MB(r.size[id].installedBytes)} MB`).join(", ")}. The Tauri candidate draws on the operating system's webview, which is not counted; the Electron candidate carries its own Chromium, which is.` },
    candidates: ids.map((id) => cand(r, id, [r.size[id].installerBytes / 2 ** 20], {
      installer: { value: MB(r.size[id].installerBytes), unit: "MB", label: "Installer as built" },
      installed: { value: MB(r.size[id].installedBytes), unit: "MB", label: "Installed on disk" },
    })),
    tests: [
      // Measured once, so the one sample is the value.
      { id: "installer", title: "Installer", description: "Bytes of the default build's installer.", unit: "MB", lowerIsBetter: true, results: ids.map((id) => row(id, MB(r.size[id].installerBytes), [MB(r.size[id].installerBytes)])), statistic: "mean" },
      { id: "installed", title: "Installed", description: "Bytes on disk after install and first launch.", unit: "MB", lowerIsBetter: true, results: ids.map((id) => row(id, MB(r.size[id].installedBytes), [MB(r.size[id].installedBytes)])), statistic: "mean" },
    ],
  };
}

/** The run file for a results file. `rig` names the run after the label's first segment unless given. */
export function buildRun(r: Raw, label: string, rig?: string): Run {
  if (r.smoke) throw new Error("refusing to import a smoke run");
  if (!r.gate?.ok) throw new Error("gate did not pass");
  const rigSlug = rig ?? label.split("/")[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  const date = (r.finishedAt ?? r.startedAt).slice(0, 10);
  const runId = `${date}-${rigSlug}`;
  return {
    schemaVersion: 1, id: runId, label, publishedAt: date,
    environment: { ...r.rig, cores: String(r.rig.cores), browser: ids.map((id) => `${name(id)}: ${candidate(r, id).webview}`).join("; ") },
    protocol: {
      warmups: r.protocol.ipcWarmups, runs: r.protocol.ipcPasses,
      processModel: `Apps launched ${r.protocol.launcher}; candidates interleaved A B / B A pass by pass; ${r.protocol.coldStarts} cold and ${r.protocol.warmStarts} warm starts, ${r.protocol.ipcPasses} IPC passes (the protocol's runs) of ${r.protocol.ipcIterations} samples per cell, each cell after ${r.protocol.ipcWarmups} warmup samples (the protocol's warmups count samples in a cell, not passes), with small payloads batched to cover the webview's timer resolution, ${r.protocol.parityPasses} parity passes of ${r.protocol.parityFrames} frames, ${r.protocol.soaks} ten-minute soaks; a conformance gate with byte-identical digests on both hosts precedes every run`,
      cacheState: r.protocol.purge === "ok" ? "OS file cache purged before every cold start; nothing purged before warm starts" : "No cache purge available on this rig; cold starts are launches after a settle, not cold",
      output: `FIRST_FRAME marker on the host's stdout timed against the launcher's wall clock; frontend performance.now() for round trips and frames; ${r.protocol.attributionRule}`,
    },
    candidates: [],
    sections: [ipcSection(r), paritySection(r), lifecycleSection(r), sizeSection(r)],
  };
}

/** The site's rule for a recomputed statistic: within half a unit of the value's last decimal, plus 1e-9 for floating point. */
export const tolerance = (value: number) => { const s = String(value); const dot = s.indexOf("."); return 0.5 * 10 ** -(dot < 0 ? 0 : s.length - dot - 1) + 1e-9; };
export const recompute = (statistic: TestStatistic, samples: number[]): number | undefined =>
  statistic === "mean" ? mean(samples) : statistic === "median" ? median(samples) : statistic === "min" ? Math.min(...samples) : statistic === "max" ? Math.max(...samples) : undefined;

/** Every test says its statistic, every result carries samples, and a recomputed statistic lands on the value. */
export function checkSamples(run: RunTests): void {
  for (const s of run.sections) for (const t of s.tests) {
    if (!t.statistic) throw new Error(`${s.id}/${t.id}: no statistic`);
    for (const x of t.results) {
      if (!x.samples?.length) throw new Error(`${s.id}/${t.id}/${x.candidateId}: no samples`);
      const computed = recompute(t.statistic, x.samples);
      if (computed !== undefined && Math.abs(computed - x.value) > tolerance(x.value)) throw new Error(`${s.id}/${t.id}/${x.candidateId}: the ${t.statistic} of the samples is ${computed}, the value ${x.value}`);
    }
  }
}

if (import.meta.main) {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
  const resultsPath = args.results ?? "results.json";
  const label = args.label;
  if (!label) throw new Error("--label is required, e.g. --label='M2 Max / macOS 26 (local)'");
  const r: Raw = JSON.parse(readFileSync(resultsPath, "utf8"));
  const run = buildRun(r, label, args.rig);
  checkSamples(run);
  const runsDir = path.resolve("runs");
  const outFile = path.join(runsDir, `${run.id}.json`);
  writeFileSync(outFile, JSON.stringify(run, null, 2) + "\n");
  const benchPath = path.resolve("benchmark.json");
  if (existsSync(benchPath)) {
    const b = JSON.parse(readFileSync(benchPath, "utf8"));
    const rel = `runs/${run.id}.json`;
    if (!b.runs.includes(rel)) b.runs.push(rel);
    writeFileSync(benchPath, JSON.stringify(b, null, 2) + "\n");
  }
  console.log(`wrote ${path.relative(process.cwd(), outFile)}`);
  console.log(`IPC geomean tauri/electron = ${round(ipcGeomean(r), 3)} -> ${run.sections[0].verdict.headline}`);
  for (const s of run.sections.slice(1)) console.log(s.verdict.headline);
}

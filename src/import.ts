// results.json -> runs/<date>-<rig>.json, registered in benchmark.json.
// Four sections. Section winners are ranked by the mean of the charted series,
// which is what the site's scorecard shows; the IPC headline alone follows ADR 0002.
// The section series the site charts are: IPC = idiomatic 1 MB
// round trip; Parity = main-thread step time per frame pooled over the three
// tests; Lifecycle = cold start; Size = installer bytes. The verdict rule for
// the headline is ADR 0002 and is computed here, not chosen after the fact.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { geomean, mean, median, quantile, round } from "./stats";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const resultsPath = args.results ?? "results.json";
const label = args.label;
if (!label) throw new Error("--label is required, e.g. --label='M2 Max / macOS 26 (local)'");
const rigSlug = args.rig ?? label.split("/")[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, "");

type Id = "tauri" | "electron";
const r = JSON.parse(readFileSync(resultsPath, "utf8"));
if (r.smoke) throw new Error("refusing to import a smoke run");
if (!r.gate?.ok) throw new Error("gate did not pass");
const ids: Id[] = ["tauri", "electron"];
const date = (r.finishedAt ?? r.startedAt).slice(0, 10);
const runId = `${date}-${rigSlug}`;

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { medianMs: round(quantile(s, 0.5)), meanMs: round(mean(s)), minMs: round(s[0]), maxMs: round(s[s.length - 1]) };
};
const cand = (id: Id, samples: number[], metrics: Record<string, { value: number; unit: string; label: string }>) => {
  const c = r.candidates.find((x: { id: string }) => x.id === id);
  return { id, name: id === "tauri" ? "Tauri" : "Electron", version: c.version, color: c.color, homepage: c.homepage, statistics: stats(samples), samplesMs: samples.map((x) => round(x)), metrics };
};
const MB = (b: number) => round(b / 2 ** 20, 1);
const lower = (vals: Record<Id, number>) => (vals.tauri <= vals.electron ? "tauri" : "electron");
const name = (id: Id) => (id === "tauri" ? "Tauri" : "Electron");

// ---------------------------------------------------------------- IPC
interface Cell { path: "idiomatic" | "raw"; targetBytes: number; actualBytes: number; rows?: number; batch: number; samplesMs: number[] }
interface Push { path: "idiomatic" | "raw"; requested: number; delivered: number; deliveredPerSecond: number; gapsMs: { p99: number } }
const ipcCells = (id: Id): Cell[] => (r.ipc[id] as Array<{ cells: Cell[] }>).flatMap((p) => p.cells);
const cellSamples = (id: Id, p: Cell["path"], bytes: number) => ipcCells(id).filter((c) => c.path === p && c.targetBytes === bytes).flatMap((c) => c.samplesMs);
const cellMedian = (id: Id, p: Cell["path"], bytes: number) => median(cellSamples(id, p, bytes));
const sizes = [...new Set(ipcCells("tauri").map((c) => c.targetBytes))].sort((a, b) => a - b);
const pushes = (id: Id): Push[] => (r.ipc[id] as Array<{ pushes: Push[] }>).flatMap((p) => p.pushes);
const pushAgg = (id: Id, p: Push["path"]) => { const ps = pushes(id).filter((x) => x.path === p); return { rate: mean(ps.map((x) => x.deliveredPerSecond)), lost: ps.reduce((a, x) => a + (x.requested - x.delivered), 0), gapP99: mean(ps.map((x) => x.gapsMs.p99)) }; };
const kb = (b: number) => (b >= 2 ** 20 ? `${b / 2 ** 20} MB` : `${b / 1024} KB`);

// ADR 0002: geometric mean over idiomatic cells of tauri/electron medians.
const ratios = sizes.map((s) => cellMedian("tauri", "idiomatic", s) / cellMedian("electron", "idiomatic", s));
const gm = geomean(ratios);
const ipcWinner: Id = gm <= 1 ? "tauri" : "electron";
const ipcFactor = round(gm <= 1 ? 1 / gm : gm, 2);

const ipcSection = {
  id: "ipc", title: "IPC across the boundary", deck: `Round trips from the frontend to the host and back at ${sizes.map(kb).join(", ")}, on each shell's idiomatic JSON path and on its raw bytes path, plus host-to-frontend push at ${r.protocol.pushRate} events per second. The chart is the idiomatic 1 MB round trip; the headline is the geometric mean over the idiomatic sizes.`,
  unit: "ms", lowerIsBetter: true,
  verdict: {
    winnerId: ipcWinner,
    headline: `${name(ipcWinner)} moved JSON across the boundary ${ipcFactor} times faster than ${name(ipcWinner === "tauri" ? "electron" : "tauri")} over ${sizes.map(kb).join(", ")} (geometric mean of medians)`,
    summary: `Per size, Tauri over Electron: ${sizes.map((s, i) => `${kb(s)} ${round(ratios[i], 2)}x`).join(", ")}. Raw bytes: ${sizes.map((s) => `${kb(s)} ${round(cellMedian("tauri", "raw", s) / cellMedian("electron", "raw", s), 2)}x`).join(", ")}.`,
  },
  candidates: ids.map((id) => cand(id, cellSamples(id, "idiomatic", 2 ** 20), Object.fromEntries([
    ...sizes.flatMap((s) => [
      [`idiomatic-${s}`, { value: round(cellMedian(id, "idiomatic", s)), unit: "ms", label: `Idiomatic ${kb(s)} round trip median` }],
      [`raw-${s}`, { value: round(cellMedian(id, "raw", s)), unit: "ms", label: `Raw ${kb(s)} round trip median` }],
    ]),
    ["push-rate", { value: round(pushAgg(id, "idiomatic").rate, 0), unit: "events/s", label: `Idiomatic push delivered per second (requested ${r.protocol.pushRate})` }],
    ["push-lost", { value: pushAgg(id, "idiomatic").lost, unit: "events", label: "Idiomatic push events lost" }],
    ["push-gap-p99", { value: round(pushAgg(id, "idiomatic").gapP99, 2), unit: "ms", label: "Idiomatic push inter-arrival gap p99" }],
    ["push-raw-rate", { value: round(pushAgg(id, "raw").rate, 0), unit: "events/s", label: `Raw push delivered per second (requested ${r.protocol.pushRate})` }],
    ["push-raw-gap-p99", { value: round(pushAgg(id, "raw").gapP99, 2), unit: "ms", label: "Raw push inter-arrival gap p99" }],
    ["timer-resolution", { value: round((r.ipc[id][0] as { timerResolutionMs: number }).timerResolutionMs, 3), unit: "ms", label: "Webview timer resolution (round trips batched to cover it)" }],
  ]))),
  tests: [
    ...sizes.map((s) => ({ id: `idiomatic-${s}`, title: `Idiomatic ${kb(s)}`, description: `Median round trip of a ${kb(s)} JSON payload of seeded rows, frontend to host and back, on the path each shell's docs recommend.`, unit: "ms", lowerIsBetter: true, results: ids.map((id) => ({ candidateId: id, value: round(cellMedian(id, "idiomatic", s)) })) })),
    ...sizes.map((s) => ({ id: `raw-${s}`, title: `Raw ${kb(s)}`, description: `Median round trip of ${kb(s)} of seeded bytes on the shell's bytes path: Tauri raw request and response, Electron Uint8Array over invoke.`, unit: "ms", lowerIsBetter: true, results: ids.map((id) => ({ candidateId: id, value: round(cellMedian(id, "raw", s)) })) })),
    { id: "push-gap-p99", title: "Push inter-arrival p99", description: `Host emits ${r.protocol.pushSize} B events at ${r.protocol.pushRate} per second for ${r.protocol.pushSeconds} s over the idiomatic event path; the p99 gap between arrivals on the frontend.`, unit: "ms", lowerIsBetter: true, results: ids.map((id) => ({ candidateId: id, value: round(pushAgg(id, "idiomatic").gapP99, 2) })) },
  ],
};

// ---------------------------------------------------------------- Parity
interface Frame { test: string; refreshHz: number; jankPct: number; samplesMs: number[]; summary: { p50: number; p99: number }; stepMs: { p50: number; p99: number; mean: number } }
const parityPasses = (id: Id) => r.parity[id] as Array<{ refreshHz: number; renderer: string; results: Frame[] }>;
const frames = (id: Id, test: string) => parityPasses(id).flatMap((p) => p.results.filter((x) => x.test === test));
const tests = ["table", "particles", "raster"];
// Mean, not median: WKWebView quantizes performance.now() to 1 ms, so per-frame medians collapse to 0 or 1.
const stepPooled = (id: Id) => parityPasses(id).flatMap((p) => p.results.flatMap((x) => x.stepMs ? [x.stepMs.mean] : []));
const frameP99 = (id: Id, t: string) => mean(frames(id, t).map((f) => f.summary.p99));
const stepP50 = (id: Id, t: string) => mean(frames(id, t).map((f) => f.stepMs.mean));
const jank = (id: Id, t: string) => mean(frames(id, t).map((f) => f.jankPct));
const hz = parityPasses("tauri")[0]?.refreshHz;
// Site scorecards rank by the MEAN of the charted series; winners follow the same statistic so headline and table agree.
const parityWinner = lower({ tauri: mean(stepPooled("tauri")), electron: mean(stepPooled("electron")) });
const paritySection = {
  id: "parity", title: "Webview parity", deck: `The same frontend, three engines: a 100,000-row virtualized table scrolled by script, 100,000 particles on Canvas 2D, and a 16-octave noise shader on WebGL2, each ${r.protocol.parityFrames} frames after ${r.protocol.parityWarmupFrames} warmup frames. Frame time is vsync-capped at ${hz} Hz so the tail and the main-thread step time carry the signal; the chart is step time per frame pooled over the three tests.`,
  unit: "ms", lowerIsBetter: true,
  verdict: { winnerId: parityWinner, headline: `${name(parityWinner)}'s webview spent ${round(mean(stepPooled(parityWinner)), 2)} ms of main-thread time per frame to ${round(mean(stepPooled(parityWinner === "tauri" ? "electron" : "tauri")), 2)} ms, pooled over table, particles and raster`, summary: tests.map((t) => `${t}: frame p99 ${ids.map((id) => `${name(id)} ${round(frameP99(id, t), 1)}`).join(" / ")} ms, step p50 ${ids.map((id) => `${round(stepP50(id, t), 2)}`).join(" / ")} ms, jank ${ids.map((id) => `${round(jank(id, t), 1)}%`).join(" / ")}`).join(". ") + "." },
  candidates: ids.map((id) => cand(id, stepPooled(id), Object.fromEntries([
    ...tests.flatMap((t) => [
      [`${t}-frame-p99`, { value: round(frameP99(id, t), 2), unit: "ms", label: `${t}: frame time p99` }],
      [`${t}-step-p50`, { value: round(stepP50(id, t), 3), unit: "ms", label: `${t}: main-thread step time, mean per frame` }],
      [`${t}-jank`, { value: round(jank(id, t), 2), unit: "%", label: `${t}: frames over 1.5x the refresh interval` }],
    ]),
    ["refresh", { value: parityPasses(id)[0].refreshHz, unit: "Hz", label: "Display refresh detected by the webview" }],
  ]))),
  tests: tests.flatMap((t) => [
    { id: `${t}-frame-p99`, title: `${t[0].toUpperCase()}${t.slice(1)} frame p99`, description: `99th percentile interval between animation frames during the ${t} test, mean over passes.`, unit: "ms", lowerIsBetter: true, results: ids.map((id) => ({ candidateId: id, value: round(frameP99(id, t), 2) })) },
    { id: `${t}-step-p50`, title: `${t[0].toUpperCase()}${t.slice(1)} step time`, description: `Mean main-thread time inside the ${t} test's per-frame step, which vsync cannot hide; a mean because WKWebView reports time in whole milliseconds.`, unit: "ms", lowerIsBetter: true, results: ids.map((id) => ({ candidateId: id, value: round(stepP50(id, t), 3) })) },
  ]),
};

// ---------------------------------------------------------------- Lifecycle
interface Start { spawnToFirstFrameMs: number; hostToFirstFrameMs: number }
const cold = (id: Id) => (r.cold[id] as Start[]).map((s) => s.spawnToFirstFrameMs);
const warm = (id: Id) => (r.warm[id] as Start[]).map((s) => s.spawnToFirstFrameMs);
interface Soak { samples: Array<{ bytes: number }> }
const soakStat = (id: Id, f: (b: number[]) => number) => mean((r.soak[id] as Soak[]).map((s) => f(s.samples.map((x) => x.bytes))));
// First sample at or after five seconds: the first seconds are the shell booting, not the app working.
const soakStart = (id: Id) => mean((r.soak[id] as Array<{ samples: Array<{ tMs: number; bytes: number }> }>).map((s) => (s.samples.find((x) => x.tMs >= 5000) ?? s.samples[0]).bytes));
// Last sample at least three seconds before the soak's scripted end: the final sample lands mid-teardown.
const soakEnd = (id: Id) => mean((r.soak[id] as Array<{ samples: Array<{ tMs: number; bytes: number }> }>).map((s) => { const cutoff = r.protocol.soakSeconds * 1000 - 3000; const before = s.samples.filter((x) => x.tMs <= cutoff); return (before[before.length - 1] ?? s.samples[s.samples.length - 1]).bytes; }));
const soakPeak = (id: Id) => soakStat(id, (b) => Math.max(...b));
const coldWinner = lower({ tauri: mean(cold("tauri")), electron: mean(cold("electron")) });
const memWinner = lower({ tauri: soakEnd("tauri"), electron: soakEnd("electron") });
const purgeNote = r.protocol.purge === "ok" ? "after the OS file cache was purged" : "WITHOUT a cache purge (purge unavailable on this rig)";
const lifecycleSection = {
  id: "lifecycle", title: "Lifecycle", deck: `Cold start ${purgeNote}: from the launch command to the frontend's first animation frame, on one wall clock, ${r.protocol.coldStarts} launches each. Warm start immediately after a prior launch, ${r.protocol.warmStarts} each. Then a ${r.protocol.soakSeconds / 60}-minute soak cycling the three parity tests with a 1 MB round trip every ${r.protocol.soakIpcEverySeconds} s, footprint sampled every second, ${r.protocol.soaks} soaks each.`,
  unit: "ms", lowerIsBetter: true,
  verdict: { winnerId: coldWinner, headline: `${name(coldWinner)} reached its first frame in ${round(mean(cold(coldWinner)), 0)} ms cold (mean) to ${name(coldWinner === "tauri" ? "electron" : "tauri")}'s ${round(mean(cold(coldWinner === "tauri" ? "electron" : "tauri")), 0)}; after ten minutes of work ${name(memWinner)} held ${MB(soakEnd(memWinner))} MB to ${MB(soakEnd(memWinner === "tauri" ? "electron" : "tauri"))} MB`, summary: `Warm start medians: ${ids.map((id) => `${name(id)} ${round(median(warm(id)), 0)} ms`).join(", ")}. Footprint at soak start / end / peak, mean over soaks: ${ids.map((id) => `${name(id)} ${MB(soakStart(id))} / ${MB(soakEnd(id))} / ${MB(soakPeak(id))} MB`).join("; ")}. ${r.protocol.attributionRule}` },
  candidates: ids.map((id) => cand(id, cold(id), {
    "warm-median": { value: round(median(warm(id)), 1), unit: "ms", label: "Warm start median" },
    "host-to-first-frame": { value: round(median((r.cold[id] as Start[]).map((s) => s.hostToFirstFrameMs)), 1), unit: "ms", label: "Host process start to first frame, median (excludes launcher latency)" },
    "soak-start": { value: MB(soakStart(id)), unit: "MB", label: "Footprint at soak start" },
    "soak-end": { value: MB(soakEnd(id)), unit: "MB", label: "Footprint at soak end" },
    "soak-peak": { value: MB(soakPeak(id)), unit: "MB", label: "Footprint peak during soak" },
  })),
  tests: [
    { id: "cold", title: "Cold start", description: `Launch command to first animation frame ${purgeNote}, median of ${r.protocol.coldStarts}.`, unit: "ms", lowerIsBetter: true, results: ids.map((id) => ({ candidateId: id, value: round(median(cold(id)), 1) })) },
    { id: "warm", title: "Warm start", description: `Same measurement immediately after a prior launch, median of ${r.protocol.warmStarts}.`, unit: "ms", lowerIsBetter: true, results: ids.map((id) => ({ candidateId: id, value: round(median(warm(id)), 1) })) },
    { id: "soak-end", title: "Footprint after soak", description: "Attributed memory at the end of the ten-minute soak, mean over soaks.", unit: "MB", lowerIsBetter: true, results: ids.map((id) => ({ candidateId: id, value: MB(soakEnd(id)) })) },
    { id: "soak-peak", title: "Footprint peak", description: "Highest attributed memory sampled during the soak, mean over soaks.", unit: "MB", lowerIsBetter: true, results: ids.map((id) => ({ candidateId: id, value: MB(soakPeak(id)) })) },
  ],
};

// ---------------------------------------------------------------- Size
const sizeWinner = lower({ tauri: r.size.tauri.installerBytes, electron: r.size.electron.installerBytes });
const sizeSection = {
  id: "size", title: "Size", deck: "The installer each shell's default build produced, unsigned, and the bytes on disk once installed. Nothing tuned on either side.",
  unit: "MB", lowerIsBetter: true,
  verdict: { winnerId: sizeWinner, headline: `${name(sizeWinner)}'s installer is ${MB(r.size[sizeWinner].installerBytes)} MB to ${name(sizeWinner === "tauri" ? "electron" : "tauri")}'s ${MB(r.size[sizeWinner === "tauri" ? "electron" : "tauri"].installerBytes)} MB`, summary: `Installed: ${ids.map((id) => `${name(id)} ${MB(r.size[id].installedBytes)} MB`).join(", ")}. The Tauri candidate draws on the operating system's webview, which is not counted; the Electron candidate carries its own Chromium, which is.` },
  candidates: ids.map((id) => cand(id, [r.size[id].installerBytes / 2 ** 20], {
    installer: { value: MB(r.size[id].installerBytes), unit: "MB", label: "Installer as built" },
    installed: { value: MB(r.size[id].installedBytes), unit: "MB", label: "Installed on disk" },
  })),
  tests: [
    { id: "installer", title: "Installer", description: "Bytes of the default build's installer.", unit: "MB", lowerIsBetter: true, results: ids.map((id) => ({ candidateId: id, value: MB(r.size[id].installerBytes) })) },
    { id: "installed", title: "Installed", description: "Bytes on disk after install and first launch.", unit: "MB", lowerIsBetter: true, results: ids.map((id) => ({ candidateId: id, value: MB(r.size[id].installedBytes) })) },
  ],
};

const run = {
  schemaVersion: 1, id: runId, label, publishedAt: date,
  environment: { ...r.rig, cores: String(r.rig.cores), browser: ids.map((id) => `${name(id)}: ${r.candidates.find((c: { id: string }) => c.id === id).webview}`).join("; ") },
  protocol: {
    warmups: r.protocol.ipcWarmups, runs: r.protocol.ipcPasses,
    processModel: `Apps launched ${r.protocol.launcher}; candidates interleaved A B / B A pass by pass; ${r.protocol.coldStarts} cold and ${r.protocol.warmStarts} warm starts, ${r.protocol.ipcPasses} IPC passes of ${r.protocol.ipcIterations} samples per cell after ${r.protocol.ipcWarmups} warmups with small payloads batched to cover the webview's timer resolution, ${r.protocol.parityPasses} parity passes of ${r.protocol.parityFrames} frames, ${r.protocol.soaks} ten-minute soaks; a conformance gate with byte-identical digests on both hosts precedes every run`,
    cacheState: r.protocol.purge === "ok" ? "OS file cache purged before every cold start; nothing purged before warm starts" : "No cache purge available on this rig; cold starts are launches after a settle, not cold",
    output: `FIRST_FRAME marker on the host's stdout timed against the launcher's wall clock; frontend performance.now() for round trips and frames; ${r.protocol.attributionRule}`,
  },
  candidates: [],
  sections: [ipcSection, paritySection, lifecycleSection, sizeSection],
};

const runsDir = path.resolve("runs");
const outFile = path.join(runsDir, `${runId}.json`);
writeFileSync(outFile, JSON.stringify(run, null, 2) + "\n");
const benchPath = path.resolve("benchmark.json");
if (existsSync(benchPath)) {
  const b = JSON.parse(readFileSync(benchPath, "utf8"));
  const rel = `runs/${runId}.json`;
  if (!b.runs.includes(rel)) b.runs.push(rel);
  writeFileSync(benchPath, JSON.stringify(b, null, 2) + "\n");
}
console.log(`wrote ${path.relative(process.cwd(), outFile)}`);
console.log(`IPC geomean tauri/electron = ${round(gm, 3)} -> ${ipcSection.verdict.headline}`);
console.log(paritySection.verdict.headline);
console.log(lifecycleSection.verdict.headline);
console.log(sizeSection.verdict.headline);

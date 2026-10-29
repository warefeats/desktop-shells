import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRun, checkSamples, tolerance, type Raw, type RawCell, type RawFrame, type RawIpcPass, type Run, type RunTests } from "../src/import";
import { enrich, enrichFile } from "../src/enrich";
import { mean, median } from "../src/stats";

const MiB = 2 ** 20;
const start = (ms: number) => ({ spawnToFirstFrameMs: ms, hostToFirstFrameMs: ms / 2 });
const cell = (p: RawCell["path"], samplesMs: number[]): RawCell => ({ path: p, targetBytes: MiB, actualBytes: MiB + 16, rows: 8000, batch: 1, samplesMs });
const ipcPass = (idiomatic: number[], raw: number[], gapP99: number, rawGapP99: number): RawIpcPass => ({
  timerResolutionMs: 0.1,
  cells: [cell("idiomatic", idiomatic), cell("raw", raw)],
  pushes: [
    { path: "idiomatic", requested: 1000, delivered: 1000, deliveredPerSecond: 999, gapsMs: { p99: gapP99 } },
    { path: "raw", requested: 1000, delivered: 999, deliveredPerSecond: 998, gapsMs: { p99: rawGapP99 } },
  ],
});
const frame = (t: string, p99: number, stepMean: number, jankPct: number): RawFrame => ({ test: t, refreshHz: 60, jankPct, samplesMs: [16, 17, p99], summary: { p50: 16.5, p99 }, stepMs: { p50: stepMean, p99: stepMean * 2, mean: stepMean } });
const parityPass = (results: RawFrame[]) => ({ refreshHz: 60, renderer: "test", results });
// Samples at 0, 5, 7, 9 and 11 s: the soak window runs from 5 s to soakSeconds - 3 s, so the middle three count.
const soak = (bytes: number[]) => ({ samples: bytes.map((b, i) => ({ tMs: [0, 5000, 7000, 9000, 11000][i], bytes: b })) });

/** Two passes of everything, every number distinct, small enough to check by hand. */
const raw = (): Raw => ({
  startedAt: "2026-01-02T03:04:05.000Z", finishedAt: "2026-01-02T05:06:07.000Z", smoke: false,
  rig: { machine: "test rig", cores: 8 },
  protocol: { coldStarts: 2, warmStarts: 2, ipcPasses: 2, ipcWarmups: 1, ipcIterations: 3, pushRate: 1000, pushSize: 1024, pushSeconds: 1, parityPasses: 2, parityWarmupFrames: 2, parityFrames: 3, soaks: 1, soakSeconds: 12, soakIpcEverySeconds: 2, attributionRule: "test: every byte counts", purge: "ok", launcher: "by hand" },
  candidates: [
    { id: "tauri", version: "2.0.0", homepage: "https://tauri.app", color: "#111111", webview: "WebKit 1" },
    { id: "electron", version: "40.0.0", homepage: "https://www.electronjs.org", color: "#222222", webview: "Chromium 2" },
  ],
  gate: { ok: true },
  cold: { tauri: [start(1000.5), start(1100.5)], electron: [start(900.25), start(950.75)] },
  warm: { tauri: [start(300), start(320)], electron: [start(280), start(310)] },
  ipc: {
    tauri: [ipcPass([10, 11, 12], [5, 6, 7], 2, 1), ipcPass([20, 24, 28], [8, 9, 10], 3, 1.5)],
    electron: [ipcPass([30, 31, 32], [1, 2, 3], 4, 2), ipcPass([40, 45, 50], [4, 5, 6], 5, 2.5)],
  },
  parity: {
    tauri: [parityPass([frame("table", 17, 0.5, 0), frame("particles", 22, 9.5, 0.1), frame("raster", 18, 0.02, 0)]), parityPass([frame("table", 18, 0.6, 0.2), frame("particles", 24, 10.5, 0.3), frame("raster", 17, 0.04, 0)])],
    electron: [parityPass([frame("table", 17.5, 0.3, 0.1), frame("particles", 34, 17, 25), frame("raster", 17.7, 0.03, 0)]), parityPass([frame("table", 18.5, 0.4, 0.2), frame("particles", 35, 18, 26), frame("raster", 17.9, 0.05, 0)])],
  },
  soak: { tauri: [soak([100e6, 200e6, 300e6, 400e6, 500e6])], electron: [soak([150e6, 250e6, 350e6, 450e6, 550e6])] },
  size: { tauri: { installerBytes: 2 * MiB + 1, installedBytes: 10 * MiB }, electron: { installerBytes: 120 * MiB, installedBytes: 300 * MiB } },
});

const label = "Test Rig / Test OS (local)";
const run = buildRun(raw(), label);
const section = (run: Run, id: string) => { const s = run.sections.find((x) => x.id === id); if (!s) throw new Error(`no section ${id}`); return s; };
const testOf = (run: Run, sectionId: string, id: string) => { const t = section(run, sectionId).tests.find((x) => x.id === id); if (!t) throw new Error(`no test ${id}`); return t; };
const resultOf = (run: Run, sectionId: string, id: string, candidateId: string) => { const x = testOf(run, sectionId, id).results.find((y) => y.candidateId === candidateId); if (!x) throw new Error(`no ${candidateId} in ${id}`); return x; };

describe("buildRun", () => {
  test("names the run and lays out the four sections", () => {
    expect(run.id).toBe("2026-01-02-testrig");
    expect(run.publishedAt).toBe("2026-01-02");
    expect(run.sections.map((s) => s.id)).toEqual(["ipc", "parity", "lifecycle", "size"]);
    expect(section(run, "ipc").tests.map((t) => t.id)).toEqual(["idiomatic-1048576", "raw-1048576", "push-gap-p99"]);
    expect(section(run, "parity").tests.map((t) => t.id)).toEqual(["table-frame-p99", "table-step-p50", "particles-frame-p99", "particles-step-p50", "raster-frame-p99", "raster-step-p50"]);
    expect(section(run, "lifecycle").tests.map((t) => t.id)).toEqual(["cold", "warm", "soak-mean", "soak-peak"]);
    expect(section(run, "size").tests.map((t) => t.id)).toEqual(["installer", "installed"]);
  });
  test("every test says which statistic its value is", () => {
    expect(Object.fromEntries(run.sections.flatMap((s) => s.tests.map((t) => [t.id, t.statistic])))).toEqual({
      "idiomatic-1048576": "other", "raw-1048576": "other", "push-gap-p99": "mean",
      "table-frame-p99": "mean", "table-step-p50": "mean", "particles-frame-p99": "mean", "particles-step-p50": "mean", "raster-frame-p99": "mean", "raster-step-p50": "mean",
      cold: "median", warm: "median", "soak-mean": "mean", "soak-peak": "mean",
      installer: "mean", installed: "mean",
    });
  });
  test("an IPC round trip's value is the median pooled over every sample of every pass; its samples are each pass's median", () => {
    const tauri = resultOf(run, "ipc", "idiomatic-1048576", "tauri");
    expect(tauri).toEqual({ candidateId: "tauri", value: 16, samples: [11, 24] });
    expect(mean(tauri.samples ?? [])).not.toBe(tauri.value);
    expect(median(tauri.samples ?? [])).not.toBe(tauri.value);
    expect(resultOf(run, "ipc", "raw-1048576", "electron")).toEqual({ candidateId: "electron", value: 3.5, samples: [2, 5] });
  });
  test("a mean or median test's samples are the per-pass numbers its value was computed from", () => {
    expect(resultOf(run, "ipc", "push-gap-p99", "tauri")).toEqual({ candidateId: "tauri", value: 2.5, samples: [2, 3] });
    expect(resultOf(run, "parity", "particles-frame-p99", "electron")).toEqual({ candidateId: "electron", value: 34.5, samples: [34, 35] });
    expect(resultOf(run, "parity", "table-step-p50", "tauri")).toEqual({ candidateId: "tauri", value: 0.55, samples: [0.5, 0.6] });
    expect(resultOf(run, "lifecycle", "cold", "tauri")).toEqual({ candidateId: "tauri", value: 1050.5, samples: [1000.5, 1100.5] });
    expect(resultOf(run, "lifecycle", "warm", "electron")).toEqual({ candidateId: "electron", value: 295, samples: [280, 310] });
    expect(resultOf(run, "lifecycle", "soak-mean", "tauri")).toEqual({ candidateId: "tauri", value: 286.1, samples: [300e6 / MiB] });
    expect(resultOf(run, "lifecycle", "soak-peak", "tauri")).toEqual({ candidateId: "tauri", value: 476.8, samples: [500e6 / MiB] });
    expect(resultOf(run, "size", "installer", "tauri")).toEqual({ candidateId: "tauri", value: 2, samples: [2] });
    expect(resultOf(run, "size", "installed", "electron")).toEqual({ candidateId: "electron", value: 300, samples: [300] });
  });
  test("serializes a test's statistic after its results and a result's samples after its value", () => {
    const t = testOf(run, "lifecycle", "cold");
    expect(Object.keys(t)).toEqual(["id", "title", "description", "unit", "lowerIsBetter", "results", "statistic"]);
    expect(Object.keys(t.results[0])).toEqual(["candidateId", "value", "samples"]);
  });
  test("says what the step time and the protocol's warmups are", () => {
    expect(testOf(run, "parity", "table-step-p50").description).toContain("a mean of means and not a p50 despite the id");
    expect(run.protocol.processModel).toContain("count samples in a cell, not passes");
  });
  test("refuses a smoke run and a failed gate", () => {
    expect(() => buildRun({ ...raw(), smoke: true }, label)).toThrow("smoke");
    expect(() => buildRun({ ...raw(), gate: { ok: false } }, label)).toThrow("gate");
  });
});

describe("checkSamples", () => {
  test("passes the fresh run", () => {
    expect(() => checkSamples(run)).not.toThrow();
  });
  test("allows half a unit of the value's last decimal", () => {
    expect(tolerance(245)).toBeCloseTo(0.5 + 1e-9, 12);
    expect(tolerance(14.5)).toBeCloseTo(0.05 + 1e-9, 12);
    expect(tolerance(0.206)).toBeCloseTo(0.0005 + 1e-9, 12);
  });
  test("rejects a value its samples do not reproduce", () => {
    const bad: RunTests = { sections: [{ id: "s", tests: [{ id: "t", statistic: "mean", results: [{ candidateId: "c", value: 2.51, samples: [2, 3] }] }] }] };
    expect(() => checkSamples(bad)).toThrow("s/t/c: the mean of the samples is 2.5, the value 2.51");
    const fine: RunTests = { sections: [{ id: "s", tests: [{ id: "t", statistic: "median", results: [{ candidateId: "c", value: 2.5, samples: [1, 2, 3, 4] }] }] }] };
    expect(() => checkSamples(fine)).not.toThrow();
    const bare: RunTests = { sections: [{ id: "s", tests: [{ id: "t", statistic: "other", results: [{ candidateId: "c", value: 1 }] }] }] };
    expect(() => checkSamples(bare)).toThrow("s/t/c: no samples");
  });
});

describe("enrich", () => {
  const fresh = JSON.stringify(buildRun(raw(), label), null, 2) + "\n";
  /** The run as it was published before the contract: no statistic, no samples. */
  const stripped = (): Run => {
    const run: Run = JSON.parse(fresh);
    for (const s of run.sections) for (const t of s.tests) { delete t.statistic; for (const x of t.results) delete x.samples; }
    return run;
  };
  test("puts statistic and samples back and nothing else, through the file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "desktop-shells-"));
    const file = path.join(dir, "run.json");
    const before = JSON.stringify(stripped(), null, 2) + "\n";
    expect(before).not.toBe(fresh);
    writeFileSync(file, before);
    enrichFile(file, raw());
    expect(readFileSync(file, "utf8")).toBe(fresh);
  });
  test("keeps the published prose and is idempotent", () => {
    const run = stripped();
    run.sections[0].verdict.headline = "edited after import";
    const once = enrich(JSON.stringify(run, null, 2) + "\n", raw());
    const enriched: Run = JSON.parse(once);
    expect(enriched.sections[0].verdict.headline).toBe("edited after import");
    expect(enriched.sections[0].tests[0].statistic).toBe("other");
    expect(resultOf(enriched, "lifecycle", "cold", "tauri").samples).toEqual([1000.5, 1100.5]);
    expect(enrich(once, raw())).toBe(once);
  });
  test("refuses a results file that rebuilds a different value", () => {
    const perturbed = raw();
    perturbed.cold.tauri[0].spawnToFirstFrameMs += 100;
    expect(() => enrich(JSON.stringify(stripped(), null, 2) + "\n", perturbed)).toThrow("lifecycle/cold/tauri: published 1050.5, the results file rebuilds 1100.5");
  });
  test("refuses a file it did not write, another run's results, and a test the results do not have", () => {
    expect(() => enrich(JSON.stringify(stripped()) + "\n", raw())).toThrow("two-space JSON");
    const another = raw();
    another.finishedAt = "2026-01-03T00:00:00.000Z";
    expect(() => enrich(JSON.stringify(stripped(), null, 2) + "\n", another)).toThrow("rebuilds as 2026-01-03-testrig, not 2026-01-02-testrig");
    const extra = stripped();
    extra.sections[3].tests.push({ id: "signed", title: "Signed", description: "", unit: "MB", lowerIsBetter: true, results: [] });
    expect(() => enrich(JSON.stringify(extra, null, 2) + "\n", raw())).toThrow("size/signed is not in the rebuilt run");
  });
});

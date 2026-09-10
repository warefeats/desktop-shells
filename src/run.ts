// The protocol. Gate first; then every phase interleaves the two candidates
// pass by pass (A B A B ...), checkpointing results.json after every pass so
// a crash loses one pass, not the run.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { adapter } from "./os";
import { candidates, type Candidate, type CandidateId } from "./candidates";

const args = new Set(process.argv.slice(2));
const smoke = args.has("--smoke");
const gateOnly = args.has("--gate-only");
const only = [...args].find((a) => a.startsWith("--only="))?.slice(7).split(",") as Array<"cold" | "warm" | "ipc" | "parity" | "soak" | "size"> | undefined;
const outPath = [...args].find((a) => a.startsWith("--out="))?.slice(6) ?? "results.json";

export const PROTOCOL = smoke
  ? { coldStarts: 2, warmStarts: 2, ipcPasses: 1, ipcWarmups: 2, ipcIterations: 5, pushRate: 1000, pushSize: 1024, pushSeconds: 2, parityPasses: 1, parityWarmupFrames: 30, parityFrames: 120, soaks: 1, soakSeconds: 12, soakSegmentSeconds: 4, soakIpcEverySeconds: 2, settleMs: 1000 }
  : { coldStarts: 20, warmStarts: 10, ipcPasses: 4, ipcWarmups: 5, ipcIterations: 50, pushRate: 1000, pushSize: 1024, pushSeconds: 10, parityPasses: 5, parityWarmupFrames: 60, parityFrames: 600, soaks: 3, soakSeconds: 600, soakSegmentSeconds: 30, soakIpcEverySeconds: 5, settleMs: 3000 };

interface StartSample { pass: number; spawnToFirstFrameMs: number; hostToFirstFrameMs: number }
interface SoakSample { tMs: number; bytes: number; processes: Array<{ pid: number; name: string; bytes: number }> }

interface Results {
  schemaVersion: 1;
  startedAt: string;
  finishedAt?: string;
  smoke: boolean;
  rig: Record<string, unknown>;
  protocol: typeof PROTOCOL & { attributionRule: string; purge: "ok" | "unavailable"; launcher: string };
  candidates: Array<Pick<Candidate, "id" | "name" | "version" | "homepage" | "color"> & { webview?: string }>;
  gate: Record<string, unknown>;
  cold: Record<CandidateId, StartSample[]>;
  warm: Record<CandidateId, StartSample[]>;
  ipc: Record<CandidateId, unknown[]>;
  parity: Record<CandidateId, unknown[]>;
  soak: Record<CandidateId, Array<{ samples: SoakSample[]; report: unknown }>>;
  size: Record<CandidateId, { installerBytes: number; installedBytes: number; installerPath: string }>;
  notes: string[];
}

const os = adapter();
const cands = candidates();
const scratch = path.resolve("results");
mkdirSync(scratch, { recursive: true });

const empty = <T>(): Record<CandidateId, T[]> => ({ tauri: [], electron: [] });
const results: Results = existsSync(outPath) && !gateOnly && args.has("--resume")
  ? JSON.parse(readFileSync(outPath, "utf8"))
  : {
      schemaVersion: 1, startedAt: new Date().toISOString(), smoke, rig: os.rig(),
      protocol: { ...PROTOCOL, attributionRule: os.attribution.rule, purge: "ok", launcher: os.platform === "darwin" ? "open -n -W (LaunchServices) so the app is its own responsible process, with --disable-backgrounding-occluded-windows --disable-renderer-backgrounding passed to both shells (Chromium honors them, WKWebView has no equivalent and keeps rendering when covered)" : "direct spawn in the interactive session with --disable-features=CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding passed to both shells (argv for Electron, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS for WebView2); WebView2 and Electron helpers are children" },
      candidates: cands.map(({ id, name, version, homepage, color }) => ({ id, name, version, homepage, color })),
      gate: {}, cold: empty(), warm: empty(), ipc: empty(), parity: empty(), soak: empty(),
      size: {} as Results["size"], notes: [],
    };

function save() { writeFileSync(outPath, JSON.stringify(results, null, 2)); }
function log(s: string) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Report { ok: boolean; info: { shell: string; shellVersion: string; webview: string; mode: string }; result?: unknown; error?: string }

async function runMode(c: Candidate, mode: string, params: Record<string, unknown>, onLaunched?: (pid: number) => Promise<void> | void): Promise<{ report: Report; spawnToFirstFrameMs: number; hostToFirstFrameMs: number }> {
  const out = path.join(scratch, `${c.id}-${mode}.json`);
  if (existsSync(out)) writeFileSync(out, "");
  const stdout = path.join(scratch, `${c.id}-${mode}.log`);
  const timeout = mode === "soak" ? (Number(params.seconds) + 60) * 1000 : mode === "ipc" ? 20 * 60 * 1000 : 120 * 1000;
  const launched = await os.launch(c, { BENCH_MODE: mode, BENCH_PARAMS: JSON.stringify(params), BENCH_OUT: out }, stdout, timeout);
  const pid = launched.pid();
  if (!pid) { launched.kill(); throw new Error(`${c.id}: pid not found after launch`); }
  const hook = onLaunched ? onLaunched(pid) : Promise.resolve();
  await launched.exited;
  await hook;
  const text = launched.stdout();
  const m = text.match(/^FIRST_FRAME (\S+) (\S+)/m);
  if (!m) throw new Error(`${c.id} ${mode}: no FIRST_FRAME line in stdout:\n${text.slice(0, 500)}`);
  const raw = readFileSync(out, "utf8");
  if (!raw) throw new Error(`${c.id} ${mode}: no report written; stdout:\n${text.slice(0, 500)}`);
  const report = JSON.parse(raw) as Report;
  if (!report.ok) throw new Error(`${c.id} ${mode}: frontend error: ${report.error}`);
  return { report, spawnToFirstFrameMs: Number(m[1]) - launched.spawnedAtMs, hostToFirstFrameMs: Number(m[2]) };
}

/** Interleave: for pass in passes, for each candidate in alternating order. */
function* interleaved(passes: number): Generator<[number, Candidate]> {
  for (let p = 0; p < passes; p++) {
    const order = p % 2 === 0 ? cands : [...cands].reverse();
    for (const c of order) yield [p, c];
  }
}

const want = (phase: NonNullable<typeof only>[number]) => !only || only.includes(phase);

async function main() {
  if (process.platform === "darwin") {
    // Keep the display and system awake for the harness's lifetime: a slept
    // display stops animation frames in every webview and hangs a pass.
    const { spawn } = await import("node:child_process");
    spawn("caffeinate", ["-dis", "-w", String(process.pid)], { stdio: "ignore", detached: true }).unref();
  }
  log(`rig: ${JSON.stringify(results.rig)}`);
  log(`candidates: ${cands.map((c) => `${c.id}@${c.version}`).join(", ")}`);

  // Gate: byte-identical answers across hosts before anything counts.
  const gates: Record<string, Report> = {};
  for (const c of cands) {
    const { report } = await runMode(c, "gate", {});
    gates[c.id] = report;
    const cand = results.candidates.find((x) => x.id === c.id)!;
    cand.webview = report.info.webview;
    log(`gate ${c.id}: ${JSON.stringify(report.result)} webview=${report.info.webview}`);
  }
  const g = cands.map((c) => gates[c.id].result as { ok: boolean; rowsDigest: string; bytesDigest: string });
  const gateOk = g.every((r) => r.ok) && g.every((r) => r.rowsDigest === g[0].rowsDigest && r.bytesDigest === g[0].bytesDigest);
  results.gate = { ok: gateOk, perCandidate: Object.fromEntries(cands.map((c) => [c.id, gates[c.id].result])) };
  save();
  if (!gateOk) throw new Error("conformance gate failed; run is invalid");
  log("gate passed: identical digests on both hosts");
  if (gateOnly) return;

  // Size: static, measured once.
  if (want("size")) {
    for (const c of cands) {
      results.size[c.id] = { installerBytes: os.installerBytes(c), installedBytes: os.installedBytes(c), installerPath: path.relative(process.cwd(), c.installerPath) };
      log(`size ${c.id}: installer ${results.size[c.id].installerBytes} B, installed ${results.size[c.id].installedBytes} B`);
    }
    save();
  }

  // Cold starts: purge, launch, first frame, quit.
  if (want("cold")) {
    for (const [p, c] of interleaved(PROTOCOL.coldStarts)) {
      if (results.cold[c.id].some((s) => s.pass === p)) continue;
      if (!os.purge() && results.protocol.purge === "ok") { results.protocol.purge = "unavailable"; results.notes.push("purge unavailable: cold starts are not cold"); }
      await sleep(PROTOCOL.settleMs);
      const r = await runMode(c, "start", {});
      results.cold[c.id].push({ pass: p, spawnToFirstFrameMs: r.spawnToFirstFrameMs, hostToFirstFrameMs: r.hostToFirstFrameMs });
      log(`cold ${p} ${c.id}: ${r.spawnToFirstFrameMs.toFixed(1)} ms (host ${r.hostToFirstFrameMs.toFixed(1)})`);
      save();
    }
  }

  // Warm starts: same, no purge, immediately after a prior start.
  if (want("warm")) {
    for (const [p, c] of interleaved(PROTOCOL.warmStarts)) {
      if (results.warm[c.id].some((s) => s.pass === p)) continue;
      await runMode(c, "start", {});
      await sleep(500);
      const r = await runMode(c, "start", {});
      results.warm[c.id].push({ pass: p, spawnToFirstFrameMs: r.spawnToFirstFrameMs, hostToFirstFrameMs: r.hostToFirstFrameMs });
      log(`warm ${p} ${c.id}: ${r.spawnToFirstFrameMs.toFixed(1)} ms`);
      save();
    }
  }

  // IPC passes.
  if (want("ipc")) {
    for (const [p, c] of interleaved(PROTOCOL.ipcPasses)) {
      if (results.ipc[c.id].length > p) continue;
      await sleep(PROTOCOL.settleMs);
      const r = await runMode(c, "ipc", { warmups: PROTOCOL.ipcWarmups, iterations: PROTOCOL.ipcIterations, pushRate: PROTOCOL.pushRate, pushSize: PROTOCOL.pushSize, pushSeconds: PROTOCOL.pushSeconds });
      results.ipc[c.id].push({ pass: p, ...(r.report.result as object) });
      const cells = (r.report.result as { cells: Array<{ path: string; targetBytes: number; summary: { p50: number } }> }).cells;
      log(`ipc ${p} ${c.id}: ${cells.map((x) => `${x.path[0]}${x.targetBytes / 1024}k=${x.summary.p50.toFixed(2)}`).join(" ")}`);
      save();
    }
  }

  // Parity passes.
  if (want("parity")) {
    for (const [p, c] of interleaved(PROTOCOL.parityPasses)) {
      if (results.parity[c.id].length > p) continue;
      await sleep(PROTOCOL.settleMs);
      const r = await runMode(c, "parity", { warmupFrames: PROTOCOL.parityWarmupFrames, frames: PROTOCOL.parityFrames });
      results.parity[c.id].push({ pass: p, ...(r.report.result as object) });
      const t = (r.report.result as { results: Array<{ test: string; summary: { p50: number; p99: number }; stepMs: { p50: number } }> }).results;
      log(`parity ${p} ${c.id}: ${t.map((x) => `${x.test} p50=${x.summary.p50.toFixed(1)} p99=${x.summary.p99.toFixed(1)} step=${x.stepMs.p50.toFixed(2)}`).join(" | ")}`);
      save();
    }
  }

  // Soaks: sample footprint every second from outside.
  if (want("soak")) {
    for (const [p, c] of interleaved(PROTOCOL.soaks)) {
      if (results.soak[c.id].length > p) continue;
      await sleep(PROTOCOL.settleMs);
      const samples: SoakSample[] = [];
      const t0 = Date.now();
      let stop = false;
      const r = await runMode(c, "soak", { seconds: PROTOCOL.soakSeconds, segmentSeconds: PROTOCOL.soakSegmentSeconds, ipcEverySeconds: PROTOCOL.soakIpcEverySeconds }, async (pid) => {
        while (!stop) {
          const s = await os.attribution.sample(pid);
          if (s.bytes > 0) samples.push({ tMs: Date.now() - t0, bytes: s.bytes, processes: s.processes });
          await sleep(1000);
          // Stop when the process is gone.
          try { process.kill(pid, 0); } catch { stop = true; }
        }
      });
      stop = true;
      results.soak[c.id].push({ samples, report: r.report.result });
      const bytes = samples.map((s) => s.bytes);
      log(`soak ${p} ${c.id}: ${samples.length} samples, start ${(bytes[0] / 2 ** 20).toFixed(0)} MB, end ${(bytes[bytes.length - 1] / 2 ** 20).toFixed(0)} MB, peak ${(Math.max(...bytes) / 2 ** 20).toFixed(0)} MB`);
      save();
    }
  }

  results.finishedAt = new Date().toISOString();
  save();
  log(`done: ${outPath}`);
}

main().catch((e) => { console.error(e); save(); process.exit(1); });

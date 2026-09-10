// Platform adapter: launching, memory attribution, cache purge, sizes, rig
// description. Everything the protocol needs that differs by operating system.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Candidate } from "./candidates";

export interface Launched {
  /** Wall-clock ms when the launch command was issued. */
  spawnedAtMs: number;
  pid: () => number | undefined;
  /** Resolves when the process has exited; rejects on timeout. */
  exited: Promise<void>;
  stdout: () => string;
  kill: () => void;
}

export interface Attribution {
  rule: string;
  /** Total bytes plus the per-process breakdown. */
  sample: (pid: number) => Promise<{ bytes: number; processes: Array<{ pid: number; name: string; bytes: number }> }>;
}

export interface Adapter {
  platform: "darwin" | "win32";
  launch(c: Candidate, env: Record<string, string>, stdoutPath: string, timeoutMs: number): Promise<Launched>;
  /** Evict the OS file cache. Returns false if not permitted, in which case cold starts are invalid. */
  purge(): boolean;
  attribution: Attribution;
  installerBytes(c: Candidate): number;
  installedBytes(c: Candidate): number;
  rig(): Record<string, unknown>;
}

function duBytes(p: string): number {
  // Portable recursive size: walk, sum st_size. du -k rounds to blocks.
  const st = statSync(p);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    if (e.isSymbolicLink()) continue;
    total += e.isDirectory() ? duBytes(f) : statSync(f).size;
  }
  return total;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ---------------------------------------------------------------- darwin
const root = path.resolve(import.meta.dir, "..");
let responsibleBin: string | undefined;

function responsibleHelper(): string {
  if (responsibleBin) return responsibleBin;
  const out = path.join(mkdtempSync(path.join(tmpdir(), "ds-")), "responsible");
  execFileSync("clang", ["-O2", "-o", out, path.join(root, "tools/responsible.c")], { stdio: "pipe" });
  responsibleBin = out;
  return out;
}

/** Every pid whose responsible process is `pid`, itself included. */
export function coalition(pid: number): number[] {
  const text = execFileSync(responsibleHelper(), [], { encoding: "utf8" });
  const pids: number[] = [];
  for (const line of text.split("\n")) {
    const [p, r] = line.trim().split(/\s+/).map(Number);
    if (r === pid && Number.isFinite(p)) pids.push(p);
  }
  return pids;
}

function pidByExe(exe: string): number | undefined {
  const r = spawnSync("pgrep", ["-f", `^${exe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`], { encoding: "utf8" });
  const pids = r.stdout.trim().split("\n").filter(Boolean).map(Number);
  return pids.length ? Math.min(...pids) : undefined;
}

const darwin: Adapter = {
  platform: "darwin",
  async launch(c, env, stdoutPath, timeoutMs) {
    if (existsSync(stdoutPath)) unlinkSync(stdoutPath);
    const args = ["-n", "-W", "--stdout", stdoutPath, "--stderr", stdoutPath + ".err"];
    for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
    args.push(c.appPath);
    const spawnedAtMs = Date.now();
    // `open -W` returns when the app exits; the app is its own responsible
    // process under LaunchServices, which is what makes coalition() work.
    const child = spawn("open", args, { stdio: "ignore" });
    let pid: number | undefined;
    const exited = new Promise<void>((res, rej) => {
      const timer = setTimeout(() => { rej(new Error(`${c.id} did not exit within ${timeoutMs} ms`)); if (pid) try { process.kill(pid, "SIGKILL"); } catch {} }, timeoutMs);
      child.on("exit", () => { clearTimeout(timer); res(); });
    });
    for (let i = 0; i < 200 && !pid; i++) { pid = pidByExe(c.exePath); if (!pid) await sleep(25); }
    return {
      spawnedAtMs,
      pid: () => pid,
      exited,
      stdout: () => (existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : ""),
      kill: () => { if (pid && alive(pid)) try { process.kill(pid, "SIGKILL"); } catch {} },
    };
  },
  purge() {
    const r = spawnSync("sudo", ["-n", "/usr/sbin/purge"], { encoding: "utf8" });
    return r.status === 0;
  },
  attribution: {
    rule: "macOS: physical footprint (phys_footprint, as Activity Monitor's Memory column) summed over every process whose responsible process is the app, which includes WKWebView's WebContent, Networking and GPU helpers for the Tauri candidate and every Electron helper for the Electron candidate; read with /usr/bin/footprint.",
    async sample(pid) {
      const pids = coalition(pid);
      if (!pids.length) return { bytes: 0, processes: [] };
      const json = path.join(tmpdir(), `ds-fp-${process.pid}.json`);
      spawnSync("footprint", ["--noCategories", "-j", json, ...pids.map(String)], { stdio: "ignore" });
      if (!existsSync(json)) return { bytes: 0, processes: [] };
      const d = JSON.parse(readFileSync(json, "utf8"));
      unlinkSync(json);
      const processes = (d.processes as Array<{ pid: number; name: string; auxiliary?: { phys_footprint?: number }; footprint?: number }>).map((p) => ({ pid: p.pid, name: p.name, bytes: p.auxiliary?.phys_footprint ?? p.footprint ?? 0 }));
      return { bytes: processes.reduce((a, p) => a + p.bytes, 0), processes };
    },
  },
  installerBytes: (c) => statSync(c.installerPath).size,
  installedBytes: (c) => duBytes(c.appPath),
  rig() {
    const sysctl = (k: string) => execFileSync("sysctl", ["-n", k], { encoding: "utf8" }).trim();
    const sw = (k: string) => execFileSync("sw_vers", [k], { encoding: "utf8" }).trim();
    const displays = execFileSync("system_profiler", ["SPDisplaysDataType"], { encoding: "utf8" })
      .split("\n").filter((l) => /UI Looks like|Resolution:/.test(l)).map((l) => l.trim());
    return {
      machine: sysctl("hw.model"),
      chip: sysctl("machdep.cpu.brand_string"),
      cores: Number(sysctl("hw.ncpu")),
      memory: `${Math.round(Number(sysctl("hw.memsize")) / 2 ** 30)} GB`,
      os: `macOS ${sw("-productVersion")} (${sw("-buildVersion")})`,
      arch: process.arch,
      runtime: `bun ${Bun.version}`,
      display: displays.join("; "),
    };
  },
};

// ---------------------------------------------------------------- win32
function ps(script: string): string {
  return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" }).trim();
}

/** pid plus every descendant, from the Win32_Process parent chain. */
export function processTree(pid: number): Array<{ pid: number; name: string }> {
  const rows = JSON.parse(ps(`Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress`)) as Array<{ ProcessId: number; ParentProcessId: number; Name: string }>;
  const out = new Map<number, string>();
  const queue = [pid];
  while (queue.length) {
    const p = queue.shift()!;
    const me = rows.find((r) => r.ProcessId === p);
    out.set(p, me?.Name ?? "?");
    for (const r of rows) if (r.ParentProcessId === p && !out.has(r.ProcessId)) queue.push(r.ProcessId);
  }
  return [...out].map(([pid, name]) => ({ pid, name }));
}

const win32: Adapter = {
  platform: "win32",
  async launch(c, env, stdoutPath, timeoutMs) {
    const { openSync, closeSync } = await import("node:fs");
    const fd = openSync(stdoutPath, "w");
    const spawnedAtMs = Date.now();
    const child = spawn(c.appPath, [], { env: { ...process.env, ...env }, stdio: ["ignore", fd, fd] });
    const exited = new Promise<void>((res, rej) => {
      const timer = setTimeout(() => { rej(new Error(`${c.id} did not exit within ${timeoutMs} ms`)); child.kill(); }, timeoutMs);
      child.on("exit", () => { clearTimeout(timer); closeSync(fd); res(); });
    });
    return {
      spawnedAtMs,
      pid: () => child.pid,
      exited,
      stdout: () => (existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : ""),
      kill: () => child.kill(),
    };
  },
  purge() {
    // Windows has no purge; the standby list is emptied with Sysinternals RAMMap if present.
    const r = spawnSync("RAMMap64.exe", ["-Ew"], { encoding: "utf8" });
    return r.status === 0;
  },
  attribution: {
    rule: "Windows: private working set (Win32_PerfFormattedData_PerfProc_Process.WorkingSetPrivate) summed over the app process and every descendant by parent process id, which includes msedgewebview2.exe for the Tauri candidate and every Electron helper for the Electron candidate.",
    async sample(pid) {
      const tree = processTree(pid);
      const ids = tree.map((t) => t.pid);
      const rows = JSON.parse(ps(`Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { @(${ids.join(",")}) -contains $_.IDProcess } | Select-Object IDProcess,Name,WorkingSetPrivate | ConvertTo-Json -Compress`) || "[]");
    const list = Array.isArray(rows) ? rows : [rows];
      const processes = list.map((r: { IDProcess: number; Name: string; WorkingSetPrivate: number }) => ({ pid: r.IDProcess, name: r.Name, bytes: Number(r.WorkingSetPrivate) }));
      return { bytes: processes.reduce((a: number, p: { bytes: number }) => a + p.bytes, 0), processes };
    },
  },
  installerBytes: (c) => statSync(c.installerPath).size,
  installedBytes: (c) => duBytes(path.dirname(c.appPath)),
  rig() {
    const j = JSON.parse(ps(`@{ cpu=(Get-CimInstance Win32_Processor).Name; cores=(Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors; mem=(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory; os=(Get-CimInstance Win32_OperatingSystem).Caption; build=(Get-CimInstance Win32_OperatingSystem).BuildNumber; model=(Get-CimInstance Win32_ComputerSystem).Model; gpu=((Get-CimInstance Win32_VideoController).Name -join '; '); driver=((Get-CimInstance Win32_VideoController).DriverVersion -join '; '); hz=((Get-CimInstance Win32_VideoController).CurrentRefreshRate -join '; ') } | ConvertTo-Json -Compress`));
    return {
      machine: j.model, chip: j.cpu, cores: Number(j.cores), memory: `${Math.round(Number(j.mem) / 2 ** 30)} GB`,
      os: `${j.os} (build ${j.build})`, arch: process.arch, runtime: `bun ${Bun.version}`, gpu: `${j.gpu} (driver ${j.driver})`, display: `${j.hz} Hz`,
    };
  },
};

export function adapter(): Adapter {
  if (process.platform === "darwin") return darwin;
  if (process.platform === "win32") return win32;
  throw new Error(`unsupported platform ${process.platform}`);
}

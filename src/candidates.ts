// The two candidates and where each shell's default build puts its artifacts.
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import path from "node:path";

export type CandidateId = "tauri" | "electron";

export interface Candidate {
  id: CandidateId;
  name: string;
  version: string;
  homepage: string;
  color: string;
  /** macOS .app bundle or Windows unpacked exe; what `open`/spawn launches. */
  appPath: string;
  /** Executable inside the bundle; used to find the pid. */
  exePath: string;
  /** Installer produced by the default build: dmg on macOS, nsis exe on Windows. */
  installerPath: string;
}

const root = path.resolve(import.meta.dir, "..");

function one(pattern: string, what: string): string {
  const hits = globSync(pattern, { cwd: root }).map((p) => path.join(root, p));
  if (hits.length !== 1) throw new Error(`expected exactly one ${what} at ${pattern}, found ${hits.length}: ${hits.join(", ")}`);
  return hits[0];
}

export function tauriVersion(): string {
  const lock = readFileSync(path.join(root, "hosts/tauri/Cargo.lock"), "utf8");
  const m = lock.match(/name = "tauri"\nversion = "([^"]+)"/);
  if (!m) throw new Error("tauri version not found in Cargo.lock");
  return m[1];
}

export function electronVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(root, "hosts/electron/node_modules/electron/package.json"), "utf8"));
  return pkg.version as string;
}

export function candidates(platform: NodeJS.Platform = process.platform): Candidate[] {
  if (platform === "darwin") {
    return [
      {
        id: "tauri", name: "tauri", version: tauriVersion(), homepage: "https://tauri.app", color: "#24c8db",
        appPath: one("hosts/tauri/target/release/bundle/macos/desktop-shells-tauri.app", "Tauri app"),
        exePath: one("hosts/tauri/target/release/bundle/macos/desktop-shells-tauri.app/Contents/MacOS/desktop-shells-tauri", "Tauri exe"),
        installerPath: one("hosts/tauri/target/release/bundle/dmg/*.dmg", "Tauri dmg"),
      },
      {
        id: "electron", name: "electron", version: electronVersion(), homepage: "https://www.electronjs.org", color: "#9feaf9",
        appPath: one("hosts/electron/out/mac*/desktop-shells-electron.app", "Electron app"),
        exePath: one("hosts/electron/out/mac*/desktop-shells-electron.app/Contents/MacOS/desktop-shells-electron", "Electron exe"),
        installerPath: one("hosts/electron/out/*.dmg", "Electron dmg"),
      },
    ];
  }
  if (platform === "win32") {
    return [
      {
        id: "tauri", name: "tauri", version: tauriVersion(), homepage: "https://tauri.app", color: "#24c8db",
        appPath: one("hosts/tauri/target/release/desktop-shells-tauri.exe", "Tauri exe"),
        exePath: one("hosts/tauri/target/release/desktop-shells-tauri.exe", "Tauri exe"),
        installerPath: one("hosts/tauri/target/release/bundle/nsis/*-setup.exe", "Tauri nsis installer"),
      },
      {
        id: "electron", name: "electron", version: electronVersion(), homepage: "https://www.electronjs.org", color: "#9feaf9",
        appPath: one("hosts/electron/out/win-unpacked/desktop-shells-electron.exe", "Electron exe"),
        exePath: one("hosts/electron/out/win-unpacked/desktop-shells-electron.exe", "Electron exe"),
        installerPath: one("hosts/electron/out/*Setup*.exe", "Electron nsis installer"),
      },
    ];
  }
  throw new Error(`unsupported platform ${platform}`);
}

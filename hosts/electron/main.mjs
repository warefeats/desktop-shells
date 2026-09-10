// The Electron host: the command surface and nothing else. Idiomatic path is
// ipcMain.handle with structured clone; raw path is Uint8Array over invoke
// and MessageChannelMain for push, which is what Electron's docs recommend.
import { app, BrowserWindow, ipcMain, MessageChannelMain } from "electron";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const started = performance.now();
const mode = process.env.BENCH_MODE ?? "start";
let params = {};
try { params = JSON.parse(process.env.BENCH_PARAMS ?? "{}"); } catch {}
const out = process.env.BENCH_OUT;

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = app.isPackaged ? path.join(process.resourcesPath, "frontend") : path.join(here, "..", "..", "frontend", "dist");

let win;

function pace(rate, count, f) {
  const interval = 1000 / rate;
  const t0 = performance.now();
  let seq = 0;
  const tick = () => {
    const now = performance.now();
    while (seq < count && t0 + seq * interval <= now) f(seq++);
    if (seq < count) setTimeout(tick, Math.max(0, t0 + seq * interval - performance.now()));
  };
  tick();
}

ipcMain.handle("info", () => ({
  shell: "electron",
  shellVersion: process.versions.electron,
  webview: `Chromium ${process.versions.chrome}`,
  mode,
  params,
}));
ipcMain.handle("first_frame", () => {
  process.stdout.write(`FIRST_FRAME ${Date.now()} ${(performance.now() - started).toFixed(3)}\n`);
});
ipcMain.handle("report", (_e, json) => {
  if (out) writeFileSync(out, json); else process.stdout.write(`REPORT ${json}\n`);
});
ipcMain.handle("quit", () => { app.exit(0); });
ipcMain.handle("log", (_e, msg) => { process.stdout.write(`LOG ${msg}\n`); });
ipcMain.handle("rows", (_e, rows) => rows);
ipcMain.handle("bytes", (_e, data) => data);
ipcMain.handle("push_start", (_e, { rate, size, count }) => {
  const s = "x".repeat(size);
  pace(rate, count, (seq) => win.webContents.send("push", { seq, t: Date.now(), s }));
});
ipcMain.handle("push_raw_start", (e, { rate, size, count }) => {
  const { port1, port2 } = new MessageChannelMain();
  e.sender.postMessage("port", null, [port2]);
  const buf = new Uint8Array(Math.max(4, size));
  pace(rate, count, (seq) => {
    new DataView(buf.buffer).setUint32(0, seq, true);
    port1.postMessage(buf);
  });
});

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1280,
    height: 720,
    useContentSize: true,
    resizable: false,
    title: "desktop-shells",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.env.BENCH_DEBUG) {
    win.webContents.on("console-message", (ev) => process.stderr.write(`renderer: ${ev.message}\n`));
  }
  win.loadFile(path.join(frontend, "index.html"));
});
app.on("window-all-closed", () => app.quit());

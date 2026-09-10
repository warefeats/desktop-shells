// Entry: read the mode from the host, run it, report, quit. The host owns
// nothing about the tests; it only relays the mode and writes the report.
import { detect } from "./bridge";
import { runGate } from "./gate";
import { runIpc, type IpcParams } from "./ipc";
import { runParity, type ParityParams } from "./parity";
import { runSoak, type SoakParams } from "./soak";
import { nextFrame } from "./stats";

const stage = document.getElementById("stage")!;
const statusEl = document.getElementById("status")!;
let logger: ((m: string) => void) | undefined;
const setStatus = (s: string) => { statusEl.textContent = s; console.log(`status: ${s}`); logger?.(`status: ${s}`); };
window.addEventListener("error", (e) => logger?.(`error: ${e.message} ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => logger?.(`unhandledrejection: ${String((e.reason && e.reason.stack) || e.reason)}`));

async function main() {
  const b = detect();
  logger = (m) => { b.log(m).catch(() => {}); };
  const tNav = performance.now();
  // First frame marker: the first animation frame after the bundle ran.
  await nextFrame();
  await b.firstFrame();
  const info = await b.info();
  setStatus(`${info.shell} ${info.shellVersion} mode=${info.mode}`);
  const params = info.params as Record<string, number>;
  let result: unknown;
  try {
    switch (info.mode) {
      case "start":
        result = { firstFrameAfterScriptMs: tNav };
        break;
      case "gate":
        result = await runGate(b);
        break;
      case "ipc":
        result = await runIpc(b, { warmups: params.warmups ?? 20, iterations: params.iterations ?? 200, pushRate: params.pushRate ?? 1000, pushSize: params.pushSize ?? 1024, pushSeconds: params.pushSeconds ?? 10 } satisfies IpcParams, setStatus);
        break;
      case "parity":
        result = await runParity(stage, { warmupFrames: params.warmupFrames ?? 60, frames: params.frames ?? 600 } satisfies ParityParams, setStatus);
        break;
      case "soak":
        result = await runSoak(b, stage, { seconds: params.seconds ?? 600, segmentSeconds: params.segmentSeconds ?? 30, ipcEverySeconds: params.ipcEverySeconds ?? 5 } satisfies SoakParams, setStatus);
        break;
      default:
        throw new Error(`unknown mode ${info.mode}`);
    }
    await b.report(JSON.stringify({ ok: true, info, result }));
  } catch (e) {
    await b.report(JSON.stringify({ ok: false, info, error: String(e && (e as Error).stack || e) }));
  }
  setStatus("done");
  await b.quit();
}

main().catch((e) => { setStatus(`fatal: ${e}`); console.error(e); });

// The command surface, as the frontend sees it. One interface, two
// implementations: Tauri's global invoke and the Electron preload's exposed
// object. Everything above this file is shell-agnostic.
import type { Row } from "./payload";

export interface Info {
  shell: "tauri" | "electron";
  shellVersion: string;
  webview: string;
  mode: string;
  params: Record<string, unknown>;
}

export interface Bridge {
  info(): Promise<Info>;
  firstFrame(): Promise<void>;
  report(json: string): Promise<void>;
  quit(): Promise<void>;
  log(msg: string): Promise<void>;
  /** Idiomatic path: JSON in, JSON out. */
  rows(rows: Row[]): Promise<Row[]>;
  /** Raw path: bytes in, bytes out. */
  bytes(data: Uint8Array): Promise<Uint8Array>;
  /** Idiomatic push: host emits `count` events of `size` bytes at `rate` per second. */
  pushStart(rate: number, size: number, count: number, onEvent: (seq: number, tHost: number) => void): Promise<void>;
  /** Raw push: same, over the shell's bytes channel. */
  pushRawStart(rate: number, size: number, count: number, onChunk: (seq: number) => void): Promise<void>;
}

interface TauriGlobal {
  core: { invoke: (cmd: string, args?: unknown) => Promise<unknown>; Channel: new () => { onmessage: (m: unknown) => void } };
  event: { listen: (name: string, cb: (e: { payload: unknown }) => void) => Promise<() => void> };
}

interface ElectronShell {
  invoke: (cmd: string, arg?: unknown) => Promise<unknown>;
  onPush: (cb: (payload: { seq: number; t: number; s: string }) => void) => () => void;
}

/** The preload forwards the MessagePort with window.postMessage("port", "*", [port]). */
function nextPort(): Promise<MessagePort> {
  return new Promise((res) => {
    const h = (ev: MessageEvent) => { if (ev.data === "port" && ev.ports[0]) { window.removeEventListener("message", h); res(ev.ports[0]); } };
    window.addEventListener("message", h);
  });
}

declare global {
  interface Window { __TAURI__?: TauriGlobal; shell?: ElectronShell }
}

function tauriBridge(t: TauriGlobal): Bridge {
  const inv = t.core.invoke;
  return {
    info: () => inv("info") as Promise<Info>,
    firstFrame: () => inv("first_frame") as Promise<void>,
    report: (json) => inv("report", { json }) as Promise<void>,
    quit: () => inv("quit") as Promise<void>,
    log: (msg) => inv("log", { msg }) as Promise<void>,
    rows: (rows) => inv("rows", { rows }) as Promise<Row[]>,
    bytes: async (data) => {
      const r = await inv("bytes", data);
      return r instanceof ArrayBuffer ? new Uint8Array(r) : (r as Uint8Array);
    },
    pushStart: async (rate, size, count, onEvent) => {
      const un = await t.event.listen("push", (e) => {
        const p = e.payload as { seq: number; t: number };
        onEvent(p.seq, p.t);
      });
      await inv("push_start", { rate, size, count });
      pending.push(un);
    },
    pushRawStart: async (rate, size, count, onChunk) => {
      const ch = new t.core.Channel();
      ch.onmessage = (m) => {
        const u8 = m instanceof ArrayBuffer ? new Uint8Array(m) : (m as Uint8Array);
        onChunk(new DataView(u8.buffer, u8.byteOffset).getUint32(0, true));
      };
      await inv("push_raw_start", { rate, size, count, channel: ch });
    },
  };
}

const pending: Array<() => void> = [];

function electronBridge(s: ElectronShell): Bridge {
  return {
    info: () => s.invoke("info") as Promise<Info>,
    firstFrame: () => s.invoke("first_frame") as Promise<void>,
    report: (json) => s.invoke("report", json) as Promise<void>,
    quit: () => s.invoke("quit") as Promise<void>,
    log: (msg) => s.invoke("log", msg) as Promise<void>,
    rows: (rows) => s.invoke("rows", rows) as Promise<Row[]>,
    bytes: (data) => s.invoke("bytes", data) as Promise<Uint8Array>,
    pushStart: async (rate, size, count, onEvent) => {
      const un = s.onPush((p) => onEvent(p.seq, p.t));
      pending.push(un);
      await s.invoke("push_start", { rate, size, count });
    },
    pushRawStart: async (rate, size, count, onChunk) => {
      const ready = nextPort();
      await s.invoke("push_raw_start", { rate, size, count });
      const port = await ready;
      port.onmessage = (ev) => {
        const u8 = ev.data as Uint8Array;
        onChunk(new DataView(u8.buffer, u8.byteOffset).getUint32(0, true));
      };
      port.start();
    },
  };
}

export function detect(): Bridge {
  if (window.__TAURI__) return tauriBridge(window.__TAURI__);
  if (window.shell) return electronBridge(window.shell);
  throw new Error("no shell bridge on window");
}

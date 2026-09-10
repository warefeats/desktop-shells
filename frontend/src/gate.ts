// Conformance gate: every host must return exactly what it was sent on both
// paths, and the digests of what came back are reported so the harness can
// compare them across hosts. Identical digests on identical seeds is the gate.
import type { Bridge } from "./bridge";
import { bytes, fnv1a64, rows, utf8 } from "./payload";

export async function runGate(b: Bridge) {
  const seed = 42;
  const sentRows = rows(seed, 1000);
  const backRows = await b.rows(sentRows);
  const rowsSent = JSON.stringify(sentRows), rowsBack = JSON.stringify(backRows);
  const sentBytes = bytes(seed, 65536);
  const backBytes = await b.bytes(sentBytes);
  let bytesEqual = backBytes.byteLength === sentBytes.byteLength;
  for (let i = 0; bytesEqual && i < sentBytes.length; i++) if (sentBytes[i] !== backBytes[i]) bytesEqual = false;
  // Push: 100 events at 100/s on each path, count them.
  let idio = 0, raw = 0;
  await b.pushStart(100, 256, 100, () => idio++);
  await b.pushRawStart(100, 256, 100, () => raw++);
  await new Promise((r) => setTimeout(r, 2500));
  return {
    rowsEqual: rowsSent === rowsBack,
    rowsDigest: fnv1a64(utf8(rowsBack)),
    bytesEqual,
    bytesDigest: fnv1a64(backBytes),
    pushIdiomaticDelivered: idio,
    pushRawDelivered: raw,
    ok: rowsSent === rowsBack && bytesEqual && idio === 100 && raw === 100,
  };
}

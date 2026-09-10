import { describe, expect, test } from "bun:test";
import { bytes, fnv1a64, rows, rowsForBytes, utf8 } from "../frontend/src/payload";

describe("payload", () => {
  test("rows are deterministic for a seed", () => {
    expect(JSON.stringify(rows(42, 10))).toBe(JSON.stringify(rows(42, 10)));
    expect(JSON.stringify(rows(42, 10))).not.toBe(JSON.stringify(rows(43, 10)));
  });
  test("bytes are deterministic for a seed", () => {
    expect(fnv1a64(bytes(7, 1024))).toBe(fnv1a64(bytes(7, 1024)));
  });
  test("fnv1a64 matches the reference vector", () => {
    // FNV-1a 64 of "a" is af63dc4c8601ec8c
    expect(fnv1a64(utf8("a"))).toBe("af63dc4c8601ec8c");
  });
  test("rowsForBytes lands within ten percent", () => {
    const n = rowsForBytes(1, 65536);
    const actual = JSON.stringify(rows(1, n)).length;
    expect(Math.abs(actual - 65536) / 65536).toBeLessThan(0.1);
  });
});

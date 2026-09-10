import { describe, expect, test } from "bun:test";
import { geomean, median, quantile, round } from "../src/stats";

describe("stats", () => {
  test("quantile interpolates", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([5], 0.99)).toBe(5);
  });
  test("median ignores order", () => {
    expect(median([3, 1, 2])).toBe(2);
  });
  test("geomean of reciprocal ratios is 1", () => {
    expect(round(geomean([2, 0.5]), 6)).toBe(1);
    expect(round(geomean([4, 1]), 6)).toBe(2);
  });
});

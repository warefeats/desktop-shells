export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
export function median(xs: number[]): number { return quantile([...xs].sort((a, b) => a - b), 0.5); }
export function mean(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length; }
export function geomean(ratios: number[]): number { return Math.exp(mean(ratios.map(Math.log))); }
export function round(x: number, d = 3): number { const f = 10 ** d; return Math.round(x * f) / f; }

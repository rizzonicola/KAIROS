export function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

function variance(values: number[]): number {
  const m = (mean(values) as number);
  return values.reduce((s, v) => s + (v - m) * (v - m), 0) / Math.max(1, values.length - 1);
}

/** Two-sided Welch test with a normal approximation of the t distribution (descriptive only). */
export function welchP(a: number[], b: number[]): number | null {
  if (a.length < 2 || b.length < 2) {
    return null;
  }
  const se = Math.sqrt(variance(a) / a.length + variance(b) / b.length);
  if (se === 0) {
    return (mean(a) as number) === (mean(b) as number) ? 1 : 0;
  }
  const z = Math.abs(((mean(a) as number) - (mean(b) as number)) / se);
  // erfc approximation (Abramowitz-Stegun 7.1.26)
  const t = 1 / (1 + 0.3275911 * (z / Math.SQRT2));
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return poly * Math.exp(-(z * z) / 2);
}

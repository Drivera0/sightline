// The honest baseline for "how soon does the queue reach every photo with a person": the same
// survey paged through in a uniformly random order. Pure maths on metrics.ranking's N and k.
//
// For N frames of which k contain a person, shuffled uniformly, let L be the position of the last
// positive frame. L <= m exactly when all k positives fall in the first m positions, so
//   P(L <= m) = C(m, k) / C(N, k) = prod_{i=0}^{k-1} (m - i) / (N - i),
// and the expectation is E[L] = k (N + 1) / (k + 1) (the maximum of k draws without replacement
// from 1..N; e.g. N = 500, k = 6 gives 3006 / 7 = 429.4). The first positive mirrors it:
// E[F] = (N + 1) / (k + 1).

/** Expected position (1-based) of the last positive frame in a uniformly random order. */
export function expectedLastPositive(n: number, k: number): number {
  assertCounts(n, k);
  return (k * (n + 1)) / (k + 1);
}

/** Expected position (1-based) of the first positive frame in a uniformly random order. */
export function expectedFirstPositive(n: number, k: number): number {
  assertCounts(n, k);
  return (n + 1) / (k + 1);
}

/** P(last positive is at position <= m) for a uniformly random order; exact. */
export function lastPositiveCdf(n: number, k: number, m: number): number {
  assertCounts(n, k);
  if (m < k) return 0;
  if (m >= n) return 1;
  let p = 1;
  for (let i = 0; i < k; i++) p *= (m - i) / (n - i);
  return p;
}

/**
 * The q-quantile of the last positive's position: the smallest m with P(L <= m) >= q.
 * Exact (no simulation), so the 10th-90th percentile spread needs no seed.
 */
export function lastPositiveQuantile(n: number, k: number, q: number): number {
  assertCounts(n, k);
  if (!(q > 0 && q <= 1)) throw new RangeError(`quantile must be in (0, 1], got ${q}`);
  // The CDF is increasing in m, so binary search over k..n. A tiny tolerance keeps floating-point
  // rounding from skipping a position whose CDF is exactly q in exact arithmetic.
  let lo = k;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lastPositiveCdf(n, k, mid) >= q - 1e-12) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export interface RandomOrderBaseline {
  /** E[last positive], 1-based position. */
  expectedAll: number;
  /** E[first positive], 1-based position. */
  expectedFirst: number;
  /** 10th and 90th percentile of the last positive's position. */
  p10All: number;
  p90All: number;
}

/** Everything the Results page shows for a random order, or null when there is nothing to rank. */
export function randomOrderBaseline(n: number, k: number): RandomOrderBaseline | null {
  if (!(Number.isInteger(n) && Number.isInteger(k)) || k < 1 || n < 1 || k >= n) return null;
  return {
    expectedAll: expectedLastPositive(n, k),
    expectedFirst: expectedFirstPositive(n, k),
    p10All: lastPositiveQuantile(n, k, 0.1),
    p90All: lastPositiveQuantile(n, k, 0.9),
  };
}

function assertCounts(n: number, k: number): void {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 1 || n < k) {
    throw new RangeError(`need integers 1 <= k <= n, got n=${n}, k=${k}`);
  }
}

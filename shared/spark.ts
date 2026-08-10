/**
 * A smooth line that cannot lie about the numbers under it.
 *
 * A polyline through an equity curve reads as a jagged mess at sparkline size,
 * but the obvious fix — a plain Catmull-Rom spline — overshoots between
 * points: the drawn curve dips below a local minimum, which on an equity chart
 * invents a drawdown that never happened. That is not a cosmetic detail. The
 * whole reason to look at the shape is to see how deep the bad stretches went.
 *
 * So this uses Fritsch-Carlson monotone cubic interpolation, which constrains
 * the tangents so the curve never leaves the range of the values it connects.
 * Between two closed trades the line is invented either way — but a monotone
 * curve only invents the path, never a new high or a new low.
 */

export interface Pt {
  x: number;
  y: number;
}

/**
 * An SVG path through the points, smoothed but bounded. Falls back to a
 * straight line for one segment and returns "" for fewer than two points.
 * `x` must be non-decreasing (a curve is a series in order, not a scatter).
 */
export function monotonePath(pts: Pt[]): string {
  if (pts.length < 2) return "";
  const n = pts.length;
  const move = `M${fmt(pts[0].x)},${fmt(pts[0].y)}`;
  if (n === 2) return `${move} L${fmt(pts[1].x)},${fmt(pts[1].y)}`;

  // Secant slopes between consecutive points.
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = pts[i + 1].x - pts[i].x;
    d.push(h === 0 ? 0 : (pts[i + 1].y - pts[i].y) / h);
  }

  // Tangents: the average of the neighbouring secants, flattened at every
  // turning point so the curve settles rather than swinging past.
  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  }

  // Fritsch-Carlson: pull any tangent back inside the circle of radius 3, the
  // condition that guarantees no overshoot on either side of the segment.
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }

  let out = move;
  for (let i = 0; i < n - 1; i++) {
    const h = pts[i + 1].x - pts[i].x;
    const c1x = pts[i].x + h / 3;
    const c1y = pts[i].y + (m[i] * h) / 3;
    const c2x = pts[i + 1].x - h / 3;
    const c2y = pts[i + 1].y - (m[i + 1] * h) / 3;
    out += ` C${fmt(c1x)},${fmt(c1y)} ${fmt(c2x)},${fmt(c2y)} ${fmt(pts[i + 1].x)},${fmt(
      pts[i + 1].y,
    )}`;
  }
  return out;
}

const fmt = (v: number) => (Math.round(v * 10) / 10).toString();

/**
 * Every point the curve passes through, sampled per segment.
 *
 * Only used to prove the no-overshoot property in tests — the browser never
 * needs it, because the constraint is enforced when the tangents are built.
 */
export function sampleCubic(pts: Pt[], perSegment = 12): Pt[] {
  const path = monotonePath(pts);
  if (!path) return [];
  const nums = path.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
  const out: Pt[] = [{ x: nums[0], y: nums[1] }];
  // After the initial M pair, each C contributes 6 numbers.
  for (let i = 2; i + 5 < nums.length; i += 6) {
    const p0 = out[out.length - 1];
    const [c1x, c1y, c2x, c2y, px, py] = nums.slice(i, i + 6);
    for (let s = 1; s <= perSegment; s++) {
      const t = s / perSegment;
      const u = 1 - t;
      out.push({
        x: u ** 3 * p0.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t ** 3 * px,
        y: u ** 3 * p0.y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t ** 3 * py,
      });
    }
  }
  return out;
}

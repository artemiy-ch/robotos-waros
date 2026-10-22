import { Vector3 } from "@babylonjs/core";

/**
 * The real outline of a building whose mesh doesn't fill its bounding box (the Moon's domes,
 * towers and stepped modules), so shots, decals and footing follow what's actually there.
 * Rays may be unnormalised (t is then in units of d).
 */
export interface Shape {
  ray(o: Vector3, d: Vector3, maxT: number): { t: number; normal: Vector3 } | null;
  /** Height of the roof at (x, z), 0 off it. */
  heightAt(x: number, z: number): number;
  /** Pushes a circle of radius r at p (on the XZ plane) out of the solid parts level with it. */
  push(p: Vector3, r: number): void;
}

/** Pushes p out of a circle of radius R round (x, z). */
function pushRound(p: Vector3, x: number, z: number, R: number) {
  const dx = p.x - x, dz = p.z - z;
  const d = Math.hypot(dx, dz);
  if (d >= R) return;
  if (d < 1e-6) p.x = x + R;
  else {
    p.x = x + (dx / d) * R;
    p.z = z + (dz / d) * R;
  }
}

type Hit = { t: number; normal: Vector3 } | null;
const nearer = (a: Hit, b: Hit) => (!a ? b : !b ? a : a.t <= b.t ? a : b);

/** A vertical cylinder standing from y0 to y1. */
export function cylinder(x: number, z: number, r: number, y0: number, y1: number): Shape {
  return {
    heightAt: (px, pz) => ((px - x) ** 2 + (pz - z) ** 2 <= r * r ? y1 : 0),
    push(p, pr) {
      if (p.y >= y1 - 0.01 || p.y < y0 - 3) return;
      pushRound(p, x, z, r + pr);
    },
    ray(o, d, maxT) {
      let best: Hit = null;
      const ox = o.x - x, oz = o.z - z;
      const a = d.x * d.x + d.z * d.z;
      if (a > 1e-12) {
        const b = ox * d.x + oz * d.z;
        const disc = b * b - a * (ox * ox + oz * oz - r * r);
        if (disc >= 0) {
          const t = (-b - Math.sqrt(disc)) / a;
          const y = o.y + d.y * t;
          if (t >= 0 && t < maxT && y >= y0 && y <= y1) {
            best = { t, normal: new Vector3(ox + d.x * t, 0, oz + d.z * t).normalize() };
          }
        }
      }
      // The flat top.
      if (d.y < 0) {
        const t = (y1 - o.y) / d.y;
        if (t >= 0 && t < maxT && (ox + d.x * t) ** 2 + (oz + d.z * t) ** 2 <= r * r) best = nearer(best, { t, normal: new Vector3(0, 1, 0) });
      }
      return best;
    },
  };
}

/** The upper half of an ellipsoid centred at (x, y, z): a dome or a rounded top. */
export function dome(x: number, y: number, z: number, rx: number, ry: number, rz: number): Shape {
  const heightAt = (px: number, pz: number) => {
    const k = 1 - ((px - x) / rx) ** 2 - ((pz - z) / rz) ** 2;
    return k > 0 ? y + ry * Math.sqrt(k) : 0;
  };
  return {
    heightAt,
    push(p, pr) {
      if (p.y >= y + ry - 0.01 || p.y < y - 3) return;
      // Standing on the curve itself: leave it alone.
      const top = heightAt(p.x, p.z);
      if (top > 0 && p.y >= top - 0.05) return;
      // How wide the dome is at this height.
      const k = p.y <= y ? 1 : 1 - ((p.y - y) / ry) ** 2;
      if (k <= 0) return;
      pushRound(p, x, z, Math.min(rx, rz) * Math.sqrt(k) + pr);
    },
    ray(o, d, maxT) {
      // Scale space so the ellipsoid becomes the unit sphere.
      const ox = (o.x - x) / rx, oy = (o.y - y) / ry, oz = (o.z - z) / rz;
      const dx = d.x / rx, dy = d.y / ry, dz = d.z / rz;
      const a = dx * dx + dy * dy + dz * dz;
      const b = ox * dx + oy * dy + oz * dz;
      const disc = b * b - a * (ox * ox + oy * oy + oz * oz - 1);
      if (disc < 0) return null;
      for (const t of [(-b - Math.sqrt(disc)) / a, (-b + Math.sqrt(disc)) / a]) {
        if (t < 0 || t >= maxT) continue;
        const py = o.y + d.y * t;
        if (py < y) continue; // only the upper half exists
        const px = o.x + d.x * t, pz = o.z + d.z * t;
        return { t, normal: new Vector3((px - x) / (rx * rx), (py - y) / (ry * ry), (pz - z) / (rz * rz)).normalize() };
      }
      return null;
    },
  };
}

/** An axis-aligned box from y0 to y1. */
export function block(minX: number, maxX: number, minZ: number, maxZ: number, y0: number, y1: number): Shape {
  return {
    heightAt: (px, pz) => (px >= minX && px <= maxX && pz >= minZ && pz <= maxZ ? y1 : 0),
    push(p, r) {
      if (p.y >= y1 - 0.01 || p.y < y0 - 3) return;
      const cx = Math.max(minX, Math.min(maxX, p.x)), cz = Math.max(minZ, Math.min(maxZ, p.z));
      const dx = p.x - cx, dz = p.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) return;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        p.x = cx + (dx / d) * r;
        p.z = cz + (dz / d) * r;
        return;
      }
      const pen = [p.x - minX, maxX - p.x, p.z - minZ, maxZ - p.z];
      const m = Math.min(...pen);
      if (m === pen[0]) p.x = minX - r;
      else if (m === pen[1]) p.x = maxX + r;
      else if (m === pen[2]) p.z = minZ - r;
      else p.z = maxZ + r;
    },
    ray(o, d, maxT) {
      let t0 = 0, t1 = maxT;
      let normal = new Vector3(0, 1, 0);
      const axes: [number, number, number, number, Vector3][] = [
        [o.x, d.x, minX, maxX, new Vector3(1, 0, 0)],
        [o.y, d.y, y0, y1, new Vector3(0, 1, 0)],
        [o.z, d.z, minZ, maxZ, new Vector3(0, 0, 1)],
      ];
      for (const [p, v, lo, hi, n] of axes) {
        if (Math.abs(v) < 1e-12) {
          if (p < lo || p > hi) return null;
          continue;
        }
        let a = (lo - p) / v, c = (hi - p) / v;
        if (a > c) [a, c] = [c, a];
        if (a > t0) {
          t0 = a;
          normal = n.scale(v > 0 ? -1 : 1);
        }
        t1 = Math.min(t1, c);
        if (t0 > t1) return null;
      }
      return t0 < maxT ? { t: t0, normal } : null;
    },
  };
}

/** Several shapes together. */
export function union(...parts: Shape[]): Shape {
  return {
    heightAt: (x, z) => Math.max(...parts.map((p) => p.heightAt(x, z))),
    push(p, r) {
      for (const part of parts) part.push(p, r);
    },
    ray(o, d, maxT) {
      let best: Hit = null;
      for (const p of parts) best = nearer(best, p.ray(o, d, best ? best.t : maxT));
      return best;
    },
  };
}

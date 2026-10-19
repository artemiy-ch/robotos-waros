import { Color3, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";

export const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** Angle wrapped to [-PI, PI]. */
export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Turns `from` towards `to` by at most `step` radians, the short way round. */
export function approachAngle(from: number, to: number, step: number) {
  const d = wrapAngle(to - from);
  return Math.abs(d) <= step ? to : from + Math.sign(d) * step;
}

/** Plain lit material, or an unlit glowing one when `glow` is set. */
export function mat(scene: Scene, name: string, hex: string, glow = false) {
  const m = new StandardMaterial(name, scene);
  const c = Color3.FromHexString(hex);
  if (glow) {
    m.emissiveColor = c;
    m.diffuseColor = Color3.Black();
    m.disableLighting = true;
  } else {
    m.diffuseColor = c;
    m.specularColor = new Color3(0.25, 0.25, 0.25);
  }
  return m;
}

/** Does the segment a→b pass within r of point c? */
export function segSphere(a: Vector3, b: Vector3, c: Vector3, r: number) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const len2 = abx * abx + aby * aby + abz * abz;
  const t = len2 > 0 ? clamp(((c.x - a.x) * abx + (c.y - a.y) * aby + (c.z - a.z) * abz) / len2, 0, 1) : 0;
  const dx = a.x + abx * t - c.x, dy = a.y + aby * t - c.y, dz = a.z + abz * t - c.z;
  return dx * dx + dy * dy + dz * dz <= r * r;
}

/** Distance along a unit ray to a sphere, or Infinity. */
export function raySphere(o: Vector3, d: Vector3, c: Vector3, r: number) {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const disc = b * b - (ox * ox + oy * oy + oz * oz - r * r);
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t > 0 ? t : Infinity;
}

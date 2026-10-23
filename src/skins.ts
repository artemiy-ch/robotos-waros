import { Color3, PBRMaterial, StandardMaterial, Vector3, VertexBuffer, type Mesh } from "@babylonjs/core";
import type { Mech } from "./models";

/** How the hero is painted, picked on the start screen. */
export type Skin = "dark" | "light" | "rainbow";
export const SKINS: Skin[] = ["dark", "light", "rainbow"];

/** The orange trim (wings, armour stripes, jet glow), which a player's colour replaces in multiplayer. */
export const ACCENT = "#ff6a14";
/** How much each trim material glows, as a share of its colour. */
const TRIM_GLOW: Record<string, number> = { "Does not work": 0.45, armourOrange: 0.35 };

/** [colour, metallic, roughness, how much of the sky it reflects, glow] for each of the hero's materials. */
type Paint = [string, number, number, number, string?];

const PAINTS: Record<"dark" | "light", Record<string, Paint>> = {
  // Black metal armour, chrome joints, orange wings (they also light the chest core).
  dark: {
    Dumb: ["#0b0c0e", 0.85, 0.3, 0.3],
    "Rock n roll racing": ["#1d1f23", 0.85, 0.38, 0.3],
    "The guy": ["#050506", 0.8, 0.5, 0.2],
    Stupid: ["#a3a8b0", 1, 0.22, 1],
    "Does not work": [ACCENT, 0.4, 0.4, 0.5],
    armourPlate: ["#15171b", 0.85, 0.32, 0.35],
    armourDark: ["#2a2d33", 0.9, 0.45, 0.35],
    armourOrange: [ACCENT, 0.4, 0.4, 0.35],
  },
  // White enamel with grey trim; less metal, or it would mirror the dark sky and turn grey.
  light: {
    Dumb: ["#e6e8ec", 0.3, 0.35, 0.6],
    "Rock n roll racing": ["#c2c7cf", 0.35, 0.35, 0.6],
    "The guy": ["#f4f5f7", 0.25, 0.45, 0.5],
    Stupid: ["#8a919b", 1, 0.22, 1],
    "Does not work": [ACCENT, 0.4, 0.4, 0.5],
    armourPlate: ["#eef0f3", 0.3, 0.32, 0.6],
    armourDark: ["#9aa1ab", 0.6, 0.4, 0.5],
    armourOrange: [ACCENT, 0.4, 0.4, 0.35],
  },
};

/** The rainbow flag, top stripe first. */
const RAINBOW = ["#e40303", "#ff8c00", "#ffed00", "#008026", "#004dff", "#750787"].map((h) => Color3.FromHexString(h));

/** Repaints the hero (and its armour) in a skin, with its trim in `accent`; can be called again at any time to change it. */
export function paintHero(mech: Mech, skin: Skin, accent = ACCENT) {
  const trim = Color3.FromHexString(accent);
  for (const m of mech.meshes) if (m.material instanceof StandardMaterial && m.material.name === "armourGlow") m.material.emissiveColor = trim;
  const meshes = mech.meshes.filter((m): m is Mesh => m.material instanceof PBRMaterial && m.material.name !== "BLOOD");
  for (const mesh of meshes) {
    const m = mesh.material as PBRMaterial;
    if (skin === "rainbow") {
      m.albedoColor = Color3.White();
      m.metallic = 0.15;
      m.roughness = 0.45;
      m.environmentIntensity = 0.4;
      m.emissiveColor = Color3.Black();
      continue;
    }
    if (mesh.isVerticesDataPresent(VertexBuffer.ColorKind)) mesh.removeVerticesData(VertexBuffer.ColorKind);
    const p = PAINTS[skin][m.name];
    if (!p) continue;
    m.albedoColor = Color3.FromHexString(p[0]);
    m.metallic = p[1];
    m.roughness = p[2];
    m.environmentIntensity = p[3];
    m.emissiveColor = p[4] ? Color3.FromHexString(p[4]) : Color3.Black();
    if (TRIM_GLOW[m.name]) {
      m.albedoColor = trim;
      m.emissiveColor = trim.scale(TRIM_GLOW[m.name]);
    }
  }
  if (skin === "rainbow") stripes(meshes);
}

/** Horizontal flag stripes over the whole robot, by how high each vertex stands. */
function stripes(meshes: Mesh[]) {
  // Copies of the hero share their geometry; the stripes go on this robot's own copy only.
  for (const mesh of meshes) mesh.makeGeometryUnique();
  const heights = meshes.map((mesh) => {
    const local = mesh.getPositionData(true) ?? [];
    const world = mesh.computeWorldMatrix(true);
    const ys: number[] = [];
    const v = new Vector3();
    for (let i = 0; i < local.length; i += 3) ys.push(Vector3.TransformCoordinatesFromFloatsToRef(local[i], local[i + 1], local[i + 2], world, v).y);
    return ys;
  });
  let low = Infinity, high = -Infinity;
  // A few vertices of the model have no bone weights and skin to NaN; they are left out.
  for (const ys of heights) for (const y of ys) if (Number.isFinite(y)) (low = Math.min(low, y)), (high = Math.max(high, y));
  meshes.forEach((mesh, k) => {
    const ys = heights[k];
    const colors = new Float32Array(ys.length * 4);
    ys.forEach((y, i) => {
      const band = !Number.isFinite(y) ? 0 : Math.min(RAINBOW.length - 1, Math.max(0, Math.floor(((high - y) / (high - low)) * RAINBOW.length)));
      const c = RAINBOW[band].toLinearSpace();
      colors.set([c.r, c.g, c.b, 1], i * 4);
    });
    mesh.setVerticesData(VertexBuffer.ColorKind, colors);
  });
}

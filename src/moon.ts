import { Color3, DynamicTexture, Matrix, Mesh, MeshBuilder, Quaternion, Scene, StandardMaterial, Texture, Vector3, Vector4, VertexBuffer } from "@babylonjs/core";
import { HALF, SIZE, type Building } from "./city";
import { mat } from "./util";

/** Station plating: light panels with seams, and a dark band where the windows are. */
export function panelTexture(scene: Scene) {
  const tex = new DynamicTexture("moonPanels", { width: 64, height: 64 }, scene, true);
  const c = tex.getContext() as unknown as CanvasRenderingContext2D;
  c.fillStyle = "#d6d6d4";
  c.fillRect(0, 0, 64, 64);
  c.fillStyle = "#b9bab8";
  c.fillRect(0, 0, 31, 64);
  c.fillStyle = "#7e8084";
  c.fillRect(0, 0, 64, 2);
  c.fillRect(0, 31, 64, 1);
  c.fillRect(31, 0, 1, 64);
  c.fillStyle = "#1a1d22";
  c.fillRect(0, 40, 64, 10);
  tex.update();
  tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

/** What glows on that plating at night: the window band, broken up into lit and dark rooms. */
export function lightsTexture(scene: Scene) {
  const tex = new DynamicTexture("moonLights", { width: 64, height: 64 }, scene, true);
  const c = tex.getContext() as unknown as CanvasRenderingContext2D;
  c.fillStyle = "#000";
  c.fillRect(0, 0, 64, 64);
  const rooms = [[2, 13, "#ffd9a0"], [16, 13, "#000"], [33, 14, "#9fe3ff"], [49, 13, "#ffd9a0"]] as const;
  for (const [x, w, color] of rooms) {
    c.fillStyle = color;
    c.fillRect(x, 42, w, 6);
  }
  tex.update();
  tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
  return tex;
}

/** Stretches a mesh's texture coordinates so the plating tiles once every 4 units. */
function tile(mesh: Mesh, u: number, v: number) {
  const uv = mesh.getVerticesData(VertexBuffer.UVKind);
  if (!uv) return mesh;
  for (let i = 0; i < uv.length; i += 2) {
    uv[i] *= u;
    uv[i + 1] *= v;
  }
  mesh.setVerticesData(VertexBuffer.UVKind, uv);
  return mesh;
}

function boxUV(w: number, d: number, h: number) {
  const fu = Math.max(1, Math.round(w / 4)), su = Math.max(1, Math.round(d / 4)), v = Math.max(1, Math.round(h / 4));
  const roof = new Vector4(0.6, 0.1, 0.9, 0.3);
  return [new Vector4(0, 0, fu, v), new Vector4(0, 0, fu, v), new Vector4(0, 0, su, v), new Vector4(0, 0, su, v), roof, roof];
}

/**
 * The lunar version of a building, filling the same footprint and height so its
 * collider still fits: a glass dome, a round tower with rings and a domed top, or
 * a stack of habitat modules.
 */
export function moonBuilding(scene: Scene, b: Building, glass: StandardMaterial, metal: StandardMaterial, seed: number) {
  const { w, d, h } = b;
  const r = Math.min(w, d) / 2;
  const parts: Mesh[] = [];
  const at = (m: Mesh, y: number, x = 0, z = 0) => {
    m.position.set(b.cx + x, y, b.cz + z);
    parts.push(m);
    return m;
  };
  const shell = b.mesh.material as StandardMaterial;
  const style = h < 16 ? "dome" : Math.abs(w - d) < 3 && seed % 3 !== 0 ? "tower" : "modules";

  if (style === "dome") {
    // A plated ring wall with a glass dome on it.
    const wall = Math.min(3, h * 0.3);
    at(tile(MeshBuilder.CreateCylinder("domeBase", { diameter: r * 2, height: wall, tessellation: 32 }, scene), Math.round((Math.PI * r * 2) / 4), 1), wall / 2).material = shell;
    const dome = at(MeshBuilder.CreateSphere("dome", { diameter: r * 2, segments: 20, slice: 0.5 }, scene), wall);
    dome.scaling.y = (h - wall) / r;
    dome.material = glass;
  } else if (style === "tower") {
    const cap = r * 0.9;
    const body = h - cap * 0.6;
    at(tile(MeshBuilder.CreateCylinder("tower", { diameter: r * 1.8, height: body, tessellation: 28 }, scene), Math.round((Math.PI * r * 1.8) / 4), Math.round(body / 4)), body / 2).material = shell;
    for (let y = 8; y < body - 4; y += 12) {
      at(MeshBuilder.CreateCylinder("towerRing", { diameter: r * 2, height: 1.2, tessellation: 28 }, scene), y).material = metal;
    }
    const top = at(MeshBuilder.CreateSphere("towerTop", { diameter: r * 1.8, segments: 16, slice: 0.5 }, scene), body);
    top.scaling.y = 0.6;
    top.material = glass;
    at(MeshBuilder.CreateCylinder("mast", { diameter: 0.4, height: 8, tessellation: 6 }, scene), body + cap * 0.55 + 4).material = metal;
  } else {
    // Habitat modules: a wide base, a narrower block on top, and a pipe up the side.
    const lower = h * (0.45 + (seed % 4) * 0.08);
    at(MeshBuilder.CreateBox("module", { width: w, depth: d, height: lower, faceUV: boxUV(w, d, lower), wrap: true }, scene), lower / 2).material = shell;
    const uw = w * 0.7, ud = d * 0.7, upper = h - lower;
    at(MeshBuilder.CreateBox("module", { width: uw, depth: ud, height: upper, faceUV: boxUV(uw, ud, upper), wrap: true }, scene), lower + upper / 2).material = shell;
    at(MeshBuilder.CreateCylinder("pipe", { diameter: 1.2, height: h, tessellation: 10 }, scene), h / 2, w / 2 - 0.4, 0).material = metal;
    const deck = at(MeshBuilder.CreateBox("deck", { width: w + 0.6, depth: d + 0.6, height: 0.6 }, scene), lower);
    deck.material = metal;
  }

  const merged = Mesh.MergeMeshes(parts, true, true, undefined, false, true)!;
  merged.name = "moonBuilding";
  return merged;
}

/** Earth hanging in the black sky: oceans, continents and swirls of cloud. */
export function earthTexture(scene: Scene) {
  const w = 512, h = 256;
  const tex = new DynamicTexture("earth", { width: w, height: h }, scene, true);
  const c = tex.getContext() as unknown as CanvasRenderingContext2D;
  c.fillStyle = "#1d4f8f";
  c.fillRect(0, 0, w, h);
  let seed = 11;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const blob = (x: number, y: number, r: number, color: string) => {
    c.fillStyle = color;
    for (let i = 0; i < 14; i++) {
      c.beginPath();
      c.arc(x + (rand() - 0.5) * r * 1.6, y + (rand() - 0.5) * r, r * (0.3 + rand() * 0.5), 0, Math.PI * 2);
      c.fill();
    }
  };
  for (let i = 0; i < 9; i++) blob(rand() * w, 50 + rand() * 150, 22 + rand() * 30, i % 3 ? "#4f7a3c" : "#8a7550");
  c.globalAlpha = 0.85;
  for (let i = 0; i < 22; i++) blob(rand() * w, rand() * h, 8 + rand() * 18, "#eef3f7");
  c.globalAlpha = 1;
  c.fillStyle = "#eef3f7";
  c.fillRect(0, 0, w, 12);
  c.fillRect(0, h - 14, w, 14);
  tex.update();
  return tex;
}

/** Craters scattered over the plain around the station and in the open blocks. */
export function craters(scene: Scene, spots: Vector3[]) {
  const rim = MeshBuilder.CreateTorus("craterRim", { diameter: 1, thickness: 0.18, tessellation: 24 }, scene);
  rim.scaling.y = 0.35;
  rim.bakeCurrentTransformIntoVertices();
  rim.material = mat(scene, "craterRim", "#5c5b59");
  const floor = MeshBuilder.CreateDisc("craterFloor", { radius: 0.48, tessellation: 24 }, scene);
  floor.rotation.x = Math.PI / 2;
  floor.position.y = 0.02;
  floor.bakeCurrentTransformIntoVertices();
  floor.material = mat(scene, "craterFloor", "#2f2f30");
  const matrices = spots.map((p) => {
    const s = p.y;
    return Matrix.Compose(new Vector3(s, s, s), Quaternion.Identity(), new Vector3(p.x, 0.02, p.z));
  });
  const buf = new Float32Array(matrices.length * 16);
  matrices.forEach((m, i) => m.copyToArray(buf, i * 16));
  for (const m of [rim, floor]) {
    m.thinInstanceSetBuffer("matrix", buf, 16, true);
    m.thinInstanceRefreshBoundingInfo(false);
    m.isPickable = false;
    m.receiveShadows = true;
  }
  return [rim, floor];
}

/** Where the craters go: mostly out on the plain beyond the station walls. */
export function craterSpots() {
  let seed = 99;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const spots: Vector3[] = [];
  while (spots.length < 70) {
    const x = (rand() - 0.5) * (SIZE + 500), z = (rand() - 0.5) * (SIZE + 500);
    if (Math.abs(x) < HALF + 8 && Math.abs(z) < HALF + 8) continue;
    spots.push(new Vector3(x, 6 + rand() * 30, z)); // y is the size
  }
  return spots;
}

export const MOON_TINTS = ["#c9ccd1", "#b3b8bf", "#d8d5ce", "#a8adb5", "#e0e2e5", "#bfc4ca"].map((h) => Color3.FromHexString(h));

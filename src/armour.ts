import { Color3, Matrix, Mesh, MeshBuilder, PBRMaterial, Quaternion, Scene, ShadowGenerator, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import type { Mech } from "./models";

/** One armour piece, in the model's own units with the hero at rest facing +Z. */
interface Piece {
  bone: string;
  shape: "box" | "cylinder" | "sphere";
  size: [number, number, number];
  at: [number, number, number];
  /** Euler angles (x, y, z). */
  turn?: [number, number, number];
  paint: "plate" | "dark" | "orange" | "glow";
}

const sides = (make: (s: number) => Piece[]) => [...make(-1), ...make(1)];
const side = (s: number) => (s < 0 ? "L" : "R");

/**
 * Heavy armour bolted onto the hero's skeleton: big shoulder pads, chest plates, a jet pack
 * with two nozzles, knee guards and a helmet crest. Each piece rides on its bone, so it moves
 * with the procedural animation.
 */
const PIECES: Piece[] = [
  ...sides((s) => [
    // Shoulder pads ride on the torso, so they stay level when the arms come up to aim.
    { bone: "spine.003", shape: "box", size: [1.5, 0.75, 1.7], at: [1.5 * s, 11.15, -0.15], turn: [0, 0, -0.3 * s], paint: "plate" },
    { bone: "spine.003", shape: "box", size: [1.54, 0.12, 1.74], at: [1.52 * s, 11.55, -0.15], turn: [0, 0, -0.3 * s], paint: "orange" },
    { bone: `upper_arm.${side(s)}`, shape: "box", size: [0.5, 0.9, 1.5], at: [2.25 * s, 10.5, -0.15], turn: [0, 0, -0.1 * s], paint: "dark" },
    { bone: "spine.003", shape: "box", size: [0.8, 1.3, 0.35], at: [0.62 * s, 9.55, 0.78], turn: [-0.12, 0.25 * s, 0], paint: "plate" },
    { bone: "spine.003", shape: "box", size: [0.06, 1.1, 0.4], at: [0.24 * s, 9.55, 0.86], paint: "orange" },
    { bone: `shin.${side(s)}`, shape: "box", size: [0.8, 1.0, 0.45], at: [0.47 * s, 4.55, 0.5], turn: [0.15, 0, 0], paint: "plate" },
    { bone: `shin.${side(s)}`, shape: "box", size: [0.82, 0.14, 0.5], at: [0.47 * s, 5.0, 0.52], turn: [0.15, 0, 0], paint: "orange" },
    { bone: `thigh.${side(s)}`, shape: "box", size: [0.5, 1.6, 1.2], at: [1.05 * s, 6.3, 0], paint: "plate" },
    { bone: "spine.003", shape: "cylinder", size: [0.5, 0.8, 0.5], at: [0.5 * s, 8.0, -1.3], paint: "dark" },
    { bone: "spine.003", shape: "cylinder", size: [0.56, 0.12, 0.56], at: [0.5 * s, 7.62, -1.3], paint: "glow" },
    { bone: "head", shape: "box", size: [0.14, 0.55, 0.65], at: [0.47 * s, 11.35, -0.05], paint: "plate" },
  ]),
  // Jet pack.
  { bone: "spine.003", shape: "box", size: [1.7, 1.9, 0.9], at: [0, 9.2, -1.25], paint: "plate" },
  { bone: "spine.003", shape: "box", size: [1.74, 0.18, 0.94], at: [0, 9.85, -1.25], paint: "orange" },
  { bone: "spine.003", shape: "box", size: [0.9, 0.5, 0.2], at: [0, 9.1, -1.75], paint: "glow" },
  // Helmet crest and antenna.
  { bone: "head", shape: "box", size: [0.16, 0.3, 0.9], at: [0, 11.95, -0.15], paint: "orange" },
  { bone: "head", shape: "cylinder", size: [0.07, 1.3, 0.07], at: [0.42, 12.2, -0.3], paint: "dark" },
];

/** Where the jet pack's flames come out (bottoms of the nozzles), in model units. */
const NOZZLES: [number, number, number][] = [
  [-0.5, 7.5, -1.3],
  [0.5, 7.5, -1.3],
];

export function armour(mech: Mech, scene: Scene, shadows: ShadowGenerator) {
  const pbr = (name: string, hex: string, metallic: number, roughness: number, glow?: string) => {
    const m = new PBRMaterial(name, scene);
    m.albedoColor = Color3.FromHexString(hex);
    m.metallic = metallic;
    m.roughness = roughness;
    m.environmentIntensity = 0.35;
    if (glow) m.emissiveColor = Color3.FromHexString(glow);
    return m;
  };
  const glow = new StandardMaterial("armourGlow", scene);
  glow.emissiveColor = Color3.FromHexString("#ff6a14");
  glow.diffuseColor = Color3.Black();
  glow.disableLighting = true;
  const paints = {
    plate: pbr("armourPlate", "#15171b", 0.85, 0.32),
    dark: pbr("armourDark", "#2a2d33", 0.9, 0.45),
    orange: pbr("armourOrange", "#ff6a14", 0.4, 0.4, "#5a1d00"),
    glow,
  };

  // The hero stands at rest at the origin; bring every bone's world matrix up to date.
  const scale = mech.root.scaling.x;
  const toBone = (bone: string, world: Matrix) => {
    mech.bonePosition(bone);
    return world.multiply(mech.node(bone).getWorldMatrix().clone().invert());
  };
  const attach = (node: TransformNode, bone: string, world: Matrix) => {
    const local = toBone(bone, world);
    const s = new Vector3(), r = new Quaternion(), t = new Vector3();
    local.decompose(s, r, t);
    node.parent = mech.node(bone);
    node.scaling.copyFrom(s);
    node.rotationQuaternion = r;
    node.position.copyFrom(t);
  };

  for (const p of PIECES) {
    const [w, h, d] = p.size;
    const mesh =
      p.shape === "box"
        ? MeshBuilder.CreateBox("armour", { width: w, height: h, depth: d }, scene)
        : p.shape === "cylinder"
          ? MeshBuilder.CreateCylinder("armour", { diameter: w, height: h, tessellation: 14 }, scene)
          : MeshBuilder.CreateSphere("armour", { diameterX: w, diameterY: h, diameterZ: d, segments: 10 }, scene);
    mesh.material = paints[p.paint];
    mesh.isPickable = false;
    mesh.receiveShadows = true;
    shadows.addShadowCaster(mesh);
    const [rx, ry, rz] = p.turn ?? [0, 0, 0];
    const world = Matrix.Compose(
      new Vector3(scale, scale, scale),
      Quaternion.RotationYawPitchRoll(ry, rx, rz),
      new Vector3(p.at[0] * scale, p.at[1] * scale, p.at[2] * scale),
    );
    attach(mesh, p.bone, world);
    mech.meshes.push(mesh as Mesh);
  }

  return NOZZLES.map(([x, y, z], i) => {
    const node = new TransformNode(`nozzle${i}`, scene);
    attach(node, "spine.003", Matrix.Translation(x * scale, y * scale, z * scale));
    return node;
  });
}

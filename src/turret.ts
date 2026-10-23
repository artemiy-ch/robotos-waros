import { Color3, Mesh, MeshBuilder, Scene, ShadowGenerator, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import type { Mech } from "./models";

/** A neutral turret's lights; one that belongs to a player glows in their colour. */
export const NEUTRAL_TURRET = "#ff3030";

/**
 * A gun turret guarding a flag, built from plain shapes: a squat armoured base, a ring of light in
 * its owner's colour, and a head the rotary cannon sits on. It stands in for a robot's model, so the
 * enemy code can aim, fire and blow it up like any other (it has no animations to play).
 */
export class TurretMech {
  readonly root: TransformNode;
  readonly meshes: Mesh[] = [];
  readonly anim = { play() {}, update() {}, oneShot() {} };
  private light: StandardMaterial;
  private head: Mesh;

  constructor(scene: Scene, shadows: ShadowGenerator, color: string) {
    this.root = new TransformNode("turret", scene);
    const metal = new StandardMaterial("turretMetal", scene);
    metal.diffuseColor = new Color3(0.2, 0.22, 0.25);
    metal.specularColor = new Color3(0.4, 0.4, 0.45);
    this.light = new StandardMaterial("turretLight", scene);
    this.light.diffuseColor = Color3.Black();
    this.light.disableLighting = true;
    this.setColor(color);
    const part = (m: Mesh, mat: StandardMaterial, y: number) => {
      m.material = mat;
      m.parent = this.root;
      m.position.y = y;
      m.isPickable = false;
      m.receiveShadows = true;
      shadows.addShadowCaster(m);
      this.meshes.push(m);
      return m;
    };
    part(MeshBuilder.CreateCylinder("turretBase", { diameterTop: 2.2, diameterBottom: 3, height: 1.2, tessellation: 8 }, scene), metal, 0.6);
    part(MeshBuilder.CreateTorus("turretRing", { diameter: 2.3, thickness: 0.22, tessellation: 24 }, scene), this.light, 1.25);
    part(MeshBuilder.CreateCylinder("turretNeck", { diameter: 1, height: 1, tessellation: 8 }, scene), metal, 1.7);
    this.head = part(MeshBuilder.CreateBox("turretHead", { width: 1.8, height: 1.1, depth: 1.6 }, scene), metal, 2.6);
    part(MeshBuilder.CreateBox("turretEye", { width: 1.2, height: 0.2, depth: 0.1 }, scene), this.light, 2.75).position.z = 0.82;
  }

  /** The lights in the owner's colour (or the neutral red). */
  setColor(hex: string) {
    this.light.emissiveColor = Color3.FromHexString(hex);
  }

  /** The cannon sits on the head, whatever bone is asked for. */
  bonePosition(_bone: string) {
    return this.head.getAbsolutePosition().clone();
  }

  setFlash(on: boolean) {
    for (const m of this.meshes) m.renderOverlay = on;
  }

  dispose() {
    this.root.dispose(false, true);
  }

  /** Passed where the enemy code expects a robot's model. */
  asMech() {
    return this as unknown as Mech;
  }
}

/** Where a flag's turret stands: beside the pole on a crossing, across from it on a roof. */
export function turretSpot(at: [number, number], y: number, radius: number) {
  return new Vector3(at[0] - (y ? radius * 0.4 : 5), y, at[1] + (y ? 0 : 5));
}

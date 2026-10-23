import { Color3, DynamicTexture, Engine, Mesh, MeshBuilder, Scene, ShadowGenerator, StandardMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { clamp, mat, wrapAngle } from "./util";

export type Team = "player" | "enemy";

interface GunMaterials {
  dark: StandardMaterial;
  metal: StandardMaterial;
  accent: StandardMaterial;
  cell: StandardMaterial;
  flash: StandardMaterial;
}

const cache = new WeakMap<Scene, Record<Team, GunMaterials>>();

function flashTexture(scene: Scene) {
  const tex = new DynamicTexture("muzzleFlash", { width: 128, height: 128 }, scene, true);
  const c = tex.getContext() as unknown as CanvasRenderingContext2D;
  const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.2, "rgba(255,255,255,0.85)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, 128, 128);
  c.translate(64, 64);
  c.fillStyle = "rgba(255,255,255,0.9)";
  for (let i = 0; i < 7; i++) {
    c.rotate((Math.PI * 2) / 7 + (Math.random() - 0.5) * 0.4);
    c.beginPath();
    c.moveTo(-6, 0);
    c.lineTo(0, -60 + Math.random() * 15);
    c.lineTo(6, 0);
    c.fill();
  }
  tex.hasAlpha = true;
  tex.update();
  return tex;
}

function materials(scene: Scene, team: Team) {
  let all = cache.get(scene);
  if (!all) {
    const tex = flashTexture(scene);
    const make = (t: Team): GunMaterials => {
      const hot = t === "player" ? new Color3(1, 0.6, 0.2) : new Color3(1, 0.3, 0.2);
      const flash = new StandardMaterial(`gunFlash-${t}`, scene);
      flash.diffuseTexture = tex;
      flash.opacityTexture = tex;
      flash.diffuseColor = hot;
      flash.emissiveColor = hot.scale(0.3);
      flash.disableLighting = true;
      flash.alphaMode = Engine.ALPHA_ADD;
      flash.backFaceCulling = false;
      return {
        // The hero's cannons match its wings: orange housing, black stripe, glowing orange cell.
        dark: mat(scene, `gunDark-${t}`, t === "player" ? "#e5631b" : "#2a2e35"),
        metal: mat(scene, `gunMetal-${t}`, t === "player" ? "#3a3e45" : "#5d646e"),
        accent: mat(scene, `gunAccent-${t}`, t === "player" ? "#141518" : "#b8322a"),
        cell: mat(scene, `gunCell-${t}`, t === "player" ? "#ff7a1a" : "#ff3a2a", true),
        flash,
      };
    };
    all = { player: make("player"), enemy: make("enemy") };
    cache.set(scene, all);
  }
  return all[team];
}

/** The laser's look: a white-hot core inside a pink glow, with a bright spot where it lands. */
export class LaserBeam {
  private core: Mesh;
  private glow: Mesh;
  private tip: Mesh;

  constructor(scene: Scene) {
    // A unit cylinder lying along +Z from 0 to 1, so scaling.z is simply the beam length.
    const unit = (name: string) => {
      const m = MeshBuilder.CreateCylinder(name, { diameter: 1, height: 1, tessellation: 10 }, scene);
      m.rotation.x = Math.PI / 2;
      m.position.z = 0.5;
      m.bakeCurrentTransformIntoVertices();
      m.isPickable = false;
      return m;
    };
    const glowing = (name: string, hex: string, alpha: number) => {
      const m = new StandardMaterial(name, scene);
      m.emissiveColor = Color3.FromHexString(hex);
      m.diffuseColor = Color3.Black();
      m.disableLighting = true;
      m.alpha = alpha;
      m.alphaMode = Engine.ALPHA_ADD;
      return m;
    };
    this.core = unit("laserCore");
    this.core.material = glowing("laserCore", "#fff0f6", 1);
    this.glow = unit("laserGlow");
    this.glow.material = glowing("laserGlow", "#ff2a6d", 0.45);
    this.tip = MeshBuilder.CreateSphere("laserTip", { diameter: 1, segments: 8 }, scene);
    this.tip.material = glowing("laserTip", "#ff7aa8", 0.9);
    this.tip.isPickable = false;
    this.hide();
  }

  show(from: Vector3, to: Vector3) {
    const len = Vector3.Distance(from, to);
    const flicker = 0.85 + Math.random() * 0.3;
    for (const [m, width] of [[this.core, 0.12], [this.glow, 0.5]] as const) {
      m.setEnabled(true);
      m.position.copyFrom(from);
      m.lookAt(to);
      m.scaling.set(width * flicker, width * flicker, len);
    }
    this.tip.setEnabled(true);
    this.tip.position.copyFrom(to);
    this.tip.scaling.setAll(0.7 + Math.random() * 0.5);
  }

  hide() {
    this.core.setEnabled(false);
    this.glow.setEnabled(false);
    this.tip.setEnabled(false);
  }

  dispose() {
    for (const m of [this.core, this.glow, this.tip]) m.dispose(false, true);
  }
}

/** Tesla bolts: jagged arcs that crackle for a blink and are gone. */
export class Lightning {
  private bolts: { mesh: Mesh; t: number }[] = [];
  private core: StandardMaterial;
  private halo: StandardMaterial;

  constructor(private scene: Scene) {
    const glowing = (name: string, hex: string, alpha: number) => {
      const m = new StandardMaterial(name, scene);
      m.emissiveColor = Color3.FromHexString(hex);
      m.diffuseColor = Color3.Black();
      m.disableLighting = true;
      m.alpha = alpha;
      m.alphaMode = Engine.ALPHA_ADD;
      return m;
    };
    this.core = glowing("teslaCore", "#eaf7ff", 1);
    this.halo = glowing("teslaHalo", "#4aa8ff", 0.35);
  }

  /** An arc from a to b; thinner ones for the jumps between enemies. */
  zap(a: Vector3, b: Vector3, width = 0.1) {
    const len = Vector3.Distance(a, b);
    const n = Math.max(3, Math.round(len / 2.2));
    const dir = b.subtract(a);
    const side = Vector3.Cross(dir, Vector3.Up()).normalize();
    if (side.lengthSquared() < 0.01) side.set(1, 0, 0);
    const up = Vector3.Cross(side, dir).normalize();
    const jag = Math.min(1.4, len * 0.06);
    const path: Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const p = a.add(dir.scale(t));
      if (i > 0 && i < n) p.addInPlace(side.scale((Math.random() - 0.5) * 2 * jag)).addInPlace(up.scale((Math.random() - 0.5) * 2 * jag));
      path.push(p);
    }
    for (const [m, r] of [[this.core, width], [this.halo, width * 4]] as const) {
      const tube = MeshBuilder.CreateTube("tesla", { path, radius: r, tessellation: 5 }, this.scene);
      tube.material = m;
      tube.isPickable = false;
      this.bolts.push({ mesh: tube, t: 0.09 });
    }
  }

  update(dt: number) {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.t -= dt;
      if (b.t > 0) continue;
      b.mesh.dispose();
      this.bolts.splice(i, 1);
    }
  }
}

/**
 * Six-barrel rotary cannon. It lives in world space: the owner places it every
 * frame (usually on a shoulder bone) and points it with aimAt().
 */
export class Gatling {
  readonly node: TransformNode;
  private spinner: TransformNode;
  private muzzle: TransformNode;
  private flash: TransformNode;
  private spin = 0;
  private spinSpeed = 0;
  private recoil = 0;
  private flashT = 0;

  constructor(scene: Scene, shadows: ShadowGenerator, team: Team, size = 1) {
    const m = materials(scene, team);
    this.node = new TransformNode("gun", scene);
    this.node.scaling.setAll(size);

    const part = (mesh: Mesh, parent: TransformNode, material: StandardMaterial, castShadow = true) => {
      mesh.parent = parent;
      mesh.material = material;
      mesh.isPickable = false;
      if (castShadow) shadows.addShadowCaster(mesh);
      return mesh;
    };
    part(MeshBuilder.CreateBox("gunBody", { width: 0.55, height: 0.6, depth: 1.0 }, scene), this.node, m.dark);
    part(MeshBuilder.CreateBox("gunStripe", { width: 0.58, height: 0.14, depth: 0.7 }, scene), this.node, m.accent).position.y = 0.2;
    const cell = part(MeshBuilder.CreateCylinder("gunCell", { diameter: 0.4, height: 0.25, tessellation: 12 }, scene), this.node, m.cell, false);
    cell.rotation.x = Math.PI / 2;
    cell.position.z = -0.6;

    // Barrels and rings are merged into one mesh that spins as a whole.
    const parts: Mesh[] = [];
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3;
      const b = MeshBuilder.CreateCylinder("barrel", { diameter: 0.09, height: 1.3, tessellation: 6 }, scene);
      b.rotation.x = Math.PI / 2;
      b.position.set(Math.cos(a) * 0.14, Math.sin(a) * 0.14, 0.65);
      parts.push(b);
    }
    for (const z of [0.15, 1.2]) {
      const r = MeshBuilder.CreateTorus("gunRing", { diameter: 0.36, thickness: 0.07, tessellation: 16 }, scene);
      r.rotation.x = Math.PI / 2;
      r.position.z = z;
      parts.push(r);
    }
    this.spinner = new TransformNode("gunSpinner", scene);
    this.spinner.parent = this.node;
    this.spinner.position.z = 0.5;
    part(Mesh.MergeMeshes(parts, true)!, this.spinner, m.metal);

    this.muzzle = new TransformNode("muzzle", scene);
    this.muzzle.parent = this.node;
    this.muzzle.position.z = 1.9;

    // Muzzle flash: a star facing forward plus two long crossed planes along the barrel.
    const front = MeshBuilder.CreatePlane("flash", { size: 1.2 }, scene);
    const side = MeshBuilder.CreatePlane("flash", { width: 2.4, height: 0.9 }, scene);
    side.rotation.y = Math.PI / 2;
    side.position.z = 0.9;
    const top = MeshBuilder.CreatePlane("flash", { width: 2.4, height: 0.9 }, scene);
    top.rotation.set(Math.PI / 2, Math.PI / 2, 0);
    top.position.z = 0.9;
    this.flash = new TransformNode("flashNode", scene);
    this.flash.parent = this.muzzle;
    part(Mesh.MergeMeshes([front, side, top], true)!, this.flash, m.flash, false);
    this.flash.setEnabled(false);
  }

  /** Points at `target`, but no further than maxYaw from the owner's facing. */
  aimAt(target: Vector3, baseYaw: number, maxYaw: number) {
    const p = this.node.position;
    const dx = target.x - p.x, dy = target.y - p.y, dz = target.z - p.z;
    const rel = clamp(wrapAngle(Math.atan2(dx, dz) - baseYaw), -maxYaw, maxYaw);
    const pitch = clamp(-Math.atan2(dy, Math.hypot(dx, dz)), -0.8, 0.8);
    this.node.rotation.set(pitch, baseYaw + rel, 0);
  }

  direction() {
    const { x: pitch, y: yaw } = this.node.rotation;
    return new Vector3(Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  }

  right() {
    const yaw = this.node.rotation.y;
    return new Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
  }

  muzzlePosition() {
    this.node.computeWorldMatrix(true);
    return this.muzzle.computeWorldMatrix(true).getTranslation();
  }

  fire() {
    this.flashT = 0.045;
    this.recoil = 1;
    this.flash.rotation.z = Math.random() * Math.PI;
    this.flash.scaling.setAll(0.8 + Math.random() * 0.5);
  }

  update(dt: number, spinning: boolean) {
    this.spinSpeed += ((spinning ? 28 : 0) - this.spinSpeed) * Math.min(1, dt * 4);
    this.spin += this.spinSpeed * dt;
    this.spinner.rotation.z = this.spin;
    this.recoil = Math.max(0, this.recoil - dt * 12);
    this.spinner.position.z = 0.5 - this.recoil * 0.18;
    this.flashT -= dt;
    this.flash.setEnabled(this.flashT > 0);
  }

  setEnabled(on: boolean) {
    this.node.setEnabled(on);
  }

  dispose() {
    this.node.dispose();
  }
}

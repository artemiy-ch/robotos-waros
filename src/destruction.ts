import { InstancedMesh, Mesh, MeshBuilder, Scene, ShadowGenerator, Vector3, Vector4 } from "@babylonjs/core";
import type { Box, Building, City } from "./city";
import type { Game } from "./game";
import { clamp, mat } from "./util";

interface Piece {
  mesh: InstancedMesh;
  vel: Vector3;
  spin: Vector3;
  /** Seconds before it starts to move (collapse blocks crumble a little out of step). */
  delay: number;
  /** Small chips fade away; rubble stays (life = Infinity). */
  life: number;
  /** Rubble stacks up in the pile of its collapse; chips just land on the floor. */
  pile: Map<string, number> | null;
  cell: number;
  settled: boolean;
}

const GRAVITY = 30;
const MAX_CHIPS = 250;
const MAX_RUBBLE = 3000;
/** A facade block is this many windows (4 units each) wide and tall. */
const WINDOW = 4;

/**
 * Building damage: hits knock chips off the walls, and a building out of hp breaks
 * along its window grid into blocks that tumble down into a pile of rubble.
 * Every piece is an instance of a handful of box meshes, so thousands are cheap.
 */
export class Destruction {
  /** Off in multiplayer: falling buildings would be too much to keep in step between players. */
  enabled = true;
  /** Per facade tint: [one window per face, 2×2 windows per face, a chip of wall]. */
  private bases: Mesh[][];
  private concrete: Mesh;
  private scrapBase: Mesh;
  private chips: Piece[] = [];
  private rubble: Piece[] = [];

  constructor(scene: Scene, private city: City, shadows: ShadowGenerator) {
    const make = (name: string, uv: Vector4, material: Mesh["material"]) => {
      const m = MeshBuilder.CreateBox(name, { size: 1, faceUV: [uv, uv, uv, uv, uv, uv] }, scene);
      m.material = material;
      m.isPickable = false;
      m.receiveShadows = true;
      m.position.y = -1000; // only the instances are seen
      shadows.addShadowCaster(m);
      return m;
    };
    this.bases = city.materials.map((m, i) => [
      make(`block1-${i}`, new Vector4(0, 0, 1, 1), m),
      make(`block2-${i}`, new Vector4(0, 0, 2, 2), m),
      make(`chip-${i}`, new Vector4(0.05, 0.05, 0.4, 0.4), m),
    ]);
    this.concrete = make("concreteChip", new Vector4(0, 0, 1, 1), mat(scene, "concrete", "#8a8780"));
    this.scrapBase = make("scrap", new Vector4(0, 0, 1, 1), mat(scene, "scrap", "#3a3e45"));
  }

  private spawn(base: Mesh, at: Vector3, size: Vector3, vel: Vector3, life: number, pile: Map<string, number> | null, cell = 1) {
    const mesh = base.createInstance("piece");
    mesh.isPickable = false;
    mesh.position.copyFrom(at);
    mesh.scaling.copyFrom(size);
    const spin = new Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).scaleInPlace(pile ? 3 : 14);
    const piece: Piece = { mesh, vel, spin, delay: 0, life, pile, cell, settled: false };
    const list = pile ? this.rubble : this.chips;
    list.push(piece);
    if (list.length > (pile ? MAX_RUBBLE : MAX_CHIPS)) list.shift()!.mesh.dispose();
    return piece;
  }

  /** Chips flying off a wall along its normal. */
  private chipOff(b: Building, at: Vector3, normal: Vector3, count: number, minSize: number, maxSize: number, speed: number) {
    for (let i = 0; i < count; i++) {
      const s = minSize + Math.random() * (maxSize - minSize);
      const vel = normal.scale(speed * (0.4 + Math.random() * 0.8));
      vel.addInPlaceFromFloats((Math.random() - 0.5) * speed, Math.random() * speed * 0.7, (Math.random() - 0.5) * speed);
      const base = Math.random() < 0.35 ? this.concrete : this.bases[b.tint][2];
      const size = new Vector3(s * (0.7 + Math.random() * 0.6), s * (0.5 + Math.random() * 0.5), s * (0.7 + Math.random() * 0.6));
      this.spawn(base, at.add(normal.scale(0.2)), size, vel, 4 + Math.random() * 2, null);
    }
  }

  /** Twisted metal flying out of an explosion. */
  scrap(at: Vector3, scale: number) {
    const count = Math.round(5 * scale);
    for (let i = 0; i < count; i++) {
      const s = (0.25 + Math.random() * 0.45) * scale;
      const vel = new Vector3(Math.random() - 0.5, 0.4 + Math.random() * 0.8, Math.random() - 0.5).normalize().scale((10 + Math.random() * 14) * Math.sqrt(scale));
      const size = new Vector3(s * (0.6 + Math.random()), s * (0.2 + Math.random() * 0.4), s * (0.6 + Math.random()));
      this.spawn(this.scrapBase, at.clone(), size, vel, 5 + Math.random() * 3, null);
    }
  }

  /** A round hitting a wall; `chipChance` is how likely it knocks a piece off. */
  hit(box: Box | null, at: Vector3, normal: Vector3, dmg: number, g: Game, chipChance = 0.4) {
    if (!this.enabled) return;
    const b = box?.building;
    if (!b?.standing) return;
    if (Math.random() < chipChance) this.chipOff(b, at, normal, 1 + Math.floor(Math.random() * 2), 0.25, 0.6, 8);
    this.damage(b, dmg, g);
  }

  /** An explosion: nearby buildings lose hp and shed chips towards the blast. */
  blast(at: Vector3, radius: number, dmg: number, g: Game) {
    if (!this.enabled) return;
    for (const b of this.city.buildings) {
      if (!b.standing) continue;
      const box = b.box;
      const p = new Vector3(clamp(at.x, box.minX, box.maxX), clamp(at.y, 0, box.h), clamp(at.z, box.minZ, box.maxZ));
      const d = Vector3.Distance(p, at);
      if (d > radius) continue;
      const k = 1 - d / radius;
      const away = at.subtract(p);
      const normal = away.lengthSquared() > 1e-6 ? away.normalize() : new Vector3(0, 1, 0);
      this.chipOff(b, p, normal, Math.round(4 + 8 * k), 0.4, 1.1, 12);
      this.damage(b, dmg * (0.3 + 0.7 * k), g);
    }
  }

  private damage(b: Building, dmg: number, g: Game) {
    b.hp -= dmg;
    if (b.hp <= 0) this.collapse(b, g);
  }

  /** Swaps the building for its facade cut into window-sized blocks, which then fall. */
  private collapse(b: Building, g: Game) {
    this.city.knockDown(b);
    g.fx.clearScorch(b.box);
    const big = b.w > 24 || b.d > 24 || b.h > 48;
    const k = big ? 2 : 1;
    const base = this.bases[b.tint][k - 1];
    const nx = Math.max(1, Math.round(b.w / (WINDOW * k)));
    const nz = Math.max(1, Math.round(b.d / (WINDOW * k)));
    const ny = Math.max(1, Math.round(b.h / (WINDOW * k)));
    const sx = b.w / nx, sy = b.h / ny, sz = b.d / nz;
    const pile = new Map<string, number>();
    const cell = Math.max(sx, sz);
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        for (let iz = 0; iz < nz; iz++) {
          // Only the outer shell: that is all one sees of a building anyway.
          if (ix > 0 && ix < nx - 1 && iz > 0 && iz < nz - 1) continue;
          const at = new Vector3(b.box.minX + (ix + 0.5) * sx, (iy + 0.5) * sy, b.box.minZ + (iz + 0.5) * sz);
          const out = new Vector3(at.x - b.cx, 0, at.z - b.cz);
          if (out.lengthSquared() < 1e-6) out.set(Math.random() - 0.5, 0, Math.random() - 0.5);
          out.normalize();
          const height = at.y / b.h;
          const vel = out.scale(2 + height * 7 + Math.random() * 2).addInPlaceFromFloats(0, Math.random() * 2, 0);
          const piece = this.spawn(base, at, new Vector3(sx * 0.98, sy * 0.98, sz * 0.98), vel, Infinity, pile, cell);
          piece.delay = Math.random() * 0.15;
        }
      }
    }

    const footprint = new Vector3(b.cx, 0, b.cz);
    g.fx.dustCloud(footprint, b.w, b.d);
    const dist = Vector3.Distance(footprint, g.player.pos);
    g.sfx.rumble(dist);
    g.addShake(dist, 0.9);
    g.onBuildingDestroyed();
  }

  update(dt: number) {
    for (let i = this.chips.length - 1; i >= 0; i--) {
      const c = this.chips[i];
      this.move(c, dt);
      c.life -= dt;
      if (c.life < 1) c.mesh.scaling.scaleInPlace(Math.max(0, 1 - dt * 3));
      if (c.life <= 0) {
        c.mesh.dispose();
        this.chips.splice(i, 1);
      }
    }
    for (const r of this.rubble) if (!r.settled) this.move(r, dt);
  }

  private move(p: Piece, dt: number) {
    if (p.settled) return;
    if (p.delay > 0) {
      p.delay -= dt;
      return;
    }
    const m = p.mesh;
    p.vel.y -= GRAVITY * dt;
    m.position.addInPlace(p.vel.scale(dt));
    m.rotation.addInPlace(p.spin.scale(dt));

    const key = p.pile ? `${Math.floor(m.position.x / p.cell)},${Math.floor(m.position.z / p.cell)}` : "";
    const floor = p.pile ? (p.pile.get(key) ?? 0) : this.city.floorAt(m.position.x, m.position.z, 0, m.position.y);
    const half = m.scaling.y / 2;
    if (m.position.y - half > floor) return;

    m.position.y = floor + half;
    if (p.vel.y < -6) {
      // Bounce, losing most of the energy.
      p.vel.y *= -0.25;
      p.vel.x *= 0.5;
      p.vel.z *= 0.5;
      p.spin.scaleInPlace(0.5);
      return;
    }
    p.settled = true;
    p.vel.setAll(0);
    if (p.pile) {
      // Rubble lies (almost) flat and builds the pile up for the blocks that land on it later.
      m.rotation.set((Math.random() - 0.5) * 0.4, m.rotation.y, (Math.random() - 0.5) * 0.4);
      p.pile.set(key, floor + m.scaling.y * 0.5);
      m.freezeWorldMatrix();
    }
  }

  /** Clears all debris; the buildings come back via City.restore(). */
  clear() {
    for (const p of [...this.chips, ...this.rubble]) p.mesh.dispose();
    this.chips.length = 0;
    this.rubble.length = 0;
  }
}


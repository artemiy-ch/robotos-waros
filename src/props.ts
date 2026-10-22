import { Color3, PBRMaterial, TransformNode, Vector3 } from "@babylonjs/core";
import { BLOCK, BLOCKS, HALF, ROAD, SIZE, STEP, rng, type Box, type Building, type City } from "./city";
import type { Game } from "./game";
import type { Models, PropName } from "./models";

type Kind = "crate" | "barrel" | "dish" | "mine" | "deco";

interface Prop {
  kind: Kind;
  root: TransformNode;
  dispose: () => void;
  /** Collider (crates and barrels). */
  box: Box | null;
  hp: number;
  /** Dishes sit on a roof and go when the building does. */
  building: Building | null;
}

const PROP_SCALE = 2;
const BARREL_HP = 3;

/** Adds a box to the list if there is one; says whether there was. */
const keep = (list: Box[], box: Box | null) => !!box && list.push(box) > 0;
const BARREL_RADIUS = 9;
const MINES = 22;
/** How close a walking enemy has to come to set a mine off. */
const MINE_TRIGGER = 3.2;

/**
 * Street furniture from the Sci-Fi Essentials Kit: crates to hide behind, barrels that explode,
 * supply depots in the open blocks, proximity mines in the roads, dishes on the roofs.
 */
export class Props {
  private list: Prop[] = [];
  private byBox = new Map<Box, Prop>();
  private barrelMaterial: PBRMaterial | null = null;

  constructor(private models: Models, private city: City) {}

  /** Lays everything out afresh (start and restart), always in the same places. */
  reset() {
    for (const p of this.list) this.remove(p);
    const rand = rng(4242);
    const boxes: Box[] = [];
    for (let bi = 0; bi < BLOCKS; bi++) {
      for (let bj = 0; bj < BLOCKS; bj++) {
        const x0 = -HALF + ROAD + bi * STEP, z0 = -HALF + ROAD + bj * STEP;
        const clusters = Math.floor(rand() * 3);
        for (let c = 0; c < clusters; c++) {
          // Along one curb of the block, just out in the road.
          const side = Math.floor(rand() * 4);
          const along = 0.15 + rand() * 0.6;
          const alongX = side < 2;
          const edge = side === 0 ? z0 - 2 : side === 1 ? z0 + BLOCK + 2 : side === 2 ? x0 - 2 : x0 + BLOCK + 2;
          const at = (t: number) => (alongX ? new Vector3(x0 + t * BLOCK, 0, edge) : new Vector3(edge, 0, z0 + t * BLOCK));
          const crates: PropName[] = ["Crate", "Crate_Tarp", "Crate_Large"];
          const crate = crates[Math.floor(rand() * crates.length)];
          keep(boxes, this.place("crate", crate, at(along), alongX ? 0 : Math.PI / 2));
          const barrels = 1 + Math.floor(rand() * 2);
          for (let b = 0; b < barrels; b++) keep(boxes, this.place("barrel", "Barrel1", at(along + (crate === "Crate_Large" ? 0.15 : 0.1) + b * 0.06), rand() * 6));
        }
      }
    }
    this.depots(boxes);
    this.curbsideClutter(boxes);
    this.mines(boxes);
    this.city.addObstacles(boxes);

    for (const b of this.city.buildings) {
      if (rand() > 0.12 || b.h > 45) continue;
      const dish = this.models.prop("SatelliteDish", 1.1);
      dish.root.position.set(b.cx + (rand() - 0.5) * (b.w - 6), b.h, b.cz + (rand() - 0.5) * (b.d - 6));
      dish.root.rotation.y = rand() * Math.PI * 2;
      this.list.push({ kind: "dish", root: dish.root, dispose: dish.dispose, box: null, hp: 0, building: b });
    }
  }

  /** Supply depots in the open blocks: tarp-covered crates, ammo, lockers, spare barrels, sometimes a desk. */
  private depots(boxes: Box[]) {
    const rand = rng(777);
    for (const c of this.city.parks) {
      const count = 1 + Math.floor(rand() * 2);
      for (let k = 0; k < count; k++) {
        const ox = c.x + (rand() - 0.5) * (BLOCK - 16), oz = c.z + (rand() - 0.5) * (BLOCK - 16);
        const turn = (Math.floor(rand() * 4) * Math.PI) / 2;
        const s = Math.sin(turn), co = Math.cos(turn);
        const at = (dx: number, dz: number) => new Vector3(ox + dx * co + dz * s, 0, oz - dx * s + dz * co);
        keep(boxes, this.place("deco", "Crate_Tarp_Large", at(0, 0), turn));
        keep(boxes, this.place("deco", "Ammo_Closed", at(4.6, -1), turn + 0.2));
        keep(boxes, this.place("deco", "Ammo", at(4.8, 1.3), turn - 0.3));
        keep(boxes, this.place("deco", "Barrel2_Closed", at(-4.6, 0.9), rand() * 6));
        keep(boxes, this.place("deco", "Barrel2_Open", at(-4.5, -1.1), rand() * 6));
        keep(boxes, this.place("deco", "Locker", at(-1.4, -3.4), turn));
        keep(boxes, this.place("deco", "Locker", at(0.7, -3.4), turn));
        if (rand() < 0.5) {
          keep(boxes, this.place("deco", "Desk_L", at(1, 5.5), turn));
          keep(boxes, this.place("deco", "Chair", at(1.6, 4.4), turn + Math.PI));
          keep(boxes, this.place("deco", "Shelves_WideTall", at(-4, 5), turn));
        } else keep(boxes, this.place("deco", "Shelves_ThinShort", at(-3, 4), turn));
      }
    }
  }

  /** Odds and ends along the curbs: ammo boxes and grey drums. */
  private curbsideClutter(boxes: Box[]) {
    const rand = rng(555);
    const items: PropName[] = ["Ammo_Small", "Ammo_Closed", "Barrel2_Closed", "Barrel2_Open"];
    for (let i = 0; i < 70; i++) {
      const k = Math.floor(rand() * (BLOCKS + 1));
      const road = -HALF + ROAD / 2 + k * STEP;
      const t = (rand() - 0.5) * (SIZE - 20);
      if ((t + HALF) % STEP < ROAD + 2) continue; // not in the crossings
      const curb = road + (rand() < 0.5 ? -1 : 1) * (ROAD / 2 - 1.2);
      const pos = rand() < 0.5 ? new Vector3(curb, 0, t) : new Vector3(t, 0, curb);
      keep(boxes, this.place("deco", items[Math.floor(rand() * items.length)], pos, rand() * 6));
    }
  }

  /** Proximity mines in the roads: walkers that step near them get blown up; a stray shot sets them off too. */
  private mines(boxes: Box[]) {
    const rand = rng(31337);
    let placed = 0;
    while (placed < MINES) {
      const k = Math.floor(rand() * (BLOCKS + 1));
      const road = -HALF + ROAD / 2 + k * STEP;
      const t = (rand() - 0.5) * (SIZE - 30);
      if ((t + HALF) % STEP < ROAD + 3) continue;
      const lane = road + (rand() - 0.5) * 6;
      const pos = rand() < 0.5 ? new Vector3(lane, 0, t) : new Vector3(t, 0, lane);
      if (keep(boxes, this.place("mine", "Mine", pos, rand() * 6))) placed++;
    }
  }

  private place(kind: Kind, name: PropName, at: Vector3, yaw: number) {
    const p = this.models.prop(name, PROP_SCALE);
    p.root.position.copyFrom(at);
    p.root.rotation.y = yaw;
    if (kind === "barrel") for (const m of p.meshes) m.material = this.redBarrel(m.material as PBRMaterial);

    // Axis-aligned collider from the model's own bounds (crates are only ever turned by 90°).
    p.root.computeWorldMatrix(true);
    const { min, max } = p.root.getHierarchyBoundingVectors(true);
    const box: Box = { minX: min.x, maxX: max.x, minZ: min.z, maxZ: max.z, h: max.y };
    // Not inside a wrecked car or a barricade.
    if (this.city.boxes.some((o) => !o.building && box.minX < o.maxX && box.maxX > o.minX && box.minZ < o.maxZ && box.maxZ > o.minZ)) {
      p.dispose();
      return null;
    }
    const prop: Prop = { kind, root: p.root, dispose: p.dispose, box, hp: BARREL_HP, building: null };
    this.list.push(prop);
    this.byBox.set(box, prop);
    for (const m of p.meshes) m.freezeWorldMatrix();
    return box;
  }

  private redBarrel(src: PBRMaterial) {
    if (!this.barrelMaterial) {
      this.barrelMaterial = src.clone("explosiveBarrel") as PBRMaterial;
      this.barrelMaterial.albedoColor = new Color3(1, 0.32, 0.18);
    }
    return this.barrelMaterial;
  }

  private remove(p: Prop) {
    if (p.box) {
      this.byBox.delete(p.box);
      this.city.removeObstacle(p.box);
    }
    p.dispose();
    this.list.splice(this.list.indexOf(p), 1);
  }

  /** A round hitting a box: barrels take damage, crates shrug it off. Returns whether it was a prop. */
  hit(box: Box | null, dmg: number, g: Game) {
    const p = box && this.byBox.get(box);
    if (!p) return false;
    if (p.kind === "barrel" || p.kind === "mine") this.damage(p, dmg, g);
    return true;
  }

  /** Explosions set off the barrels around them. */
  blast(at: Vector3, radius: number, g: Game) {
    for (const p of [...this.list]) {
      if ((p.kind !== "barrel" && p.kind !== "mine") || p.hp <= 0) continue;
      if (Vector3.Distance(p.root.position, at) < radius) this.damage(p, BARREL_HP, g);
    }
  }

  private damage(p: Prop, dmg: number, g: Game) {
    if (p.hp <= 0) return;
    p.hp -= dmg;
    if (p.hp > 0) return;
    const at = p.root.position.add(new Vector3(0, 1.4, 0));
    this.remove(p);
    const dist = Vector3.Distance(at, g.player.pos);
    g.fx.explosion(at, 1.5);
    g.fx.scorch(new Vector3(at.x, 0.02, at.z), new Vector3(0, 1, 0), 5);
    g.sfx.explode(true, dist);
    g.addShake(dist, 0.7);
    g.enemies.splash(at, BARREL_RADIUS, 12, g);
    g.destruction.blast(at, BARREL_RADIUS, 20, g);
    const toPlayer = Vector3.Distance(at, g.player.chest());
    if (toPlayer < BARREL_RADIUS) g.hurtPlayer(30 * (1 - toPlayer / BARREL_RADIUS));
    this.blast(at, BARREL_RADIUS, g); // chain reaction
  }

  update(g: Game) {
    // Roof dishes go down with their building.
    for (const p of [...this.list]) if (p.building && !p.building.standing) this.remove(p);
    // Mines go off under walking enemies.
    for (const p of [...this.list]) {
      if (p.kind !== "mine" || p.hp <= 0) continue;
      const pos = p.root.position;
      const near = g.enemies.list.some((e) => e.spec.rig.gait && Math.hypot(e.pos.x - pos.x, e.pos.z - pos.z) < MINE_TRIGGER + e.spec.radius);
      if (near) this.damage(p, 99, g);
    }
  }
}

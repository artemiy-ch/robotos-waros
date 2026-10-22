import {
  Color3,
  Color4,
  Engine,
  GlowLayer,
  Matrix,
  Mesh,
  MeshBuilder,
  ParticleSystem,
  Quaternion,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  TransformNode,
  Vector3,
  VertexBuffer,
} from "@babylonjs/core";
import { BLOCK, BLOCKS, HALF, ROAD, SIZE, STEP, crossing, rng, type Box, type Building, type City, type Theme } from "./city";
import { GRAFFITI_CELLS, SIGN_CELLS, SPERDALYAY, beamTexture, bearMural, graffitiAtlas, padTexture, riverText, signAtlas, solarTexture } from "./decor-textures";
import type { Fx } from "./fx";
import { VEHICLES, type Models, type VehicleName } from "./models";
import { mat } from "./util";

const CARS = 46;
const BURNING = 6;
const BARRICADES = 8;
/** The player starts here, looking along +Z. */
const SPAWN = crossing(BLOCKS / 2, BLOCKS / 2);
/** The quote painted on the road straight ahead of the start, and its size. */
const RIVER_AT = SPAWN.add(new Vector3(0, 0.07, ROAD / 2 + BLOCK / 2)); // just over the lane dashes
const RIVER_SIZE = [11, 22];

/** A picture stuck on a building's wall (graffiti, a sign): hidden while the building is down. */
interface WallDecal {
  building: Building;
  mesh: Mesh;
  index: number;
  matrix: Matrix;
  shown: boolean;
}

interface Searchlight {
  node: TransformNode;
  yaw: number;
  phase: number;
  speed: number;
}

/** Thin instances from a list of matrices. */
function thin(mesh: Mesh, matrices: Matrix[], shadows?: ShadowGenerator) {
  const buf = new Float32Array(Math.max(1, matrices.length) * 16);
  matrices.forEach((m, i) => m.copyToArray(buf, i * 16));
  mesh.thinInstanceSetBuffer("matrix", buf, 16, false);
  mesh.thinInstanceRefreshBoundingInfo(false);
  mesh.isPickable = false;
  mesh.receiveShadows = true;
  shadows?.addShadowCaster(mesh);
  return mesh;
}

/** A plane showing one cell of a cols×rows atlas (canvas row 0 at the top). */
function atlasPlane(scene: Scene, name: string, cell: number, cols: number, rows: number) {
  const plane = MeshBuilder.CreatePlane(name, { size: 1 }, scene);
  const uv = plane.getVerticesData(VertexBuffer.UVKind)!;
  const col = cell % cols, row = Math.floor(cell / cols);
  for (let i = 0; i < uv.length; i += 2) {
    uv[i] = (col + uv[i]) / cols;
    uv[i + 1] = 1 - (row + 1 - uv[i + 1]) / rows;
  }
  plane.setVerticesData(VertexBuffer.UVKind, uv);
  return plane;
}

/** Outward normals of a building's walls, by side: 0 +X, 1 −X, 2 +Z, 3 −Z. */
const NORMALS = [new Vector3(1, 0, 0), new Vector3(-1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, 0, -1)];

const wallWidth = (b: Building, side: number) => (side < 2 ? b.box.maxZ - b.box.minZ : b.box.maxX - b.box.minX);

/** Where something flat sits on a building wall, facing out. */
function onWall(b: Building, side: number, along: number, y: number, w: number, h: number, out = 0.06) {
  const { minX, maxX, minZ, maxZ } = b.box;
  const n = NORMALS[side];
  const pos =
    side < 2
      ? new Vector3(side === 0 ? maxX : minX, y, minZ + along * (maxZ - minZ))
      : new Vector3(minX + along * (maxX - minX), y, side === 2 ? maxZ : minZ);
  pos.addInPlace(n.scale(out));
  // A plane's front faces −Z; turn it to face along the wall's normal.
  const yaw = Math.atan2(-n.x, -n.z);
  return Matrix.Compose(new Vector3(w, h, 1), Quaternion.RotationAxis(Vector3.Up(), yaw), pos);
}

const overlaps = (a: Box, b: Box, pad = 0) => a.minX < b.maxX + pad && a.maxX > b.minX - pad && a.minZ < b.maxZ + pad && a.maxZ > b.minZ - pad;

/**
 * Set dressing that costs almost nothing to draw: wrecked cars and barricades in the streets,
 * graffiti and neon signs on the walls, searchlights sweeping the smog; on the Moon, solar
 * fields, radio masts and landing pads. Repeated things are thin instances (one draw call each).
 */
export class Scenery {
  private theme: Theme | null = null;
  private earth: (Mesh | TransformNode)[] = [];
  private moon: (Mesh | TransformNode)[] = [];
  private earthBoxes: Box[] = [];
  private moonBoxes: Box[] = [];
  private fires: ParticleSystem[] = [];
  private decals: WallDecal[] = [];
  private lights: Searchlight[] = [];
  private flicker: { mesh: Mesh; t: number }[] = [];
  private beacon: StandardMaterial | null = null;
  private runners: { mesh: Mesh; centre: Vector3; r: number; angle: number }[] = [];
  private time = 0;
  private decalCheck = 0;
  /** The wall with the bear mural on it, kept clear of other paint and signs. */
  private mural: { b: Building; side: number } | null;

  constructor(
    private scene: Scene,
    private models: Models,
    private city: City,
    private fx: Fx,
    private shadows: ShadowGenerator,
    private glow: GlowLayer,
  ) {
    const rand = rng(2077);
    this.mural = this.muralWall();
    this.cars(rand);
    this.barricades(rand);
    this.graffiti(rand);
    this.signs(rand);
    this.searchlights();
    this.memes();
    for (const m of this.earth) m.setEnabled(false);
  }

  setTheme(theme: Theme) {
    if (theme === this.theme) return;
    if (theme === "moon" && !this.moon.length) this.buildMoon();
    const earth = theme === "earth";
    for (const m of this.earth) m.setEnabled(earth);
    for (const m of this.moon) m.setEnabled(!earth);
    for (const f of this.fires) {
      if (earth) f.start();
      else f.stop();
    }
    if (this.theme) for (const b of this.theme === "earth" ? this.earthBoxes : this.moonBoxes) this.city.removeObstacle(b);
    this.city.addObstacles(earth ? this.earthBoxes : this.moonBoxes);
    this.theme = theme;
  }

  // ---- Earth ----

  /** Wrecked and burnt-out cars along the streets, a few still on fire. */
  private cars(rand: () => number) {
    const kinds = new Map<VehicleName, { ok: Matrix[]; burnt: Matrix[] }>();
    const weight = (n: VehicleName) => (n === "Bus" || n === "Truck" ? 0.35 : n === "Ambulance" || n === "Police_Sedan" ? 0.6 : 1);
    const total = VEHICLES.reduce((a, [n]) => a + weight(n), 0);
    const pick = () => {
      let r = rand() * total;
      for (const [n] of VEHICLES) if ((r -= weight(n)) <= 0) return n;
      return VEHICLES[0][0];
    };
    const spawn = SPAWN;
    const burning: Vector3[] = [];
    let placed = 0;
    for (let tries = 0; placed < CARS && tries < 4000; tries++) {
      const k = Math.floor(rand() * (BLOCKS + 1));
      const road = -HALF + ROAD / 2 + k * STEP;
      const t = (rand() - 0.5) * (SIZE - 24);
      const local = (t + HALF) % STEP;
      if (local < ROAD + 4 || local > STEP - 4) continue; // keep the crossings clear
      const alongX = rand() < 0.5;
      const lane = (rand() < 0.5 ? -1 : 1) * (2 + rand() * 1.4);
      const pos = alongX ? new Vector3(t, 0, road + lane) : new Vector3(road + lane, 0, t);
      if (Vector3.Distance(pos, spawn) < 22 || Vector3.Distance(pos, this.city.crashSite) < 34) continue;
      if (Math.abs(pos.x - RIVER_AT.x) < RIVER_SIZE[0] / 2 + 3 && Math.abs(pos.z - RIVER_AT.z) < RIVER_SIZE[1] / 2 + 3) continue;
      const name = pick();
      const car = this.models.vehicles.get(name)!;
      const { minimum, maximum } = car.getBoundingInfo().boundingBox;
      const len = maximum.z - minimum.z, wid = maximum.x - minimum.x, ht = maximum.y;
      // Mostly parked along the road, some slewed across it after a crash, a few on their roofs.
      let yaw = (alongX ? Math.PI / 2 : 0) + (rand() < 0.5 ? Math.PI : 0) + (rand() - 0.5) * 0.4;
      if (rand() < 0.18) yaw += (rand() < 0.5 ? -1 : 1) * (0.6 + rand() * 0.7);
      const flipped = rand() < 0.08;
      const ex = (Math.abs(Math.cos(yaw)) * wid + Math.abs(Math.sin(yaw)) * len) / 2;
      const ez = (Math.abs(Math.sin(yaw)) * wid + Math.abs(Math.cos(yaw)) * len) / 2;
      const box: Box = { minX: pos.x - ex, maxX: pos.x + ex, minZ: pos.z - ez, maxZ: pos.z + ez, h: ht };
      if (this.city.boxes.some((b) => overlaps(b, box, 0.5)) || this.earthBoxes.some((b) => overlaps(b, box, 1))) continue;
      const burnt = flipped || rand() < 0.38;
      const rot = Quaternion.RotationYawPitchRoll(yaw, 0, flipped ? Math.PI : 0);
      const at = flipped ? pos.add(new Vector3(0, ht, 0)) : pos;
      const list = kinds.get(name) ?? { ok: [], burnt: [] };
      (burnt ? list.burnt : list.ok).push(Matrix.Compose(Vector3.One(), rot, at));
      kinds.set(name, list);
      this.earthBoxes.push(box);
      if (burnt && burning.length < BURNING && rand() < 0.5) burning.push(pos.add(new Vector3(0, ht * 0.8, 0)));
      placed++;
    }
    const paint = mat(this.scene, "carPaint", "#ffffff");
    paint.specularColor = new Color3(0.3, 0.3, 0.3);
    const charred = mat(this.scene, "carCharred", "#3a3532");
    charred.specularColor = new Color3(0.05, 0.05, 0.05);
    // Instances rather than thin instances: these meshes carry vertex colours, which thin instances drop.
    for (const [name, { ok, burnt }] of kinds) {
      const template = this.models.vehicles.get(name)!;
      for (const [list, material] of [[ok, paint], [burnt, charred]] as const) {
        if (!list.length) continue;
        const source = template.clone(`${name}-${material.name}`)!;
        source.material = material;
        source.setEnabled(true);
        source.isPickable = false;
        source.receiveShadows = true;
        this.shadows.addShadowCaster(source);
        list.forEach((matrix, i) => {
          const car = i === 0 ? source : source.createInstance(source.name);
          const scale = new Vector3(), rot = new Quaternion(), pos = new Vector3();
          matrix.decompose(scale, rot, pos);
          car.rotationQuaternion = rot;
          car.position.copyFrom(pos);
          car.isPickable = false;
          car.freezeWorldMatrix();
          this.earth.push(car as Mesh);
        });
      }
    }
    for (const p of burning) this.burn(p);
  }

  /** A car still burning: flames and a thin smoke trail. */
  private burn(at: Vector3) {
    const tex = this.fx.puffTexture;
    const fire = new ParticleSystem("carFire", 90, this.scene);
    fire.particleTexture = tex;
    fire.emitter = at;
    fire.updateSpeed = 1 / 60;
    fire.createSphereEmitter(1.2);
    fire.addColorGradient(0, new Color4(1, 0.75, 0.35, 0.8));
    fire.addColorGradient(0.5, new Color4(1, 0.35, 0.06, 0.55));
    fire.addColorGradient(1, new Color4(0.2, 0.05, 0.02, 0));
    fire.minSize = 1.2;
    fire.maxSize = 2.6;
    fire.minLifeTime = 0.5;
    fire.maxLifeTime = 1.1;
    fire.emitRate = 35;
    fire.minEmitPower = 0.5;
    fire.maxEmitPower = 2;
    fire.gravity = new Vector3(0, 5, 0);
    fire.blendMode = ParticleSystem.BLENDMODE_ADD;
    const smoke = new ParticleSystem("carSmoke", 80, this.scene);
    smoke.particleTexture = tex;
    smoke.emitter = at.add(new Vector3(0, 2, 0));
    smoke.updateSpeed = 1 / 60;
    smoke.createSphereEmitter(0.8);
    smoke.addColorGradient(0, new Color4(0.1, 0.1, 0.1, 0));
    smoke.addColorGradient(0.1, new Color4(0.12, 0.11, 0.1, 0.55));
    smoke.addColorGradient(1, new Color4(0.25, 0.25, 0.25, 0));
    smoke.minSize = 2.5;
    smoke.maxSize = 5;
    smoke.minLifeTime = 4;
    smoke.maxLifeTime = 7;
    smoke.emitRate = 8;
    smoke.minEmitPower = 1;
    smoke.maxEmitPower = 2;
    smoke.gravity = new Vector3(0.6, 2.5, 0.2);
    smoke.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    this.fires.push(fire, smoke);
  }

  /** Roadblocks at some crossings: concrete barriers, sandbag walls and tank traps. */
  private barricades(rand: () => number) {
    const concrete = MeshBuilder.CreateBox("barrierBase", { width: 3.2, height: 0.55, depth: 0.85 }, this.scene);
    concrete.position.y = 0.275;
    const top = MeshBuilder.CreateBox("barrierTop", { width: 3.2, height: 0.6, depth: 0.4 }, this.scene);
    top.position.y = 0.85;
    const barrier = Mesh.MergeMeshes([concrete, top], true)!;
    barrier.material = mat(this.scene, "jersey", "#8f8b84");
    const bag = MeshBuilder.CreateSphere("sandbag", { diameterX: 1.1, diameterY: 0.42, diameterZ: 0.62, segments: 6 }, this.scene);
    bag.material = mat(this.scene, "sandbag", "#7a6a4c");
    const beams = [0, 1, 2].map((i) => {
      const b = MeshBuilder.CreateBox("hedgehogBeam", { width: 2.6, height: 0.22, depth: 0.22 }, this.scene);
      b.rotationQuaternion = Quaternion.RotationYawPitchRoll(i * 1.05, i === 1 ? 0.9 : 0, i === 2 ? 0.9 : 0.45);
      b.position.y = 0.9;
      return b;
    });
    const hedgehog = Mesh.MergeMeshes(beams, true)!;
    hedgehog.material = mat(this.scene, "rust", "#4a3a30");

    const barriers: Matrix[] = [], bags: Matrix[] = [], hogs: Matrix[] = [];
    const used = new Set<string>([`${BLOCKS / 2},${BLOCKS / 2}`]);
    for (let n = 0; n < BARRICADES; ) {
      const i = 1 + Math.floor(rand() * (BLOCKS - 1)), j = 1 + Math.floor(rand() * (BLOCKS - 1));
      if (used.has(`${i},${j}`)) continue;
      used.add(`${i},${j}`);
      n++;
      const c = crossing(i, j);
      // Across one of the four streets into the crossing, leaving a gap to get through.
      const dir = Math.floor(rand() * 4);
      const out = [new Vector3(1, 0, 0), new Vector3(-1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, 0, -1)][dir];
      const across = new Vector3(out.z, 0, out.x);
      const line = c.add(out.scale(ROAD / 2 + 4));
      const yaw = Math.atan2(across.x, across.z) - Math.PI / 2;
      const gap = (rand() - 0.5) * 6;
      for (const off of [-5, -1.7, 4]) {
        const p = line.add(across.scale(off + gap * 0.3));
        barriers.push(Matrix.Compose(Vector3.One(), Quaternion.RotationAxis(Vector3.Up(), yaw + (rand() - 0.5) * 0.25), p));
        this.earthBoxes.push({ minX: p.x - 1.7, maxX: p.x + 1.7, minZ: p.z - 1.7, maxZ: p.z + 1.7, h: 1.15 });
      }
      // A sandbag nest behind the barriers.
      const nest = line.add(out.scale(2.4)).add(across.scale(-3 + gap * 0.3));
      for (let row = 0; row < 3; row++) {
        for (let k = 0; k < 4 - row; k++) {
          const p = nest.add(across.scale((k - (3 - row) / 2) * 1.05)).add(new Vector3(0, 0.2 + row * 0.38, 0));
          bags.push(Matrix.Compose(Vector3.One(), Quaternion.RotationAxis(Vector3.Up(), yaw + (rand() - 0.5) * 0.3), p));
        }
      }
      this.earthBoxes.push({ minX: nest.x - 2.2, maxX: nest.x + 2.2, minZ: nest.z - 2.2, maxZ: nest.z + 2.2, h: 1.2 });
      for (let k = 0; k < 3; k++) {
        const p = line.add(out.scale(-4 - rand() * 4)).add(across.scale((rand() - 0.5) * 10));
        hogs.push(Matrix.Compose(Vector3.One(), Quaternion.RotationAxis(Vector3.Up(), rand() * 3), p));
        this.earthBoxes.push({ minX: p.x - 1, maxX: p.x + 1, minZ: p.z - 1, maxZ: p.z + 1, h: 1.6 });
      }
    }
    this.earth.push(thin(barrier, barriers, this.shadows), thin(bag, bags, this.shadows), thin(hedgehog, hogs, this.shadows));
  }

  /** Spray paint: a few buildings near the start covered in it, a tag here and there elsewhere. */
  private graffiti(rand: () => number) {
    const atlas = graffitiAtlas(this.scene);
    const m = new StandardMaterial("graffiti", this.scene);
    m.diffuseTexture = atlas;
    m.useAlphaFromDiffuseTexture = true;
    m.specularColor = new Color3(0.05, 0.05, 0.05);
    m.zOffset = -2;
    const placements = new Map<number, { building: Building; matrix: Matrix }[]>();
    const add = (b: Building, cell: number, matrix: Matrix) => {
      const list = placements.get(cell) ?? [];
      list.push({ building: b, matrix });
      placements.set(cell, list);
    };
    const cell = () => Math.floor(rand() * GRAFFITI_CELLS);
    const side = (b: Building) => {
      let s = Math.floor(rand() * 4);
      while (!this.wallFree(b, s)) s = (s + 1) % 4;
      return s;
    };
    // Side by side, not on top of each other.
    const spots = new Map<Building, { side: number; x: number; y: number; s: number }[]>();
    const place = (b: Building, sd: number, along: number, y: number, s: number, c: number) => {
      const list = spots.get(b) ?? [];
      const x = along * wallWidth(b, sd);
      if (list.some((o) => o.side === sd && Math.abs(o.x - x) < (o.s + s) * 0.45 && Math.abs(o.y - y) < (o.s + s) * 0.45)) return false;
      list.push({ side: sd, x, y, s });
      spots.set(b, list);
      add(b, c, onWall(b, sd, along, y, s, s, 0.06 + list.length * 0.005));
      return true;
    };
    const spawn = SPAWN;
    const byDistance = [...this.city.buildings].sort((a, b) => Math.hypot(a.cx - spawn.x, a.cz - spawn.z) - Math.hypot(b.cx - spawn.x, b.cz - spawn.z));
    const covered = byDistance.slice(0, 6);
    // A big «СПЕРДАЛЯЙ» on the nearest building, on the wall that faces the start best.
    const first = covered[0];
    const towards = (s: number) => Vector3.Dot(NORMALS[s], spawn.subtract(onWall(first, s, 0.5, 0, 1, 1).getTranslation()).normalize());
    const front = [0, 1, 2, 3].filter((s) => this.wallFree(first, s)).sort((a, z) => towards(z) - towards(a))[0];
    place(first, front, 0.5, Math.min(19, first.h - 6), 10, SPERDALYAY);
    for (const b of covered) {
      // A spot is tried a few times before giving up.
      for (let k = 0, n = 0; k < 30 && n < 7; k++) {
        const s = 5 + rand() * 3;
        if (place(b, side(b), 0.15 + rand() * 0.7, 1.4 + s / 2 + rand() * 3, s, cell())) n++;
      }
    }
    for (const b of byDistance.slice(6)) {
      if (rand() > 0.35) continue;
      const s = 4 + rand() * 2.5;
      place(b, side(b), 0.2 + rand() * 0.6, 1.2 + s / 2 + rand() * 2, s, cell());
    }
    for (const [cell, list] of placements) {
      const plane = atlasPlane(this.scene, `graffiti${cell}`, cell, 2, 4);
      plane.material = m;
      thin(plane, list.map((p) => p.matrix));
      list.forEach((p, i) => this.decals.push({ building: p.building, mesh: plane, index: i, matrix: p.matrix, shown: true }));
      this.earth.push(plane);
    }
  }

  /** Neon shop signs on the walls; a few of them flicker. */
  private signs(rand: () => number) {
    const atlas = signAtlas(this.scene);
    const neon = new StandardMaterial("neon", this.scene);
    neon.emissiveTexture = atlas;
    neon.opacityTexture = atlas;
    neon.emissiveColor = new Color3(0.8, 0.8, 0.8);
    neon.diffuseColor = Color3.Black();
    neon.disableLighting = true;
    neon.zOffset = -3;
    const backing = MeshBuilder.CreateBox("signBack", { width: 1, height: 1, depth: 0.3 }, this.scene);
    backing.material = mat(this.scene, "signBack", "#121418");
    const backs: Matrix[] = [];
    const placements = new Map<number, { building: Building; matrix: Matrix }[]>();
    const flickering: { b: Building; cell: number; matrix: Matrix }[] = [];
    for (const b of this.city.buildings) {
      if (b.h < 12 || rand() > 0.32) continue;
      const cell = Math.floor(rand() * SIGN_CELLS);
      const side = Math.floor(rand() * 4), along = 0.2 + rand() * 0.6, y = 5 + rand() * Math.min(5, b.h - 8);
      if (!this.wallFree(b, side)) continue;
      const w = 6 + rand() * 3, h = w / 4;
      backs.push(onWall(b, side, along, y, w + 0.6, h + 0.5, 0.15));
      const matrix = onWall(b, side, along, y, w, h, 0.32);
      if (flickering.length < 5 && rand() < 0.2) flickering.push({ b, cell, matrix });
      else {
        const list = placements.get(cell) ?? [];
        list.push({ building: b, matrix });
        placements.set(cell, list);
      }
    }
    this.earth.push(thin(backing, backs, this.shadows));
    for (const [cell, list] of placements) {
      const plane = atlasPlane(this.scene, `sign${cell}`, cell, 2, 4);
      plane.material = neon;
      thin(plane, list.map((p) => p.matrix));
      list.forEach((p, i) => this.decals.push({ building: p.building, mesh: plane, index: i, matrix: p.matrix, shown: true }));
      this.earth.push(plane);
    }
    // The flickering ones are single meshes, so each can blink on its own.
    for (const f of flickering) {
      const plane = atlasPlane(this.scene, "signFlicker", f.cell, 2, 4);
      plane.material = neon;
      thin(plane, [f.matrix]);
      this.decals.push({ building: f.b, mesh: plane, index: 0, matrix: f.matrix, shown: true });
      this.flicker.push({ mesh: plane, t: rand() * 3 });
      this.earth.push(plane);
    }
  }

  private wallFree(b: Building, side: number) {
    return this.mural?.b !== b || this.mural.side !== side;
  }

  /** The wall for the bear mural: the biggest one facing the start in plain view of it (across the park behind it). */
  private muralWall() {
    let best: { b: Building; side: number; score: number } | null = null;
    for (const b of this.city.buildings) {
      if (b.h < 18) continue;
      for (let side = 0; side < 4; side++) {
        const width = wallWidth(b, side);
        if (width < 12) continue;
        const centre = onWall(b, side, 0.5, 0, 1, 1).getTranslation();
        const to = SPAWN.subtract(centre);
        const d = to.length();
        const facing = Vector3.Dot(NORMALS[side], to.scale(1 / d));
        if (d < 15 || d > 160 || facing < 0.25 || !this.inSight(centre.add(NORMALS[side]), b)) continue;
        const score = (facing * width * Math.min(b.h, width * 1.4)) / d;
        if (!best || score > best.score) best = { b, side, score };
      }
    }
    return best;
  }

  /** Whether no other building stands between the start and a point by building b. */
  private inSight(to: Vector3, b: Building) {
    const d = Vector3.Distance(SPAWN, to);
    for (let t = 2; t < d; t += 2) {
      const p = Vector3.Lerp(SPAWN, to, t / d);
      if (this.city.buildings.some((o) => o !== b && p.x > o.box.minX && p.x < o.box.maxX && p.z > o.box.minZ && p.z < o.box.maxZ)) return false;
    }
    return true;
  }

  /** The bear mural over a whole wall, and the quote on the road ahead of the start. */
  private memes() {
    if (this.mural) {
      const { b, side } = this.mural;
      const w = wallWidth(b, side) - 2, h = Math.min(b.h - 2, w * 1.4);
      const m = new StandardMaterial("bearMural", this.scene);
      m.diffuseTexture = bearMural(this.scene, w, h);
      m.useAlphaFromDiffuseTexture = true;
      m.emissiveColor = new Color3(0.25, 0.25, 0.25);
      m.specularColor = new Color3(0.05, 0.05, 0.05);
      m.zOffset = -2;
      const plane = MeshBuilder.CreatePlane("bearMural", { size: 1 }, this.scene);
      plane.material = m;
      const matrix = onWall(b, side, 0.5, 1 + h / 2, w, h, 0.07);
      thin(plane, [matrix]);
      this.decals.push({ building: b, mesh: plane, index: 0, matrix, shown: true });
      this.earth.push(plane);
    }
    const paint = new StandardMaterial("riverText", this.scene);
    paint.diffuseTexture = riverText(this.scene);
    paint.diffuseTexture.hasAlpha = true; // cut out, not blended
    paint.specularColor = new Color3(0.05, 0.05, 0.05);
    paint.zOffset = -2;
    const road = MeshBuilder.CreatePlane("riverText", { width: RIVER_SIZE[0], height: RIVER_SIZE[1] }, this.scene);
    road.material = paint;
    road.rotation.x = Math.PI / 2; // lying flat, the top of the text ahead (+Z)
    road.position.copyFrom(RIVER_AT);
    road.isPickable = false;
    road.receiveShadows = true;
    road.freezeWorldMatrix();
    this.earth.push(road);
    // Painted over the lane dashes: take away the ones under it, which would otherwise show through.
    // Their buffer is static, so it gets replaced rather than updated.
    const dashes = this.scene.getMeshByName("dash") as Mesh | null;
    if (dashes) {
      const kept = dashes.thinInstanceGetWorldMatrices().filter((m) => {
        const t = m.getTranslation();
        return Math.abs(t.x - RIVER_AT.x) > RIVER_SIZE[0] / 2 + 1 || Math.abs(t.z - RIVER_AT.z) > RIVER_SIZE[1] / 2 + 1;
      });
      thin(dashes, kept);
    }
  }

  /** Searchlights on the tallest roofs, sweeping the smoggy sky. */
  private searchlights() {
    const beam = MeshBuilder.CreateCylinder("searchBeam", { diameterTop: 38, diameterBottom: 1.2, height: 260, tessellation: 20, cap: Mesh.NO_CAP }, this.scene);
    beam.bakeTransformIntoVertices(Matrix.Translation(0, 130, 0));
    const tex = beamTexture(this.scene);
    const m = new StandardMaterial("searchBeam", this.scene);
    m.emissiveColor = new Color3(1, 0.95, 0.82);
    m.opacityTexture = tex;
    m.diffuseColor = Color3.Black();
    m.disableLighting = true;
    m.alpha = 0.32;
    m.alphaMode = Engine.ALPHA_ADD;
    m.backFaceCulling = false;
    m.disableDepthWrite = true;
    beam.material = m;
    beam.isPickable = false;
    this.glow.addExcludedMesh(beam);
    const lamp = MeshBuilder.CreateCylinder("searchLamp", { diameter: 2.2, height: 1.6, tessellation: 14 }, this.scene);
    lamp.material = mat(this.scene, "lampHousing", "#2b2e33");

    const roofs: Building[] = [];
    for (const b of [...this.city.buildings].sort((a, z) => z.h - a.h)) {
      if (roofs.length >= 5) break;
      if (roofs.every((o) => Math.hypot(o.cx - b.cx, o.cz - b.cz) > 110)) roofs.push(b);
    }
    roofs.forEach((b, i) => {
      const node = new TransformNode("searchlight", this.scene);
      node.position.set(b.cx, b.h + 1, b.cz);
      const lampMesh = i === 0 ? lamp : lamp.createInstance("searchLamp");
      lampMesh.position.set(b.cx, b.h + 0.8, b.cz);
      const beamMesh = i === 0 ? beam : beam.createInstance("searchBeam");
      beamMesh.parent = node;
      if (i > 0) this.glow.addExcludedMesh(beamMesh as unknown as Mesh);
      this.lights.push({ node, yaw: i * 1.3, phase: i * 2.1, speed: 0.12 + i * 0.03 });
      this.earth.push(node, lampMesh as unknown as Mesh);
    });
  }

  // ---- Moon ----

  private buildMoon() {
    const rand = rng(1969);
    const metal = mat(this.scene, "moonMetal", "#6e737c");
    // Solar fields out on the plain beyond the station.
    const panel = MeshBuilder.CreateBox("solarPanel", { width: 4, height: 0.12, depth: 2.4 }, this.scene);
    const sm = new StandardMaterial("solar", this.scene);
    sm.diffuseTexture = solarTexture(this.scene);
    sm.specularColor = new Color3(0.6, 0.6, 0.7);
    sm.specularPower = 64;
    panel.material = sm;
    const post = MeshBuilder.CreateCylinder("solarPost", { diameter: 0.25, height: 1.4, tessellation: 6 }, this.scene);
    post.bakeTransformIntoVertices(Matrix.Translation(0, 0.7, 0));
    post.material = metal;
    const panels: Matrix[] = [], posts: Matrix[] = [];
    for (const [cx, cz, rotate] of [[0, HALF + 45, false], [0, -HALF - 45, false], [HALF + 45, 0, true], [-HALF - 45, 0, true]] as const) {
      for (let a = -9; a <= 9; a++) {
        for (let r = -2; r <= 2; r++) {
          const along = a * 5.2 + (rand() - 0.5) * 0.3, row = r * 7;
          const x = cx + (rotate ? row : along), z = cz + (rotate ? along : row);
          panels.push(Matrix.Compose(Vector3.One(), Quaternion.RotationYawPitchRoll(0, -0.45, 0), new Vector3(x, 1.6, z)));
          posts.push(Matrix.Translation(x, 0, z));
        }
      }
    }
    this.moon.push(thin(panel, panels, this.shadows), thin(post, posts, this.shadows));

    // Radio masts with blinking lights, in the open blocks; landing pads in two of them.
    const mast = MeshBuilder.CreateCylinder("mast", { diameterTop: 0.5, diameterBottom: 1.4, height: 30, tessellation: 4 }, this.scene);
    mast.bakeTransformIntoVertices(Matrix.Translation(0, 15, 0));
    mast.material = metal;
    const dish = MeshBuilder.CreateCylinder("mastDish", { diameterTop: 3.2, diameterBottom: 0.3, height: 1, tessellation: 16 }, this.scene);
    dish.bakeTransformIntoVertices(Matrix.RotationX(1.1).multiply(Matrix.Translation(0, 24, 0.8)));
    dish.material = mat(this.scene, "dishWhite", "#d8dadf");
    const light = MeshBuilder.CreateSphere("mastLight", { diameter: 0.7, segments: 6 }, this.scene);
    light.bakeTransformIntoVertices(Matrix.Translation(0, 30.4, 0));
    this.beacon = mat(this.scene, "beacon", "#ff2a1a", true);
    light.material = this.beacon;
    const masts: Matrix[] = [];
    const parks = this.city.parks;
    parks.forEach((p, i) => {
      if (i < 2) return this.pad(p);
      const at = p.add(new Vector3((rand() - 0.5) * 10, 0, (rand() - 0.5) * 10));
      masts.push(Matrix.Compose(Vector3.One(), Quaternion.RotationAxis(Vector3.Up(), rand() * 6), at));
      this.moonBoxes.push({ minX: at.x - 1, maxX: at.x + 1, minZ: at.z - 1, maxZ: at.z + 1, h: 30 });
    });
    for (const [x, z] of [[HALF + 20, HALF + 20], [-HALF - 20, HALF + 20], [HALF + 20, -HALF - 20], [-HALF - 20, -HALF - 20]]) masts.push(Matrix.Translation(x, 0, z));
    this.moon.push(thin(mast, masts, this.shadows), thin(dish, masts, this.shadows), thin(light, masts));
  }

  /** A landing pad with marker lights chasing round its rim. */
  private pad(centre: Vector3) {
    const R = Math.min(12, BLOCK / 2 - 4);
    const deck = MeshBuilder.CreateDisc("pad", { radius: R, tessellation: 40 }, this.scene);
    deck.rotation.x = Math.PI / 2;
    deck.position.set(centre.x, 0.25, centre.z);
    const pm = new StandardMaterial("pad", this.scene);
    pm.diffuseTexture = padTexture(this.scene);
    pm.specularColor = new Color3(0.1, 0.1, 0.1);
    deck.material = pm;
    deck.receiveShadows = true;
    deck.isPickable = false;
    const dim = MeshBuilder.CreateSphere("padLight", { diameter: 0.45, segments: 6 }, this.scene);
    dim.material = mat(this.scene, "padLightDim", "#5a4a10", true);
    const spots: Matrix[] = [];
    for (let k = 0; k < 20; k++) {
      const a = (k / 20) * Math.PI * 2;
      spots.push(Matrix.Translation(centre.x + Math.cos(a) * (R + 0.6), 0.4, centre.z + Math.sin(a) * (R + 0.6)));
    }
    this.moon.push(deck, thin(dim, spots));
    const bright = mat(this.scene, "padLightOn", "#ffd23a", true);
    for (let k = 0; k < 2; k++) {
      const runner = MeshBuilder.CreateSphere("padRunner", { diameter: 0.7, segments: 8 }, this.scene);
      runner.material = bright;
      runner.isPickable = false;
      this.runners.push({ mesh: runner, centre, r: R + 0.6, angle: k * Math.PI });
      this.moon.push(runner);
    }
  }

  update(dt: number) {
    this.time += dt;
    if (this.theme === "earth") {
      for (const l of this.lights) {
        const t = this.time * l.speed + l.phase;
        l.node.rotation.set(0.45 + 0.22 * Math.sin(t * 0.7), l.yaw + Math.sin(t) * 1.4, 0);
      }
      for (const f of this.flicker) {
        f.t -= dt;
        if (f.t > 0) continue;
        // Mostly on; now and then a stutter of blinks.
        const off = f.mesh.isVisible && Math.random() < 0.5;
        f.mesh.isVisible = !off;
        f.t = off ? 0.04 + Math.random() * 0.12 : Math.random() < 0.3 ? 0.05 : 0.6 + Math.random() * 3;
      }
      // Signs and graffiti vanish with a collapsed building, and come back with the city.
      this.decalCheck -= dt;
      if (this.decalCheck <= 0) {
        this.decalCheck = 0.5;
        for (const d of this.decals) {
          if (d.shown === d.building.standing) continue;
          d.shown = d.building.standing;
          d.mesh.thinInstanceSetMatrixAt(d.index, d.shown ? d.matrix : Matrix.Scaling(0, 0, 0), true);
        }
      }
    } else if (this.theme === "moon") {
      if (this.beacon) this.beacon.emissiveColor = Math.sin(this.time * 3) > 0.3 ? new Color3(1, 0.16, 0.1) : new Color3(0.15, 0.02, 0.02);
      for (const r of this.runners) {
        r.angle += dt * 2.6;
        r.mesh.position.set(r.centre.x + Math.cos(r.angle) * r.r, 0.45, r.centre.z + Math.sin(r.angle) * r.r);
      }
    }
  }
}

import {
  Color3,
  DynamicTexture,
  Matrix,
  Mesh,
  MeshBuilder,
  Quaternion,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  Texture,
  Vector3,
  Vector4,
} from "@babylonjs/core";
import { clamp, mat } from "./util";
import { craterSpots, craters, lightsTexture, MOON_TINTS, moonBuilding, panelTexture } from "./moon";

export type Theme = "earth" | "moon";

/** Axis-aligned obstacle standing on the ground, from y = 0 to y = h. */
export interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  h: number;
  /** Set for buildings (trees have none): they can be stood on and knocked down. */
  building?: Building;
}

export interface Building {
  box: Box;
  /** The mesh for the current theme (one of the two below). */
  mesh: Mesh;
  earthMesh: Mesh;
  moonMesh: Mesh | null;
  tint: number;
  cx: number;
  cz: number;
  w: number;
  d: number;
  h: number;
  hp: number;
  maxHp: number;
  standing: boolean;
  /** Thin-instance indices of the roof units on top. */
  roofUnits: number[];
}

export const BLOCKS = 8;
export const BLOCK = 36;
export const ROAD = 14;
export const STEP = BLOCK + ROAD;
export const SIZE = BLOCKS * BLOCK + (BLOCKS + 1) * ROAD;
export const HALF = SIZE / 2;
/** The block a cruiser crashed into: no buildings there. */
const CRASH_BLOCK = [5, 6];

export function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Center of road crossing (i, j), with i and j in [0, BLOCKS]. */
export function crossing(i: number, j: number) {
  return new Vector3(-HALF + ROAD / 2 + i * STEP, 0, -HALF + ROAD / 2 + j * STEP);
}

function windowTexture(scene: Scene) {
  const tex = new DynamicTexture("windows", { width: 64, height: 64 }, scene, true);
  const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
  ctx.fillStyle = "#c4c4c4";
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = "#161d27";
  ctx.fillRect(12, 14, 40, 34);
  ctx.fillStyle = "#2c3d50";
  ctx.fillRect(12, 14, 40, 8);
  tex.update();
  tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE; // dynamic textures clamp by default
  tex.anisotropicFilteringLevel = 8;
  return tex;
}

/** One window per 4 units of facade; the roof samples a plain wall pixel. */
function buildingUV(w: number, d: number, h: number) {
  const fu = Math.max(1, Math.round(w / 4));
  const su = Math.max(1, Math.round(d / 4));
  const v = Math.max(1, Math.round(h / 4));
  const roof = new Vector4(0.02, 0.45, 0.08, 0.55);
  return [new Vector4(0, 0, fu, v), new Vector4(0, 0, fu, v), new Vector4(0, 0, su, v), new Vector4(0, 0, su, v), roof, roof];
}

function thin(mesh: Mesh, matrices: Matrix[]) {
  if (!matrices.length) return mesh.dispose();
  const buf = new Float32Array(matrices.length * 16);
  matrices.forEach((m, i) => m.copyToArray(buf, i * 16));
  mesh.thinInstanceSetBuffer("matrix", buf, 16, true);
  mesh.thinInstanceRefreshBoundingInfo(false);
}

// Face hit by the last successful rayBox(): axis 0/1/2 = x/y/z (-1 if the ray started inside), sign = normal direction.
let hitAxis = -1;
let hitSign = 0;

function rayBox(o: Vector3, d: Vector3, b: Box, maxT: number) {
  let t0 = 0, t1 = maxT, axis = -1, sign = 0;
  for (let i = 0; i < 3; i++) {
    const p = i === 0 ? o.x : i === 1 ? o.y : o.z;
    const v = i === 0 ? d.x : i === 1 ? d.y : d.z;
    const lo = i === 0 ? b.minX : i === 1 ? 0 : b.minZ;
    const hi = i === 0 ? b.maxX : i === 1 ? b.h : b.maxZ;
    if (Math.abs(v) < 1e-9) {
      if (p < lo || p > hi) return Infinity;
      continue;
    }
    let a = (lo - p) / v, c = (hi - p) / v;
    if (a > c) [a, c] = [c, a];
    if (a > t0) {
      t0 = a;
      axis = i;
      sign = v > 0 ? -1 : 1;
    }
    if (c < t1) t1 = c;
    if (t0 > t1) return Infinity;
  }
  hitAxis = axis;
  hitSign = sign;
  return t0;
}

export class City {
  readonly boxes: Box[] = [];
  /** Every building, standing or not. */
  readonly buildings: Building[] = [];
  /** Facade materials, one per tint (the debris uses them too). */
  readonly materials: StandardMaterial[];
  readonly nav: NavGrid;
  /** Centres of the open blocks (parks on Earth, rock fields on the Moon). */
  readonly parks: Vector3[] = [];
  /** Centre of the crash site block. */
  readonly crashSite = new Vector3();
  /** Bumped whenever a building falls or the city is restored. */
  version = 0;
  theme: Theme = "earth";
  private roofMesh: Mesh;
  private roofMatrices: Matrix[];
  private tints: Color3[];
  private windows: DynamicTexture;
  /** Ground-level materials that change with the theme. */
  private looks: Record<"ground" | "sidewalk" | "lawn" | "paint" | "barrier" | "crater", StandardMaterial> = {} as never;
  private earthOnly: Mesh[] = [];
  private moonOnly: Mesh[] = [];
  private treeMatrices: Matrix[] = [];

  constructor(private scene: Scene, private shadows: ShadowGenerator) {
    const rand = rng(1337);
    const tints = (this.tints = ["#857f78", "#66717d", "#86705f", "#717375", "#8f8a82", "#58626d"].map((h) => Color3.FromHexString(h)));
    const windows = (this.windows = windowTexture(scene));
    this.materials = tints.map((tint, i) => {
      const m = new StandardMaterial(`buildings${i}`, scene);
      m.diffuseTexture = windows;
      m.diffuseColor = tint;
      m.specularColor = new Color3(0.12, 0.12, 0.12);
      return m;
    });
    const sidewalks: Mesh[] = [];
    const lawns: Mesh[] = [];
    const roofUnits: Matrix[] = [];
    const trees: Matrix[] = [];

    for (let bi = 0; bi < BLOCKS; bi++) {
      for (let bj = 0; bj < BLOCKS; bj++) {
        const x0 = -HALF + ROAD + bi * STEP;
        const z0 = -HALF + ROAD + bj * STEP;
        if (bi === CRASH_BLOCK[0] && bj === CRASH_BLOCK[1]) {
          const ground = MeshBuilder.CreateBox("crater", { width: BLOCK, depth: BLOCK, height: 0.2 }, scene);
          ground.position.set(x0 + BLOCK / 2, 0.1, z0 + BLOCK / 2);
          ground.material = this.looks.crater = mat(scene, "scorchedEarth", "#1d1b1a");
          this.finish(ground);
          this.crashSite.set(x0 + BLOCK / 2, 0, z0 + BLOCK / 2);
          continue;
        }
        const park = rand() < 0.12;
        const slab = MeshBuilder.CreateBox("slab", { width: BLOCK, depth: BLOCK, height: 0.2 }, scene);
        slab.position.set(x0 + BLOCK / 2, 0.1, z0 + BLOCK / 2);
        (park ? lawns : sidewalks).push(slab);

        if (park) {
          this.parks.push(new Vector3(x0 + BLOCK / 2, 0, z0 + BLOCK / 2));
          for (let k = 0; k < 9; k++) {
            const tx = x0 + 4 + rand() * (BLOCK - 8);
            const tz = z0 + 4 + rand() * (BLOCK - 8);
            const s = 0.8 + rand() * 0.6;
            trees.push(Matrix.Compose(new Vector3(s, s, s), Quaternion.Identity(), new Vector3(tx, 0, tz)));
            this.boxes.push({ minX: tx - 0.4, maxX: tx + 0.4, minZ: tz - 0.4, maxZ: tz + 0.4, h: 5 * s });
          }
          continue;
        }

        const inner = BLOCK - 4;
        const lots: [number, number, number][] = [];
        if (rand() < 0.25) lots.push([x0 + 2, z0 + 2, inner]);
        else {
          const half = (inner - 2) / 2;
          for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) lots.push([x0 + 2 + a * (half + 2), z0 + 2 + b * (half + 2), half]);
        }
        for (const [lx, lz, size] of lots) {
          const w = size - rand() * 3;
          const d = size - rand() * 3;
          const h = size > 20 ? 30 + rand() * 40 : 8 + Math.pow(rand(), 1.5) * 36;
          const cx = lx + size / 2, cz = lz + size / 2;
          // Separate meshes (not merged) so that a single building can be knocked down.
          const mesh = MeshBuilder.CreateBox("building", { width: w, depth: d, height: h, faceUV: buildingUV(w, d, h), wrap: true }, scene);
          mesh.position.set(cx, h / 2, cz);
          const tint = Math.floor(rand() * tints.length);
          mesh.material = this.materials[tint];
          this.finish(mesh, shadows);
          const box: Box = { minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2, h };
          const maxHp = Math.round(40 + h * 2 + w * d * 0.05);
          const building: Building = { box, mesh, earthMesh: mesh, moonMesh: null, tint, cx, cz, w, d, h, hp: maxHp, maxHp, standing: true, roofUnits: [] };
          box.building = building;
          this.boxes.push(box);
          this.buildings.push(building);

          const units = Math.floor(rand() * 3);
          for (let k = 0; k < units; k++) {
            const scale = new Vector3(1.5 + rand() * 2, 1 + rand(), 1.5 + rand() * 2);
            const at = new Vector3(cx + (rand() - 0.5) * (w - 5), h, cz + (rand() - 0.5) * (d - 5));
            building.roofUnits.push(roofUnits.length);
            roofUnits.push(Matrix.Compose(scale, Quaternion.Identity(), at));
          }
        }
      }
    }

    const sidewalk = Mesh.MergeMeshes(sidewalks, true, true)!;
    sidewalk.material = this.looks.sidewalk = mat(scene, "sidewalk", "#5f6266");
    this.finish(sidewalk);
    if (lawns.length) {
      const lawn = Mesh.MergeMeshes(lawns, true, true)!;
      lawn.material = this.looks.lawn = mat(scene, "lawn", "#33472a");
      this.finish(lawn);
    }

    const unit = MeshBuilder.CreateBox("roofUnit", { size: 1 }, scene);
    unit.bakeTransformIntoVertices(Matrix.Translation(0, 0.5, 0));
    unit.material = mat(scene, "roofUnit", "#4b4e53");
    thin(unit, roofUnits);
    this.finish(unit, shadows);
    this.roofMesh = unit;
    this.roofMatrices = roofUnits;

    const trunk = MeshBuilder.CreateCylinder("trunk", { height: 2.4, diameter: 0.45, tessellation: 6 }, scene);
    trunk.bakeTransformIntoVertices(Matrix.Translation(0, 1.2, 0));
    trunk.material = mat(scene, "trunk", "#3f2e20");
    const crown = MeshBuilder.CreateSphere("crown", { diameter: 3.4, segments: 4 }, scene);
    crown.bakeTransformIntoVertices(Matrix.Translation(0, 3.6, 0));
    crown.convertToFlatShadedMesh();
    crown.material = mat(scene, "crown", "#2c5530");
    for (const m of [trunk, crown]) {
      thin(m, trees);
      if (!m.isDisposed()) this.finish(m, shadows);
    }
    this.earthOnly.push(trunk, crown);
    this.treeMatrices = trees;

    this.buildRoads(scene);
    this.nav = new NavGrid(this.boxes, 2.4);
  }

  private buildRoads(scene: Scene) {
    const ground = MeshBuilder.CreateGround("ground", { width: SIZE + 600, height: SIZE + 600 }, scene);
    ground.material = this.looks.ground = mat(scene, "asphalt", "#26282c");
    this.finish(ground);

    const dashes: Matrix[] = [];
    for (let k = 0; k <= BLOCKS; k++) {
      const c = -HALF + ROAD / 2 + k * STEP;
      for (let t = -HALF + 3; t < HALF; t += 6) {
        const local = (t + HALF) % STEP;
        if (local < ROAD + 2 || local > STEP - 2) continue;
        dashes.push(Matrix.Translation(c, 0.03, t));
        dashes.push(Matrix.RotationY(Math.PI / 2).multiply(Matrix.Translation(t, 0.03, c)));
      }
    }
    const dash = MeshBuilder.CreateBox("dash", { width: 0.3, height: 0.04, depth: 3 }, scene);
    dash.material = this.looks.paint = mat(scene, "paint", "#a9a38c");
    thin(dash, dashes);
    this.finish(dash);

    const barrier = (this.looks.barrier = mat(scene, "barrier", "#8f7428"));
    for (const [x, z, w, d] of [
      [0, HALF + 0.5, SIZE + 2, 1],
      [0, -HALF - 0.5, SIZE + 2, 1],
      [HALF + 0.5, 0, 1, SIZE + 2],
      [-HALF - 0.5, 0, 1, SIZE + 2],
    ]) {
      const wall = MeshBuilder.CreateBox("barrier", { width: w, depth: d, height: 1.2 }, scene);
      wall.position.set(x, 0.6, z);
      wall.material = barrier;
      this.finish(wall);
    }
  }

  private finish(mesh: Mesh, shadows?: ShadowGenerator) {
    mesh.receiveShadows = true;
    mesh.isPickable = false;
    shadows?.addShadowCaster(mesh);
    mesh.freezeWorldMatrix();
  }

  /** Distance along the (unit or scaled) ray `d` to the first wall or the ground, capped at maxT. */
  raycast(o: Vector3, d: Vector3, maxT: number) {
    return this.raycastHit(o, d, maxT).t;
  }

  /** Like raycast(), plus the normal of the surface that was hit (up if nothing was) and the box, if it was one. */
  raycastHit(o: Vector3, d: Vector3, maxT: number) {
    let best = maxT, axis = 1, sign = 1;
    let box: Box | null = null;
    if (d.y < 0) best = Math.min(best, -o.y / d.y);
    for (const b of this.boxes) {
      const t = rayBox(o, d, b, best);
      if (t < best) {
        best = t;
        box = b;
        axis = hitAxis < 0 ? 1 : hitAxis;
        sign = hitAxis < 0 ? 1 : hitSign;
      }
    }
    const normal = new Vector3(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
    return { t: best, normal, box };
  }

  /** Height of whatever one would stand on at (x, z) when coming from height y: a roof within reach, or the ground. */
  floorAt(x: number, z: number, r: number, y: number) {
    let floor = 0;
    for (const b of this.boxes) {
      if (!b.building || b.h > y + 0.6 || b.h <= floor) continue;
      if (x > b.minX - r && x < b.maxX + r && z > b.minZ - r && z < b.maxZ + r) floor = b.h;
    }
    return floor;
  }

  /** Takes a building out of the world: no mesh, no collisions, open streets for the enemies. */
  knockDown(b: Building) {
    b.standing = false;
    b.mesh.setEnabled(false);
    this.boxes.splice(this.boxes.indexOf(b.box), 1);
    for (const i of b.roofUnits) this.roofMesh.thinInstanceSetMatrixAt(i, Matrix.Scaling(0, 0, 0), true);
    this.nav.reblock(b.box, this.boxes);
    this.version++;
  }

  /**
   * Switches between the Earth city and the Moon station. The layout, the colliders and
   * the street grid stay the same; the buildings swap meshes and everything gets repainted.
   */
  setTheme(theme: Theme) {
    if (theme === this.theme) return;
    this.theme = theme;
    const moon = theme === "moon";
    if (moon && !this.moonOnly.length) this.buildMoon();
    for (const b of this.buildings) {
      b.mesh.setEnabled(false);
      b.mesh = moon ? b.moonMesh! : b.earthMesh;
      b.mesh.setEnabled(b.standing);
    }
    this.materials.forEach((m, i) => {
      m.diffuseTexture = moon ? this.panels : this.windows;
      m.emissiveTexture = moon ? this.lights : null;
      m.diffuseColor = moon ? MOON_TINTS[i] : this.tints[i];
      m.specularColor = moon ? new Color3(0.25, 0.25, 0.25) : new Color3(0.12, 0.12, 0.12);
    });
    const paint = (m: StandardMaterial, earth: string, lunar: string, glow = false) => {
      m.diffuseColor = Color3.FromHexString(moon ? lunar : earth);
      m.emissiveColor = moon && glow ? Color3.FromHexString(lunar) : Color3.Black();
    };
    paint(this.looks.ground, "#26282c", "#464543");
    paint(this.looks.sidewalk, "#5f6266", "#3c4047");
    paint(this.looks.lawn, "#33472a", "#3a3937");
    paint(this.looks.paint, "#a9a38c", "#5fd8ff", true);
    paint(this.looks.barrier, "#8f7428", "#c75a1e");
    paint(this.looks.crater, "#1d1b1a", "#252525");
    for (const m of this.earthOnly) m.setEnabled(!moon);
    for (const m of this.moonOnly) m.setEnabled(moon);
  }

  private panels: DynamicTexture | null = null;
  private lights: DynamicTexture | null = null;

  private buildMoon() {
    const scene = this.scene;
    this.panels = panelTexture(scene);
    this.lights = lightsTexture(scene);
    const glass = new StandardMaterial("domeGlass", scene);
    glass.diffuseColor = new Color3(0.15, 0.3, 0.38);
    glass.emissiveColor = new Color3(0.06, 0.16, 0.22);
    glass.specularColor = new Color3(0.9, 0.9, 0.9);
    glass.specularPower = 64;
    glass.alpha = 0.6;
    const metal = mat(scene, "stationMetal", "#5a5f67");
    this.buildings.forEach((b, i) => {
      const m = moonBuilding(scene, b, glass, metal, i * 7 + 3);
      this.finish(m, this.shadows);
      m.setEnabled(false);
      b.moonMesh = m;
    });
    // Moon rocks where the park trees stood (on the same colliders).
    const rock = MeshBuilder.CreateIcoSphere("rock", { radius: 1.3, subdivisions: 1 }, scene);
    rock.scaling.set(1, 0.7, 1.2);
    rock.bakeCurrentTransformIntoVertices();
    rock.convertToFlatShadedMesh();
    rock.material = mat(scene, "moonRock", "#77736e");
    thin(rock, this.treeMatrices);
    if (!rock.isDisposed()) {
      this.finish(rock, this.shadows);
      this.moonOnly.push(rock);
    }
    for (const m of craters(scene, craterSpots())) this.moonOnly.push(m);
  }

  /** Puts every building back as new (after a game over). */
  restore() {
    for (const b of this.buildings) {
      b.hp = b.maxHp;
      if (b.standing) continue;
      b.standing = true;
      b.mesh.setEnabled(true);
      this.boxes.push(b.box);
      for (const i of b.roofUnits) this.roofMesh.thinInstanceSetMatrixAt(i, this.roofMatrices[i], true);
    }
    this.nav.reblock({ minX: -HALF, maxX: HALF, minZ: -HALF, maxZ: HALF, h: 0 }, this.boxes);
    this.version++;
  }

  /** Extra solid things (street props); they block movement, shots and the enemies' paths. */
  addObstacles(boxes: Box[]) {
    this.boxes.push(...boxes);
    for (const b of boxes) this.nav.reblock(b, this.boxes);
    this.version++;
  }

  removeObstacle(box: Box) {
    const i = this.boxes.indexOf(box);
    if (i < 0) return;
    this.boxes.splice(i, 1);
    this.nav.reblock(box, this.boxes);
    this.version++;
  }

  lineOfSight(a: Vector3, b: Vector3) {
    return this.raycast(a, b.subtract(a), 1) >= 1 - 1e-6;
  }

  /** Pushes a circle of radius r at p (on the XZ plane) out of buildings and keeps it inside the city. */
  collide(p: Vector3, r: number) {
    for (const b of this.boxes) {
      if (p.y >= b.h - 0.01) continue; // above it, or standing on its roof
      const cx = clamp(p.x, b.minX, b.maxX);
      const cz = clamp(p.z, b.minZ, b.maxZ);
      const dx = p.x - cx, dz = p.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        p.x = cx + (dx / d) * r;
        p.z = cz + (dz / d) * r;
      } else {
        const pen = [p.x - b.minX, b.maxX - p.x, p.z - b.minZ, b.maxZ - p.z];
        const m = Math.min(...pen);
        if (m === pen[0]) p.x = b.minX - r;
        else if (m === pen[1]) p.x = b.maxX + r;
        else if (m === pen[2]) p.z = b.minZ - r;
        else p.z = b.maxZ + r;
      }
    }
    const lim = HALF - r;
    p.x = clamp(p.x, -lim, lim);
    p.z = clamp(p.z, -lim, lim);
  }
}

/** Coarse grid over the city with a BFS distance field towards the player, used by drones to find a way around blocks. */
export class NavGrid {
  readonly cell = 3;
  readonly n = Math.ceil(SIZE / 3);
  private blocked: Uint8Array;
  private dist: Int32Array;
  private queue: Int32Array;

  constructor(boxes: Box[], private margin: number) {
    const n = this.n;
    this.blocked = new Uint8Array(n * n);
    this.dist = new Int32Array(n * n).fill(-1);
    this.queue = new Int32Array(n * n);
    this.mark(0, n - 1, 0, n - 1, boxes);
  }

  private mark(i0: number, i1: number, j0: number, j1: number, boxes: Box[]) {
    const m = this.margin;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = -HALF + (i + 0.5) * this.cell;
        const z = -HALF + (j + 0.5) * this.cell;
        this.blocked[j * this.n + i] = boxes.some((b) => x > b.minX - m && x < b.maxX + m && z > b.minZ - m && z < b.maxZ + m) ? 1 : 0;
      }
    }
  }

  /** Re-evaluates the cells around an area after something there changed. */
  reblock(area: Box, boxes: Box[]) {
    const cell = (v: number) => clamp(Math.floor((v + HALF) / this.cell), 0, this.n - 1);
    const m = this.margin + this.cell;
    this.mark(cell(area.minX - m), cell(area.maxX + m), cell(area.minZ - m), cell(area.maxZ + m), boxes);
  }

  private cellOf(x: number, z: number) {
    const i = clamp(Math.floor((x + HALF) / this.cell), 0, this.n - 1);
    const j = clamp(Math.floor((z + HALF) / this.cell), 0, this.n - 1);
    return j * this.n + i;
  }

  isFree(x: number, z: number) {
    return !this.blocked[this.cellOf(x, z)];
  }

  update(target: Vector3) {
    const { n, dist, queue, blocked } = this;
    dist.fill(-1);
    const start = this.cellOf(target.x, target.z);
    let head = 0, tail = 0;
    dist[start] = 0;
    queue[tail++] = start;
    while (head < tail) {
      const c = queue[head++];
      const i = c % n, j = (c / n) | 0, d = dist[c] + 1;
      const visit = (k: number) => {
        if (dist[k] === -1 && !blocked[k]) {
          dist[k] = d;
          queue[tail++] = k;
        }
      };
      if (i > 0) visit(c - 1);
      if (i < n - 1) visit(c + 1);
      if (j > 0) visit(c - n);
      if (j < n - 1) visit(c + n);
    }
  }

  /** Unit direction on XZ towards the target along the distance field, or null if unreachable. */
  steer(x: number, z: number) {
    const { n, dist, blocked } = this;
    const c = this.cellOf(x, z);
    const i = c % n, j = (c / n) | 0;
    let best = -1;
    let bestD = dist[c] === -1 ? Infinity : dist[c];
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const ni = i + di, nj = j + dj;
        if ((!di && !dj) || ni < 0 || nj < 0 || ni >= n || nj >= n) continue;
        // Don't cut corners diagonally past a blocked cell.
        if (di && dj && (blocked[j * n + ni] || blocked[nj * n + i])) continue;
        const k = nj * n + ni;
        if (dist[k] !== -1 && dist[k] < bestD) {
          bestD = dist[k];
          best = k;
        }
      }
    }
    if (best < 0) return null;
    const tx = -HALF + ((best % n) + 0.5) * this.cell - x;
    const tz = -HALF + (((best / n) | 0) + 0.5) * this.cell - z;
    const len = Math.hypot(tx, tz) || 1;
    return { x: tx / len, z: tz / len };
  }
}

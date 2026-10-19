import {
  AbstractMesh,
  AnimationGroup,
  AssetContainer,
  Color3,
  InstantiatedEntries,
  LoadAssetContainerAsync,
  Mesh,
  PBRMaterial,
  Scene,
  ShadowGenerator,
  StandardMaterial,
  Texture,
  TransformNode,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF";
import { clamp } from "./util";

/**
 * Animated models, all facing +Z:
 * - the hero, "Rigged robot" by joney_lol (CC BY 3.0, via Poly Pizza): a skeleton, no clips,
 * - mechs from Quaternius' Animated Mech Pack (public/models, CC0),
 * - robots and props from Quaternius' Sci-Fi Essentials Kit (public/models/scifi, CC0).
 */
export type MechName = "Stan";
export type BotName = "EyeDrone" | "QuadShell" | "Trilobite";
export type RigName = "Hero" | "Chest" | "Carrier" | MechName | BotName;
export type PropName =
  | "HealthPack" | "Barrel1" | "Crate" | "Crate_Tarp" | "Crate_Large" | "SatelliteDish"
  | "Barrel2_Closed" | "Barrel2_Open" | "Ammo" | "Ammo_Closed" | "Ammo_Small" | "Crate_Tarp_Large"
  | "Locker" | "Shelves_WideTall" | "Shelves_ThinShort" | "Desk_L" | "Chair" | "Mine";

const MECHS: MechName[] = ["Stan"];
const BOTS: BotName[] = ["EyeDrone", "QuadShell", "Trilobite"];
const PROPS: PropName[] = [
  "HealthPack", "Barrel1", "Crate", "Crate_Tarp", "Crate_Large", "SatelliteDish",
  "Barrel2_Closed", "Barrel2_Open", "Ammo", "Ammo_Closed", "Ammo_Small", "Crate_Tarp_Large",
  "Locker", "Shelves_WideTall", "Shelves_ThinShort", "Desk_L", "Chair", "Mine",
];

const FADE_PER_SECOND = 8;

/**
 * Cross-fades between a model's animation groups by weight. play() sets the looping
 * base animation (idle, walk…); oneShot() plays a clip over it once (attack, hit…).
 */
export class Animator {
  private groups = new Map<string, AnimationGroup>();
  private weights = new Map<AnimationGroup, number>();
  private current: AnimationGroup | null = null;
  private base: AnimationGroup | null = null;
  private baseLoop = true;
  private shot: AnimationGroup | null = null;

  constructor(groups: AnimationGroup[]) {
    for (const g of groups) {
      g.stop(true);
      // Converted FBX files list every clip twice ("RobotArmature|Walk"); keep the first.
      const name = g.name.split("|").pop()!;
      if (!this.groups.has(name)) this.groups.set(name, g);
    }
  }

  has(name: string) {
    return this.groups.has(name);
  }

  play(name: string, { loop = true, speed = 1, instant = false } = {}) {
    const g = this.groups.get(name);
    if (!g) return;
    g.speedRatio = speed;
    this.base = g;
    this.baseLoop = loop;
    if (!this.shot) this.activate(g, loop, instant);
  }

  /** Plays a clip once over the base animation, then goes back to it. */
  oneShot(name: string, speed = 1) {
    const g = this.groups.get(name);
    if (!g || this.shot === g) return;
    this.shot = g;
    if (this.weights.has(g)) {
      g.stop(true);
      this.weights.delete(g);
    }
    g.speedRatio = speed;
    this.activate(g, false, false);
    g.onAnimationGroupEndObservable.addOnce(() => {
      if (this.shot !== g) return;
      this.shot = null;
      if (this.base) this.activate(this.base, this.baseLoop, false);
    });
  }

  private activate(g: AnimationGroup, loop: boolean, instant: boolean) {
    if (this.current === g) return;
    this.current = g;
    if (!this.weights.has(g)) {
      g.start(loop, g.speedRatio);
      this.weights.set(g, 0);
    }
    if (instant) {
      for (const other of this.weights.keys()) {
        if (other === g) continue;
        other.stop(true);
        this.weights.delete(other);
      }
      this.weights.set(g, 1);
    }
    g.setWeightForAllAnimatables(this.weights.get(g)!);
  }

  update(dt: number) {
    for (const [g, w] of this.weights) {
      const target = g === this.current ? 1 : 0;
      if (w === target) continue;
      const next = clamp(w + Math.sign(target - w) * dt * FADE_PER_SECOND, 0, 1);
      if (target === 0 && next === 0) {
        g.stop(true);
        this.weights.delete(g);
      } else {
        this.weights.set(g, next);
        g.setWeightForAllAnimatables(next);
      }
    }
  }
}

/** One animated model in the scene: our own root node, its meshes, bones and animations. */
export class Mech {
  readonly root: TransformNode;
  readonly meshes: AbstractMesh[];
  readonly anim: Animator;
  private nodes: Map<string, TransformNode>;

  constructor(private entries: InstantiatedEntries, scene: Scene, name: string, scale: number, shadows: ShadowGenerator) {
    this.root = new TransformNode(name, scene);
    this.root.scaling.setAll(scale);
    for (const r of entries.rootNodes) r.parent = this.root;
    this.meshes = entries.rootNodes.flatMap((r) => r.getChildMeshes(false));
    for (const m of this.meshes) {
      m.isPickable = false;
      m.receiveShadows = true;
      m.overlayColor = Color3.White();
      m.overlayAlpha = 0.6;
      shadows.addShadowCaster(m);
    }
    const nodes = entries.rootNodes.flatMap((r) => r.getDescendants(false).filter((n): n is TransformNode => n instanceof TransformNode));
    this.nodes = new Map(nodes.map((t) => [t.name, t]));
    this.anim = new Animator(entries.animationGroups);
  }

  node(name: string) {
    const n = this.nodes.get(name);
    if (!n) throw new Error(`no node "${name}" in ${this.root.name}`);
    return n;
  }

  /** World position of a bone, brought up to date along with its whole parent chain. */
  bonePosition(name: string) {
    const chain: TransformNode[] = [];
    for (let n = this.nodes.get(name) ?? null; n; n = n.parent as TransformNode | null) chain.push(n);
    for (let i = chain.length - 1; i >= 0; i--) chain[i].computeWorldMatrix(true);
    return chain[0].getAbsolutePosition().clone();
  }

  setFlash(on: boolean) {
    for (const m of this.meshes) m.renderOverlay = on;
  }

  dispose() {
    this.entries.dispose();
    this.root.dispose();
  }
}

export class Models {
  private rigs = new Map<RigName, AssetContainer>();
  private props = new Map<PropName, AssetContainer>();
  private ship: AssetContainer | null = null;

  constructor(private scene: Scene, private shadows: ShadowGenerator) {}

  async load() {
    const base = `${import.meta.env.BASE_URL}models/`;
    const loadMech = async (n: MechName) => {
      const c = await LoadAssetContainerAsync(`${base}${n}.glb`, this.scene);
      // The FBX → glTF conversion dropped the texture, so the material is rebuilt here.
      const m = new StandardMaterial(`mech${n}`, this.scene);
      m.diffuseTexture = new Texture(`${base}${n}.jpg`, this.scene, false, false);
      m.specularColor = new Color3(0.3, 0.3, 0.3);
      m.specularPower = 32;
      for (const mesh of c.meshes) if (mesh.material) mesh.material = m;
      this.rigs.set(n, c);
    };
    const loadKit = async (file: string) => {
      const c = await LoadAssetContainerAsync(`${base}scifi/${file}.gltf`, this.scene);
      for (const m of c.materials) {
        if (!(m instanceof PBRMaterial)) continue;
        // Mostly metal by the texture; with no environment map to reflect, that renders black.
        m.metallic = 0.2;
        if (m.name.startsWith("MI_Enemies")) {
          const large = m.name.includes("Large");
          m.emissiveTexture = new Texture(`${base}scifi/T_Enemies${large ? "_Large" : ""}_Emissive.png`, this.scene, false, false);
          m.emissiveColor = Color3.White();
        }
      }
      return c;
    };
    const loadHero = async () => {
      const c = await LoadAssetContainerAsync(`${base}Hero.glb`, this.scene);
      // Repainted: black metal armour, chrome joints, orange wings (they also light the chest core).
      // [colour, metallic, roughness, how much of the sky it reflects]
      const paint: Record<string, [string, number, number, number]> = {
        Dumb: ["#0b0c0e", 0.85, 0.3, 0.3],
        "Rock n roll racing": ["#1d1f23", 0.85, 0.38, 0.3],
        "The guy": ["#050506", 0.8, 0.5, 0.2],
        Stupid: ["#a3a8b0", 1, 0.22, 1],
        "Does not work": ["#ff6a14", 0.4, 0.4, 0.5],
      };
      for (const m of c.materials) {
        if (!(m instanceof PBRMaterial)) continue;
        const p = paint[m.name];
        if (!p) continue;
        m.albedoColor = Color3.FromHexString(p[0]);
        m.metallic = p[1];
        m.roughness = p[2];
        m.environmentIntensity = p[3];
        if (m.name === "Does not work") m.emissiveColor = Color3.FromHexString("#ff5a00").scale(0.45);
      }
      this.rigs.set("Hero", c);
    };
    const loadShip = async (texture: string, tint: Color3, glow?: Color3) => {
      const c = await LoadAssetContainerAsync(`${base}Cruiser.glb`, this.scene);
      const m = new StandardMaterial(`ship-${texture}`, this.scene);
      m.diffuseTexture = new Texture(`${base}${texture}`, this.scene, false, false);
      m.specularColor = new Color3(0.2, 0.2, 0.2);
      m.diffuseColor = tint;
      if (glow) m.emissiveColor = glow;
      for (const mesh of c.meshes) if (mesh.material) mesh.material = m;
      return c;
    };
    await Promise.all([
      loadHero(),
      ...MECHS.map(loadMech),
      ...BOTS.map(async (n) => this.rigs.set(n, await loadKit(`Enemy_${n}`))),
      (async () => this.rigs.set("Chest", await loadKit("Prop_Chest")))(),
      ...PROPS.map(async (n) => this.props.set(n, await loadKit(`Prop_${n}`))),
      // "Imperial" from Quaternius' Ultimate Spaceships (CC0); the FBX conversion dropped the texture.
      (async () => {
        // The wreck: soot-stained.
        this.ship = await loadShip("Cruiser.jpg", new Color3(0.55, 0.52, 0.5));
      })(),
      (async () => {
        // The carrier boss: the same hull in red, with glowing engines.
        this.rigs.set("Carrier", await loadShip("Cruiser_Red.jpg", new Color3(0.9, 0.85, 0.85), new Color3(0.12, 0.03, 0.02)));
      })(),
    ]);
  }

  spawn(name: RigName, scale: number) {
    const entries = this.rigs.get(name)!.instantiateModelsToScene((n) => n, false, { doNotInstantiate: true });
    if (name !== "Carrier") return new Mech(entries, this.scene, name, scale, this.shadows);
    // The ship needs turning so that it flies nose first (+Z) like everything else.
    const mech = new Mech(entries, this.scene, name, 1, this.shadows);
    const model = this.shipModel(entries.rootNodes as TransformNode[]);
    model.parent = mech.root;
    mech.root.scaling.setAll(scale);
    return mech;
  }

  /** Puts a ship's nodes under a new node, turned so its length runs along +Z and centred on it. */
  private shipModel(nodes: TransformNode[]) {
    const model = new TransformNode("shipModel", this.scene);
    for (const r of nodes) r.parent = model;
    let { min, max } = model.getHierarchyBoundingVectors(true);
    const size = max.subtract(min);
    if (size.y > size.x && size.y > size.z) model.rotation.x = Math.PI / 2;
    else if (size.x > size.z) model.rotation.y = Math.PI / 2;
    model.computeWorldMatrix(true);
    ({ min, max } = model.getHierarchyBoundingVectors(true));
    model.position.subtractInPlace(min.add(max).scale(0.5));
    return model;
  }

  /** The cruiser, centred on its root with its length along +Z. */
  cruiser(scale: number) {
    const entries = this.ship!.instantiateModelsToScene((n) => n, false, { doNotInstantiate: true });
    const model = this.shipModel(entries.rootNodes as TransformNode[]);
    const root = new TransformNode("cruiser", this.scene);
    model.parent = root;
    root.scaling.setAll(scale);
    for (const m of model.getChildMeshes(false)) {
      m.isPickable = false;
      m.receiveShadows = true;
      this.shadows.addShadowCaster(m);
    }
    return root;
  }

  /** A static prop: a root node holding clones that share geometry and materials with the template. */
  prop(name: PropName, scale: number) {
    const entries = this.props.get(name)!.instantiateModelsToScene((n) => n, false, { doNotInstantiate: true });
    for (const g of entries.animationGroups) g.dispose();
    const root = new TransformNode(name, this.scene);
    root.scaling.setAll(scale);
    for (const r of entries.rootNodes) r.parent = root;
    const meshes = entries.rootNodes.flatMap((r) => r.getChildMeshes(false)) as Mesh[];
    for (const m of meshes) {
      m.isPickable = false;
      m.receiveShadows = true;
      this.shadows.addShadowCaster(m);
    }
    const dispose = () => {
      entries.dispose();
      root.dispose();
    };
    return { root, meshes, dispose };
  }
}

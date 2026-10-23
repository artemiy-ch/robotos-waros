import { Color3, Engine, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import { HALF, type City } from "./city";
import type { Game } from "./game";
import type { Mech, Models } from "./models";
import { SPECIALS, type Special } from "./player";
import type { CrateInfo } from "../shared/mp";

/** How many weapon crates lie around the city at a time. */
const CRATES = 6;
/** Seconds before an emptied crate is replaced somewhere else. */
const RESPAWN = 25;
const PICK_RADIUS = 3.8;

interface Crate {
  mech: Mech;
  beacon: Mesh;
  pos: Vector3;
  /** -1 while closed, then seconds since it was opened. */
  opened: number;
  weapon: Special;
  /** Multiplayer: the server's number for it, and when we last asked for it. */
  id?: number;
  asked?: number;
}

/** Weapon crates (the kit's animated chest) holding a laser or a tesla gun; a beam of light in the weapon's colour marks each one. */
export class Loot {
  readonly crates: Crate[] = [];
  private respawns: number[] = [];
  private beaconMaterials = new Map<Special, StandardMaterial>();
  private time = 0;
  /** Multiplayer: the server says where crates are and who gets each; walking up to one asks for it. */
  network: { take(id: number): void } | null = null;

  constructor(private scene: Scene, private models: Models, private city: City) {
    for (const kind of Object.keys(SPECIALS) as Special[]) {
      const m = new StandardMaterial(`crateBeacon-${kind}`, scene);
      m.emissiveColor = Color3.FromHexString(SPECIALS[kind].color);
      m.diffuseColor = Color3.Black();
      m.disableLighting = true;
      m.alphaMode = Engine.ALPHA_ADD;
      m.alpha = 0.25;
      this.beaconMaterials.set(kind, m);
    }
  }

  reset() {
    for (const c of this.crates) this.dispose(c);
    this.crates.length = 0;
    this.respawns.length = 0;
    if (!this.network) for (let i = 0; i < CRATES; i++) this.spawn();
  }

  /** A crate the server has put down. */
  add(info: CrateInfo) {
    this.place(info.x, info.z, info.weapon, info.id);
  }

  /** The server gave a crate away: it opens for everyone, and its weapon goes to `mine`'s player. */
  open(id: number, mine: boolean, g: Game) {
    const c = this.crates.find((k) => k.id === id && k.opened < 0);
    if (c) this.unpack(c, mine, g);
  }

  /** Somewhere random out on the streets. */
  private spawn() {
    for (let tries = 0; tries < 200; tries++) {
      const x = (Math.random() * 2 - 1) * (HALF - 8);
      const z = (Math.random() * 2 - 1) * (HALF - 8);
      if (!this.city.nav.isFree(x, z)) continue;
      // Lasers mostly: always one tesla gun and one shawarma buster on the map, sometimes a second of either.
      const count = (w: Special) => this.crates.filter((c) => c.opened < 0 && c.weapon === w).length;
      const teslas = count("tesla"), busters = count("shawarma"), r = Math.random();
      const weapon: Special =
        teslas === 0 ? "tesla" : busters === 0 ? "shawarma" : r < 0.15 && teslas < 2 ? "tesla" : r > 0.8 && busters < 2 ? "shawarma" : "laser";
      this.place(x, z, weapon);
      return;
    }
  }

  private place(x: number, z: number, weapon: Special, id?: number) {
    const mech = this.models.spawn("Chest", 2.2);
    mech.anim.play("Idle_Closed", { instant: true });
    mech.root.position.set(x, 0, z);
    mech.root.rotation.y = Math.random() * Math.PI * 2;
    const beacon = MeshBuilder.CreateCylinder("crateBeacon", { diameter: 0.7, height: 40, tessellation: 8 }, this.scene);
    beacon.material = this.beaconMaterials.get(weapon)!;
    beacon.position.set(x, 20, z);
    beacon.isPickable = false;
    this.crates.push({ mech, beacon, pos: new Vector3(x, 0, z), opened: -1, weapon, id });
  }

  /** Opens a crate; the weapon in it goes to the player if `mine`. */
  private unpack(c: Crate, mine: boolean, g: Game) {
    c.opened = 0;
    c.mech.anim.play("Open", { loop: false });
    c.beacon.setEnabled(false);
    g.fx.spark(c.pos.add(new Vector3(0, 2, 0)), 30);
    if (!mine) return;
    const p = g.player;
    p.giveSpecial(c.weapon);
    g.sfx.powerup();
    g.hud.banner(`${SPECIALS[c.weapon].name} · ${Math.round(p.specialMax)} сек`, 2);
  }

  private dispose(c: Crate) {
    c.mech.dispose();
    c.beacon.dispose();
  }

  update(dt: number, g: Game) {
    this.time += dt;
    for (const m of this.beaconMaterials.values()) m.alpha = 0.18 + Math.sin(this.time * 3) * 0.08;
    for (let i = this.network ? -1 : this.respawns.length - 1; i >= 0; i--) {
      this.respawns[i] -= dt;
      if (this.respawns[i] > 0) continue;
      this.respawns.splice(i, 1);
      this.spawn();
    }

    const p = g.player;
    for (let i = this.crates.length - 1; i >= 0; i--) {
      const c = this.crates[i];
      c.mech.anim.update(dt);
      if (c.opened < 0) {
        const near = Math.hypot(c.pos.x - p.pos.x, c.pos.z - p.pos.z) < PICK_RADIUS && p.pos.y < 3;
        if (!near || !p.alive || g.state !== "playing") continue;
        if (!this.network) this.unpack(c, true, g);
        else if (c.id !== undefined && (c.asked === undefined || this.time - c.asked > 1)) {
          // First to ask gets it; the answer opens it for everyone.
          c.asked = this.time;
          this.network.take(c.id);
        }
        continue;
      }
      // An empty crate lingers open for a moment, sinks out of sight, and comes back elsewhere later.
      c.opened += dt;
      if (c.opened > 3) c.mech.root.position.y -= dt * 1.5;
      if (c.opened > 5) {
        this.dispose(c);
        this.crates.splice(i, 1);
        if (!this.network) this.respawns.push(RESPAWN);
      }
    }
  }
}

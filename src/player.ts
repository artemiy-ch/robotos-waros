import { Color3, ParticleSystem, PointLight, Scene, ShadowGenerator, TransformNode, UniversalCamera, Vector3 } from "@babylonjs/core";
import type { City } from "./city";
import type { Fx } from "./fx";
import type { Input } from "./input";
import { armour } from "./armour";
import { HeroRig } from "./hero";
import type { Mech, Models } from "./models";
import { baseStats, type Stats, type Upgrade } from "./upgrades";
import { approachAngle, clamp } from "./util";
import { Gatling } from "./weapons";

const WALK_SPEED = 13.5;
const RUN_SPEED = 23.5;
const AIR_SPEED = 25;

const GRAVITY = 26;
const THRUST = 75;
const MAX_RISE = 21;
const MAX_ALTITUDE = 90;
/** Fuel is 0..1: a full tank lasts about 3.5 s of thrust. */
const FUEL_DRAIN = 0.28;
const FUEL_REGEN_GROUND = 0.4;
const FUEL_REGEN_AIR = 0.08;
const MOUSE_SENS = 0.0025;
export const FIRE_INTERVAL = 0.07;
const SPREAD = 0.015;
export type Special = "laser" | "tesla" | "shawarma";
/** Weapons from crates: full and short names, colour, and how many seconds each lasts. */
export const SPECIALS: Record<Special, { name: string; short: string; color: string; time: number }> = {
  laser: { name: "Лазер", short: "Лазер", color: "#ff2a6d", time: 30 },
  tesla: { name: "Тесла-пушка", short: "Тесла", color: "#4aa8ff", time: 15 },
  shawarma: { name: "Шаурмбастер", short: "Шаурма", color: "#ffb347", time: 25 },
};
/** Q in the air: dive straight down at this speed. */
const DIVE_SPEED = 48;
const SALVO_INTERVAL = 0.09;
/** The hero model is 12.5 units tall; this makes it about 5.3. */
const HERO_SCALE = 0.42;

export interface Shot {
  from: Vector3;
  dir: Vector3;
  right: Vector3;
}

export class Player {
  readonly radius = 1.3;
  /** Upgradable stats; reset on respawn. */
  stats: Stats = baseStats();
  /** Level of each upgrade taken so far. */
  readonly levels = new Map<string, number>();
  hp = 100;
  /** Force field over the hull: soaks up hits first, recharges after a pause. */
  shield = 60;
  private sinceHit = 99;
  /** Length of the current crate weapon (for the indicator). */
  specialMax = 30;
  alive = true;
  fuel = 1;
  thrusting = false;
  readonly pos = Vector3.Zero();
  /** Look angles; positive pitch looks down. The body turns to follow the yaw. */
  yaw = 0;
  pitch = 0.15;
  camDist = 10;
  facing = 0;
  rocketCd = 0;
  /** A weapon from a crate, and how many seconds of it are left; the cannons don't fire rounds meanwhile. */
  special: Special | null = null;
  specialT = 0;
  /** 1 on Earth; less on the Moon. */
  gravity = 1;
  /** How hard the last landing was (fall speed), until the game has played it. */
  landed = 0;
  /** How far the hero fell on the last landing, until the game has dealt with it. */
  fell = 0;
  /** Highest point of the current flight or fall. */
  private apex = 0;
  /** Counts footfalls; alternates the step sound between the feet. */
  steps = 0;

  readonly mech: Mech;
  private rig: HeroRig;
  private deathT = -1;
  readonly guns: Gatling[];
  private light: PointLight;
  private jets: ParticleSystem[];
  /** Where the jet pack's flames come out. */
  private nozzles: TransformNode[];
  private vel = Vector3.Zero();
  /** Seconds until Q can be used again, and whether a dive is under way. */
  diveCd = 0;
  private diving = false;
  private vy = 0;
  private onGround = true;
  private sinceThrust = 10;
  private cooldown = 0;
  private gun = 0;
  private salvo = 0;
  private salvoT = 0;

  constructor(models: Models, scene: Scene, shadows: ShadowGenerator, fx: Fx) {
    this.mech = models.spawn("Hero", HERO_SCALE);
    this.rig = new HeroRig(this.mech);
    this.nozzles = armour(this.mech, scene, shadows);
    // Arm cannons, held in the hands.
    this.guns = [new Gatling(scene, shadows, "player", 0.9), new Gatling(scene, shadows, "player", 0.9)];
    this.light = new PointLight("muzzleLight", Vector3.Zero(), scene);
    this.light.diffuse = new Color3(1, 0.75, 0.4);
    this.light.specular = Color3.Black();
    this.light.range = 16;
    this.light.intensity = 0;
    // Leg jets, then the two jet-pack nozzles.
    this.jets = [fx.jet(), fx.jet(), fx.jet(), fx.jet()];
  }

  get maxShield() {
    return this.stats.maxShield;
  }

  /**
   * Takes a hit. Enemy fire goes into the shield first and only what gets through dents the hull;
   * a hard landing hits the hull directly. Returns how much the hull lost.
   */
  takeHit(dmg: number, throughShield: boolean) {
    this.sinceHit = 0;
    let hull = dmg;
    if (throughShield) {
      const soaked = Math.min(this.shield, dmg);
      this.shield -= soaked;
      hull -= soaked;
    }
    this.hp = Math.max(0, this.hp - hull);
    return hull;
  }

  get maxHp() {
    return this.stats.maxHp;
  }

  get grounded() {
    return this.onGround;
  }

  /** Horizontal velocity (enemies lead their shots with it). */
  get velocity() {
    return this.vel;
  }

  chest() {
    return new Vector3(this.pos.x, this.pos.y + 3.4, this.pos.z);
  }

  hitSpheres(): [Vector3, number][] {
    return [
      [this.chest(), 1.6],
      [new Vector3(this.pos.x, this.pos.y + 1.4, this.pos.z), 1.1],
    ];
  }

  /** Camera look direction. */
  look() {
    const cp = Math.cos(this.pitch);
    return new Vector3(Math.sin(this.yaw) * cp, -Math.sin(this.pitch), Math.cos(this.yaw) * cp);
  }

  respawn(at: Vector3) {
    this.pos.copyFrom(at);
    this.vel.setAll(0);
    this.vy = 0;
    this.apex = at.y;
    this.fell = this.landed = 0;
    this.stats = baseStats();
    this.levels.clear();
    this.hp = this.maxHp;
    this.shield = this.maxShield;
    this.sinceHit = 99;
    this.fuel = 1;
    this.alive = true;
    this.yaw = this.facing = 0;
    this.pitch = 0.15;
    this.rocketCd = this.salvo = 0;
    this.special = null;
    this.specialT = 0;
    this.deathT = -1;
    this.diveCd = 0;
    this.diving = false;
    this.mech.root.setEnabled(true);
    for (const g of this.guns) g.setEnabled(true);
    this.mech.root.position.copyFrom(this.pos);
    this.mech.root.rotation.set(0, this.facing, 0);
  }

  upgrade(u: Upgrade) {
    u.apply(this.stats);
    this.levels.set(u.id, (this.levels.get(u.id) ?? 0) + 1);
    if (u.repair) this.hp = Math.min(this.maxHp, this.hp + this.maxHp * u.repair);
  }

  /** Moves the hero somewhere else, keeping health, upgrades and weapons. */
  teleport(at: Vector3) {
    this.pos.copyFrom(at);
    this.vel.setAll(0);
    this.vy = 0;
    this.apex = at.y;
    this.fell = this.landed = 0;
    this.mech.root.position.copyFrom(at);
  }

  giveSpecial(kind: Special) {
    this.special = kind;
    this.specialT = this.specialMax = SPECIALS[kind].time + this.stats.specialBonus;
  }

  die() {
    this.alive = false;
    this.thrusting = false;
    this.deathT = 0;
  }

  hide() {
    this.mech.root.setEnabled(false);
    for (const g of this.guns) g.setEnabled(false);
  }

  update(dt: number, input: Input, city: City) {
    const look = input.consumeLook();
    this.yaw += look.dx * MOUSE_SENS;
    this.pitch = clamp(this.pitch + look.dy * MOUSE_SENS, -0.8, 1.1);
    this.camDist = clamp(this.camDist + look.wheel * 0.01, 6, 22);

    let mx = 0, mz = 0;
    if (this.alive) {
      const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
      const ahead = (input.down("KeyW") ? 1 : 0) - (input.down("KeyS") ? 1 : 0);
      const side = (input.down("KeyD") ? 1 : 0) - (input.down("KeyA") ? 1 : 0);
      mx = fx * ahead + fz * side;
      mz = fz * ahead - fx * side;
      const ml = Math.hypot(mx, mz);
      if (ml > 0) {
        mx /= ml;
        mz /= ml;
      }
    }
    const speed = !this.onGround ? AIR_SPEED : input.down("ShiftLeft", "ShiftRight") ? RUN_SPEED : WALK_SPEED;
    const k = 1 - Math.exp(-(this.onGround ? 10 : 4) * dt);
    this.vel.x += (mx * speed - this.vel.x) * k;
    this.vel.z += (mz * speed - this.vel.z) * k;
    // In small steps, so at speed the hero can't tunnel through a crate.
    const steps = Math.max(1, Math.ceil((Math.hypot(this.vel.x, this.vel.z) * dt) / 0.8));
    for (let i = 0; i < steps; i++) {
      this.pos.x += (this.vel.x * dt) / steps;
      this.pos.z += (this.vel.z * dt) / steps;
      if (steps > 1) city.collide(this.pos, this.radius);
    }

    // Q in the air: cut the jets and drop like a stone, for a harder landing. Then it recharges.
    this.diveCd = Math.max(0, this.diveCd - dt);
    if (this.alive && !this.onGround && this.diveCd === 0 && input.pressed("KeyQ")) {
      this.diving = true;
      this.diveCd = this.stats.diveCooldown;
    }
    if (this.diving) this.vy = Math.min(this.vy, -DIVE_SPEED);
    // Space fires the leg jets: hold to climb, tap to hover, release to drop.
    const wantThrust = this.alive && input.down("Space") && !this.diving;
    this.thrusting = wantThrust && this.fuel > (this.thrusting ? 0 : 0.08);
    if (this.thrusting) {
      this.vy = Math.min(MAX_RISE, this.vy + THRUST * dt);
      this.fuel = Math.max(0, this.fuel - (FUEL_DRAIN / this.stats.fuelTank) * dt);
      this.sinceThrust = 0;
    } else {
      this.sinceThrust += dt;
      if (this.sinceThrust > 0.5) this.fuel = Math.min(1, this.fuel + (this.onGround ? FUEL_REGEN_GROUND : FUEL_REGEN_AIR) * dt);
    }
    this.vy -= GRAVITY * this.gravity * dt;
    this.pos.y += this.vy * dt;
    if (this.pos.y > MAX_ALTITUDE) {
      this.pos.y = MAX_ALTITUDE;
      this.vy = Math.min(0, this.vy);
    }
    const floor = city.floorAt(this.pos.x, this.pos.z, 0.6, this.pos.y);
    const wasAirborne = !this.onGround;
    if (wasAirborne) this.apex = Math.max(this.apex, this.pos.y);
    this.onGround = this.pos.y <= floor;
    if (this.onGround && wasAirborne && this.vy < -6) this.landed = -this.vy;
    if (this.onGround && wasAirborne) this.fell = this.apex - floor;
    if (this.onGround) this.diving = false;
    if (this.onGround) this.apex = floor;
    if (this.onGround) {
      this.pos.y = floor;
      this.vy = Math.max(0, this.vy);
    }
    city.collide(this.pos, this.radius);

    if (this.alive) this.facing = approachAngle(this.facing, this.yaw, dt * 12);
    this.specialT = Math.max(0, this.specialT - dt);
    if (this.specialT === 0) this.special = null;
    if (this.alive) this.hp = Math.min(this.maxHp, this.hp + this.stats.regen * dt);
    this.sinceHit += dt;
    if (this.alive && this.sinceHit > this.stats.shieldDelay) this.shield = Math.min(this.maxShield, this.shield + this.stats.shieldRegen * dt);
  }

  /**
   * Poses the body, keeps the cannons in its hands pointed at `aim`, and runs the jets.
   * Returns true on the frame a foot comes down.
   */
  pose(dt: number, aim: Vector3, firing: boolean) {
    const s = Math.sin(this.facing), c = Math.cos(this.facing);
    const toAim = aim.subtract(this.chest());
    const flat = Math.hypot(toAim.x, toAim.z);
    const aimYaw = clamp(Math.atan2(toAim.x * c - toAim.z * s, toAim.x * s + toAim.z * c), -0.9, 0.9);
    const aimPitch = clamp(-Math.atan2(toAim.y, flat), -0.8, 0.8);
    if (this.deathT >= 0) this.deathT += dt;

    const stepped = this.rig.update(dt, {
      facing: this.facing,
      forward: this.vel.x * s + this.vel.z * c,
      side: this.vel.x * c - this.vel.z * s,
      grounded: this.onGround,
      thrusting: this.thrusting,
      aimPitch: this.alive ? aimPitch : 0,
      aimYaw: this.alive ? aimYaw : 0,
      dead: this.deathT,
    });
    // Falls forward when destroyed.
    const fall = this.deathT >= 0 ? Math.min(1.35, this.deathT * this.deathT * 4) : 0;
    this.mech.root.position.set(this.pos.x, this.pos.y + this.rig.bob, this.pos.z);
    this.mech.root.rotation.set(fall, this.facing, 0);

    this.guns.forEach((g, i) => {
      g.node.position.copyFrom(this.mech.bonePosition(i ? "hand.R" : "hand.L"));
      g.aimAt(aim, this.facing, 0.9);
      g.update(dt, firing && this.alive && !this.special);
    });
    this.light.intensity *= Math.exp(-dt * 25);

    ["foot.L", "foot.R"].forEach((bone, i) => {
      (this.jets[i].emitter as Vector3).copyFrom(this.mech.bonePosition(bone));
      this.jets[i].emitRate = this.thrusting ? 120 : 0;
    });
    this.mech.bonePosition("spine.003");
    this.nozzles.forEach((n, i) => {
      (this.jets[2 + i].emitter as Vector3).copyFrom(n.computeWorldMatrix(true).getTranslation());
      this.jets[2 + i].emitRate = this.thrusting ? 200 : 0;
    });
    if (stepped) this.steps++;
    return stepped;
  }

  /** Alternates the two cannons while the trigger is held. */
  fire(dt: number, trigger: boolean): Shot | null {
    this.cooldown -= dt;
    if (!trigger || !this.alive || this.cooldown > 0 || this.special) return null;
    this.cooldown = FIRE_INTERVAL * this.stats.fireInterval;
    this.gun = 1 - this.gun;
    const g = this.guns[this.gun];
    g.fire();
    const from = g.muzzlePosition();
    const dir = g.direction();
    dir.addInPlaceFromFloats((Math.random() - 0.5) * SPREAD, (Math.random() - 0.5) * SPREAD, (Math.random() - 0.5) * SPREAD).normalize();
    this.light.position.copyFrom(from);
    this.light.intensity = 1.4;
    return { from, dir, right: g.right().scale(this.gun ? 1 : -1) };
  }

  /** A salvo of rockets from the tops of the cannon pods, then a cooldown. */
  rockets(dt: number, trigger: boolean): Shot | null {
    this.rocketCd = Math.max(0, this.rocketCd - dt);
    if (trigger && this.alive && this.rocketCd === 0) {
      this.salvo = this.stats.salvo;
      this.salvoT = 0;
      this.rocketCd = this.stats.rocketCooldown;
    }
    if (this.salvo <= 0) return null;
    this.salvoT -= dt;
    if (this.salvoT > 0) return null;
    this.salvoT = SALVO_INTERVAL;
    this.salvo--;
    const g = this.guns[this.salvo % 2];
    const from = g.muzzlePosition().addInPlaceFromFloats(0, 0.6, 0);
    const dir = g.direction().addInPlaceFromFloats((Math.random() - 0.5) * 0.06, 0.03, (Math.random() - 0.5) * 0.06).normalize();
    return { from, dir, right: g.right() };
  }

  /** Over-the-shoulder camera that slides in instead of clipping into walls. */
  updateCamera(cam: UniversalCamera, city: City, shake: number) {
    const look = this.look();
    const right = new Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const pivot = new Vector3(this.pos.x, this.pos.y + 5, this.pos.z);
    const offset = right.scale(2).subtract(look.scale(this.camDist));
    const len = offset.length();
    const dir = offset.scale(1 / len);
    const hit = city.raycast(pivot, dir, len + 0.5);
    cam.position.copyFrom(pivot).addInPlace(dir.scale(clamp(hit - 0.5, 0.3, len)));
    if (shake > 0) {
      const s = shake * 0.6;
      cam.position.addInPlaceFromFloats((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s);
    }
    cam.setTarget(cam.position.add(look));
  }
}

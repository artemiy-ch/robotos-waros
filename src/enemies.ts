import { AbstractMesh, Color3, PBRMaterial, Scene, ShadowGenerator, StandardMaterial, Vector3 } from "@babylonjs/core";
import { HALF, NAV_FIELDS } from "./city";
import type { Game } from "./game";
import type { Mech, Models, RigName } from "./models";
import type { ShotKind } from "./projectiles";
import { approachAngle, clamp, raySphere, segSphere } from "./util";
import { Gatling } from "./weapons";
import { BURN_DPS, BURN_TIME } from "./primary";
import { NEUTRAL_TURRET, TurretMech } from "./turret";

export type Kind = "drone" | "kamikaze" | "heavyDrone" | "walker" | "gunner" | "titan" | "bossTitan" | "bossTitan2" | "carrier" | "flagship" | "pilot" | "turret";

interface RigSpec {
  model: RigName;
  scale: number;
  /** Walking animation; null for hovering robots. */
  gait: "Walk" | "Run" | null;
  /** Clip played before the wreck blows up; null blows up at once. */
  death: string | null;
  attack: string | null;
  hit: string | null;
  /** Bones the shots come out of, in turn. */
  guns?: string[];
  /** Or a rotary cannon on the chest bone: offset sideways/up/forward, and size. */
  gatling?: { at: [number, number, number]; size: number };
  tint?: Color3;
}

export interface Spec {
  name: string;
  hp: number;
  speed: number;
  radius: number;
  score: number;
  drop: number;
  /** Distance it likes to keep from the player. */
  want: number;
  range: number;
  dmg: number;
  bulletSpeed: number;
  burst: number;
  cooldown: [number, number];
  shot: ShotKind;
  /**
   * Hit spheres as [height above pos, radius, distance ahead]; the first one is
   * also where it looks from and what explosions measure to.
   */
  hit: [number, number, number?][];
  rig: RigSpec;
  /** Gets a health bar at the top of the screen. */
  boss?: boolean;
  /** Flies at this fixed height, above the rooftops and their collisions. */
  altitude?: number;
  /** Walks straight through buildings, knocking them down. */
  crusher?: boolean;
  /** Seconds between ground stomps when the player is near; damage and reach. */
  stomp?: { every: number; dmg: number; reach: number };
  /** Salvos of homing rockets at the player, from the gun bones. */
  rockets?: { every: number; count: number; dmg: number };
  /** Flies straight at the player and blows itself up: how close it arms, the fuse, the blast. */
  kamikaze?: { trigger: number; fuse: number; radius: number; dmg: number };
  /** The final boss: fights in phases and goes down in a long crash. */
  final?: boolean;
  /** Stands guard on a flag (multiplayer): never moves, turns to shoot. */
  turret?: boolean;
  /** Launches this many drones every few seconds, up to a limit; and kamikazes with them, up to their own limit. */
  launches?: { every: number; count: number; max: number; kamikaze?: { count: number; max: number } };
}

/** Height of another player's head (its own hit sphere: a shot through it is a headshot). */
const PILOT_HEAD = 4.95;

export const SPECS: Record<Kind, Spec> = {
  // A flag's gun turret (multiplayer): its model is built from shapes (turret.ts), the cannon is a gatling.
  turret: {
    name: "Турель", hp: 120, speed: 0, radius: 1.6, score: 0, drop: 0, want: 0, range: 70,
    dmg: 4, bulletSpeed: 70, burst: 5, cooldown: [1.2, 1.8], shot: "bolt", hit: [[2.4, 1.3], [0.8, 1.5]],
    rig: { model: "Hero", scale: 1, gait: null, death: null, attack: null, hit: null, gatling: { at: [0, 0.2, 0.9], size: 1.3 } },
    turret: true,
  },
  // Another player in multiplayer: moved by the network, hit like a robot, damaged over the network.
  pilot: {
    name: "Пилот", hp: 100, speed: 0, radius: 1.3, score: 0, drop: 0, want: 0, range: 0,
    dmg: 0, bulletSpeed: 1, burst: 0, cooldown: [9, 9], shot: "tracer", hit: [[3.4, 1.6], [1.4, 1.1], [PILOT_HEAD, 0.7]],
    rig: { model: "Hero", scale: 0.42, gait: null, death: null, attack: null, hit: null },
  },
  drone: {
    name: "Дрон", hp: 4, speed: 10, radius: 1.1, score: 100, drop: 0.15, want: 16, range: 60,
    dmg: 6, bulletSpeed: 34, burst: 1, cooldown: [1.2, 2.5], shot: "bolt", hit: [[0, 1.15]],
    rig: { model: "EyeDrone", scale: 2.2, gait: null, death: null, attack: "Attack", hit: "Hit" },
  },
  kamikaze: {
    name: "Камикадзе", hp: 3, speed: 21, radius: 1.1, score: 120, drop: 0.05, want: 0, range: 0,
    dmg: 0, bulletSpeed: 0, burst: 0, cooldown: [99, 99], shot: "bolt", hit: [[0, 1.2]],
    rig: { model: "EyeDrone", scale: 2, gait: null, death: null, attack: "Charging", hit: "Hit", tint: new Color3(1, 0.62, 0.1) },
    kamikaze: { trigger: 5, fuse: 0.55, radius: 7, dmg: 24 },
  },
  heavyDrone: {
    name: "Тяжёлый дрон", hp: 14, speed: 6, radius: 1.8, score: 300, drop: 0.6, want: 24, range: 65,
    dmg: 8, bulletSpeed: 40, burst: 3, cooldown: [2.4, 3], shot: "bolt", hit: [[0, 1.85]],
    rig: { model: "EyeDrone", scale: 3.6, gait: null, death: null, attack: "Charging", hit: "Hit", tint: new Color3(1, 0.45, 0.4) },
  },
  walker: {
    name: "Паук", hp: 8, speed: 9, radius: 2.2, score: 150, drop: 0.2, want: 14, range: 50,
    dmg: 6, bulletSpeed: 36, burst: 2, cooldown: [1.4, 2.4], shot: "bolt", hit: [[2.0, 2.0], [0.9, 1.4]],
    rig: { model: "QuadShell", scale: 2.6, gait: "Run", death: "TurnOff", attack: "Attack", hit: "Hit", guns: ["Gun.L", "Gun.R"] },
  },
  gunner: {
    name: "Стрелок", hp: 12, speed: 6, radius: 1.5, score: 250, drop: 0.35, want: 20, range: 60,
    dmg: 5, bulletSpeed: 40, burst: 4, cooldown: [2, 3], shot: "bolt", hit: [[3.9, 1.6], [1.9, 1.1]],
    rig: { model: "Stan", scale: 0.85, gait: "Walk", death: "Death", attack: null, hit: null, gatling: { at: [1.45, 0.75, 0.1], size: 0.9 } },
  },
  titan: {
    name: "Трилобит", hp: 68, speed: 4.5, radius: 3.2, score: 700, drop: 0.8, want: 26, range: 80,
    dmg: 16, bulletSpeed: 28, burst: 4, cooldown: [1.3, 1.9], shot: "plasma", hit: [[5.6, 3.2], [2.6, 2.4]],
    rig: { model: "Trilobite", scale: 3.0, gait: "Walk", death: "TurnOff", attack: "AttackAuto", hit: "Hit", guns: ["Gun.L", "Gun.R"] },
  },
  bossTitan: {
    name: "Гигантский трилобит", hp: 840, speed: 4.2, radius: 5.5, score: 3000, drop: 1, want: 24, range: 100,
    dmg: 18, bulletSpeed: 28, burst: 7, cooldown: [2.2, 2.8], shot: "plasma", hit: [[10.3, 5.9], [4.8, 4.4]],
    rig: { model: "Trilobite", scale: 5.5, gait: "Walk", death: "TurnOff", attack: "AttackAuto", hit: null, guns: ["Gun.L", "Gun.R"], tint: new Color3(0.8, 0.28, 0.22) },
    boss: true, crusher: true, stomp: { every: 4.5, dmg: 28, reach: 16 }, rockets: { every: 5.5, count: 3, dmg: 22 },
  },
  // The Moon's boss: the giant again, bigger and half as tough again, with bigger rocket salvos.
  bossTitan2: {
    name: "Трилобит-разрушитель", hp: 1260, speed: 4.4, radius: 6.5, score: 6000, drop: 1, want: 26, range: 110,
    dmg: 22, bulletSpeed: 30, burst: 9, cooldown: [1.9, 2.4], shot: "plasma", hit: [[12.1, 7], [5.7, 5.2]],
    rig: { model: "Trilobite", scale: 6.5, gait: "Walk", death: "TurnOff", attack: "AttackAuto", hit: null, guns: ["Gun.L", "Gun.R"], tint: new Color3(0.55, 0.1, 0.08) },
    boss: true, crusher: true, stomp: { every: 3.8, dmg: 34, reach: 20 }, rockets: { every: 4, count: 4, dmg: 30 },
  },
  carrier: {
    name: "Крейсер-матка", hp: 480, speed: 9, radius: 12, score: 3500, drop: 1, want: 45, range: 140,
    dmg: 7, bulletSpeed: 45, burst: 8, cooldown: [2.5, 3.5], shot: "bolt",
    hit: [[0, 6, 0], [0, 6, 10], [0, 6, -10], [0, 5, 17], [0, 5, -16]],
    rig: { model: "Carrier", scale: 2, gait: null, death: null, attack: null, hit: null },
    boss: true, altitude: 72, launches: { every: 7, count: 2, max: 10 },
  },
  // The final boss: a battleship-sized carrier over the Moon station.
  flagship: {
    name: "Флагман «Левиафан»", hp: 2600, speed: 7, radius: 22, score: 20000, drop: 1, want: 55, range: 170,
    dmg: 7, bulletSpeed: 48, burst: 12, cooldown: [1.8, 2.4], shot: "bolt",
    hit: [[0, 11, 0], [0, 11, 14], [0, 11, -14], [0, 9, 27], [0, 9, -27]],
    rig: { model: "Carrier", scale: 4, gait: null, death: null, attack: null, hit: null },
    boss: true, final: true, altitude: 80,
    launches: { every: 6, count: 3, max: 12, kamikaze: { count: 2, max: 6 } },
    rockets: { every: 5, count: 5, dmg: 26 },
  },
};


/** Which stage of the fight the final boss is in: 1 (above 60% health), 2, or 3 (below 25%). */
export const stageOf = (e: Enemy) => (e.hp > e.spec.hp * 0.6 ? 1 : e.hp > e.spec.hp * 0.25 ? 2 : 3);

/** Centre of one of an enemy's hit spheres. */
function sphereAt(e: Enemy, [h, , ahead = 0]: [number, number, number?]) {
  return new Vector3(e.pos.x + Math.sin(e.yaw) * ahead, e.pos.y + h, e.pos.z + Math.cos(e.yaw) * ahead);
}

export interface Enemy {
  kind: Kind;
  spec: Spec;
  mech: Mech;
  gatling: Gatling | null;
  pos: Vector3;
  vel: Vector3;
  yaw: number;
  hp: number;
  hover: number;
  phase: number;
  strafe: number;
  fireCd: number;
  burst: number;
  burstT: number;
  flashT: number;
  /** Next gun bone to fire from. */
  gun: number;
  /** Keeps the hit reaction from restarting on every bullet. */
  hitAnimT: number;
  /** Seconds left of standing dazed after being hit by a shawarma. */
  stunT: number;
  /** Which distance field it follows when it can't see the player: 0 heads straight for them, the rest flank. */
  flank: number;
  /** Health and damage multipliers from the wave and the map. */
  dmgScale: number;
  /** Kamikaze: seconds left on the armed fuse (-1 while not armed), and time to the next beep. */
  fuse: number;
  beepT: number;
  /** The final boss's current stage of the fight (see stageOf). */
  stage: number;
  /** Timers for the bosses' crushing, stomping and drone launches. */
  crushT: number;
  stompT: number;
  launchT: number;
  /** Rockets left in the current salvo, and the timers between salvos and between rockets. */
  salvo: number;
  salvoT: number;
  rocketT: number;
  /** Multiplayer: the player this stands in for, and their colour on the minimap. */
  pilot?: number;
  color?: string;
  /** Multiplayer bots: its number across the room; shots fired and where at since last reported (host); who hit it last. */
  netId?: number;
  fired?: number;
  aim?: Vector3;
  by?: number;
  /** A copy of the host's bot (not ours to run): its number, and where the host last saw it. */
  remoteBot?: number;
  netPos?: Vector3;
  netYaw?: number;
  /** Seconds the copy's gun keeps spinning after a reported shot. */
  firingT?: number;
  /** A turret: which flag it guards, and whose it is (WORLD for a neutral one). */
  turretFlag?: number;
  turretOwner?: number;
  /** Seconds left on fire from a flamethrower, and when its flames next show. */
  burnT?: number;
  burnFx?: number;
  /** Multiplayer bots are harder: faster on their feet, quicker to fire, better at leading their shots. */
  edge?: { speed: number; rate: number; lead: number };
}

const DEATH_TIME = 1.1;
/** Every wave brings this many times the base numbers, up to a cap (each robot is a skinned model). */
const WAVE_SIZE = 1.6;
const WAVE_CAP = 46;
/** Ordinary enemies move this much faster than their base speed, to keep up with the hero. */
const PACE = 1.4;
/** Enemies further than this from the player go round by their flanking routes. */
const FLANK_FROM = 45;

export class Enemies {
  readonly list: Enemy[] = [];
  private dying: { e: Enemy; t: number }[] = [];
  private tinted = new Map<string, PBRMaterial>();

  private nextNet = 1;
  /** Ordinary enemies get tougher every wave, and tougher still on the Moon. */
  private hpScale = 1;
  private dmgScale = 1;

  constructor(private scene: Scene, private shadows: ShadowGenerator, private models: Models) {}

  spawnWave(wave: number, g: Game) {
    const moon = g.city.theme === "moon";
    this.hpScale = 1.5 * (moon ? 1.35 : 1) * (1 + 0.05 * (wave - 1));
    this.dmgScale = (moon ? 1.25 : 1) * (1 + 0.03 * (wave - 1));
    let budget = WAVE_CAP;
    const add = (kind: Kind, count: number) => {
      const n = Math.min(budget, Math.ceil(count * WAVE_SIZE));
      budget -= n;
      for (let i = 0; i < n; i++) this.spawnAwayFrom(g, kind);
    };
    add("drone", Math.min(2 + wave, 10));
    if (wave >= 2) add("kamikaze", Math.min(wave, 8));
    add("walker", Math.min(wave, 6));
    if (wave >= 2) add("gunner", Math.min(wave - 1, 5));
    if (wave >= 3) add("heavyDrone", Math.min(wave - 2, 4));
    if (wave >= 2) add("titan", Math.min(Math.floor(wave / 2), 3));
  }

  private spawnAwayFrom(g: Game, kind: Kind) {
    const p = g.player.pos;
    for (let tries = 0; tries < 400; tries++) {
      const x = (Math.random() * 2 - 1) * (HALF - 5);
      const z = (Math.random() * 2 - 1) * (HALF - 5);
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < 60 || d > 170 || !g.city.nav.isFree(x, z)) continue;
      this.spawn(kind, x, z);
      return;
    }
  }

  /** A boss, somewhere out of sight. */
  spawnBoss(kind: Kind, g: Game) {
    this.spawnAwayFrom(g, kind);
  }

  private spawn(kind: Kind, x: number, z: number, y?: number) {
    const spec = SPECS[kind];
    const rig = spec.rig;
    const mech = spec.turret ? new TurretMech(this.scene, this.shadows, NEUTRAL_TURRET).asMech() : this.models.spawn(rig.model, rig.scale);
    mech.anim.play("Idle", { instant: true });
    if (rig.tint) for (const m of mech.meshes) m.material = this.tint(m, rig.tint);
    // The flagship gets its own copy of the hull material, so it can glow red with rage.
    if (spec.final) for (const m of mech.meshes) if (m.material) m.material = m.material.clone("flagshipHull");
    const gatling = rig.gatling ? new Gatling(this.scene, this.shadows, "enemy", rig.gatling.size) : null;
    const hover = spec.altitude ?? (rig.gait ? 0 : kind === "heavyDrone" ? 5 + Math.random() * 2 : 3.5 + Math.random() * 3);
    const pos = new Vector3(x, y ?? hover, z);
    mech.root.position.copyFrom(pos);
    const scaled = !spec.boss;
    this.list.push({
      netId: this.nextNet++,
      kind, spec, mech, gatling, pos, hover,
      vel: Vector3.Zero(),
      yaw: Math.random() * Math.PI * 2,
      hp: scaled ? spec.hp * this.hpScale : spec.hp,
      dmgScale: scaled ? this.dmgScale : 1,
      flank: Math.random() < 0.35 ? 0 : 1 + Math.floor(Math.random() * (NAV_FIELDS - 1)),
      fuse: -1,
      beepT: 0,
      phase: Math.random() * 10,
      strafe: Math.random() < 0.5 ? -1 : 1,
      fireCd: 1 + Math.random() * 2,
      burst: 0,
      burstT: 0,
      flashT: 0,
      gun: 0,
      hitAnimT: 0,
      stunT: 0,
      crushT: 0,
      stompT: spec.stomp?.every ?? 0,
      launchT: 2,
      stage: 1,
      salvo: 0,
      salvoT: 0,
      rocketT: spec.rockets ? 3 : 0,
    });
  }

  /** A tinted copy of a mesh's material, shared by every enemy with that tint. */
  private tint(mesh: AbstractMesh, color: Color3) {
    const src = mesh.material as PBRMaterial;
    const key = `${src.name}/${color.toHexString()}`;
    let m = this.tinted.get(key);
    if (!m) {
      m = src.clone(`${src.name}-tinted`) as PBRMaterial;
      m.albedoColor = color;
      this.tinted.set(key, m);
    }
    return m;
  }

  /** Where one of an enemy's hit spheres is now. */
  sphere(e: Enemy, sp: [number, number, number?]) {
    return sphereAt(e, sp);
  }

  /** Set alight by our flamethrower (again: the fire lasts BURN_TIME from the last lick). */
  ignite(e: Enemy) {
    e.burnT = BURN_TIME;
  }

  /** Burning: our damage over time (other players' and bots' copies pass it on over the network). */
  private burn(e: Enemy, dt: number, g: Game) {
    if (!e.burnT || e.burnT <= 0 || e.hp <= 0) return;
    e.burnT -= dt;
    e.burnFx = (e.burnFx ?? 0) - dt;
    if (e.burnFx <= 0) {
      e.burnFx = 0.25;
      g.fx.pop(this.centre(e).addInPlaceFromFloats((Math.random() - 0.5) * 1.5, 0, (Math.random() - 0.5) * 1.5));
    }
    this.damage(e, BURN_DPS * g.player.stats.gunDamage * dt, g, true);
  }

  /** Where an enemy is aimed at: the middle of its main hit sphere. */
  centre(e: Enemy) {
    return sphereAt(e, e.spec.hit[0]);
  }

  private eye(e: Enemy) {
    return sphereAt(e, e.spec.hit[0]);
  }

  update(dt: number, g: Game) {
    const local = { chest: g.player.chest(), vel: g.player.velocity, alive: g.state === "playing" && g.player.alive };
    for (const e of this.list) {
      this.burn(e, dt, g);
      if (e.pilot !== undefined) {
        e.flashT -= dt;
        e.mech.setFlash(e.flashT > 0);
        continue;
      }
      if (e.remoteBot !== undefined) {
        this.followBot(e, dt);
        continue;
      }
      // In a room each robot goes for the nearest player; on its own, for ours.
      const goal = g.arena ? g.arena.targetFor(e.pos, e.turretOwner) : local;
      const target = goal.chest;
      const canFire = goal.alive;
      const spec = e.spec;
      const flying = !spec.rig.gait;
      e.phase += dt;
      e.hitAnimT -= dt;
      if (spec.turret) {
        this.guard(e, dt, g, goal);
        continue;
      }
      if (e.stunT > 0) {
        this.daze(e, dt);
        continue;
      }
      const eye = this.eye(e);
      const to = target.subtract(eye);
      const dist = to.length();
      const los = dist < Math.max(90, spec.range) && g.city.lineOfSight(eye, target);
      const flat = Math.hypot(to.x, to.z) || 1;
      const ux = to.x / flat, uz = to.z / flat;

      // Seen the player: keep a comfortable range and circle around. Otherwise follow the flow field.
      let mx = 0, mz = 0;
      if (spec.kamikaze) {
        const s = los || flat < 30 ? null : g.city.nav.steer(e.pos.x, e.pos.z);
        mx = s ? s.x : ux;
        mz = s ? s.z : uz;
      } else if (los) {
        const radial = flat > spec.want + 5 ? 1 : flat < spec.want - 6 ? -1 : 0;
        mx = ux * radial - uz * e.strafe * 0.7;
        mz = uz * radial + ux * e.strafe * 0.7;
        if (Math.random() < dt * 0.5) {
          e.strafe = -e.strafe;
          if (flying && Math.random() < 0.3) e.mech.anim.oneShot("BackFlip");
        }
      } else if (spec.altitude || spec.crusher) {
        // Over the rooftops, or straight through the buildings: no need for the street grid.
        mx = ux;
        mz = uz;
      } else {
        const s = g.city.nav.steer(e.pos.x, e.pos.z, flat > FLANK_FROM ? e.flank : 0) ?? g.city.nav.steer(e.pos.x, e.pos.z);
        if (s) {
          mx = s.x;
          mz = s.z;
        }
      }
      const ml = Math.hypot(mx, mz);
      if (ml > 1) {
        mx /= ml;
        mz /= ml;
      }
      const k = 1 - Math.exp(-3 * dt);
      const speed = (spec.final && e.stage >= 3 ? spec.speed * 1.6 : spec.boss ? spec.speed : spec.speed * PACE) * (e.edge?.speed ?? 1);
      e.vel.x += (mx * speed - e.vel.x) * k;
      e.vel.z += (mz * speed - e.vel.z) * k;
      for (const o of this.list) {
        if (o === e) continue;
        const sx = e.pos.x - o.pos.x, sz = e.pos.z - o.pos.z;
        const min = spec.radius + o.spec.radius + 3;
        const d2 = sx * sx + sz * sz;
        if (d2 < min * min && d2 > 1e-6) {
          const d = Math.sqrt(d2);
          e.vel.x += (sx / d) * 22 * dt;
          e.vel.z += (sz / d) * 22 * dt;
        }
      }
      e.pos.x += e.vel.x * dt;
      e.pos.z += e.vel.z * dt;
      if (flying) {
        // Drones climb after a player hovering above the streets or standing on a roof.
        const alt = spec.kamikaze
          ? Math.max(2, target.y - 0.5)
          : spec.altitude
            ? e.hover
            : Math.max(e.hover, Math.min(target.y - 3.4 + e.hover * 0.6, 85));
        e.pos.y += (alt + Math.sin(e.phase * 1.7) * 0.4 - e.pos.y) * Math.min(1, dt * (spec.kamikaze ? 4 : 1.5));
      }
      if (spec.crusher) this.crush(e, dt, g);
      else if (!spec.altitude) g.city.collide(e.pos, spec.radius);
      if (spec.altitude) {
        e.pos.x = clamp(e.pos.x, -HALF, HALF);
        e.pos.z = clamp(e.pos.z, -HALF, HALF);
      }

      const hs = Math.hypot(e.vel.x, e.vel.z);
      const wantYaw = los ? Math.atan2(ux, uz) : hs > 0.5 ? Math.atan2(e.vel.x, e.vel.z) : e.yaw;
      e.yaw = approachAngle(e.yaw, wantYaw, dt * (flying ? 8 : 4));
      e.mech.root.position.copyFrom(e.pos);
      e.mech.root.rotation.y = e.yaw;

      if (flying) {
        const fwd = e.vel.x * Math.sin(e.yaw) + e.vel.z * Math.cos(e.yaw);
        const side = e.vel.x * Math.cos(e.yaw) - e.vel.z * Math.sin(e.yaw);
        e.mech.root.rotation.x = clamp(fwd * 0.03, -0.35, 0.35);
        e.mech.root.rotation.z = clamp(-side * 0.03, -0.35, 0.35);
        e.mech.anim.play("Idle");
      } else if (hs < 0.7) e.mech.anim.play("Idle");
      else {
        const along = (e.vel.x * Math.sin(e.yaw) + e.vel.z * Math.cos(e.yaw)) / hs;
        e.mech.anim.play(spec.rig.gait!, { speed: ((along < -0.3 ? -1 : 1) * hs) / spec.speed });
      }
      e.mech.anim.update(dt);
      if (e.gatling) {
        this.mountGatling(e);
        e.gatling.aimAt(target, e.yaw, 0.9);
        e.gatling.update(dt, e.burst > 0);
      }
      e.flashT -= dt;
      e.mech.setFlash(e.flashT > 0);

      if (spec.kamikaze) {
        if (canFire) this.tickFuse(e, dt, dist, g);
        continue;
      }
      if (!canFire) continue;
      if (spec.stomp) this.stomp(e, dt, flat, g);
      if (spec.launches) this.launch(e, dt, g);
      if (spec.final) this.stages(e, g);
      if (spec.rockets && (!spec.final || e.stage >= 2)) this.rocketSalvo(e, dt, los, dist, target, g);
      e.fireCd -= dt;
      if (los && dist < spec.range && e.fireCd <= 0) {
        e.burst = spec.burst;
        e.burstT = 0;
        e.fireCd = (spec.cooldown[0] + Math.random() * (spec.cooldown[1] - spec.cooldown[0])) * (e.edge?.rate ?? 1);
        if (spec.rig.attack) e.mech.anim.oneShot(spec.rig.attack);
      }
      e.burstT -= dt;
      if (e.burst > 0 && e.burstT <= 0) {
        this.fire(e, target, g, goal.vel);
        e.burst--;
        e.burstT = 0.14;
      }
    }
    for (const e of this.list.filter((x) => x.fuse === 0)) this.detonate(e, g);
    this.updateDying(dt, g);
  }

  /** A kamikaze beeps faster as it closes in, arms within reach, and goes off when the fuse runs out. */
  private tickFuse(e: Enemy, dt: number, dist: number, g: Game) {
    const k = e.spec.kamikaze!;
    if (e.fuse < 0 && dist < k.trigger + e.spec.radius) {
      e.fuse = k.fuse;
      e.mech.anim.oneShot("Charging");
    }
    if (e.fuse > 0) e.fuse = Math.max(0, e.fuse - dt);
    e.beepT -= dt;
    if (e.beepT <= 0 && dist < 45) {
      e.beepT = e.fuse > 0 ? 0.09 : clamp(dist / 80, 0.12, 0.55);
      e.flashT = 0.05;
      g.sfx.beep(e.fuse > 0 ? 1 : 1 - dist / 45, dist);
    }
  }

  /** Blows a kamikaze up where it is: hurts the player and anything else caught in the blast. */
  private detonate(e: Enemy, g: Game) {
    const i = this.list.indexOf(e);
    if (i < 0) return;
    this.list.splice(i, 1);
    this.disposeEnemy(e);
    this.blast(e, g);
  }

  private blast(e: Enemy, g: Game) {
    const k = e.spec.kamikaze!;
    const at = e.pos.clone();
    const dist = Vector3.Distance(at, g.player.pos);
    g.fx.explosion(at, 1.3);
    g.sfx.explode(false, dist);
    g.addShake(dist, 0.6);
    const d = Vector3.Distance(at, g.player.chest());
    if (d < k.radius) g.hurtPlayer(k.dmg * e.dmgScale * (1 - (d / k.radius) * 0.5));
    // Other robots caught in it get hurt too.
    this.splash(at, k.radius, 10, g);
    g.props.blast(at, k.radius * 0.6, g);
  }

  /** The giant smashes whatever buildings it walks into. */
  private crush(e: Enemy, dt: number, g: Game) {
    e.crushT -= dt;
    if (e.crushT > 0) return;
    e.crushT = 0.25;
    const ahead = new Vector3(e.pos.x + Math.sin(e.yaw) * 2, 5, e.pos.z + Math.cos(e.yaw) * 2);
    g.destruction.blast(ahead, e.spec.radius + 2, 45, g);
    const lim = HALF - e.spec.radius;
    e.pos.x = clamp(e.pos.x, -lim, lim);
    e.pos.z = clamp(e.pos.z, -lim, lim);
  }

  /** Close up, the giant rears and slams the ground: a shockwave the player has to jump over. */
  private stomp(e: Enemy, dt: number, flat: number, g: Game) {
    const st = e.spec.stomp!;
    e.stompT -= dt;
    if (e.stompT > 0 || flat > st.reach * 1.4) return;
    e.stompT = st.every;
    e.mech.anim.oneShot("Attack");
    const at = new Vector3(e.pos.x, 0.3, e.pos.z);
    g.fx.slam(at, st.reach);
    g.sfx.slam(Vector3.Distance(at, g.player.pos));
    g.addShake(Vector3.Distance(at, g.player.pos), 0.9);
    const p = g.player;
    if (p.grounded && Math.hypot(p.pos.x - at.x, p.pos.z - at.z) < st.reach) g.hurtPlayer(st.dmg);
  }

  /** Every few seconds, a salvo of homing rockets that arc up out of its guns and come down on the player. */
  private rocketSalvo(e: Enemy, dt: number, los: boolean, dist: number, target: Vector3, g: Game) {
    const r = e.spec.rockets!;
    e.rocketT -= dt;
    if (e.rocketT <= 0 && los && dist < 130) {
      e.rocketT = e.stage >= 3 ? r.every * 0.55 : r.every;
      e.salvo = r.count;
      // A beat of warning before the first one leaves: the guns spark and an alarm goes.
      e.salvoT = 0.7;
      e.mech.anim.oneShot("Attack");
      for (const p of this.launchPoints(e)) g.fx.spark(p, 25);
      g.sfx.missileWarning();
      g.hud.warning("Ракетный залп!");
    }
    e.salvoT -= dt;
    if (e.salvo <= 0 || e.salvoT > 0) return;
    e.salvoT = 0.35;
    e.salvo--;
    const points = this.launchPoints(e);
    const from = points[e.salvo % points.length].addInPlaceFromFloats(0, 2, 0);
    const dir = target.subtract(from).normalize().addInPlaceFromFloats((Math.random() - 0.5) * 0.9, 0.9, (Math.random() - 0.5) * 0.9).normalize();
    g.projectiles.enemyRocket(from, dir, r.dmg, g);
    g.sfx.rocket(Math.max(0.15, 0.7 - Vector3.Distance(e.pos, g.player.pos) / 150));
  }

  /** Where rockets come out: the gun bones of walkers, or pods along a ship's hull. */
  private launchPoints(e: Enemy) {
    const guns = e.spec.rig.guns;
    if (guns) return guns.map((gun) => e.mech.bonePosition(gun));
    const r = e.spec.radius;
    return [-0.7, -0.25, 0.25, 0.7].map((f) => sphereAt(e, [-r * 0.15, 0, f * r]));
  }

  /**
   * The final boss gets angrier as it is hurt: it comes lower, starts firing missile salvos,
   * then glows red, speeds up and fires them twice as often.
   */
  private stages(e: Enemy, g: Game) {
    const stage = stageOf(e);
    if (stage === 3) {
      const pulse = 0.35 + 0.25 * Math.sin(e.phase * 6);
      for (const m of e.mech.meshes) if (m.material instanceof StandardMaterial) m.material.emissiveColor = new Color3(pulse, 0.04, 0.02);
    }
    if (stage === e.stage) return;
    e.stage = stage;
    e.hover = stage === 2 ? 55 : 42;
    e.launchT = 0;
    g.sfx.bossAlarm();
    g.hud.warning(stage === 2 ? "Флагман снижается!" : "Флагман в ярости!");
    g.addShake(0, 0.6);
  }

  /** The carrier drops drones out of its belly. */
  private launch(e: Enemy, dt: number, g: Game) {
    const l = e.spec.launches!;
    e.launchT -= dt;
    if (e.launchT > 0) return;
    e.launchT = l.every;
    const drones = this.list.filter((o) => o.kind === "drone").length;
    for (let i = 0; i < Math.min(l.count, l.max - drones); i++) {
      const side = (i % 2 ? 1 : -1) * 5;
      this.spawn("drone", e.pos.x + Math.cos(e.yaw) * side, e.pos.z - Math.sin(e.yaw) * side, e.pos.y - 5);
      g.fx.spark(new Vector3(e.pos.x, e.pos.y - 4, e.pos.z), 20);
    }
    // Kamikazes drop out of the belly and dive at the player; one more each time once it is enraged.
    const k = l.kamikaze;
    if (!k) return;
    const armed = this.list.filter((o) => o.kind === "kamikaze").length;
    const count = Math.min(k.count + (e.stage >= 3 ? 1 : 0), k.max - armed);
    for (let i = 0; i < count; i++) {
      const along = (i - (count - 1) / 2) * 8;
      this.spawn("kamikaze", e.pos.x + Math.sin(e.yaw) * along, e.pos.z + Math.cos(e.yaw) * along, e.pos.y - 8);
    }
    if (count > 0) g.hud.warning("Камикадзе!");
  }

  private mountGatling(e: Enemy) {
    const [lx, ly, lz] = e.spec.rig.gatling!.at;
    const chest = e.mech.bonePosition("Chest");
    const s = Math.sin(e.yaw), c = Math.cos(e.yaw);
    e.gatling!.node.position.set(chest.x + c * lx + s * lz, chest.y + ly, chest.z - s * lx + c * lz);
  }

  private fire(e: Enemy, chest: Vector3, g: Game, vel = g.player.velocity) {
    const spread = 0.04;
    // Aim where the player is going to be (about two thirds of the way).
    const lead = Vector3.Distance(e.pos, chest) / Math.max(1, e.spec.bulletSpeed);
    const target = chest.add(vel.scale(lead * (e.edge?.lead ?? 0.65)));
    // Told to the other players, so their copies of this robot fire too.
    e.fired = (e.fired ?? 0) + 1;
    e.aim = target;
    const guns = e.spec.rig.guns;
    let from: Vector3;
    if (e.gatling) {
      e.gatling.fire();
      from = e.gatling.muzzlePosition();
    } else if (guns) {
      from = e.mech.bonePosition(guns[e.gun++ % guns.length]);
      from.addInPlace(target.subtract(from).normalize().scale(0.6 * e.spec.rig.scale));
      g.fx.spark(from, 6);
    } else if (e.spec.altitude) {
      // Belly turrets along the hull.
      from = sphereAt(e, [-e.spec.radius * 0.18, 0, (Math.random() - 0.5) * e.spec.radius * 1.6]);
    } else from = e.pos.add(target.subtract(e.pos).normalize().scale(e.spec.radius + 0.3));
    const dir = target.subtract(from).normalize();
    dir.addInPlaceFromFloats((Math.random() - 0.5) * 2 * spread, (Math.random() - 0.5) * 2 * spread, (Math.random() - 0.5) * 2 * spread).normalize();
    // A player's turret fires on their behalf: its kills are theirs.
    const by = e.turretOwner !== undefined && e.turretOwner > 0 ? e.turretOwner : undefined;
    g.projectiles.spawn(from, dir.scale(e.spec.bulletSpeed), e.spec.shot, e.spec.dmg * e.dmgScale, 2, by);
    g.sfx.enemyShoot(Vector3.Distance(e.pos, g.player.pos), e.spec.shot === "plasma");
  }

  /** `quiet` skips the hit click (the laser hits every frame). */
  /** Whether a shot from a to b goes through another player's head. */
  headshot(e: Enemy, a: Vector3, b: Vector3) {
    return e.pilot !== undefined && segSphere(a, b, sphereAt(e, [PILOT_HEAD, 0.7]), 0.7);
  }

  /** `head`: it was a headshot (another player, multiplayer). */
  damage(e: Enemy, dmg: number, g: Game, quiet = false, head = false) {
    if (e.remoteBot !== undefined) {
      // The host's robot: the host's game takes the damage.
      if (dmg <= 0) return;
      g.arena?.hitBot(e.remoteBot, dmg);
      e.flashT = 0.08;
      g.hud.hitMarker();
      if (!quiet) g.sfx.hit();
      return;
    }
    if (e.pilot !== undefined) {
      // Only the shooter's own hits count (others' shots are just for show); the victim's game takes the damage.
      if (dmg <= 0) return;
      g.arena?.hitPilot(e.pilot, dmg, head);
      if (head) g.popup(sphereAt(e, [PILOT_HEAD + 1, 0]), "Хедшот", false);
      e.flashT = 0.08;
      g.hud.hitMarker();
      if (!quiet) g.sfx.hit();
      return;
    }
    if (e.hp <= 0) return;
    e.hp -= dmg;
    e.flashT = 0.08;
    g.hud.hitMarker();
    if (!quiet) g.sfx.hit();
    if (e.hp > 0) {
      if (e.spec.rig.hit && e.hitAnimT <= 0) {
        e.mech.anim.oneShot(e.spec.rig.hit);
        e.hitAnimT = 0.8;
      }
      return;
    }
    this.list.splice(this.list.indexOf(e), 1);
    g.onEnemyKilled(e);
    e.mech.setFlash(false);
    if (e.spec.kamikaze) {
      this.disposeEnemy(e);
      this.blast(e, g);
      return;
    }
    if (e.spec.rig.death || e.spec.final) {
      if (e.spec.rig.death) e.mech.anim.play(e.spec.rig.death, { loop: false, speed: 1.3 });
      this.dying.push({ e, t: 0 });
    } else this.disposeEnemy(e);
  }

  /** Walkers play their shut-down animation, then blow up. */
  private updateDying(dt: number, g: Game) {
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const d = this.dying[i];
      d.t += dt;
      if (d.e.spec.final) {
        if (this.crash(d.e, d.t, dt, g)) this.dying.splice(i, 1);
        continue;
      }
      d.e.mech.anim.update(dt);
      if (d.e.gatling) {
        this.mountGatling(d.e);
        d.e.gatling.update(dt, false);
      }
      if (d.t < DEATH_TIME) continue;
      const size = d.e.spec.boss ? 3.5 : d.e.kind === "titan" ? 2.2 : 1.4;
      const dist = Vector3.Distance(d.e.pos, g.player.pos);
      g.fx.explosion(d.e.pos.add(new Vector3(0, d.e.spec.hit[0][0] * 0.6, 0)), size);
      g.sfx.explode(true, dist);
      g.addShake(dist, size > 2 ? 0.9 : 0.5);
      this.disposeEnemy(d.e);
      this.dying.splice(i, 1);
    }
  }

  /**
   * The flagship's end: it lurches, noses over and falls burning for a few seconds, blowing up
   * along its hull, then hits the station in one enormous blast that flattens the blocks around.
   * Returns true when it is over.
   */
  private crash(e: Enemy, t: number, dt: number, g: Game) {
    const FALL = 4.5;
    if (t < FALL) {
      e.vel.y = (e.vel.y || 0) - 14 * dt;
      e.pos.addInPlace(e.vel.scale(dt));
      e.pos.x += Math.sin(e.yaw) * 10 * dt;
      e.pos.z += Math.cos(e.yaw) * 10 * dt;
      e.mech.root.position.copyFrom(e.pos);
      e.mech.root.rotation.x = Math.min(0.6, e.mech.root.rotation.x + dt * 0.18);
      e.mech.root.rotation.z += dt * 0.12;
      e.flashT -= dt;
      if (e.flashT <= 0) {
        e.flashT = 0.22;
        const along = (Math.random() - 0.5) * e.spec.radius * 1.6;
        g.fx.explosion(sphereAt(e, [(Math.random() - 0.5) * 6, 0, along]), 1.4, true);
        g.sfx.explode(false, Vector3.Distance(e.pos, g.player.pos) * 0.5);
        g.addShake(0, 0.25);
      }
      if (e.pos.y > 4) return false;
    }
    // Impact.
    const at = new Vector3(e.pos.x, 2, e.pos.z);
    for (let k = 0; k < 6; k++) {
      const off = new Vector3((Math.random() - 0.5) * 50, Math.random() * 10, (Math.random() - 0.5) * 50);
      setTimeout(() => g.fx.explosion(at.add(off), 3, k > 1), k * 180);
    }
    g.fx.slam(at, 60);
    g.sfx.explode(true, 0);
    g.sfx.slam(0);
    g.addShake(0, 1);
    g.destruction.blast(at.add(new Vector3(0, 6, 0)), 40, 1000, g);
    this.disposeEnemy(e);
    g.onFinalBossDown();
    return true;
  }

  private disposeEnemy(e: Enemy) {
    e.mech.dispose();
    e.gatling?.dispose();
  }

  /** The first enemy whose body the segment a→b passes through. */
  hitTest(a: Vector3, b: Vector3) {
    for (const e of this.list) {
      for (const sp of e.spec.hit) if (segSphere(a, b, sphereAt(e, sp), sp[1])) return e;
    }
    return null;
  }

  /** The nearest enemy along a unit ray within maxT, and how far it is. */
  raycastEnemy(o: Vector3, d: Vector3, maxT: number) {
    let best: { t: number; enemy: Enemy } | null = null;
    for (const e of this.list) {
      for (const sp of e.spec.hit) {
        const t = raySphere(o, d, sphereAt(e, sp), sp[1]);
        if (t < (best?.t ?? maxT)) best = { t, enemy: e };
      }
    }
    return best;
  }

  /** Distance along a unit ray to the nearest enemy, or maxT. */
  raycast(o: Vector3, d: Vector3, maxT: number) {
    let best = maxT;
    for (const e of this.list) {
      for (const sp of e.spec.hit) best = Math.min(best, raySphere(o, d, sphereAt(e, sp), sp[1]));
    }
    return best;
  }

  /** Explosion damage, measured to the nearest hit sphere; returns who was caught in it. */
  splash(center: Vector3, radius: number, dmg: number, g: Game) {
    const caught: Enemy[] = [];
    for (const e of [...this.list]) {
      const d = Math.min(...e.spec.hit.map((sp) => Vector3.Distance(center, sphereAt(e, sp)) - sp[1]));
      if (d >= radius) continue;
      caught.push(e);
      this.damage(e, Math.max(1, dmg * (1 - Math.max(0, d) / radius)), g);
    }
    return caught;
  }

  /** Hit by a shawarma: everything but a boss stops to spin round in a daze. */
  feed(e: Enemy, seconds: number, g: Game) {
    e.flashT = 0.15;
    if (e.pilot !== undefined) return g.arena?.stunPilot(e.pilot, seconds);
    if (e.remoteBot !== undefined) return;
    if (e.spec.boss || seconds <= 0) return;
    if (e.stunT <= 0 && e.spec.kamikaze) e.fuse = -1; // forgets it was about to blow up, too
    e.stunT = seconds;
  }

  /** Dazed: no moving, no shooting, just turning on the spot and bobbing. */
  private daze(e: Enemy, dt: number) {
    e.stunT -= dt;
    e.vel.scaleInPlace(Math.max(0, 1 - dt * 6));
    e.pos.x += e.vel.x * dt;
    e.pos.z += e.vel.z * dt;
    e.yaw += dt * 9;
    e.mech.root.position.copyFrom(e.pos);
    e.mech.root.position.y += Math.abs(Math.sin(e.phase * 7)) * 0.4;
    e.mech.root.rotation.y = e.yaw;
    e.mech.root.rotation.z = Math.sin(e.phase * 5) * 0.15;
    e.mech.anim.play("Idle");
    e.mech.anim.update(dt);
    e.flashT -= dt;
    e.mech.setFlash(e.flashT > 0);
  }

  /** A shove away from `from` (the landing shockwave). */
  knockBack(e: Enemy, from: Vector3, strength: number) {
    if (e.pilot !== undefined || e.remoteBot !== undefined) return;
    const dx = e.pos.x - from.x, dz = e.pos.z - from.z;
    const d = Math.hypot(dx, dz) || 1;
    const k = e.spec.boss ? 0.15 : 1;
    e.vel.x += (dx / d) * strength * k;
    e.vel.z += (dz / d) * strength * k;
    e.flashT = 0.15;
  }

  get boss() {
    return this.list.find((e) => e.spec.boss) ?? null;
  }

  /** Multiplayer bots, which the host runs: these kinds (no bosses, nothing that homes in on one player). */
  static readonly BOT_KINDS: Kind[] = ["drone", "drone", "walker", "gunner", "heavyDrone"];

  /** The host adds a bot somewhere away from the action. */
  spawnBot(g: Game) {
    this.hpScale = 1.5 * 1.25; // a quarter more than in the waves
    this.dmgScale = 1.25;
    const before = this.list.length;
    this.spawnAwayFrom(g, Enemies.BOT_KINDS[Math.floor(Math.random() * Enemies.BOT_KINDS.length)]);
    if (this.list.length > before) this.list[this.list.length - 1].edge = { speed: 1.3, rate: 0.5, lead: 0.75 };
  }

  /** A copy of one of the host's bots. */
  addRemoteBot(id: number, kind: Kind, x: number, y: number, z: number, yaw: number) {
    this.spawn(kind, x, z, y);
    const e = this.list[this.list.length - 1];
    e.remoteBot = id;
    e.netPos = new Vector3(x, y, z);
    e.yaw = e.netYaw = yaw;
    e.firingT = 0;
    return e;
  }

  /** A copy whose bot is gone: blown up (or just removed, `quietly`). */
  dropRemoteBot(e: Enemy, g: Game, quietly = false) {
    const i = this.list.indexOf(e);
    if (i >= 0) this.list.splice(i, 1);
    if (!quietly) {
      const dist = Vector3.Distance(e.pos, g.player.pos);
      g.fx.explosion(e.pos.add(new Vector3(0, e.spec.hit[0][0] * 0.6, 0)), e.kind === "heavyDrone" ? 1.6 : 1.2);
      g.sfx.explode(false, dist);
    }
    this.disposeEnemy(e);
  }

  /** A copy follows where the host says its bot is, walking or hovering as it goes. */
  private followBot(e: Enemy, dt: number) {
    const to = e.netPos!.subtract(e.pos);
    const k = to.length() > 30 ? 1 : 1 - Math.exp(-dt * 10);
    const step = to.scale(k);
    e.pos.addInPlace(step);
    const speed = Math.hypot(step.x, step.z) / Math.max(dt, 1e-3);
    e.yaw = approachAngle(e.yaw, e.netYaw!, dt * 8);
    e.phase += dt;
    e.mech.root.position.copyFrom(e.pos);
    e.mech.root.rotation.y = e.yaw;
    const gait = e.spec.rig.gait;
    if (gait && speed > 0.7) e.mech.anim.play(gait, { speed: speed / e.spec.speed });
    else e.mech.anim.play("Idle");
    e.mech.anim.update(dt);
    e.firingT = Math.max(0, (e.firingT ?? 0) - dt);
    if (e.gatling) {
      this.mountGatling(e);
      if (e.aim) e.gatling.aimAt(e.aim, e.yaw, 0.9);
      e.gatling.update(dt, e.firingT > 0);
    }
    e.flashT -= dt;
    e.mech.setFlash(e.flashT > 0);
  }

  /** A copy's shots, for show: the host's game deals the damage. */
  showShots(e: Enemy, count: number, at: Vector3, g: Game) {
    e.aim = at;
    e.firingT = 0.4;
    for (let i = 0; i < count; i++) {
      const from = e.gatling ? e.gatling.muzzlePosition() : this.eye(e).add(at.subtract(e.pos).normalize().scale(e.spec.radius + 0.3));
      const dir = at.subtract(from).normalize();
      g.projectiles.spawn(from, dir.scale(e.spec.bulletSpeed), e.spec.shot, 0);
    }
    if (count) g.sfx.enemyShoot(Vector3.Distance(e.pos, g.player.pos), e.spec.shot === "plasma");
  }

  /** A turret on a flag (the host's), neutral or a player's. */
  spawnTurret(flag: number, at: Vector3, owner: number, color: string) {
    this.spawn("turret", at.x, at.z, at.y);
    const e = this.list[this.list.length - 1];
    e.hp = SPECS.turret.hp;
    e.dmgScale = 1;
    e.turretFlag = flag;
    this.setTurretOwner(e, owner, color);
    return e;
  }

  setTurretOwner(e: Enemy, owner: number, color: string) {
    e.turretOwner = owner;
    (e.mech as unknown as TurretMech).setColor(color);
  }

  /** A turret's turn: swing round to whoever it is after, and fire bursts while it can see them. */
  private guard(e: Enemy, dt: number, g: Game, goal: { chest: Vector3; vel: Vector3; alive: boolean }) {
    const spec = e.spec;
    const eye = this.eye(e);
    const to = goal.chest.subtract(eye);
    const dist = to.length();
    const sees = goal.alive && dist < spec.range && g.city.lineOfSight(eye, goal.chest);
    if (sees) e.yaw = approachAngle(e.yaw, Math.atan2(to.x, to.z), dt * 3);
    e.mech.root.position.copyFrom(e.pos);
    e.mech.root.rotation.y = e.yaw;
    if (e.gatling) {
      this.mountGatling(e);
      e.gatling.aimAt(goal.chest, e.yaw, 0.9);
      e.gatling.update(dt, e.burst > 0);
    }
    e.flashT -= dt;
    e.mech.setFlash(e.flashT > 0);
    e.fireCd -= dt;
    e.burstT -= dt;
    if (!sees) return;
    if (e.fireCd <= 0) {
      e.burst = spec.burst;
      e.burstT = 0;
      e.fireCd = spec.cooldown[0] + Math.random() * (spec.cooldown[1] - spec.cooldown[0]);
    }
    if (e.burst > 0 && e.burstT <= 0) {
      this.fire(e, goal.chest, g, goal.vel);
      e.burst--;
      e.burstT = 0.12;
    }
  }

  /** Another player's robot joins the list (multiplayer); its model belongs to the caller. */
  addPilot(id: number, mech: Mech, pos: Vector3, color: string) {
    const spec = SPECS.pilot;
    this.list.push({
      kind: "pilot", spec, mech, gatling: null, pos, hover: 0, vel: Vector3.Zero(), yaw: 0, hp: spec.hp, dmgScale: 1, flank: 0,
      fuse: -1, beepT: 0, phase: 0, strafe: 1, fireCd: 99, burst: 0, burstT: 0, flashT: 0, gun: 0, hitAnimT: 0, stunT: 0,
      crushT: 0, stompT: 0, launchT: 99, stage: 1, salvo: 0, salvoT: 0, rocketT: 0, pilot: id, color,
    });
  }

  removePilot(id: number) {
    const i = this.list.findIndex((e) => e.pilot === id);
    if (i >= 0) this.list.splice(i, 1);
  }

  /** Every robot goes, except other players' (they leave when their players do). */
  clear() {
    for (const e of this.list) if (e.pilot === undefined) this.disposeEnemy(e);
    for (const d of this.dying) this.disposeEnemy(d.e);
    this.list.splice(0, this.list.length, ...this.list.filter((e) => e.pilot !== undefined));
    this.dying.length = 0;
  }
}


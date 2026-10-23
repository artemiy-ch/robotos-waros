import { InstancedMesh, Mesh, MeshBuilder, ParticleSystem, Scene, Vector3 } from "@babylonjs/core";
import type { Game } from "./game";
import { HEADSHOT } from "../shared/mp";
import { mat, segSphere } from "./util";

/** "tracer" is the player's cannon round; "bolt" and "plasma" are hostile. */
export type ShotKind = "tracer" | "bolt" | "plasma";

interface Bullet {
  mesh: InstancedMesh;
  pos: Vector3;
  vel: Vector3;
  life: number;
  kind: ShotKind;
  dmg: number;
  /** A player's turret fired it (multiplayer): it spares them, and its kills are theirs. */
  by?: number;
}

interface Rocket {
  mesh: Mesh;
  trail: ParticleSystem[];
  pos: Vector3;
  vel: Vector3;
  life: number;
  /** Fired at the player (homing, hurts the player) rather than by them; with its damage. */
  hostile: boolean;
  dmg: number;
  /** Another player's rocket, shown but harmless here (their game deals the damage). */
  show?: boolean;
}

/** Enemy rockets: how hard they turn towards the player, their blast radius. */
const HOMING_TURN = 1.6;
const HOSTILE_RADIUS = 8;

const ROCKET_RADIUS = 7;
const ROCKET_DAMAGE = 9;
const ROCKET_BUILDING_DAMAGE = 30;
const PLASMA_BUILDING_DAMAGE = 10;

export class Projectiles {
  private bullets: Bullet[] = [];
  private rockets: Rocket[] = [];
  private bases: Record<ShotKind, Mesh>;
  private rocketBase: Mesh;

  constructor(private scene: Scene) {
    this.bases = {
      tracer: this.base("#ff9a3c", 0.2),
      bolt: this.base("#ff3030", 0.24),
      plasma: this.base("#ff7a2a", 0.9),
    };

    const body = MeshBuilder.CreateCylinder("rocketBody", { diameter: 0.22, height: 1.0, tessellation: 8 }, scene);
    const nose = MeshBuilder.CreateCylinder("rocketNose", { diameterTop: 0, diameterBottom: 0.22, height: 0.3, tessellation: 8 }, scene);
    nose.position.y = 0.65;
    const fins = MeshBuilder.CreateBox("rocketFins", { width: 0.5, height: 0.25, depth: 0.04 }, scene);
    fins.position.y = -0.4;
    const fins2 = fins.clone("rocketFins2");
    fins2.rotation.y = Math.PI / 2;
    this.rocketBase = Mesh.MergeMeshes([body, nose, fins, fins2], true)!;
    this.rocketBase.rotation.x = Math.PI / 2; // nose along +Z
    this.rocketBase.bakeCurrentTransformIntoVertices();
    this.rocketBase.material = mat(scene, "rocket", "#d8d8d0");
    const flame = MeshBuilder.CreateSphere("rocketFlame", { diameter: 0.35, segments: 6 }, scene);
    flame.material = mat(scene, "rocketFlame", "#ffb347", true);
    flame.scaling.z = 2;
    flame.position.z = -0.75;
    flame.parent = this.rocketBase;
    this.rocketBase.setEnabled(false);
  }

  private base(hex: string, diameter: number) {
    const m = MeshBuilder.CreateSphere("bullet", { diameter, segments: 6 }, this.scene);
    m.material = mat(this.scene, `bullet${hex}`, hex, true);
    m.isPickable = false;
    m.position.y = -1000; // the source mesh stays out of sight; only its instances are seen
    return m;
  }

  /** A round; `life` in seconds sets how far it goes (shotgun pellets don't go far). */
  spawn(from: Vector3, vel: Vector3, kind: ShotKind, dmg: number, life = 2, by?: number) {
    const mesh = this.bases[kind].createInstance("b");
    mesh.isPickable = false;
    mesh.scaling.set(1, 1, kind === "tracer" ? 14 : kind === "bolt" ? 4 : 1.4);
    mesh.position.copyFrom(from);
    mesh.lookAt(from.add(vel));
    this.bullets.push({ mesh, pos: from.clone(), vel, life, kind, dmg, by });
  }

  rocket(from: Vector3, dir: Vector3, g: Game, show = false) {
    this.launch(from, dir.scale(45), g, false, 0, 3);
    this.rockets[this.rockets.length - 1].show = show;
  }

  /** A homing rocket fired at the player. */
  enemyRocket(from: Vector3, dir: Vector3, dmg: number, g: Game) {
    this.launch(from, dir.scale(26), g, true, dmg, 6);
  }

  private launch(from: Vector3, vel: Vector3, g: Game, hostile: boolean, dmg: number, life: number) {
    const mesh = this.rocketBase.clone("rocket", null)!;
    mesh.setEnabled(true);
    mesh.position.copyFrom(from);
    mesh.lookAt(from.add(vel));
    // Boss missiles are big, so they read from far off.
    if (hostile) mesh.scaling.setAll(2.4);
    this.rockets.push({ mesh, trail: g.fx.rocketTrail(mesh, hostile), pos: from.clone(), vel, life, hostile, dmg });
  }

  update(dt: number, g: Game) {
    this.updateBullets(dt, g);
    this.updateRockets(dt, g);
  }

  private updateBullets(dt: number, g: Game) {
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      const prev = b.pos.clone();
      b.pos.addInPlace(b.vel.scale(dt));
      b.life -= dt;
      let dead = b.life <= 0;

      // Hostile fire with damage in it (copies of the host's bots fire blanks): us, or in a room another player.
      if (!dead && b.kind !== "tracer" && b.dmg > 0) {
        const ours = b.by !== undefined && b.by === g.arena?.me;
        if (!ours && g.player.alive && g.player.hitSpheres().some(([c, r]) => segSphere(prev, b.pos, c, r))) {
          if (b.kind === "plasma") g.fx.pop(b.pos);
          g.arena?.hitByBot(b.by);
          g.hurtPlayer(b.dmg);
          dead = true;
        } else if (g.arena) {
          const hit = g.arena.hitRemote(prev, b.pos, b.by);
          if (hit !== null) {
            if (b.kind === "plasma") g.fx.pop(b.pos);
            g.arena.botHurt(hit, b.dmg, b.by);
            dead = true;
          }
        }
      }
      if (!dead && b.kind === "tracer") {
        const e = g.enemies.hitTest(prev, b.pos);
        if (e) {
          g.fx.impact(b.pos, null);
          const head = g.enemies.headshot(e, prev, b.pos);
          g.enemies.damage(e, b.dmg * (head ? HEADSHOT : 1), g, false, head);
          dead = true;
        }
      }
      if (!dead) {
        const seg = b.pos.subtract(prev);
        const len = seg.length();
        const hit = g.city.raycastHit(prev, seg.scale(1 / len), len);
        if (hit.t < len) {
          const at = prev.add(seg.scale(hit.t / len));
          if (b.kind === "plasma") {
            g.fx.pop(at);
            g.fx.scorch(at, hit.normal, 3);
            g.destruction.blast(at, 4, PLASMA_BUILDING_DAMAGE, g);
            g.props.blast(at, 4, g);
            const near = Vector3.Distance(at, g.player.chest());
            if (near < 4 && b.dmg > 0) g.hurtPlayer(b.dmg * 0.5);
          } else {
            g.fx.impact(at, hit.normal, b.kind === "tracer");
            if (b.kind === "tracer" && !g.props.hit(hit.box, b.dmg, g)) g.destruction.hit(hit.box, at, hit.normal, b.dmg, g);
          }
          dead = true;
        }
      }

      if (dead) {
        b.mesh.dispose();
        this.bullets.splice(i, 1);
      } else b.mesh.position.copyFrom(b.pos);
    }
  }

  private updateRockets(dt: number, g: Game) {
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i];
      const prev = r.pos.clone();
      if (r.hostile) {
        // Turn towards the player, a little at a time: they can be outrun or dodged.
        const speed = Math.min(60, r.vel.length() * (1 + dt * 0.6));
        const want = g.player.chest().subtract(r.pos).normalize();
        const dir = r.vel.normalize();
        const k = Math.min(1, dt * HOMING_TURN);
        r.vel = dir.scale(1 - k).add(want.scale(k)).normalize().scale(speed);
        r.mesh.lookAt(r.pos.add(r.vel));
      } else if (r.vel.length() < 110) r.vel.scaleInPlace(1 + dt * 1.5);
      r.pos.addInPlace(r.vel.scale(dt));
      r.life -= dt;

      let at: Vector3 | null = r.life <= 0 ? r.pos.clone() : null;
      if (!at && !r.hostile && g.enemies.hitTest(prev, r.pos)) at = r.pos.clone();
      if (!at && r.hostile && g.player.alive && g.player.hitSpheres().some(([c, rad]) => segSphere(prev, r.pos, c, rad + 0.6))) at = r.pos.clone();
      if (!at) {
        const seg = r.pos.subtract(prev);
        const len = seg.length();
        const hit = g.city.raycastHit(prev, seg.scale(1 / len), len);
        if (hit.t < len) {
          at = prev.add(seg.scale(hit.t / len));
          g.fx.scorch(at, hit.normal, 4);
        }
      }

      if (at && r.hostile) {
        g.fx.explosion(at, 1.6, true);
        g.sfx.explode(false, Vector3.Distance(at, g.player.pos));
        g.addShake(Vector3.Distance(at, g.player.pos), 0.5);
        const d = Vector3.Distance(at, g.player.chest());
        if (d < HOSTILE_RADIUS) g.hurtPlayer(r.dmg * (1 - (d / HOSTILE_RADIUS) * 0.6));
        g.destruction.blast(at, 4, 15, g);
        g.props.blast(at, 4, g);
      } else if (at) {
        g.fx.explosion(at, 1.1);
        g.sfx.explode(false, Vector3.Distance(at, g.player.pos));
        g.addShake(Vector3.Distance(at, g.player.pos), 0.5);
        if (!r.show) g.enemies.splash(at, ROCKET_RADIUS, ROCKET_DAMAGE, g);
        g.destruction.blast(at, ROCKET_RADIUS, ROCKET_BUILDING_DAMAGE, g);
        g.props.blast(at, ROCKET_RADIUS, g);
      }
      if (at) {
        g.fx.retire(r.trail, at);
        r.mesh.dispose();
        this.rockets.splice(i, 1);
      } else r.mesh.position.copyFrom(r.pos);
    }
  }

  clear() {
    for (const b of this.bullets) b.mesh.dispose();
    for (const r of this.rockets) {
      for (const t of r.trail) t.dispose(false);
      r.mesh.dispose();
    }
    this.bullets.length = 0;
    this.rockets.length = 0;
  }
}

import { Color3, Engine, Mesh, MeshBuilder, ParticleSystem, Scene, StandardMaterial, Vector3 } from "@babylonjs/core";
import type { Game } from "./game";
import type { Player } from "./player";
import { segSphere } from "./util";
import { HEADSHOT } from "../shared/mp";

/** The weapon on the left button, picked on the start screen. */
export type Primary = "guns" | "shotgun" | "rail" | "flame";
export const PRIMARY_LIST: Primary[] = ["guns", "shotgun", "rail", "flame"];

/** Name, a line about it, and its damage / range / rate of fire out of 5, for the cards. */
export const PRIMARIES: Record<Primary, { name: string; blurb: string; bars: [number, number, number] }> = {
  guns: { name: "Пулемёты", blurb: "Две гатлинг-пушки: просто и надёжно", bars: [2, 4, 5] },
  shotgun: { name: "Дробовик «Вазген»", blurb: "Веер дроби: страшен вблизи", bars: [5, 2, 3] },
  rail: { name: "Рельсотрон", blurb: "Мгновенный луч насквозь, далеко", bars: [5, 5, 2] },
  flame: { name: "Огнемёт", blurb: "Струя огня и поджог: держит зону", bars: [4, 3, 5] },
};

// Each weapon's numbers; damage is in units of the machine guns' damage per round (so upgrades help them all).
const SHOTGUN = { interval: 0.5, pellets: 10, damage: 2.4, spread: 0.065, speed: 170, life: 0.36 };
const RAIL = { interval: 0.8, damage: 24, range: 300 };
/** Every tick the cone of fire burns what is in it, and sets it alight for BURN_TIME. */
const FLAME = { tick: 0.1, damage: 2.2, range: 26, cone: Math.cos(0.24) };
export const BURN_TIME = 3;
export const BURN_DPS = 5;

/** Somebody's trigger: when they may fire next, which gun is next, their flames. */
interface Shooter {
  t: number;
  gun: number;
  flames: ParticleSystem[] | null;
}

/**
 * The left-button weapons besides the machine guns (which the player and the game handle as
 * before): shotgun, railgun, flamethrower. The same code fires them for us and,
 * for show only (no damage), for the other players' robots in multiplayer.
 */
export class Arsenal {
  private shooters = new Map<number, Shooter>();
  private trails: { mesh: Mesh; mat: StandardMaterial; t: number }[] = [];

  constructor(private scene: Scene) {}

  private shooter(id: number) {
    let s = this.shooters.get(id);
    if (!s) this.shooters.set(id, (s = { t: 0, gun: 0, flames: null }));
    return s;
  }

  /**
   * Fires \`kind\` for player \`id\` while \`firing\`, from \`p\`'s cannons towards \`aim\`. \`real\` is our own
   * shooting, which hurts; the other players' is for show.
   */
  fire(id: number, kind: Primary, dt: number, firing: boolean, p: Player, aim: Vector3, g: Game, real: boolean) {
    const s = this.shooter(id);
    s.t -= dt;
    if (kind === "flame") this.flame(s, firing, p, aim, g, real);
    else if (s.flames) for (const f of s.flames) f.emitRate = 0;
    if (real) g.sfx.flameLoop(firing && kind === "flame");
    if (!firing || s.t > 0 || kind === "guns" || kind === "flame") return;
    const rate = p.stats.fireInterval;
    s.gun = 1 - s.gun;
    const gun = p.guns[s.gun];
    gun.fire();
    const from = gun.muzzlePosition();
    let dir = aim.subtract(from).normalize();
    if (Vector3.Dot(dir, p.look()) < 0.5) dir = p.look();
    const dmg = real ? p.stats.gunDamage : 0;
    const near = Vector3.Distance(from, g.player.pos);
    if (kind === "shotgun") {
      s.t = SHOTGUN.interval * rate;
      for (let i = 0; i < SHOTGUN.pellets; i++) {
        const d = dir.add(new Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2).scale(SHOTGUN.spread)).normalize();
        g.projectiles.spawn(from, d.scale(SHOTGUN.speed), "tracer", dmg * SHOTGUN.damage, SHOTGUN.life);
      }
      g.sfx.shotgun(near);
      if (real) g.addShake(0, 0.25);
    } else if (kind === "rail") {
      s.t = RAIL.interval * rate;
      this.rail(from, dir, real ? dmg * RAIL.damage : 0, g);
      g.sfx.rail(near);
      if (real) g.addShake(0, 0.3);
    }
  }

  /** A railgun slug: straight to the first wall, through every robot on the way. */
  private rail(from: Vector3, dir: Vector3, damage: number, g: Game) {
    const wall = g.city.raycastHit(from, dir, RAIL.range);
    const end = from.add(dir.scale(wall.t));
    if (damage > 0) {
      for (const e of [...g.enemies.list]) {
        if (!e.spec.hit.some((sp) => segSphere(from, end, g.enemies.sphere(e, sp), sp[1]))) continue;
        const head = g.enemies.headshot(e, from, end);
        g.enemies.damage(e, damage * (head ? HEADSHOT : 1), g, false, head);
      }
      if (wall.t < RAIL.range && !g.props.hit(wall.box, damage, g)) g.destruction.hit(wall.box, end, wall.normal, damage, g, 0.8);
    }
    if (wall.t < RAIL.range) g.fx.impact(end, wall.normal, true);
    // A bright cyan streak that fades.
    const mesh = MeshBuilder.CreateCylinder("rail", { diameter: 0.25, height: 1, tessellation: 8 }, this.scene);
    mesh.position.copyFrom(from.add(end).scale(0.5));
    mesh.scaling.y = wall.t;
    mesh.lookAt(end);
    mesh.rotation.x += Math.PI / 2;
    const mat = new StandardMaterial("rail", this.scene);
    mat.emissiveColor = new Color3(0.45, 0.95, 1);
    mat.diffuseColor = Color3.Black();
    mat.disableLighting = true;
    mat.alphaMode = Engine.ALPHA_ADD;
    mesh.material = mat;
    mesh.isPickable = false;
    this.trails.push({ mesh, mat, t: 0.35 });
  }

  /** The flamethrower: a stream of fire from both cannons; real ones burn what is in the cone. */
  private flame(s: Shooter, firing: boolean, p: Player, aim: Vector3, g: Game, real: boolean) {
    s.flames ??= [g.fx.flamer(), g.fx.flamer()];
    p.guns.forEach((gun, i) => {
      const f = s.flames![i];
      const from = gun.muzzlePosition();
      const dir = aim.subtract(from).normalize();
      (f.emitter as Vector3).copyFrom(from);
      f.direction1 = dir.add(new Vector3(-0.12, -0.08, -0.12));
      f.direction2 = dir.add(new Vector3(0.12, 0.1, 0.12));
      f.emitRate = firing ? 260 : 0;
    });
    if (!firing || s.t > 0) return;
    s.t = FLAME.tick;
    if (!real) return g.sfx.flame(Vector3.Distance(p.pos, g.player.pos));
    const from = p.chest(), look = aim.subtract(from).normalize();
    for (const e of [...g.enemies.list]) {
      const c = g.enemies.centre(e);
      const to = c.subtract(from);
      const d = to.length();
      if (d > FLAME.range + e.spec.radius || Vector3.Dot(to.scale(1 / d), look) < FLAME.cone || !g.city.lineOfSight(from, c)) continue;
      g.enemies.damage(e, FLAME.damage * p.stats.gunDamage, g, true);
      g.enemies.ignite(e);
    }
  }

  update(dt: number, g: Game) {
    for (let i = this.trails.length - 1; i >= 0; i--) {
      const t = this.trails[i];
      t.t -= dt;
      t.mat.alpha = Math.max(0, t.t / 0.35);
      if (t.t > 0) continue;
      t.mesh.dispose(false, true);
      this.trails.splice(i, 1);
    }
  }

  /** A player left: their flames go. */
  forget(id: number) {
    const s = this.shooters.get(id);
    for (const f of s?.flames ?? []) f.dispose();
    this.shooters.delete(id);
  }

  clear() {
    for (const t of this.trails) t.mesh.dispose(false, true);
    this.trails = [];
    for (const s of this.shooters.values()) for (const f of s.flames ?? []) f.emitRate = 0;
  }
}

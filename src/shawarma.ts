import { Color3, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3, type InstancedMesh } from "@babylonjs/core";
import type { Game } from "./game";

/** Seconds between lobs while the right button is held. */
const COOLDOWN = 0.45;
const GRAVITY = 30;
const LIFE = 5;
const SHOUTS = ["НЯМ!", "С СЫРОМ!", "ОТ ВАЗГЕНА!", "ДВОЙНАЯ!", "БЕЗ ЛУКА?!", "ОСТРАЯ!", "СОУСА БОЛЬШЕ!", "НА УГЛЯХ!", "ЗАВЕРНИТЕ!"];

/** How a shawarma flies and what it does to whoever it hits. */
interface Throw {
  speed: number;
  loft: number;
  /** Share of gravity it feels. */
  fall: number;
  bounces: number;
  size: number;
  damage: number;
  /** Seconds the target stands dazed (bosses never are). */
  stun: number;
  /** Chance of a shout over the target. */
  shout: number;
}

/**
 * The launcher on the right mouse button lobs a huge shawarma that bounces down the street: next
 * to useless (one point of damage), but whatever it hits forgets the war for a moment.
 */
const LOB: Throw = { speed: 46, loft: 7, fall: 1, bounces: 3, size: 1, damage: 1, stun: 1.6, shout: 1 };
/**
 * The shawarma buster from the crates fires them like bullets, a bit harder than the machine guns;
 * `damage` is set per shot from the guns' damage.
 */
const BLAST: Throw = { speed: 95, loft: 1.5, fall: 0.25, bounces: 0, size: 0.75, damage: 0, stun: 0, shout: 0.15 };
/** Seconds between buster shots (scaled like the machine guns' rate), and its damage per second against theirs. */
export const BUSTER_INTERVAL = 0.11;
export const BUSTER_EDGE = 1.15;

interface Wrap {
  mesh: InstancedMesh;
  pos: Vector3;
  vel: Vector3;
  spin: Vector3;
  bounces: number;
  life: number;
  kind: Throw;
  damage: number;
}

export class Shawarma {
  private template: Mesh;
  private wraps: Wrap[] = [];
  private cooldown = 0;

  constructor(private scene: Scene) {
    const solid = (name: string, hex: string) => {
      const m = new StandardMaterial(name, scene);
      m.diffuseColor = Color3.FromHexString(hex);
      m.specularColor = new Color3(0.1, 0.1, 0.1);
      return m;
    };
    // Lavash rolled round the filling, which shows at the open end: meat, tomato and lettuce.
    const lavash = MeshBuilder.CreateCylinder("lavash", { height: 1.7, diameterTop: 0.62, diameterBottom: 0.5, tessellation: 12 }, scene);
    lavash.material = solid("lavash", "#e9cf93");
    const parts: Mesh[] = [lavash];
    const fill = [["#7a3f1d", 0, 0], ["#d8322a", 0.13, 0.06], ["#5fb33a", -0.12, -0.05], ["#f2efe6", 0.03, -0.14]] as const;
    for (const [hex, x, z] of fill) {
      const bit = MeshBuilder.CreateSphere("filling", { diameter: 0.34, segments: 6 }, scene);
      bit.position.set(x, 0.86, z);
      bit.material = solid(`filling${hex}`, hex);
      parts.push(bit);
    }
    // A paper wrapper round the bottom.
    const paper = MeshBuilder.CreateCylinder("wrapper", { height: 0.6, diameterTop: 0.56, diameterBottom: 0.53, tessellation: 12 }, scene);
    paper.position.y = -0.55;
    paper.material = solid("wrapper", "#f7f3ea");
    parts.push(paper);
    this.template = Mesh.MergeMeshes(parts, true, true, undefined, false, true)!;
    this.template.name = "shawarma";
    this.template.isPickable = false;
    this.template.setEnabled(false);
  }

  /** Call every frame with the right button's state; lobs from `from` towards `aim`. */
  update(dt: number, held: boolean, from: Vector3, aim: Vector3, g: Game) {
    this.cooldown -= dt;
    if (held && this.cooldown <= 0) {
      this.cooldown = COOLDOWN;
      this.launch(from, aim.subtract(from).normalize(), LOB, LOB.damage);
      g.sfx.whoosh();
    }
    for (const w of [...this.wraps]) this.fly(w, dt, g);
  }

  /** One shot of the shawarma buster, straight along `dir`. */
  blast(from: Vector3, dir: Vector3, damage: number) {
    this.launch(from, dir, BLAST, damage);
  }

  private launch(from: Vector3, dir: Vector3, kind: Throw, damage: number) {
    const mesh = this.template.createInstance("shawarma");
    mesh.setEnabled(true);
    mesh.scaling.setAll(kind.size);
    const vel = dir.scale(kind.speed).addInPlaceFromFloats(0, kind.loft, 0);
    const spin = new Vector3((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, 9 + Math.random() * 6);
    this.wraps.push({ mesh, pos: from.clone(), vel, spin, bounces: 0, life: LIFE, kind, damage });
  }

  private fly(w: Wrap, dt: number, g: Game) {
    w.life -= dt;
    w.vel.y -= GRAVITY * w.kind.fall * dt;
    const step = w.vel.scale(dt);
    const len = step.length();
    const prev = w.pos.clone();
    const hit = len > 0 ? g.city.raycastHit(prev, step.scale(1 / len), len) : null;
    const blocked = !!hit && hit.t < len;
    const end = blocked ? prev.add(step.scale(hit.t / len)) : prev.add(step);
    // A robot in the way, before whatever wall or ground lies beyond it.
    const enemy = g.enemies.hitTest(prev, end);
    if (enemy) {
      w.pos.copyFrom(end);
      g.enemies.feed(enemy, w.kind.stun);
      g.enemies.damage(enemy, w.damage, g, true);
      if (Math.random() < w.kind.shout) {
        g.popup(w.pos, SHOUTS[Math.floor(Math.random() * SHOUTS.length)], true);
        g.sfx.nom();
      }
      return this.drop(w, g);
    }
    w.pos.copyFrom(end);
    // Walls and the ground: bounce off, losing some of the go.
    if (blocked) {
      const n = hit.normal;
      w.pos.addInPlace(n.scale(0.3));
      w.vel.subtractInPlace(n.scale(2 * Vector3.Dot(w.vel, n))).scaleInPlace(0.55);
      w.spin.scaleInPlace(-0.8);
      if (++w.bounces > w.kind.bounces || w.vel.length() < 4) return this.drop(w, g);
      g.sfx.boing(w.bounces);
    }
    if (w.life <= 0) return this.drop(w, g);
    w.mesh.position.copyFrom(w.pos);
    w.mesh.rotation.addInPlace(w.spin.scale(dt));
  }

  private drop(w: Wrap, g: Game) {
    g.fx.pop(w.pos);
    w.mesh.dispose();
    this.wraps.splice(this.wraps.indexOf(w), 1);
  }

  clear() {
    for (const w of this.wraps) w.mesh.dispose();
    this.wraps = [];
  }
}

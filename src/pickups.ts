import { TransformNode, Vector3 } from "@babylonjs/core";
import type { Game } from "./game";
import type { Models } from "./models";

const HEAL = 25;
const LIFETIME = 30;

interface Pickup {
  root: TransformNode;
  dispose: () => void;
  t: number;
}

export class Pickups {
  readonly list: Pickup[] = [];

  constructor(private models: Models) {}

  spawn(at: Vector3) {
    const kit = this.models.prop("HealthPack", 3);
    kit.root.position.set(at.x, 1, at.z);
    this.list.push({ root: kit.root, dispose: kit.dispose, t: 0 });
  }

  update(dt: number, g: Game) {
    const p = g.player;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const k = this.list[i];
      k.t += dt;
      k.root.rotation.y += dt * 2;
      k.root.position.y = 1 + Math.sin(k.t * 3) * 0.25;
      const near = Math.hypot(k.root.position.x - p.pos.x, k.root.position.z - p.pos.z) < 2.5;
      const taken = near && p.hp < p.maxHp;
      if (taken) {
        p.hp = Math.min(p.maxHp, p.hp + HEAL);
        g.sfx.pickup();
      }
      if (taken || k.t > LIFETIME) {
        k.dispose();
        this.list.splice(i, 1);
      }
    }
  }

  clear() {
    for (const k of this.list) k.dispose();
    this.list.length = 0;
  }
}

import { Color4, ParticleSystem, Scene, Vector3 } from "@babylonjs/core";
import type { Box, City } from "./city";
import type { Fx } from "./fx";
import type { Models } from "./models";

/** The cruiser is about 18.5 units long; this makes it a 75-metre wreck. */
const SCALE = 4;

/**
 * A crashed cruiser ("Imperial", Quaternius' Ultimate Spaceships, CC0) buried nose first
 * in its own city block: burning, smoking, throwing sparks. Visible from anywhere.
 */
export class CrashSite {
  private sparkPoints: Vector3[] = [];
  private sparkT = 0;

  constructor(scene: Scene, models: Models, city: City, private fx: Fx) {
    const site = city.crashSite;
    const ship = models.cruiser(SCALE);

    // Lying across the block diagonally, nose dug in, rolled over onto one side.
    const yaw = 0.75, pitch = 0.035, roll = 0.2;
    ship.rotation.set(pitch, yaw, roll);
    const ahead = new Vector3(Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    const len = 18.5 * SCALE;
    // Centre it on the block, then sink it until its lowest point is a few units underground.
    ship.position.set(site.x, 0, site.z);
    ship.computeWorldMatrix(true);
    const { min, max } = ship.getHierarchyBoundingVectors(true);
    ship.position.addInPlaceFromFloats(site.x - (min.x + max.x) / 2, -min.y - 3, site.z - (min.z + max.z) / 2);
    const centre = ship.position.clone();
    const halfThick = Math.max(3, ((max.y - min.y) - len * Math.sin(pitch)) / 2);

    // Colliders along the hull, so it can be walked around, hidden behind and stood on.
    const boxes: Box[] = [];
    for (let t = -0.45; t <= 0.46; t += 0.075) {
      const p = centre.add(ahead.scale(len * t));
      boxes.push({ minX: p.x - 4.5, maxX: p.x + 4.5, minZ: p.z - 4.5, maxZ: p.z + 4.5, h: Math.max(1.5, p.y + halfThick * 0.8) });
    }
    city.addObstacles(boxes);

    // Where the nose went in, a few spots along the hull, and the broken tail.
    const along = (t: number, up: number) => centre.add(ahead.scale(len * t)).addInPlaceFromFloats(0, up, 0);
    const nose = along(0.42, 0);
    nose.y = Math.max(1, nose.y);
    this.burn(scene, nose, 2.2, true);
    this.burn(scene, along(0.1, 3), 1.2, false);
    this.burn(scene, along(-0.25, 4), 1.5, true);
    this.sparkPoints = [along(0.25, 3), along(-0.05, 4), along(-0.4, 5)];
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * 14;
      fx.scorch(new Vector3(nose.x + Math.cos(a) * r, 0.03, nose.z + Math.sin(a) * r), Vector3.Up(), 8 + Math.random() * 8);
    }
  }

  /** A fire that never goes out, and (optionally) a tall column of smoke above it. */
  private burn(scene: Scene, at: Vector3, scale: number, smoke: boolean) {
    const puff = this.fx.puffTexture;
    const fire = new ParticleSystem("wreckFire", 300, scene);
    fire.particleTexture = puff;
    fire.emitter = at;
    fire.updateSpeed = 1 / 60;
    fire.createSphereEmitter(1.5 * scale);
    fire.addColorGradient(0, new Color4(1, 0.75, 0.35, 0.8));
    fire.addColorGradient(0.4, new Color4(1, 0.4, 0.08, 0.6));
    fire.addColorGradient(1, new Color4(0.25, 0.05, 0.02, 0));
    fire.minSize = 2 * scale;
    fire.maxSize = 4 * scale;
    fire.minLifeTime = 0.6;
    fire.maxLifeTime = 1.3;
    fire.emitRate = 45 * scale;
    fire.minEmitPower = 1;
    fire.maxEmitPower = 3;
    fire.minInitialRotation = 0;
    fire.maxInitialRotation = Math.PI * 2;
    fire.minAngularSpeed = -1.5;
    fire.maxAngularSpeed = 1.5;
    fire.gravity = new Vector3(0, 6, 0);
    fire.blendMode = ParticleSystem.BLENDMODE_ADD;
    fire.start();
    if (!smoke) return;
    const column = new ParticleSystem("wreckSmoke", 500, scene);
    column.particleTexture = puff;
    column.emitter = at.add(new Vector3(0, 3, 0));
    column.updateSpeed = 1 / 60;
    column.createSphereEmitter(2 * scale);
    column.addColorGradient(0, new Color4(0.12, 0.11, 0.1, 0));
    column.addColorGradient(0.08, new Color4(0.12, 0.11, 0.1, 0.55));
    column.addColorGradient(0.7, new Color4(0.22, 0.21, 0.2, 0.45));
    column.addColorGradient(1, new Color4(0.3, 0.3, 0.3, 0));
    column.minSize = 6 * scale;
    column.maxSize = 13 * scale;
    column.minLifeTime = 8;
    column.maxLifeTime = 14;
    column.emitRate = 9 * scale;
    column.minEmitPower = 1;
    column.maxEmitPower = 2;
    column.direction1 = new Vector3(-0.3, 1, -0.3);
    column.direction2 = new Vector3(0.6, 1, 0.4);
    column.minInitialRotation = 0;
    column.maxInitialRotation = Math.PI * 2;
    column.minAngularSpeed = -0.3;
    column.maxAngularSpeed = 0.3;
    column.gravity = new Vector3(0.8, 3.5, 0.3); // drifting with the wind
    column.blendMode = ParticleSystem.BLENDMODE_STANDARD;
    column.preWarmCycles = 600;
    column.preWarmStepOffset = 3;
    column.start();
  }

  update(dt: number) {
    // Shorted wiring spits sparks now and then.
    this.sparkT -= dt;
    if (this.sparkT > 0) return;
    this.sparkT = 0.3 + Math.random() * 1.2;
    const p = this.sparkPoints[Math.floor(Math.random() * this.sparkPoints.length)];
    this.fx.spark(p, 12 + Math.floor(Math.random() * 15));
  }
}

